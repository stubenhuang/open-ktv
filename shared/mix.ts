/**
 * 前后端共享的混音数学（纯函数，无 IO、无浏览器/Node 依赖）。
 *
 * 服务端用它们构造 ffmpeg 滤波器，前端实时预览用它们复算电平和偏移 ——
 * 两边必须用同一套公式，预览才能和成品 MP3 对齐。
 */

import type {
  MixParams,
  PreviewParams,
  ReverbAnchor,
  ReverbKind,
  VocalPreset,
  WorkLevels,
} from './types.ts';
import { REVERB_ANCHORS, REVERB_LABELS } from './types.ts';

/** 对齐偏移的绝对上限（ms）：用户微调 − 自动间隔后夹到 ±MAX_OFFSET_MS */
export const MAX_OFFSET_MS = 30_000;

/**
 * 实测起播间隔的钳制上限（ms）。
 *
 * 录音时「起录 → 伴奏真正起播」的间隔是量出来的，而测量手段（渲染时钟上的
 * onset 探测器、墙钟上的 playing 事件 / currentTime 轮询）都可能给出异常值：
 * 伴奏开头长静音、seek 期间喂脏数据、设备抽风。超过 10 秒的间隔一律不采信
 * —— 那种成品已经没法听了，按上限截断至少不会更糟。
 */
export const MAX_MEASURED_GAP_MS = 10_000;

/**
 * 把「起录 / 伴奏起播」两个时刻折算成自动对齐间隔 G（ms，恒为正）。
 *
 * 两端录音引擎共用这一道收敛：
 *  · 桌面引擎（web/src/audio/engine.ts）在**渲染时钟**上量，本函数只做钳制；
 *  · 手机引擎（web/src/audio/mobileEngine.ts）在**墙钟**上量（媒体元素不进
 *    Web Audio，见那里的说明），收敛逻辑一模一样，所以也走这里。
 *
 * 为什么要钳到 [0, 上限]：负值意味着「伴奏比人声先开始」，那是测量假象
 * （事件早 firing / 读到上一段残留），按 0 处理 = 人声不提前，宁可轻微拖拍
 * 也不要把人声推到伴奏前面；一个时刻都没测到就退回预备静音常量。
 *
 * @param captureStartPerf 起录时刻（t=0）
 * @param accompStartPerf 伴奏起播时刻；null = 没测到
 * @param prerollMs 兜底常量（先起录再放伴奏的那段静音，见两端引擎的 PREROLL_MS）
 */
export function resolveRecordGapMs(input: {
  captureStartPerf: number;
  accompStartPerf: number | null;
  prerollMs: number;
}): number {
  const { captureStartPerf, accompStartPerf, prerollMs } = input;
  if (accompStartPerf === null) return prerollMs;
  const gap = accompStartPerf - captureStartPerf;
  return Math.max(0, Math.min(MAX_MEASURED_GAP_MS, Math.round(gap)));
}

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
    | 'reverbSpace'
    | 'reverbWet'
    | 'userOffsetMs'
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
    reverbSpace: params.reverbSpace,
    reverbWet: params.reverbWet,
    offsetMs: effectiveOffsetMs(autoOffsetMs, params.userOffsetMs),
    levels,
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
  /** 混响空间起点（0–1，锚点位置）；用户之后还能用「空间」滑块连续微调 */
  reverbSpace: number;
  /** 混响湿度起点（0–1）；用「湿度」滑块连续微调 */
  reverbWet: number;
}

/**
 * 预设 = 一组具名默认值，不是不透明滤镜串。
 *
 * 点了预设就等于把这里的数字写进 MixParams 的对应字段，之后用户还能继续手调
 *（混响现在是「空间 + 湿度」两个连续滑块，精度远高于原来的 8 档）。
 * 好处是预览与服务端天然同构（它们只看数值），也省掉「预设和滑块谁说了算」
 * 这类必然扯不清的推导。
 *
 * 10 个预设的参数包两两不同：matchPreset 是按数值反推的，包与包一旦重了
 * 就会有两个按钮同时高亮，用户点不出区别。混响起点也因此全部错开 ——
 * 10 种预设覆盖从「小房间干声」到「体育场满湿度」的整条空间轴。
 */
