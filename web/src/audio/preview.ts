import type { MixParams, PreviewParams, ReverbKind, WorkLevels } from '../../../shared/types';
import {
  REVERB_PREVIEW,
  mixTimeline,
  previewDurationSec,
  previewLinearGains,
  toPreviewParams,
} from '../../../shared/mix';
import { getAudioContext } from './engine';
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
 *   vocalBufferSource ──> vocalGain ──> highpass(80Hz) ──┬── dryGain ──────────┐
 *                                                        └──> convolver ──> wetGain ─┤
 *   accompBufferSource ──> accompGain ──────────────────────────────────────────────┼──> limiter ──> destination
 *
 *  - highpass=80Hz：和服务端一致，砍掉隆隆低频；
 *  - vocalGain/accompGain：实测归一化增益 × 用户滑块（shared/mix.ts 的公式）；
 *  - convolver：程序生成的指数衰减噪声 IR，对服务端 aecho 四档混响的听感近似；
 *  - limiter：DynamicsCompressor，近似服务端末端 alimiter=0.95，防预览削波；
 *  - 对齐偏移不用 DelayNode（改 delayTime 会有爆音），改用「晚到的一轨晚起播」
 *    的调度方式（与服务端 mixTimeline 同一套符号规则：offset ≥ 0 人声晚进，
 *    offset < 0 伴奏晚进）；偏移变化时按当前位置重排两轨。
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

type ReverbKindWithReverb = Exclude<ReverbKind, 'dry'>;

export interface PreviewEngineOptions {
  vocalUrl: string;
  accompUrl: string;
}

async function fetchDecode(url: string, label: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label}加载失败（HTTP ${response.status}）`);
  }
  const bytes = await response.arrayBuffer();
  // decodeAudioData 基于回调的老形态在 Safari 上才需要，Chrome/Edge 直接返回 Promise
  return getAudioContext().decodeAudioData(bytes);
}

/** 程序生成混响 IR：前延迟静音 + 指数衰减噪声，立体声不相关 */
function createImpulseResponse(kind: ReverbKindWithReverb): AudioBuffer {
  const context = getAudioContext();
  const spec = REVERB_PREVIEW[kind]!;
  const rate = context.sampleRate;
  const length = Math.max(1, Math.floor(rate * spec.seconds));
  const preDelay = Math.floor((rate * spec.preDelayMs) / 1000);
  const buffer = context.createBuffer(2, length, rate);

  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = preDelay; i < length; i += 1) {
      const t = (i - preDelay) / Math.max(1, length - preDelay);
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, spec.decay);
    }
  }
  return buffer;
}

export class PreviewEngine {
  private readonly context: AudioContext;
  private readonly vocalBuffer: AudioBuffer;
  private readonly accompBuffer: AudioBuffer;

  private readonly vocalGain: GainNode;
  private readonly accompGain: GainNode;
  private readonly highpass: BiquadFilterNode;
  private readonly dryGain: GainNode;
  private readonly wetGain: GainNode;
  private readonly convolver: ConvolverNode;
  private readonly limiter: DynamicsCompressorNode;

  private readonly impulseCache = new Map<ReverbKindWithReverb, AudioBuffer>();

  private vocalSource: AudioBufferSourceNode | null = null;
  private accompSource: AudioBufferSourceNode | null = null;

  private params: PreviewParams = {
    vocalGain: 1,
    accompGain: 1,
    reverb: 'room',
    offsetMs: 0,
    levels: null,
  };

  /** 播放时：本次起播的 context 时间；暂停时：null */
  private passStartCtxTime: number | null = null;
  /** 起播时所在的混音时间轴位置（秒） */
  private startPositionSec = 0;
  /** 自然播完 vs 手动停止：onended 两种都会触发，靠这个区分 */
  private stopping = false;
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

    this.dryGain = this.context.createGain();
    this.wetGain = this.context.createGain();
    this.convolver = this.context.createConvolver();
    this.convolver.normalize = true;

    this.limiter = this.context.createDynamicsCompressor();
    // 近似服务端 alimiter=limit=0.95：只兜削峰，不改变整体动态
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    // 人声链：gain → 高通 → 干/湿双路
    this.vocalGain.connect(this.highpass);
    this.highpass.connect(this.dryGain);
    this.highpass.connect(this.convolver);
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
    const [vocalBuffer, accompBuffer] = await Promise.all([
      fetchDecode(options.vocalUrl, '干声').catch((error: unknown) => {
        throw new Error(`干声解码失败：${errorMessage(error)}`);
      }),
      fetchDecode(options.accompUrl, '伴奏').catch((error: unknown) => {
        throw new Error(`伴奏解码失败：${errorMessage(error)}`);
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

    const reverb = this.params.reverb;
    if (reverb !== 'dry') {
      const spec = REVERB_PREVIEW[reverb]!;
      if (this.convolver.buffer !== this.impulseFor(reverb)) {
        this.convolver.buffer = this.impulseFor(reverb);
      }
      this.wetGain.gain.setTargetAtTime(spec.wet, now, GAIN_SMOOTHING);
      this.dryGain.gain.setTargetAtTime(1 - spec.wet * 0.5, now, GAIN_SMOOTHING);
    } else {
      this.wetGain.gain.setTargetAtTime(0, now, GAIN_SMOOTHING);
      this.dryGain.gain.setTargetAtTime(1, now, GAIN_SMOOTHING);
    }
  }

  private impulseFor(kind: ReverbKindWithReverb): AudioBuffer {
    const cached = this.impulseCache.get(kind);
    if (cached) return cached;
    const created = createImpulseResponse(kind);
    this.impulseCache.set(kind, created);
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

    const vocalSource = this.context.createBufferSource();
    vocalSource.buffer = this.vocalBuffer;
    vocalSource.connect(this.vocalGain);
    this.stopping = false;
    vocalSource.onended = () => this.handleVocalEnded();
    vocalSource.start(
      now + Math.max(0, vocalEnterSec - positionSec),
      Math.min(Math.max(0, positionSec - vocalEnterSec), this.vocalBuffer.duration),
    );
    this.vocalSource = vocalSource;
  }

  private stopSources(): void {
    this.stopping = true;
    this.accompSource?.disconnect();
    this.accompSource?.stop();
    this.accompSource = null;
    this.vocalSource?.disconnect();
    this.vocalSource?.stop();
    this.vocalSource = null;
    this.passStartCtxTime = null;
  }

  /** 干声播完 = 成品播完（duration=first）：整体停下并通知 UI */
  private handleVocalEnded(): void {
    if (this.stopping) return;
    this.startPositionSec = this.durationSec;
    this.stopSources();
    this.onEnded?.();
  }
}
