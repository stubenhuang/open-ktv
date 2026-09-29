/**
 * 前后端共享的混音数学（纯函数，无 IO、无浏览器/Node 依赖）。
 *
 * 服务端用它们构造 ffmpeg 滤波器，前端实时预览用它们复算电平和偏移 ——
 * 两边必须用同一套公式，预览才能和成品 MP3 对齐。
 */

import type {
  MixParams,
  PreviewParams,
  ReverbKind,
  VocalPreset,
  WorkLevels,
} from './types.ts';

/** 对齐偏移的绝对上限（ms）：用户微调 − 自动间隔后夹到 ±MAX_OFFSET_MS */
export const MAX_OFFSET_MS = 30_000;

/**
 * 对齐偏移的合成（服务端 ffmpeg 与前端预览共用同一套公式）。
 *
 * 语义：offsetMs 是**人声相对混音时间轴的延迟**，正数 = 人声更晚，
 * 负数 = 人声更早（即人声要抢在伴奏前面）。
 *
 * autoOffsetMs 恒为正数：录音时「起录 → 伴奏真正起播」测得的间隔 G
 * （含 150ms 预备静音 + 浏览器 seek/解码/调度延迟，渲染时钟测得）。
 * 干声 WAV 的 t=0 是起录时刻，歌手是对着起播后的伴奏唱的，
 * 所以干声第一拍落在 WAV 时间 ≈ G —— 要把它搬回混音的 0 点，
 * 必须**提前** G，即 offset = −G。用户微调在此基础上叠加：
 *
 *     effective = userOffsetMs − autoOffsetMs
 *
 * 因此负偏移是正常用法（拖拍时往回拖），钳制范围是 ±MAX_OFFSET_MS，
 * 不再钳到 0 —— 钳到 0 会让人声至少晚 G，用户永远修不好拖拍。
 */
export function effectiveOffsetMs(autoOffsetMs: number, userOffsetMs: number): number {
  const gap = Number.isFinite(autoOffsetMs) ? autoOffsetMs : 0;
  const user = Number.isFinite(userOffsetMs) ? userOffsetMs : 0;
  return Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, Math.round(user - gap)));
}

/**
 * 有符号偏移落实到两轨的延迟（毫秒）。
 *
 * ffmpeg 没有负的 adelay，所以「谁早到就延后谁」：
 *  - offset ≥ 0：延后人声（干声分支 adelay=offset）；
 *  - offset < 0：延后伴奏（伴奏分支 adelay=−offset）。
 *
 * 等价于把干声提前 |offset| —— 干声开头那段预备静音正好被吃掉。
 */
export function mixTimeline(offsetMs: number): { vocalDelayMs: number; accompDelayMs: number } {
  const offset = Number.isFinite(offsetMs) ? Math.round(offsetMs) : 0;
  return offset >= 0
    ? { vocalDelayMs: offset, accompDelayMs: 0 }
    : { vocalDelayMs: 0, accompDelayMs: -offset };
}

/** dB → 线性增益 */
export function dbToLinear(db: number): number {
  if (!Number.isFinite(db)) return 1;
  return Math.pow(10, db / 20);
}

/**
 * 单条轨最终乘上的线性增益：实测归一化增益（dB）× 用户滑块，夹在 0–4。
 *
 * 服务端 computeLevels 与前端 previewLinearGains 都走这一个函数 ——
 * 两边公式一旦分叉，实时试听的绝对电平和成品 MP3 就对不上了。
 */
export function linearGain(userGain: number, levelDb: number): number {
  const linear = dbToLinear(levelDb) * userGain;
  return Number.isFinite(linear) ? Math.max(0, Math.min(4, linear)) : 1;
}

/**
 * 实时预览的总时长（秒）。
 *
 * 服务端 amix 用 duration=first 且人声分支在第一路，成品长度 = 干声时长 +
 * max(0, 对齐偏移)（负偏移延后的是伴奏，人声没被推后，长度不增加）。
 * 预览必须跟着这个口径走，否则「播完自动停」的时机和成品不一样；
 * 服务端估 ffmpeg 进度（mixJob 的 totalDurationSec）用的也是它。
 */
export function previewDurationSec(vocalDurationSec: number, offsetMs: number): number {
  const vocal = Number.isFinite(vocalDurationSec) && vocalDurationSec > 0 ? vocalDurationSec : 0;
  const offset = Number.isFinite(offsetMs) && offsetMs > 0 ? offsetMs : 0;
  return vocal + offset / 1000;
}

/**
 * 把面板参数 + 自动间隔 + 实测增益合成预览引擎的输入。
 *
 * 偏移公式与服务端一致：用户微调 − 自动间隔（见 effectiveOffsetMs 的符号说明）。
 * 增益公式与服务端 computeLevels 一致：实测归一化增益 × 用户滑块。
 * levels 为 null（老作品，没落过库）时按 0dB 基准 —— 相对调节仍准确，
 * 绝对电平和成品可能有偏差，合成一次后即一致。
 */
