import { concatFloat32, downmixToMono, encodeWavBlob } from '../../../shared/wav';
import { log } from '../log';

/**
 * KTV 音频引擎。
 *
 * 音频图：
 *
 *   <video>/<audio> ──MediaElementSource──> accompGain ─────────────┐
 *                                                                  ├──> destination
 *   MediaStreamSource ──> analyser ──> micMonitorGain ─────────────┘
 *                    │
 *                    └──> AudioWorklet(pcm-capture) ──> captureSink(0) ──> destination
 *
 * 三个关键设计：
 *  1. 录音只采麦克风干声，耳返混音绝不进录音文件 —— 这是服务端能重新混音的前提。
 *  2. captureSink 是个 0 增益节点，纯粹为了让 Worklet 处于「被 destination 拉动」的
 *     路径上。没有它，浏览器可能根本不调用 process()。
 *  3. 全 App 共用一个 AudioContext，且用 WeakMap 缓存 MediaElementSource：
 *     createMediaElementSource 对同一个元素只能调一次，React 严格模式的重复挂载
 *     会直接把它踩爆。
 */

const WORKLET_URL = '/pcm-worklet.js';
/** 先开录再放伴奏，保证 offset 恒为正数，服务端 adelay 才好处理 */
const PREROLL_MS = 150;
/** 停止后留给 worklet flush 尾巴的时间 */
const FLUSH_WAIT_MS = 80;

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
    workletModulePromise = context.audioWorklet.addModule(WORKLET_URL).catch((error: unknown) => {
      // 允许下次重试，避免一次失败就把整个会话卡死
      workletModulePromise = null;
      throw new Error(`录音模块加载失败：${error instanceof Error ? error.message : String(error)}`);
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

  private chunks: Float32Array[] = [];
  /** 用户视角的「正在录音」 */
  private recording = false;
  /** 是否还在接收 PCM 分片（停止后的 flush 尾巴也要收） */
  private accepting = false;
  private recordStartMs = 0;
  private measuredOffsetMs = 0;
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

  get hasMic(): boolean {
    return this.micSource !== null;
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
   * 返回时 measuredOffsetMs 已经记录了「录音起点 → 伴奏时间轴 0」的偏移。
   */
  async startRecording(): Promise<void> {
    if (!this.micSource) throw new Error('还没有可用的麦克风');
    await this.init();
    await this.resume();

    this.chunks = [];
    this.accepting = true;
    this.recording = true;
    this.measuredOffsetMs = 0;
    this.recordStartMs = performance.now();

    await sleep(PREROLL_MS);
    if (!this.recording) return;

    this.element.currentTime = 0;
    try {
      await this.element.play();
    } catch (error) {
      this.recording = false;
      this.accepting = false;
      throw new Error(
        `伴奏播放被浏览器拦住了：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.measuredOffsetMs = performance.now() - this.recordStartMs;
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

    const sampleRate = this.context.sampleRate;
    const merged = concatFloat32(this.chunks);
    this.chunks = [];
    const mono = downmixToMono([merged]);

    const stats = this.lastStats as CaptureStats | null;
    const droppedRatio =
      stats && stats.frames > 0
        ? (stats.missingQuanta * stats.renderQuantum) / stats.frames
        : 0;

    return {
      blob: encodeWavBlob(mono, sampleRate),
      durationSec: mono.length / sampleRate,
      autoOffsetMs: Math.round(this.measuredOffsetMs),
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
  }

  pause(): void {
    this.element.pause();
  }

  dispose(): void {
    this.recording = false;
    this.accepting = false;
    this.chunks = [];
    this.element.pause();

    this.teardownMic();

    if (this.captureNode) {
      this.captureNode.port.onmessage = null;
      this.captureNode.disconnect();
      this.captureNode = null;
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