export const VOCAL_PRESET_SPECS: Record<VocalPreset, VocalPresetSpec> = {
  natural: { eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, compression: 0, deEss: 0, reverbSpace: anchorSpace('room'), reverbWet: 1 },
  warm: { eqLowDb: 3, eqMidDb: 0.5, eqHighDb: -1.5, compression: 0.25, deEss: 0, reverbSpace: anchorSpace('hall'), reverbWet: 0.8 },
  bright: { eqLowDb: -1.5, eqMidDb: 1, eqHighDb: 4, compression: 0.15, deEss: 0.2, reverbSpace: anchorSpace('plate'), reverbWet: 0.7 },
  sweet: { eqLowDb: 1.5, eqMidDb: 2, eqHighDb: 2.5, compression: 0.35, deEss: 0.35, reverbSpace: anchorSpace('hall'), reverbWet: 0.95 },
  magnetic: { eqLowDb: 2, eqMidDb: 3, eqHighDb: -2, compression: 0.45, deEss: 0.15, reverbSpace: anchorSpace('stage'), reverbWet: 0.9 },
  ethereal: { eqLowDb: -2, eqMidDb: -1, eqHighDb: 3, compression: 0.2, deEss: 0.3, reverbSpace: anchorSpace('cathedral'), reverbWet: 0.85 },
  soft: { eqLowDb: 0.5, eqMidDb: -1, eqHighDb: 1, compression: 0.2, deEss: 0.25, reverbSpace: anchorSpace('plate'), reverbWet: 0.6 },
  powerful: { eqLowDb: 1, eqMidDb: 1.5, eqHighDb: 3.5, compression: 0.6, deEss: 0.1, reverbSpace: anchorSpace('arena'), reverbWet: 0.75 },
  retro: { eqLowDb: 4, eqMidDb: -1.5, eqHighDb: -3, compression: 0.3, deEss: 0, reverbSpace: anchorSpace('plate'), reverbWet: 0.75 },
  live: { eqLowDb: 1, eqMidDb: 0.5, eqHighDb: 1.5, compression: 0.5, deEss: 0.2, reverbSpace: anchorSpace('stage'), reverbWet: 1 },
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
 *
 * 连续量的容差比离散量严，而且必须**小于滑块一步能造成的最近距离**：
 * 空间锚点是 i/7（不在 0.01 栅格上），浏览器把 DOM 值吸附到栅格后，
 * 离锚点最近的栅格点也有 0.0014 的偏差 —— 容差取 0.001，拖动必掉高亮，
 * 而预设写入的原值（精确 i/7）必然命中。湿度同理（0.005 < 一步 0.01）。
 */
export function matchPreset(
  params: Pick<
    MixParams,
    | 'eqLowDb'
    | 'eqMidDb'
    | 'eqHighDb'
    | 'compression'
    | 'deEss'
    | 'reverbSpace'
    | 'reverbWet'
  >,
): VocalPreset | null {
  const close = (a: number, b: number) => Math.abs((Number(a) || 0) - b) < 0.01;
  const closeSpace = (a: number, b: number) => Math.abs((Number(a) || 0) - b) < 0.001;
  const closeWet = (a: number, b: number) => Math.abs((Number(a) || 0) - b) < 0.005;
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
      closeSpace(params.reverbSpace, spec.reverbSpace) &&
      closeWet(params.reverbWet, spec.reverbWet)
    ) {
      return preset;
    }
  }
  return null;
}

/**
 * 是否需要跑一次「人声预处理 pass」。
 *
 * 判据是「有没有用到带内部延迟的人声处理」：acompressor（前瞻）、deesser、
 * afftdn 都有延迟，挂在混音图里会破坏这个项目最值钱的对齐语义，
 * 所以它们统统走独立的预处理 pass，现有 mixTimeline 的计算一个字都不用改。
 *
 * 全中性 → 不跑 pass，直接拿原始干声混音，与改动前完全一致（零回归）。
 */
export function needsVocalPreProcess(
  params: Pick<MixParams, 'compression' | 'deEss' | 'noiseReduction'>,
): boolean {
  return (
    clamp01(params.compression) > 0 ||
    clamp01(params.deEss) > 0 ||
    params.noiseReduction === true
  );
}

/* ------------------------------ 混响：空间 × 湿度 ------------------------------ */

/**
 * 在锚点表上做分段线性插值。
 *
 * 锚点处**原样返回锚点值**（落在整数锚点坐标上时不做任何运算）—— 这是
 * 「老作品零回归」的数值基础：`reverb: 'hall'` 迁移成 (3/7, 湿度 1) 后，
 * 插值返回的就是 hall 锚点的原值，服务端滤镜串与试听 IR 和旧版逐字节一致。
 */
function lerpAnchor(pick: (anchor: ReverbAnchor) => number, space: number): number {
  const scaled = clamp01(space) * (REVERB_ANCHORS.length - 1);
  const nearest = Math.round(scaled);
  // 落在锚点上（含 3/7 这类浮点残差）：直接取锚点值
  if (Math.abs(scaled - nearest) < 1e-9) return pick(REVERB_ANCHORS[nearest]!);
  const lower = Math.min(REVERB_ANCHORS.length - 1, Math.floor(scaled));
  const upper = Math.min(REVERB_ANCHORS.length - 1, lower + 1);
  const t = scaled - lower;
  const from = pick(REVERB_ANCHORS[lower]!);
  const to = pick(REVERB_ANCHORS[upper]!);
  return from + (to - from) * t;
}

