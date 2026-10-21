//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { concatFloat32, encodeWavBlob } from '../../../shared/wav';
import { resolveRecordGapMs } from '../../../shared/mix';
import { apiLocale } from '../api';
import { translateWith } from '../i18n';
import { ensureWorklet, getAudioContext, type CaptureStats } from './engine';
import { log } from '../log';

/**
 * 手机端录音引擎。
 *
 * 和桌面的 KtvEngine 是两套，差异全是**手机平台的约束**逼出来的：
 *
 *  1. **媒体元素不接进 Web Audio**。桌面把 `<audio>` 过 MediaElementSource，
 *     是为了让 onset 探测器在渲染时钟上量伴奏起播时刻。手机这边刻意不接：
 *     iOS 的「侧边静音开关」会静音 Web Audio 输出，而 HTMLMediaElement 走的是
 *     媒体声道、不受它影响；不接进去伴奏就一定能响。代价是拿不到渲染时钟，
 *     起播间隔改用 performance.now() 量（见 resolveMobileGapMs）。
 *  2. **没有耳返**。手机外放伴奏时开耳返就是啸叫，所以这条链路里根本没有
 *     监听支路；要听自己请戴耳机（耳机里也听不到自己，只能防串音）。
 *  3. **不选设备**。手机就一个麦克风，getUserMedia 不传 deviceId 用系统默认。
 *
 * 保留的部分与桌面一致：只录麦克风干声（伴奏不进录音文件）、关掉浏览器自带的
 * 回声消除/降噪（它们会把歌声当噪声削掉）、AudioWorklet 攒原始 PCM 编 WAV
 * （MediaRecorder 的 opus 有固有前导延迟，采样点对不齐）。
 */

/** 先开录再放伴奏：这段静音就是对齐时要从干声头部抠掉的量 */
const PREROLL_MS = 150;
/** 停止后留给 worklet flush 尾巴的时间 */
const FLUSH_WAIT_MS = 80;
/** currentTime 轮询间隔：playing 事件之外的双保险 */
const ACCOMP_POLL_MS = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface MobileRecordResult {
  blob: Blob;
  durationSec: number;
  /**
   * 自动对齐间隔 G（ms，恒为正）：墙钟下「起录 → 伴奏真正起播」的实测值，
   * 含 150ms 预备静音和浏览器 seek/解码/调度延迟。服务端最终偏移 =
   * userOffsetMs − autoOffsetMs（人声提前 G 才对齐，见 shared/mix.ts）。
   */
  autoOffsetMs: number;
  sampleRate: number;
  /** 采集期间「整拍没拿到输入」的比例（0–1）。>0.5% 就说明音频设备在抖 */
  droppedRatio: number;
}

/**
 * 起播间隔的收敛见 shared/mix.ts 的 resolveRecordGapMs（与桌面引擎共用）：
 * 负值钳 0、超大值封顶、测不到退回预备静音常量。手机与桌面量的时钟不同
 * （墙钟 vs 渲染时钟），但「什么算异常」必须同一个口径。
 */

export class MobileEngine {
  private readonly context: AudioContext;
  private readonly analyser: AnalyserNode;
  private readonly captureSink: GainNode;
  private readonly levelData: Float32Array<ArrayBuffer>;

  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private captureNode: AudioWorkletNode | null = null;

  private chunks: Float32Array[] = [];
  /** 是否还在接收 PCM 分片（停止后的 flush 尾巴也要收） */
  private accepting = false;
  /** 用户视角的「正在录音」 */
  private recording = false;
  /** 干声 WAV 的 t=0（墙钟） */
  private captureStartPerf = 0;
  /** 伴奏起播时刻（墙钟）；null = 没测到 */
  private accompStartPerf: number | null = null;
  private gapWatcher: Promise<void> | null = null;
  private pollTimer: number | null = null;
  private onElementPlaying: (() => void) | null = null;
  /** 正在被观测起播的媒体元素（disarm 时要摘监听） */
  private watchedElement: HTMLMediaElement | null = null;
  private lastStats: CaptureStats | null = null;