export function toPreviewParams(
  params: Pick<
    MixParams,
    | 'vocalGain'
    | 'accompGain'
    | 'reverb'
    | 'userOffsetMs'
    | 'pitchSemitones'
    | 'accompSemitones'
    | 'eqLowDb'
    | 'eqMidDb'
    | 'eqHighDb'
    | 'compression'
    | 'deEss'
    | 'noiseReduction'
  >,
  autoOffsetMs: number,
  levels: WorkLevels | null,
): PreviewParams {
  return {
    vocalGain: params.vocalGain,
    accompGain: params.accompGain,
    reverb: params.reverb,
    offsetMs: effectiveOffsetMs(autoOffsetMs, params.userOffsetMs),
    levels,
    pitchSemitones: params.pitchSemitones,
    accompSemitones: params.accompSemitones,
    eqLowDb: params.eqLowDb,
    eqMidDb: params.eqMidDb,
    eqHighDb: params.eqHighDb,
    compression: params.compression,
    deEss: params.deEss,
    noiseReduction: params.noiseReduction,
  };
}

/** 预览引擎复算出的两轨线性增益（与服务端 computeLevels 同公式） */
export function previewLinearGains(
  params: Pick<MixParams, 'vocalGain' | 'accompGain' | 'compression'>,
  levels: WorkLevels | null,
): { vocalLinear: number; accompLinear: number } {
  return {
    // 人声多了压缩补偿这一项；伴奏没有压缩链路
    vocalLinear: vocalChainLinearGain(params.vocalGain, levels?.vocalGainDb ?? 0, params.compression),
    accompLinear: linearGain(params.accompGain, levels?.accompGainDb ?? 0),
  };
}

/* ----------------------------- 修音与音效链 ----------------------------- */

/**
 * 均衡三段：频率与类型在前后端**必须**一致。
 * 服务端用 ffmpeg 的 equalizer（t=q 为 peaking，另有 lowshelf/highshelf），
 * 预览用 BiquadFilterNode 的 lowshelf / peaking / highshelf —— 同名同型，一一对应。
 */
export const EQ_BANDS = {
  low: { frequency: 200, q: 1 },
  mid: { frequency: 1200, q: 1 },
  high: { frequency: 4000, q: 1 },
} as const;