export interface ReverbDsp {
  /** 空间 0 或湿度 0：不挂滤镜（与旧 dry 同路，老作品的干声分文不差） */
  bypass: boolean;
  /** aecho 入增益（锚点值 × 湿度） */
  inGain: number;
  /** aecho 出增益（干声侧）：湿度 1 = 锚点原值，湿度 0 = 1（满干声） */
  outGain: number;
  delayMs: number;
  decay: number;
  /** 试听湿度（锚点湿度 × 用户湿度，0..1） */
  wet: number;
  /* ---- 试听 IR ---- */
  tailSec: number;
  preDelayMs: number;
  irDecay: number;
}

/**
 * 空间 + 湿度 → 全套混响参数（服务端 aecho 与前端预览共用这一份）。
 *
 * 湿度的语义是「发送量」：只缩放回声支路（inGain / wet），干声侧反向补偿
 * （outGain 从锚点值回到 1），所以湿度 0 就是干声、湿度 1 就是锚点原值，
 * 中间是平滑的交叉淡化 —— 拖湿度不会有音量台阶。
 */
export function reverbDsp(space: number, wet: number): ReverbDsp {
  const s = clamp01(Number.isFinite(space) ? space : 0);
  const w = clamp01(Number.isFinite(wet) ? wet : 0);
  const anchorOut = lerpAnchor((anchor) => anchor.outGain, s);
  return {
    bypass: s <= 0 || w <= 0,
    inGain: lerpAnchor((anchor) => anchor.inGain, s) * w,
    outGain: 1 - (1 - anchorOut) * w,
    delayMs: lerpAnchor((anchor) => anchor.delayMs, s),
    decay: lerpAnchor((anchor) => anchor.decay, s),
    wet: lerpAnchor((anchor) => anchor.wet, s) * w,
    tailSec: lerpAnchor((anchor) => anchor.tailSec, s),
    preDelayMs: lerpAnchor((anchor) => anchor.preDelayMs, s),
    irDecay: lerpAnchor((anchor) => anchor.irDecay, s),
  };
}

/** 试听 IR 规格（尾巴秒数 / 前延迟 / 衰减指数 / 该空间档的满湿度） */
export function reverbIrSpec(space: number): {
  seconds: number;
  preDelayMs: number;
  decay: number;
  wet: number;
} {
  const dsp = reverbDsp(space, 1);
  return { seconds: dsp.tailSec, preDelayMs: dsp.preDelayMs, decay: dsp.irDecay, wet: dsp.wet };
}

/**
 * aecho 滤镜字符串；旁通返回 null。
 *
 * 数字格式刻意「去掉多余的零」（0.8 而不是 0.80）：锚点处的输出必须与旧表
 * 逐字节一致，tests/mix.test.ts 对 8 个档位逐一钉死了期望串。
 */
export function reverbAechoFilter(space: number, wet: number): string | null {
  const dsp = reverbDsp(space, wet);
  if (dsp.bypass) return null;
  const fmt = (value: number) => String(Number(value.toFixed(4)));
  return `aecho=${fmt(dsp.inGain)}:${fmt(dsp.outGain)}:${fmt(dsp.delayMs)}:${fmt(dsp.decay)}`;
}

/** 档位名 → 空间轴位置（老数据迁移、预设表都走它，避免手写 i/7 走样） */
export function anchorSpace(kind: ReverbKind): number {
  return (
    REVERB_ANCHORS.find((anchor) => anchor.kind === kind)?.position ?? REVERB_ANCHORS[1]!.position
  );
}

/** 空间位置 → 最近的档位名（UI 读数 / 作品库徽章）；并列取偏小的那一档 */
export function nearestReverbKind(space: number): ReverbKind {
  const s = clamp01(Number.isFinite(space) ? space : 0);
  let best = REVERB_ANCHORS[0]!;
  for (const anchor of REVERB_ANCHORS) {
    if (Math.abs(anchor.position - s) < Math.abs(best.position - s)) best = anchor;
  }
  return best.kind;
}

/** 给人看的一行混响摘要（作品库徽章 / 服务端日志），如「大厅 65%」/「原声」 */
export function describeReverb(space: number, wet: number): string {
  const s = clamp01(Number.isFinite(space) ? space : 0);
  const w = clamp01(Number.isFinite(wet) ? wet : 0);
  if (s <= 0 || w <= 0) return REVERB_LABELS.dry;
  const pct = Math.round(w * 100);
  const label = REVERB_LABELS[nearestReverbKind(s)];
  return pct >= 100 ? label : `${label} ${pct}%`;
}
