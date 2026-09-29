import { concatFloat32, encodeWavBlob } from '../../../shared/wav';
import { log } from '../log';
import { errorMessage } from '../utils';

/**
 * KTV 音频引擎。
 *
 * 音频图：
 *
 *   <video>/<audio> ──MediaElementSource──┬──> accompGain ──────────────────────────────────────────────────────────────────────┐
 *                                         │                                                   │
 *                                         └──> AudioWorklet(accomp-onset) ──> captureSink(0)
 *                                                                                          │
 *   MediaStreamSource ──> analyser ──> micMonitorGain ──────────────────────────────────────────────────────────────────────────────├──> destination
 *                     │                                                                       │
 *                     └──> AudioWorklet(pcm-capture) ──> captureSink(0) ──────────────────────────────────────────┘
 *
 * 四个关键设计：
 *  1. 录音只采麦克风干声，耳返混音绝不进录音文件 —— 这是服务端能重新混音的前提。
 *  2. captureSink 是个 0 增益节点，纯粹为了让 Worklet 处于「被 destination 拉动」的
 *     路径上。没有它，浏览器可能根本不调用 process()。
 *  3. 全 App 共用一个 AudioContext，且用 WeakMap 缓存 MediaElementSource：
 *     createMediaElementSource 对同一个元素只能调一次，React 严格模式的重复挂载
 *     会直接把它踩爆。
 *  4. onsetWorklet 挂在 MediaElementSource 上（伴奏音量 gain 之前），用**渲染时钟**
 *     测伴奏真正开始渲染的时刻。干声 WAV 的 t=0 是起录时刻，两者相减才是服务端
 *     需要的自动对齐间隔（见 shared/mix.ts 的符号说明）—— play() 的 promise
 *     兑现时刻和墙钟都不够准。
 */

const WORKLET_URL = '/pcm-worklet.js';
const ONSET_WORKLET_URL = '/accomp-onset.js';
/** 先开录再放伴奏：这段静音就是对齐时要从干声头部抠掉的量，别抢唱 */
const PREROLL_MS = 150;
/** 停止后留给 worklet flush 尾巴的时间 */
const FLUSH_WAIT_MS = 80;
/** 起播探测总超时：伴奏 2.5s 还没动静就放弃精确测量，回退到常量 */
const ACCOMP_START_TIMEOUT_SEC = 2.5;
/** playing 事件已到、onset 还没来时再宽限的时长（给精确值一个赢的机会） */
const ACCOMP_START_GRACE_SEC = 0.4;
/** currentTime 轮询间隔：playing 事件之外的双保险 */
const ACCOMP_POLL_MS = 8;
/** 起播间隔的钳制范围：异常值（设备抽风）不至于把成品拖垮 */
const MAX_MEASURED_GAP_MS = 10_000;

let sharedContext: AudioContext | null = null;
let workletModulePromise: Promise<void> | null = null;
const mediaElementSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