  constructor() {
    this.context = getAudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.levelData = new Float32Array(this.analyser.fftSize);
    this.captureSink = this.context.createGain();
    this.captureSink.gain.value = 0;
    // 0 增益 sink：纯粹为了让 worklet 处于「被 destination 拉动」的路径上
    this.captureSink.connect(this.context.destination);
  }

  get isRecording(): boolean {
    return this.recording;
  }

  async resume(): Promise<void> {
    if (this.context.state === 'suspended') await this.context.resume();
  }

  /** 建好录音链路（AudioWorklet + 采集节点）；拿麦克风之前调 */
  async init(): Promise<void> {
    await ensureWorklet(this.context);
    if (this.captureNode) return;

    this.captureNode = new AudioWorkletNode(this.context, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    this.captureNode.port.onmessage = (event: MessageEvent<Float32Array | CaptureStats>) => {
      const data = event.data;
      if (data instanceof Float32Array) {
        if (this.accepting) this.chunks.push(data);
        return;
      }
      if (data && typeof data === 'object' && 'missingQuanta' in data) {
        this.lastStats = data;
      }
    };
    this.captureNode.connect(this.captureSink);
    this.micSource?.connect(this.captureNode);
  }

  /**
   * 授权并接入麦克风。
   *
   * @param deviceId 要用的输入设备；null = 系统默认。手机端**必须传外置设备的 id**
   *   （演唱页的设备下拉只列外置输入），不允许静默回退到机身内置麦 —— 外放伴奏
   *   会被它收进去，混音里就是一串伴奏声。
   *
   * 处理开关与桌面一致地全部关掉 —— AEC / 降噪是给语音通话做的，
   * 会把歌声当噪声削掉。代价是不防啸叫，所以手机端也要求戴耳机。
   */
  async setMic(deviceId: string | null): Promise<void> {
    await this.init();
    const audio: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };

    const stream = await navigator.mediaDevices.getUserMedia({ audio });

    this.teardownMic();
    this.micStream = stream;
    this.micSource = this.context.createMediaStreamSource(stream);
    this.micSource.connect(this.analyser);
    if (this.captureNode) this.micSource.connect(this.captureNode);
  }

  private teardownMic(): void {
    this.micSource?.disconnect();
    this.micSource = null;
    for (const track of this.micStream?.getTracks() ?? []) track.stop();
    this.micStream = null;
  }

  /** 当前麦克风峰值 0–1，给音量条用 */
  getLevel(): number {
    if (!this.micSource) return 0;
    this.analyser.getFloatTimeDomainData(this.levelData);
    let peak = 0;
    for (let i = 0; i < this.levelData.length; i += 1) {
      const value = Math.abs(this.levelData[i]!);
      if (value > peak) peak = value;
    }
    return Math.min(1, peak);
  }

