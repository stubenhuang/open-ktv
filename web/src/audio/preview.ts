//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { MixParams, PreviewParams, WorkLevels } from '../../../shared/types';
import {
  EQ_BANDS,
  compressorParams,
  deEssGainDb,
  generateReverbIr,
  mixTimeline,
  previewDurationSec,
  previewLinearGains,
  reverbDsp,
  reverbIrKey,
  reverbIrSpec,
  toPreviewParams,
} from '../../../shared/mix';
import { getAudioContext } from './engine';
import { apiLocale } from '../api';
import { translateWith } from '../i18n';
import { errorMessage } from '../utils';

/**
 * 实时试听引擎（纯客户端，零网络请求）。
 *
 * 存在的原因：以前改任何混音参数都要点「重新生成」，等 ffmpeg 把整首 MP3
 * 重编码一遍（几秒起）。这里在浏览器里用 Web Audio 复刻服务端的滤波器链，
 * 参数改动只操作本地音频图节点，立即发声。
 *
 * 音频图（与服务端 buildMixFilter 同构）：
 *
 *   vocalBufferSource ──> vocalGain ──> highpass(80) ──> eqLow ──> eqMid ──> eqHigh
 *                                     ──> compressor ──> deEss ──┬── dryGain ─────────────┐
 *                                                                └──> convolver ──> wetGain ─┤
 *   accompBufferSource ──> accompGain ──────────────────────────────────────────────────────┼──> limiter ──> destination
 *
 *  - highpass=80Hz / eqLow·Mid·High：和服务端一致（共用 shared/mix.ts 的 EQ_BANDS）；
 *  - compressor：与服务端 acompressor 同参数（共用 compressorParams）；
 *    压缩的 makeup 已经并进 vocalGain（见 vocalChainLinearGain），这里不再补一次；
 *  - deEss：静态高架下压，对服务端 deesser 的听感近似；
 *  - vocalGain/accompGain：实测归一化增益 × 用户滑块 × 压缩补偿（shared/mix.ts 的公式）；
 *  - convolver：程序生成的指数衰减噪声 IR（shared/mix.ts 的 generateReverbIr），
 *    与服务端 afir 卷积用的是**同一份生成公式、同一个量化键、同一个缩放系数**；
 *    normalize=false —— 缩放已烘进 IR，不再依赖浏览器内部的归一化行为；
 *  - limiter：DynamicsCompressor，近似服务端末端 alimiter=0.95，防预览削波；
 *  - 对齐偏移不用 DelayNode（改 delayTime 会有爆音），改用「晚到的一轨晚起播」
 *    的调度方式（与服务端 mixTimeline 同一套符号规则：offset ≥ 0 人声晚进，
 *    offset < 0 伴奏晚进）；偏移变化时按当前位置重排两轨。
 *
 * **预览不支持的处理**（UI 里明确标注，别让用户以为是 bug）：
 *  降噪（afftdn）—— 没有对应的 Web Audio 节点，只影响服务端成品。
 *
 * 已知限制：整曲 decodeAudioData 进内存，接近 15 分钟的录音解码后约几百 MB
 * Float32（单机自用可接受）。
 */

/** 偏移变化后的重排防抖：拖动过程中每 10ms 都在变，合并成一次无缝重排 */
const OFFSET_REARM_MS = 120;
/** 增益平滑的时间常数，太小会有阶梯感，太大显得滞后 */
const GAIN_SMOOTHING = 0.02;
/** 起播前的调度余量，给浏览器留足准备时间 */
const START_LEAD_SEC = 0.05;

/**
 * 试听 IR 的量化步进在 shared/mix.ts（REVERB_IR_QUANTIZE）—— 服务端生成
 * 混响 IR 时用同一个 reverbIrKey，两端的 IR 才逐位同源。
 *
 * 缓存上限 12 条、超出清空：拖完整个轴再拖回来会重建，内存有界。
 */
const IR_CACHE_MAX = 12;

export interface PreviewEngineOptions {
  vocalUrl: string;
  accompUrl: string;
}

