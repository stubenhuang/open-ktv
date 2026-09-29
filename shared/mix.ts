/**
 * 前后端共享的混音数学（纯函数，无 IO、无浏览器/Node 依赖）。
 *
 * 服务端用它们构造 ffmpeg 滤波器，前端实时预览用它们复算电平和偏移 ——
 * 两边必须用同一套公式，预览才能和成品 MP3 对齐。
 */

import type { MixParams, PreviewParams, ReverbKind, WorkLevels } from './types.ts';

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
  params: Pick<MixParams, 'vocalGain' | 'accompGain' | 'reverb' | 'userOffsetMs'>,
  autoOffsetMs: number,
  levels: WorkLevels | null,
): PreviewParams {
  return {
    vocalGain: params.vocalGain,
    accompGain: params.accompGain,
    reverb: params.reverb,
    offsetMs: effectiveOffsetMs(autoOffsetMs, params.userOffsetMs),
    levels,
  };
}

/** 预览引擎复算出的两轨线性增益（与服务端 computeLevels 同公式） */
export function previewLinearGains(
  params: Pick<MixParams, 'vocalGain' | 'accompGain'>,
  levels: WorkLevels | null,
): { vocalLinear: number; accompLinear: number } {
  return {
    vocalLinear: linearGain(params.vocalGain, levels?.vocalGainDb ?? 0),
    accompLinear: linearGain(params.accompGain, levels?.accompGainDb ?? 0),
  };
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