/** 半音数 → 频率比；升降调用它（±12 半音 = 一个八度） */
export function semitonesToRatio(semitones: number): number {
  const value = Number.isFinite(semitones) ? semitones : 0;
  return Math.pow(2, value / 12);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** 均衡三段是否全为 0（全 0 就不必挂滤镜） */
export function eqIsNeutral(low: number, mid: number, high: number): boolean {
  const isZero = (value: number) => !Number.isFinite(value) || Math.abs(value) < 0.01;
  return isZero(low) && isZero(mid) && isZero(high);
}

export interface CompressorParams {
  thresholdDb: number;
  ratio: number;
  /** 补偿被压掉的静态电平（dB）；会并进人声线性增益 */
  makeupDb: number;
  enabled: boolean;
}

/**
 * 压缩量 0..1 → 压缩器参数。
 *
 * makeup **不**用 ffmpeg 的 `makeup` 选项，而是并进人声的 volume：
 * Web Audio 的 DynamicsCompressorNode 没有 makeupGain，预览得自己补一个增益节点；
 * 把补偿统一收进「人声线性增益」这一处（vocalChainLinearGain），
 * 前后端就只剩一套公式，不会出现「试听响、成品轻」。
 */
export function compressorParams(amount: number): CompressorParams {
  const a = clamp01(amount);
  if (a <= 0) return { thresholdDb: 0, ratio: 1, makeupDb: 0, enabled: false };
  return {
    thresholdDb: -12 - 12 * a,
    ratio: 1 + 5 * a,
    makeupDb: 1 + 5 * a,
    enabled: true,
  };
}

/**
 * 去齿音强度 → **预览用**的高频下压量（dB，负值）。
 *
 * 服务端用的是真正的 deesser（动态、按齿音检测动作），预览没有对应节点，
 * 只能用静态高架下压做听感近似 —— 这是已知偏差，和「卷积混响近似 aecho」
 * 属同一类取舍。
 */
export function deEssGainDb(amount: number): number {
  const a = clamp01(amount);
  return a <= 0 ? 0 : -(2 + 6 * a);
}

export function deEssEnabled(amount: number): boolean {
  return clamp01(amount) > 0;
}

/**
 * 人声链的总线性增益 = 实测归一化增益 × 用户滑块 × 压缩补偿。
 *
 * 服务端 computeLevels 与前端预览都走这一个函数 ——
 * 一旦分叉，实时试听的绝对电平和成品 MP3 就对不上了。
 */
export function vocalChainLinearGain(
  userGain: number,
  levelDb: number,
  compressionAmount: number,
): number {
  const base = linearGain(userGain, levelDb);
  const makeup = dbToLinear(compressorParams(compressionAmount).makeupDb);
  const total = base * makeup;
  return Number.isFinite(total) ? Math.max(0, Math.min(4, total)) : 1;
}

export interface VocalPresetSpec {
  eqLowDb: number;
  eqMidDb: number;
  eqHighDb: number;
  compression: number;
  deEss: number;
  reverb: ReverbKind;
}

/**
 * 预设 = 一组具名默认值，不是不透明滤镜串。
 *
 * 点了预设就等于把这里的数字写进 MixParams 的对应字段，之后用户还能继续手调。
 * 好处是预览与服务端天然同构（它们只看数值），也省掉「预设和滑块谁说了算」
 * 这类必然扯不清的推导。
 */
export const VOCAL_PRESET_SPECS: Record<VocalPreset, VocalPresetSpec> = {
  natural: { eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, compression: 0, deEss: 0, reverb: 'room' },
  warm: { eqLowDb: 3, eqMidDb: 0.5, eqHighDb: -1.5, compression: 0.25, deEss: 0, reverb: 'room' },
  bright: { eqLowDb: -1.5, eqMidDb: 1, eqHighDb: 4, compression: 0.15, deEss: 0.2, reverb: 'room' },
  magnetic: { eqLowDb: 2, eqMidDb: 3, eqHighDb: -2, compression: 0.45, deEss: 0.15, reverb: 'hall' },
  ethereal: { eqLowDb: -2, eqMidDb: -1, eqHighDb: 3, compression: 0.2, deEss: 0.3, reverb: 'stage' },
  powerful: { eqLowDb: 1, eqMidDb: 1.5, eqHighDb: 3.5, compression: 0.6, deEss: 0.1, reverb: 'room' },
};

/** 预设对应的那部分参数（UI 点预设时写进 MixParams） */
export function presetParams(preset: VocalPreset): VocalPresetSpec {
  return VOCAL_PRESET_SPECS[preset] ?? VOCAL_PRESET_SPECS.natural;
}

/**
 * 当前参数落在哪个预设上；都不匹配返回 null。
 *
 * UI 用它决定哪个预设按钮高亮 —— 与其记住「最后点了哪个」，不如
 * 按实际数值反推，这样手调过之后高亮会自动消失，不会骗人。
 */
export function matchPreset(
  params: Pick<MixParams, 'eqLowDb' | 'eqMidDb' | 'eqHighDb' | 'compression' | 'deEss' | 'reverb'>,
): VocalPreset | null {
  const close = (a: number, b: number) => Math.abs((Number(a) || 0) - b) < 0.01;
  for (const [preset, spec] of Object.entries(VOCAL_PRESET_SPECS) as [
    VocalPreset,
    VocalPresetSpec,
  ][]) {
    if (
      close(params.eqLowDb, spec.eqLowDb) &&
      close(params.eqMidDb, spec.eqMidDb) &&
      close(params.eqHighDb, spec.eqHighDb) &&
      close(params.compression, spec.compression) &&
      close(params.deEss, spec.deEss) &&
      params.reverb === spec.reverb
    ) {
      return preset;
    }
  }
  return null;
}

/**
 * 是否需要跑一次「人声预处理 pass」。
 *
 * 判据是「有没有用到带内部延迟的人声处理」：rubberband（相位声码器）、
 * acompressor（前瞻）、deesser、afftdn 都有延迟，挂在混音图里会破坏
 * 这个项目最值钱的对齐语义，所以它们统统走独立的预处理 pass，
 * 现有 mixTimeline 的计算一个字都不用改。
 *
 * 全中性 → 不跑 pass，直接拿原始干声混音，与改动前完全一致（零回归）。
 */
export function needsVocalPreProcess(
  params: Pick<MixParams, 'pitchSemitones' | 'compression' | 'deEss' | 'noiseReduction'>,
): boolean {
  return (
    Math.round(Number(params.pitchSemitones) || 0) !== 0 ||
    clamp01(params.compression) > 0 ||
    clamp01(params.deEss) > 0 ||
    params.noiseReduction === true
  );
}

/** 伴奏是否需要预处理（只有升降调会动它） */
export function needsAccompPreProcess(
  params: Pick<MixParams, 'accompSemitones'>,
): boolean {
  return Math.round(Number(params.accompSemitones) || 0) !== 0;
}

/**
 * 实时预览的混响参数。
 *
 * 服务端用 aecho（延迟回声，见 server/src/mix.ts 的 REVERB_FILTER），
 * Web Audio 里没有对应滤镜，这里用「程序生成的指数衰减噪声 IR + ConvolverNode」
 * 做听感近似：四档的尾巴长度/前延迟/湿度拉开差距，切换时差异清晰可辨。
 * 预览只为试听，最终音色以下载的成品 MP3 为准。
 *
 * dry 为 null = 旁通混响。
 */
export const REVERB_PREVIEW: Record<
  ReverbKind,
  { seconds: number; preDelayMs: number; decay: number; wet: number } | null
> = {
  dry: null,
  room: { seconds: 0.35, preDelayMs: 10, decay: 2.6, wet: 0.35 },
  hall: { seconds: 1.3, preDelayMs: 25, decay: 2.0, wet: 0.45 },
  stage: { seconds: 2.6, preDelayMs: 45, decay: 1.6, wet: 0.55 },
};
