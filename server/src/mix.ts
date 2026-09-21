import type { MixParams, ReverbKind } from '../../shared/types.ts';
import { AUDIO } from './config.ts';
import { dbToLinear } from '../../shared/mix.ts';

/** 偏移钳制逻辑住在 shared/mix.ts，前端实时预览要用同一套；这里转手出去保持既有 import 不破 */
export { MAX_OFFSET_MS, effectiveOffsetMs } from '../../shared/mix.ts';

/** 归一化目标：伴奏略高于人声，人声才有「贴着伴奏唱」的感觉 */
export const LOUDNESS_TARGET = {
  vocal: -18,
  accompaniment: -16,
} as const;

/**
 * 混响档次。这里用的是 aecho（延迟回声）而不是卷积混响 ——
 * 不需要外挂脉冲响应文件，零依赖，听感够用。
 */
export const REVERB_FILTER: Record<ReverbKind, string | null> = {
  dry: null,
  room: 'aecho=0.8:0.85:18:0.25',
  hall: 'aecho=0.8:0.9:55:0.35',
  stage: 'aecho=0.9:0.92:110:0.45',
};

function clampLinear(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(4, value));
}

export interface MixLevels {
  /** 人声轨最终乘的线性增益（归一化增益 × 用户滑块） */
  vocalLinear: number;
  accompLinear: number;
}

export function computeLevels(
  mixParams: Pick<MixParams, 'vocalGain' | 'accompGain'>,
  vocalGainDb: number,
  accompGainDb: number,
): MixLevels {
  return {
    vocalLinear: clampLinear(dbToLinear(vocalGainDb) * mixParams.vocalGain),
    accompLinear: clampLinear(dbToLinear(accompGainDb) * mixParams.accompGain),
  };
}

export interface MixFilterInput {
  offsetMs: number;
  levels: MixLevels;
  reverb: ReverbKind;
}

/**
 * 构造 filter_complex。
 *
 * 对齐的关键点：`adelay` 必须挂在**人声分支**上，不能在 amix 之后 ——
 * 挂在后面会把伴奏一起推后，等于没对齐。
 *
 * `duration=first`：amix 的第一路输入是（延迟后的）人声，混音长度就以人声为准。
 * 用户中途点了结束，不会在成品里拖出一长段纯伴奏尾巴。
 */
export function buildMixFilter(input: MixFilterInput): string {
  const { offsetMs, levels, reverb } = input;
  const sampleRate = AUDIO.sampleRate;

  const vocalChain = [
    `aformat=sample_rates=${sampleRate}:channel_layouts=stereo`,
    'highpass=f=80',
    `volume=${levels.vocalLinear.toFixed(4)}`,
  ];
  const reverbFilter = REVERB_FILTER[reverb];
  if (reverbFilter) vocalChain.push(reverbFilter);
  if (offsetMs > 0) vocalChain.push(`adelay=delays=${offsetMs}:all=1`);

  const accompChain = [
    `aformat=sample_rates=${sampleRate}:channel_layouts=stereo`,
    `volume=${levels.accompLinear.toFixed(4)}`,
  ];

  return [
    `[0:a]${vocalChain.join(',')}[v]`,
    `[1:a]${accompChain.join(',')}[a]`,
    '[v][a]amix=inputs=2:duration=first:normalize=0:dropout_transition=0,' +
      'alimiter=limit=0.95:level=0[m]',
  ].join(';');
}

export interface MixArgsInput extends MixFilterInput {
  vocalPath: string;
  accompanimentPath: string;
  outputPath: string;
  title: string;
}

export function buildMixArgs(input: MixArgsInput): string[] {
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-i',
    input.vocalPath,
    '-i',
    input.accompanimentPath,
    '-filter_complex',
    buildMixFilter(input),
    '-map',
    '[m]',
    '-c:a',
    'libmp3lame',
    '-b:a',
    AUDIO.mp3Bitrate,
    '-ar',
    String(AUDIO.sampleRate),
    '-ac',
    String(AUDIO.channels),
    '-id3v2_version',
    '3',
    '-metadata',
    `title=${input.title}`,
    '-progress',
    'pipe:1',
    '-nostats',
    input.outputPath,
  ];
}