  /**
   * 开始录音并紧接着播放伴奏。
   *
   * @param element 播放伴奏的 `<audio>` / `<video>`（不在 Web Audio 图里）
   */
  async startRecording(element: HTMLMediaElement): Promise<void> {
    // 内部不变量（正常流程 setMic 成功后才进这里），但 message 会经 errorMessage(err)
    // 显示给用户，所以照样走文案目录
    if (!this.micSource) throw new Error(translateWith(apiLocale(), 'audio.micNotConnected'));
    await this.init();
    await this.resume();

    this.chunks = [];
    this.accepting = true;
    this.recording = true;
    this.accompStartPerf = null;
    this.captureStartPerf = performance.now();

    await sleep(PREROLL_MS);
    if (!this.recording) return;

    element.currentTime = 0;
    this.armAccompStartWatcher(element);
    try {
      await element.play();
    } catch (error) {
      this.recording = false;
      this.accepting = false;
      this.disarmAccompStartWatcher();
      throw new Error(
        translateWith(apiLocale(), 'audio.accompPlayBlockedRetry', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * 武装起播观测：playing 事件 + currentTime 轮询，**先到为准**。
   *
   * 两个信号都不完美 —— playing 可能在真正出声前就 firing，轮询只能到 8ms
   * 粒度 —— 但取早的那个足够贴住「耳朵第一次听到伴奏」的时刻，
   * 而桌面对只有单个信号时也是照用的（见 KtvEngine.computeGapMs）。
   */
  private armAccompStartWatcher(element: HTMLMediaElement): void {
    const mark = () => {
      if (this.accompStartPerf === null) this.accompStartPerf = performance.now();
    };
    this.onElementPlaying = mark;
    this.watchedElement = element;
    element.addEventListener('playing', this.onElementPlaying);
    this.pollTimer = window.setInterval(() => {
      if (this.accompStartPerf === null && element.currentTime > 0) mark();
    }, ACCOMP_POLL_MS);
    // 收敛协程：正常几百毫秒内就有了，stopRecording 几乎不用等
    this.gapWatcher = (async () => {
      const deadline = performance.now() + 2500;
      while (performance.now() < deadline) {
        if (this.accompStartPerf !== null) break;
        await sleep(25);
      }
      this.disarmAccompStartWatcher();
    })();
  }

  private disarmAccompStartWatcher(): void {
    if (this.onElementPlaying && this.watchedElement) {
      this.watchedElement.removeEventListener('playing', this.onElementPlaying);
    }
    this.onElementPlaying = null;
    this.watchedElement = null;
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** 结束录音，返回可以直接上传的 WAV */
  async stopRecording(element: HTMLMediaElement): Promise<MobileRecordResult> {
    // 同上：不变量文案，但会经 errorMessage(err) 显示给用户（重复点「停止」就会看到）
    if (!this.recording) throw new Error(translateWith(apiLocale(), 'audio.notRecording'));

    element.pause();
    this.lastStats = null;
    this.captureNode?.port.postMessage('flush');
    await sleep(FLUSH_WAIT_MS);

    this.recording = false;
    this.accepting = false;
    if (this.gapWatcher) {
      await this.gapWatcher;
      this.gapWatcher = null;
    }

    const gapMs = resolveRecordGapMs({
      captureStartPerf: this.captureStartPerf,
      accompStartPerf: this.accompStartPerf,
      prerollMs: PREROLL_MS,
    });
    if (this.accompStartPerf === null) {
      log.warn('record', '没测到伴奏起播时刻，自动对齐回退到预备静音常量', {
        prerollMs: PREROLL_MS,
      });
    }

    const sampleRate = this.context.sampleRate;
    const mono = concatFloat32(this.chunks);
    this.chunks = [];

    const stats = this.lastStats as CaptureStats | null;
    const droppedRatio =
      stats && stats.frames > 0
        ? (stats.missingQuanta * stats.renderQuantum) / stats.frames
        : 0;

    return {
      blob: encodeWavBlob(mono, sampleRate),
      durationSec: mono.length / sampleRate,
      autoOffsetMs: gapMs,
      sampleRate,
      droppedRatio,
    };
  }

  /** 中途放弃录音 */
  cancelRecording(): void {
    this.recording = false;
    this.accepting = false;
    this.chunks = [];
    this.gapWatcher = null;
    this.disarmAccompStartWatcher();
  }

  dispose(): void {
    this.recording = false;
    this.accepting = false;
    this.chunks = [];
    this.gapWatcher = null;
    this.disarmAccompStartWatcher();

    this.teardownMic();

    if (this.captureNode) {
      this.captureNode.port.onmessage = null;
      this.captureNode.disconnect();
      this.captureNode = null;
    }
    this.analyser.disconnect();
    this.captureSink.disconnect();
  }
}