export function getAudioContext(): AudioContext {
  if (!sharedContext) {
    // 刻意不指定 sampleRate：写死 48000 会让浏览器在「麦克风原生采样率」和
    // 「AudioContext 采样率」之间多插一级重采样。麦克风常见是 44.1k，
    // 这一级转换在设备时钟有偏差时会周期性丢/插样本，听感就是断断续续。
    // 用设备默认采样率最稳；服务端 aformat 会把一切重采样到 48k，
    // 所以录到 44.1k 也完全没问题。
    sharedContext = new AudioContext({ latencyHint: 'interactive' });
  }
  return sharedContext;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureWorklet(context: AudioContext): Promise<void> {
  if (!workletModulePromise) {
    workletModulePromise = Promise.all(
      [WORKLET_URL, ONSET_WORKLET_URL].map((url) => context.audioWorklet.addModule(url)),
    )
      .then(() => undefined)
      .catch((error: unknown) => {
        // 允许下次重试，避免一次失败就把整个会话卡死
        workletModulePromise = null;
        throw new Error(`录音模块加载失败：${errorMessage(error)}`);
      });
  }
  return workletModulePromise;
}

function mediaSourceFor(
  context: AudioContext,
  element: HTMLMediaElement,
): MediaElementAudioSourceNode {
  const cached = mediaElementSources.get(element);
  if (cached) return cached;
  const source = context.createMediaElementSource(element);
  mediaElementSources.set(element, source);
  return source;
}

export interface RecordResult {
  blob: Blob;
  durationSec: number;
  /**
   * 自动对齐间隔 G（ms，恒为正）：渲染时钟下「起录 → 伴奏真正起播」的实测值，
   * 含 150ms 预备静音和浏览器 seek/解码/调度延迟。服务端最终偏移 =
   * userOffsetMs − autoOffsetMs（人声提前 G 才对齐）。
   */
  autoOffsetMs: number;
  sampleRate: number;
  /** 采集期间「整拍没拿到输入」的比例（0–1）。>0.5% 就说明音频设备在抖 */
  droppedRatio: number;
  /** 实际生效的麦克风设置，用来确认浏览器没偷偷加重处理 */
  captureSettings: MicCaptureSettings;
}

export interface MicCaptureSettings {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  channelCount: number | null;
  sampleRate: number | null;
  deviceId: string | null;
}

interface CaptureStats {
  frames: number;
  missingQuanta: number;
  renderQuantum: number;
}

export interface MicDeviceInfo {
  deviceId: string;
  label: string;
}

/**
 * 录歌用的麦克风约束。
 * `voiceIsolation`（Chrome 121+ 的语音隔离）会按“人声/非人声”切分音频，
 * 对唱歌是灾难，但 TS 的 DOM 类型还没跟上，所以在这里补上。
 */
type MusicTrackConstraints = MediaTrackConstraints & {
  voiceIsolation?: boolean;
};

export class KtvEngine {
  readonly context: AudioContext;

  private readonly element: HTMLMediaElement;
  private readonly accompSource: MediaElementAudioSourceNode;
  private readonly accompGain: GainNode;
  private readonly micMonitorGain: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly captureSink: GainNode;
  private readonly levelData: Float32Array<ArrayBuffer>;

  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private onsetNode: AudioWorkletNode | null = null;

  private chunks: Float32Array[] = [];
  /** 用户视角的「正在录音」 */
  private recording = false;
  /** 是否还在接收 PCM 分片（停止后的 flush 尾巴也要收） */
  private accepting = false;
  /** 干声 WAV 的 t=0 对应的渲染时钟时刻（起录那一刻记下） */
  private captureStartCtxTime = 0;
  /** onset worklet 测到的伴奏首样本渲染时刻（渲染时钟，秒）；null = 没测到 */
  private accompOnsetCtxTime: number | null = null;
  /** playing 事件 / currentTime 轮询测到的「伴奏起播」时刻（渲染时钟，秒） */
  private accompPlaySignalCtxTime: number | null = null;
  /** 任一信号到达时的墙钟快照，用于「只到一个信号」时的宽限判断 */
  private accompSignalAtMs = 0;
  /** 两个起播信号收敛后的实测间隔 G（ms）；null = 没测到，回退常量 */
  private measuredGapMs: number | null = null;
  /** 起播信号收敛协程：stopRecording 会等它（正常情况早就 resolve 了） */
  private gapWatcher: Promise<void> | null = null;
  private pollTimer: number | null = null;
  private onElementPlaying: (() => void) | null = null;
  private lastStats: CaptureStats | null = null;
  private captureSettings: MicCaptureSettings = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: null,
    sampleRate: null,
    deviceId: null,
  };

  private accompVolume = 0.9;
  private micMonitorVolume = 0.65;
  private micMonitorEnabled = true;

  constructor(element: HTMLMediaElement) {
    this.element = element;
    this.context = getAudioContext();
    this.accompSource = mediaSourceFor(this.context, element);

    this.accompGain = this.context.createGain();
    this.micMonitorGain = this.context.createGain();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.levelData = new Float32Array(this.analyser.fftSize);

    this.captureSink = this.context.createGain();
    this.captureSink.gain.value = 0;

    this.accompSource.connect(this.accompGain).connect(this.context.destination);
    this.analyser.connect(this.micMonitorGain).connect(this.context.destination);
    this.captureSink.connect(this.context.destination);

    this.applyVolumes();
  }

  get isRecording(): boolean {
    return this.recording;
  }

  private applyVolumes(): void {
    this.accompGain.gain.value = this.accompVolume;
    this.micMonitorGain.gain.value = this.micMonitorEnabled ? this.micMonitorVolume : 0;
  }

  async resume(): Promise<void> {
    if (this.context.state === 'suspended') await this.context.resume();
  }

  /** 建好 AudioWorklet 录音链路（需要用户手势之前调用也没关系） */
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

    // 起播探测器：从 MediaElementSource 直接抽头（伴奏音量 gain 之前），
    // 音量拉到 0 也能测；同样挂到 0 增益 sink 上保证被 destination 拉动
    this.onsetNode = new AudioWorkletNode(this.context, 'accomp-onset', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    this.onsetNode.port.onmessage = (
      event: MessageEvent<{ accompOnsetTime?: number } | unknown>,
    ) => {
      const data = event.data;
      if (
        data &&
        typeof data === 'object' &&
        'accompOnsetTime' in data &&
        typeof (data as { accompOnsetTime: unknown }).accompOnsetTime === 'number'
      ) {
        this.accompOnsetCtxTime = (data as { accompOnsetTime: number }).accompOnsetTime;
        this.accompSignalAtMs = performance.now();
      }
    };
    this.accompSource.connect(this.onsetNode);
    this.onsetNode.connect(this.captureSink);
  }

  /**
   * 授权并接入指定麦克风。
   *
   * 这里**必须关掉浏览器自带的音频处理** —— 这是「录音断断续续」的主因：
   *
   *  · echoCancellation（AEC）是给语音通话做的。我们把人声直接送进了耳机（耳返），
   *    AEC 会把这路监听当成“回声”去自适应抵消，于是人声被自己的监听掐掉，
   *    听起来就是一段一段的。
   *  · noiseSuppression 用谱减法把持续成分当噪声削掉。唱歌的长音、伴奏残留
   *    正好符合“持续噪声”的特征，会被整段衰减（实测一个恒定正弦波被削掉 18dB）。
   *  · voiceIsolation（新版 Chrome）同类，也会动音色。
   *
   * 系统自带录音机不做这些处理，所以它录出来是正常的。
   * 代价是不再自动防啸叫 —— 所以演唱页明确要求戴耳机。
   */
  async setMicDevice(deviceId: string | null): Promise<void> {
    await this.init();
    const audio: MusicTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      voiceIsolation: false,
      channelCount: 1,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };

    const stream = await navigator.mediaDevices.getUserMedia({ audio });

    this.teardownMic();
    this.micStream = stream;
    this.micSource = this.context.createMediaStreamSource(stream);
    this.micSource.connect(this.analyser);
    if (this.captureNode) this.micSource.connect(this.captureNode);

    // 有些设备/驱动会无视上面的请求硬开着处理，这里读回来确认一下
    const settings = stream.getAudioTracks()[0]?.getSettings() ?? {};
    this.captureSettings = {
      echoCancellation: Boolean(settings.echoCancellation),
      noiseSuppression: Boolean(settings.noiseSuppression),
      autoGainControl: Boolean(settings.autoGainControl),
      channelCount: settings.channelCount ?? null,
      sampleRate: settings.sampleRate ?? null,
      deviceId: settings.deviceId ?? null,
    };
    if (this.captureSettings.echoCancellation || this.captureSettings.noiseSuppression) {
      log.warn(
        'mic',
        '浏览器仍然对该麦克风启用了音频处理，录音音质可能受损：',
        this.captureSettings,
      );
    }
  }

  private teardownMic(): void {
    this.micSource?.disconnect();
    this.micSource = null;
    for (const track of this.micStream?.getTracks() ?? []) track.stop();
    this.micStream = null;
  }

  setAccompVolume(value: number): void {
    this.accompVolume = Math.max(0, Math.min(1.5, value));
    this.applyVolumes();
  }

  setMicMonitorVolume(value: number): void {
    this.micMonitorVolume = Math.max(0, Math.min(1.5, value));
    this.applyVolumes();
  }

  setMicMonitorEnabled(enabled: boolean): void {
    this.micMonitorEnabled = enabled;
    this.applyVolumes();
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
   * 干声 WAV 的 t=0 = 此刻（captureStartCtxTime）。伴奏真正开始渲染的时刻
   * 由 onset worklet / playing 事件在**同一个渲染时钟**下测得，两者之差就是
   * 服务端要的自动对齐间隔 G —— 混音时人声提前 G 才能贴到伴奏时间轴上
   * （推导见 shared/mix.ts）。不阻塞录音：信号收敛协程后台跑，stopRecording 再收。
   */
  async startRecording(): Promise<void> {
    if (!this.micSource) throw new Error('还没有可用的麦克风');
    await this.init();
    await this.resume();

    this.chunks = [];
    this.accepting = true;
    this.recording = true;
    this.measuredGapMs = null;
    this.accompOnsetCtxTime = null;
    this.accompPlaySignalCtxTime = null;
    this.accompSignalAtMs = 0;
    // 与 accepting=true 背靠背记：干声第一个样本就落在这一刻（误差 ≤ 一个渲染量子）
    this.captureStartCtxTime = this.context.currentTime;

    await sleep(PREROLL_MS);
    if (!this.recording) return;

    this.element.currentTime = 0;
    // 先武装探测器再 play()：seek 期间 Chrome 对 MediaElementSource 喂静音，
    // 不会误触；真有异常也有 playing 事件兜底（见 computeGapMs）
    this.onsetNode?.port.postMessage('record:begin');
    this.armAccompStartWatcher();
    try {
      await this.element.play();
    } catch (error) {
      this.recording = false;
      this.accepting = false;
      this.disarmAccompStartWatcher();
      throw new Error(
        `伴奏播放被浏览器拦住了：${errorMessage(error)}`,
      );
    }
  }

  /* ----------------------------- 起播信号收敛 ----------------------------- */

  private armAccompStartWatcher(): void {
    const markPlaySignal = () => {
      if (this.accompPlaySignalCtxTime === null) {
        this.accompPlaySignalCtxTime = this.context.currentTime;
        this.accompSignalAtMs = performance.now();
      }
    };
    this.onElementPlaying = markPlaySignal;
    this.element.addEventListener('playing', this.onElementPlaying);
    // playing 事件之外的双保险：个别浏览器/驱动事件不可靠时靠轮询 currentTime
    this.pollTimer = window.setInterval(() => {
      if (this.accompPlaySignalCtxTime === null && this.element.currentTime > 0) {
        markPlaySignal();
      }
    }, ACCOMP_POLL_MS);
    this.gapWatcher = this.resolveAccompStart();
  }

  private disarmAccompStartWatcher(): void {
    if (this.onElementPlaying) {
      this.element.removeEventListener('playing', this.onElementPlaying);
      this.onElementPlaying = null;
    }
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * 等两个起播信号到齐（或超时），收敛出实测间隔 G。
   * 播放中信号其实几十毫秒内就到齐，stopRecording 基本不用等。
   */
  private async resolveAccompStart(): Promise<void> {
    try {
      const deadline = performance.now() + ACCOMP_START_TIMEOUT_SEC * 1000;
      while (performance.now() < deadline) {
        const hasOnset = this.accompOnsetCtxTime !== null;
        const hasPlay = this.accompPlaySignalCtxTime !== null;
        // 两个都到 → 精确值有了
        if (hasOnset && hasPlay) break;
        // 只到一个（伴奏开头是长静音 → onset 迟；个别浏览器 playing 不触发 →
        // 只剩 onset）：宽限一点就认现有信号，不让 stopRecording 干等 2.5s
        if (
          (hasOnset || hasPlay) &&
          performance.now() - this.accompSignalAtMs > ACCOMP_START_GRACE_SEC * 1000
        ) {
          break;
        }
        await sleep(25);
      }
    } finally {
      this.disarmAccompStartWatcher();
      this.measuredGapMs = this.computeGapMs();
    }
  }

  /** 渲染时钟下把两个信号折算成「起录 → 伴奏起播」的毫秒间隔；没测到返回 null */
  private computeGapMs(): number | null {
    const clamp = (ms: number) => Math.max(0, Math.min(MAX_MEASURED_GAP_MS, ms));
    const base = this.captureStartCtxTime;
    const onsetMs =
      this.accompOnsetCtxTime === null ? null : (this.accompOnsetCtxTime - base) * 1000;
    const playMs =
      this.accompPlaySignalCtxTime === null ? null : (this.accompPlaySignalCtxTime - base) * 1000;

    if (onsetMs === null && playMs === null) return null;
    if (onsetMs === null) return clamp(playMs!);
    if (playMs === null) return clamp(onsetMs);

    const drift = onsetMs - playMs;
    if (drift > 250 || drift < -250) {
      // 伴奏开头是长静音（onset 远晚于 playing）或 seek 期间喂了脏数据
      // （onset 远早于 playing）：两种情况都认 playing —— 它标的是真实起播
      log.warn('record', `起播信号偏差 ${drift.toFixed(0)}ms，采用 playing 事件值`, {
        onsetMs: Math.round(onsetMs),
        playMs: Math.round(playMs),
      });
      return clamp(playMs);
    }
    return clamp(onsetMs);
  }

  /** 结束录音，返回可以直接上传的 WAV */
  async stopRecording(): Promise<RecordResult> {
    if (!this.recording) throw new Error('当前没有在录音');

    this.element.pause();
    this.lastStats = null;
    this.captureNode?.port.postMessage('flush');
    await sleep(FLUSH_WAIT_MS);

    this.recording = false;
    this.accepting = false;

    // 等起播信号收敛：正常情况几十毫秒前就完成了，这里几乎不耗时
    if (this.gapWatcher) {
      await this.gapWatcher;
      this.gapWatcher = null;
    }
    const gapMs = this.measuredGapMs;
    if (gapMs === null) {
      log.warn('record', '没测到伴奏起播时刻，自动对齐回退到预备静音常量', {
        prerollMs: PREROLL_MS,
      });
    }

    const sampleRate = this.context.sampleRate;
    // captureNode 用 channelCount: 1 显式下混，worklet 也只取 inputs[0][0]，
    // 所以这里拿到的必然是单声道，不需要再做下混
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
      autoOffsetMs: Math.round(gapMs ?? PREROLL_MS),
      sampleRate,
      droppedRatio,
      captureSettings: this.captureSettings,
    };
  }

  /** 中途放弃录音（比如用户点了取消） */
  cancelRecording(): void {
    this.element.pause();
    this.recording = false;
    this.accepting = false;
    this.chunks = [];
    this.measuredGapMs = null;
    this.gapWatcher = null;
    this.disarmAccompStartWatcher();
  }

  dispose(): void {
    this.recording = false;
    this.accepting = false;
    this.chunks = [];
    this.gapWatcher = null;
    this.disarmAccompStartWatcher();
    this.element.pause();

    this.teardownMic();

    if (this.captureNode) {
      this.captureNode.port.onmessage = null;
      this.captureNode.disconnect();
      this.captureNode = null;
    }
    if (this.onsetNode) {
      this.onsetNode.port.onmessage = null;
      this.onsetNode.disconnect();
      this.onsetNode = null;
    }

    // accompSource 是从 WeakMap 里拿的缓存节点，只断开、不销毁，下次还能复用
    this.accompSource.disconnect();
    this.accompGain.disconnect();
    this.analyser.disconnect();
    this.micMonitorGain.disconnect();
    this.captureSink.disconnect();
  }
}

/** 列出可用的音频输入设备（需要先拿到一次麦克风权限，label 才有内容） */
export async function listMicDevices(): Promise<MicDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `麦克风 ${index + 1}`,
    }));
}

export function isMicSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof AudioWorkletNode !== 'undefined'
  );
}
