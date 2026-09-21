/**
 * 前后端共享的混音数学（纯函数，无 IO、无浏览器/Node 依赖）。
 *
 * 服务端用它们构造 ffmpeg 滤波器，前端实时预览用它们复算电平和偏移 ——
 * 两边必须用同一套公式，预览才能和成品 MP3 对齐。
 */

import type { MixParams, PreviewParams, ReverbKind, WorkLevels } from './types.ts';

/** 合成偏移的绝对上限（ms）：自动偏移 + 用户微调后夹到 [0, MAX_OFFSET_MS] */
export const MAX_OFFSET_MS = 30_000;

/** 自动测得偏移 + 用户微调，夹到合理区间 */
export function effectiveOffsetMs(autoOffsetMs: number, userOffsetMs: number): number {
  const total = (Number.isFinite(autoOffsetMs) ? autoOffsetMs : 0) + (Number.isFinite(userOffsetMs) ? userOffsetMs : 0);
  return Math.max(0, Math.min(MAX_OFFSET_MS, Math.round(total)));
}

/** dB → 线性增益 */
export function dbToLinear(db: number): number {
  if (!Number.isFinite(db)) return 1;
  return Math.pow(10, db / 20);
}

/**
 * 实时预览的总时长（秒）。
 *
 * 服务端 amix 用 duration=first 且人声分支在第一路（延迟后），
 * 成品长度 = 对齐偏移 + 干声时长。预览必须跟着这个口径走，
 * 否则「播完自动停」的时机和成品不一样。
 */
export function previewDurationSec(vocalDurationSec: number, offsetMs: number): number {
  const vocal = Number.isFinite(vocalDurationSec) && vocalDurationSec > 0 ? vocalDurationSec : 0;
  const offset = Number.isFinite(offsetMs) && offsetMs > 0 ? offsetMs : 0;
  return vocal + offset / 1000;
}

/**
 * 把面板参数 + 自动偏移 + 实测增益合成预览引擎的输入。
 *
 * 增益公式与服务端 computeLevels 一致：实测归一化增益 × 用户滑块。
 * levels 为 null（老作品，没落过库）时按 0dB 基准 —— 相对调节仍准确，
 * 绝对电平和成品可能有偏差，重新生成一次后即一致。
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
  const clamp = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(4, value)) : 1);
  return {
    vocalLinear: clamp(dbToLinear(levels?.vocalGainDb ?? 0) * params.vocalGain),
    accompLinear: clamp(dbToLinear(levels?.accompGainDb ?? 0) * params.accompGain),
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