async function fetchDecode(url: string, label: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      translateWith(apiLocale(), 'audio.preview.loadFailed', { label, status: response.status }),
    );
  }
  const bytes = await response.arrayBuffer();
  // decodeAudioData 基于回调的老形态在 Safari 上才需要，Chrome/Edge 直接返回 Promise
  return getAudioContext().decodeAudioData(bytes);
}

/** 试听 IR 规格：尾巴秒数 / 前延迟 ms / 衰减指数 */
interface IrSpec {
  seconds: number;
  preDelayMs: number;
  decay: number;
}

/** 程序生成混响 IR（shared/mix.ts）：前延迟静音 + 指数衰减噪声，立体声不相关 */
function createImpulseResponse(spec: IrSpec): AudioBuffer {
  const context = getAudioContext();
  const channels = generateReverbIr(spec, context.sampleRate, 2);
  const buffer = context.createBuffer(2, channels[0]!.length, context.sampleRate);
  buffer.copyToChannel(channels[0]!, 0);
  buffer.copyToChannel(channels[1]!, 1);
  return buffer;
}

export class PreviewEngine {
  private readonly context: AudioContext;
  private readonly vocalBuffer: AudioBuffer;
  private readonly accompBuffer: AudioBuffer;

  private readonly vocalGain: GainNode;
  private readonly accompGain: GainNode;
  private readonly highpass: BiquadFilterNode;
  private readonly eqLow: BiquadFilterNode;
  private readonly eqMid: BiquadFilterNode;
  private readonly eqHigh: BiquadFilterNode;
  private readonly compressor: DynamicsCompressorNode;
  /** 去齿音近似：高频高架下压；服务端用的是动态 deesser */
  private readonly deEss: BiquadFilterNode;
  private readonly dryGain: GainNode;
  private readonly wetGain: GainNode;
  private readonly convolver: ConvolverNode;
  private readonly limiter: DynamicsCompressorNode;

  private readonly impulseCache = new Map<number, AudioBuffer>();

  private vocalSource: AudioBufferSourceNode | null = null;
  private accompSource: AudioBufferSourceNode | null = null;

  private params: PreviewParams = {
    vocalGain: 1,
    accompGain: 1,
    reverbSpace: 1 / 7,
    reverbWet: 1,
    offsetMs: 0,
    levels: null,
    eqLowDb: 0,
    eqMidDb: 0,
    eqHighDb: 0,
    compression: 0,
    deEss: 0,
    noiseReduction: false,
  };

  /** 播放时：本次起播的 context 时间；暂停时：null */
  private passStartCtxTime: number | null = null;
  /** 起播时所在的混音时间轴位置（秒） */
  private startPositionSec = 0;
  /**
   * 自然播完 vs 手动停止：onended 两种都会触发，靠这个区分。
   *
   * 但它挡不住「被替换掉的旧 source」迟到的 ended：stopSources() 先把 stopping 置 true，
   * startSources() 建好新轨后又置回 false，而旧 source 的 ended 是排队异步派发的 ——
   * 等它到的时候 stopping 已经是 false，handleVocalEnded 会把它当成自然播完，
   * 把刚起播的新轨掐掉、通知 UI 跳结尾（seek / 改对齐都会踩到）。
   * 所以另配 sourceGeneration：stopSources() 每次 +1，旧 source 的 ended 一律作废。
   */
  private stopping = false;
  /** 起播代数。stopSources() 每次 +1；只有当代数匹配才是「当前这轨真的播完了」 */
  private sourceGeneration = 0;
  private rearmTimer: number | null = null;

  /** 干声（含对齐偏移）播完时触发；UI 用来复位播放按钮 */
  onEnded: (() => void) | null = null;

  private constructor(vocalBuffer: AudioBuffer, accompBuffer: AudioBuffer) {
    this.context = getAudioContext();
    this.vocalBuffer = vocalBuffer;
    this.accompBuffer = accompBuffer;

    this.vocalGain = this.context.createGain();
    this.accompGain = this.context.createGain();

    this.highpass = this.context.createBiquadFilter();
    this.highpass.type = 'highpass';
    this.highpass.frequency.value = 80;

    // 均衡三段：类型与频率必须和服务端 buildEqChain 一致（共用 EQ_BANDS）
    this.eqLow = this.context.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = EQ_BANDS.low.frequency;

    this.eqMid = this.context.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = EQ_BANDS.mid.frequency;
    this.eqMid.Q.value = EQ_BANDS.mid.q;

    this.eqHigh = this.context.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = EQ_BANDS.high.frequency;

    this.compressor = this.context.createDynamicsCompressor();
    this.compressor.knee.value = 6;
    this.compressor.attack.value = 0.01;
    this.compressor.release.value = 0.2;

    this.deEss = this.context.createBiquadFilter();
    this.deEss.type = 'highshelf';
    this.deEss.frequency.value = 6000;

    this.dryGain = this.context.createGain();
    this.wetGain = this.context.createGain();
    this.convolver = this.context.createConvolver();
    // normalize=false：缩放已在 shared/mix.ts 的 generateReverbIr 里按浏览器的
    // normalize=true 等效增益（RMS→1 后再 −58dB 感知校准）显式烘好。开着
    // normalize 会让浏览器按自己的内部公式重新归一回，IR 幅度反而说了不算，
    // 服务端也就没法用同一份 IR 对齐。
    this.convolver.normalize = false;

    this.limiter = this.context.createDynamicsCompressor();
    // 近似服务端 alimiter=limit=0.95：只兜削峰，不改变整体动态
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    // 人声链：gain → 高通 → 均衡 → 压缩 → 去齿音 → 干/湿双路
    this.vocalGain.connect(this.highpass);
    this.highpass.connect(this.eqLow);
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.compressor);
    this.compressor.connect(this.deEss);
    this.deEss.connect(this.dryGain);
    this.deEss.connect(this.convolver);
    this.convolver.connect(this.wetGain);
    // 伴奏链：gain 直达
    this.accompGain.connect(this.limiter);
    this.dryGain.connect(this.limiter);
    this.wetGain.connect(this.limiter);
    this.limiter.connect(this.context.destination);

    this.applyAudioParams();
  }

  /** 并行下载并解码干声 + 伴奏；任何一路失败整体失败（由调用方展示错误） */
  static async create(options: PreviewEngineOptions): Promise<PreviewEngine> {
    // 两轨在各语言里的叫法：下载 / 解码失败时要能说清是哪一轨
    const vocalLabel = translateWith(apiLocale(), 'audio.preview.vocal');
    const accompLabel = translateWith(apiLocale(), 'audio.preview.accomp');
    const [vocalBuffer, accompBuffer] = await Promise.all([
      fetchDecode(options.vocalUrl, vocalLabel).catch((error: unknown) => {
        throw new Error(
          translateWith(apiLocale(), 'audio.preview.decodeFailed', {
            label: vocalLabel,
            reason: errorMessage(error),
          }),
        );
      }),
      fetchDecode(options.accompUrl, accompLabel).catch((error: unknown) => {
        throw new Error(
          translateWith(apiLocale(), 'audio.preview.decodeFailed', {
            label: accompLabel,
            reason: errorMessage(error),
          }),
        );
      }),
    ]);
    return new PreviewEngine(vocalBuffer, accompBuffer);
  }

  get playing(): boolean {
    return this.passStartCtxTime !== null;
  }

  /** 混音时间轴位置（秒）：0 = 伴奏起点 */
  get positionSec(): number {
    if (this.passStartCtxTime === null) return this.startPositionSec;
    const elapsed = this.context.currentTime - this.passStartCtxTime;
    return Math.min(this.durationSec, Math.max(0, this.startPositionSec + elapsed));
  }

  /** 总时长 = 干声时长 + max(0, 对齐偏移)（与服务端 duration=first 一致） */
  get durationSec(): number {
    return previewDurationSec(this.vocalBuffer.duration, this.params.offsetMs);
  }

  async play(): Promise<void> {
    if (this.playing) return;
    if (this.context.state === 'suspended') await this.context.resume();
    if (this.positionSec >= this.durationSec - 0.01) this.startPositionSec = 0;
    this.startSources(this.startPositionSec);
  }

  pause(): void {
    if (!this.playing) return;
    this.startPositionSec = this.positionSec;
    this.stopSources();
  }

  async toggle(): Promise<void> {
    if (this.playing) this.pause();
    else await this.play();
  }

  seek(positionSec: number): void {
    const target = Math.min(this.durationSec, Math.max(0, positionSec));
    this.startPositionSec = target;
    // 播放中拖进度 = 按新位置重排两轨；暂停中只记位置
    if (this.playing) this.startSources(target);
  }

  /**
   * 更新混音参数（实时，不发请求）。
   *  - 音量/混响：立即平滑生效，不打断播放；
   *  - 对齐偏移：播放中防抖重排两轨（重排 seam < 50ms）。
   *
   * 参数合成走共享的 toPreviewParams，和服务端用同一套偏移/增益公式。
   */
  setParams(params: MixParams, autoOffsetMs: number, levels: WorkLevels | null): void {
    const next = toPreviewParams(params, autoOffsetMs, levels);
    const offsetChanged = next.offsetMs !== this.params.offsetMs;
    this.params = next;
    this.applyAudioParams();

    if (offsetChanged && this.playing) {
      if (this.rearmTimer !== null) window.clearTimeout(this.rearmTimer);
      this.rearmTimer = window.setTimeout(() => {
        this.rearmTimer = null;
        if (!this.playing) return;
        const position = this.positionSec;
        this.startSources(position);
      }, OFFSET_REARM_MS);
    }
  }

  dispose(): void {
    if (this.rearmTimer !== null) window.clearTimeout(this.rearmTimer);
    this.rearmTimer = null;
    this.stopSources();
    this.vocalGain.disconnect();
    this.accompGain.disconnect();
    this.highpass.disconnect();
    this.eqLow.disconnect();
    this.eqMid.disconnect();
    this.eqHigh.disconnect();
    this.compressor.disconnect();
    this.deEss.disconnect();
    this.dryGain.disconnect();
    this.wetGain.disconnect();
    this.convolver.disconnect();
    this.limiter.disconnect();
    this.onEnded = null;
  }

  /* --------------------------------- 内部实现 -------------------------------- */

  private applyAudioParams(): void {
    const now = this.context.currentTime;
    const { vocalLinear, accompLinear } = previewLinearGains(this.params, this.params.levels);
    this.vocalGain.gain.setTargetAtTime(vocalLinear, now, GAIN_SMOOTHING);
    this.accompGain.gain.setTargetAtTime(accompLinear, now, GAIN_SMOOTHING);

    // 均衡：三段各自平滑过渡，拖动时不会有爆音
    this.eqLow.gain.setTargetAtTime(this.params.eqLowDb, now, GAIN_SMOOTHING);
    this.eqMid.gain.setTargetAtTime(this.params.eqMidDb, now, GAIN_SMOOTHING);
    this.eqHigh.gain.setTargetAtTime(this.params.eqHighDb, now, GAIN_SMOOTHING);

    // 压缩：阈值与压缩比与服务端 acompressor 同源（shared/mix.ts）
    const comp = compressorParams(this.params.compression);
    this.compressor.threshold.setTargetAtTime(comp.enabled ? comp.thresholdDb : 0, now, GAIN_SMOOTHING);
    this.compressor.ratio.setTargetAtTime(comp.enabled ? comp.ratio : 1, now, GAIN_SMOOTHING);

    // 去齿音：静态高架下压（服务端是动态 deesser，属听感近似）
    this.deEss.gain.setTargetAtTime(deEssGainDb(this.params.deEss), now, GAIN_SMOOTHING);

    // 混响：空间决定 IR（尾巴/前延迟/衰减），湿度决定发送量。
    // 湿度只动 wetGain/dryGain（平滑过渡），不重建 IR —— 拖湿度不会有爆音。
    // 干湿增益都来自共享的 reverbDsp，服务端 afir 分支用的是同一对数值。
    const dsp = reverbDsp(this.params.reverbSpace, this.params.reverbWet);
    if (!dsp.bypass) {
      const ir = this.impulseFor(this.params.reverbSpace);
      if (this.convolver.buffer !== ir) {
        this.convolver.buffer = ir;
      }
      this.wetGain.gain.setTargetAtTime(dsp.wet, now, GAIN_SMOOTHING);
      this.dryGain.gain.setTargetAtTime(dsp.dry, now, GAIN_SMOOTHING);
    } else {
      this.wetGain.gain.setTargetAtTime(0, now, GAIN_SMOOTHING);
      this.dryGain.gain.setTargetAtTime(1, now, GAIN_SMOOTHING);
    }
  }

  /** 当前空间对应的试听 IR（量化键缓存，键函数与干湿增益的取参口径见 shared/mix.ts） */
  private impulseFor(space: number): AudioBuffer {
    const key = reverbIrKey(space);
    const cached = this.impulseCache.get(key);
    if (cached) return cached;
    const spec = reverbIrSpec(key);
    const created = createImpulseResponse({
      seconds: spec.seconds,
      preDelayMs: spec.preDelayMs,
      decay: spec.decay,
    });
    if (this.impulseCache.size >= IR_CACHE_MAX) this.impulseCache.clear();
    this.impulseCache.set(key, created);
    return created;
  }

  /**
   * 从混音时间轴 position 处起播两轨。
   *
   * 符号规则与服务端 mixTimeline 一致（shared/mix.ts）：
   *  - offset ≥ 0：人声晚 V0 = offset 秒进入，伴奏从 position 处续；
   *  - offset < 0：伴奏晚 A0 = |offset| 秒进入，人声从 position 处续。
   * 任一点还没到就延后起播，已经过了就按对应 buffer 偏移续播。
   */
  private startSources(positionSec: number): void {
    this.stopSources();

    const now = this.context.currentTime + START_LEAD_SEC;
    // 谁进得晚由共享的 mixTimeline 决定（服务端 adelay 用的是同一套规则）
    const { vocalDelayMs, accompDelayMs } = mixTimeline(this.params.offsetMs);
    const vocalEnterSec = vocalDelayMs / 1000;
    const accompEnterSec = accompDelayMs / 1000;

    this.passStartCtxTime = now;
    this.startPositionSec = positionSec;

    const accompSource = this.context.createBufferSource();
    accompSource.buffer = this.accompBuffer;
    accompSource.connect(this.accompGain);
    accompSource.start(
      now + Math.max(0, accompEnterSec - positionSec),
      Math.min(Math.max(0, positionSec - accompEnterSec), this.accompBuffer.duration),
    );
    this.accompSource = accompSource;

    // stopSources() 刚把代数 +1，这里取的就是「当前这轨」的代数；
    // 之后再被替换/停止，取到的代数就对不上了
    const generation = this.sourceGeneration;

    const vocalSource = this.context.createBufferSource();
    vocalSource.buffer = this.vocalBuffer;
    vocalSource.connect(this.vocalGain);
    this.stopping = false;
    vocalSource.onended = () => this.handleVocalEnded(generation);
    vocalSource.start(
      now + Math.max(0, vocalEnterSec - positionSec),
      Math.min(Math.max(0, positionSec - vocalEnterSec), this.vocalBuffer.duration),
    );
    this.vocalSource = vocalSource;
  }

  private stopSources(): void {
    this.stopping = true;
    // 旧轨的 ended 事件还会派发（stop() 也会触发它），用代数把它作废
    this.sourceGeneration += 1;
    this.accompSource?.disconnect();
    this.accompSource?.stop();
    this.accompSource = null;
    this.vocalSource?.disconnect();
    this.vocalSource?.stop();
    this.vocalSource = null;
    this.passStartCtxTime = null;
  }

  /** 干声播完 = 成品播完（duration=first）：整体停下并通知 UI */
  private handleVocalEnded(generation: number): void {
    // 不是当前这轨（被 seek / 对齐重排 / pause 替换掉的旧轨）——它的 ended 不作数
    if (generation !== this.sourceGeneration) return;
    if (this.stopping) return;
    this.startPositionSec = this.durationSec;
    this.stopSources();
    this.onEnded?.();
  }
}
