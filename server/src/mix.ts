import type { MixParams, ReverbKind } from '../../shared/types.ts';
import { AUDIO } from './config.ts';
import { linearGain, mixTimeline } from '../../shared/mix.ts';
import { MP3_OUTPUT_ARGS, PROGRESS_OUTPUT_ARGS } from './ffmpeg.ts';

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

export interface MixLevels {
  /** 人声轨最终乘的线性增益（归一化增益 × 用户滑块） */
  vocalLinear: number;
  accompLinear: number;
}

/** 实测归一化增益 × 用户滑块；公式本体在 shared/mix.ts（前端实时预览要用同一套） */
export function computeLevels(
  mixParams: Pick<MixParams, 'vocalGain' | 'accompGain'>,
  vocalGainDb: number,
  accompGainDb: number,
): MixLevels {
  return {
    vocalLinear: linearGain(mixParams.vocalGain, vocalGainDb),
    accompLinear: linearGain(mixParams.accompGain, accompGainDb),
  };
}

export interface MixFilterInput {
  /** 合成后的总对齐偏移（userOffsetMs − autoOffsetMs），ms；正值推后人声，负值延后伴奏 */
  offsetMs: number;
  levels: MixLevels;
  reverb: ReverbKind;
}

/**
 * 构造 filter_complex。
 *
 * 对齐模型（shared/mix.ts 的符号语义）：
 *  offsetMs 是人声相对混音时间轴的延迟，**可正可负**。
 *  · offset > 0：人声要更晚 → `adelay` 挂**人声分支**（干声被推后）；
 *  · offset < 0：人声要更早 → 没有负的 adelay，改成把**伴奏分支**延后
 *    |offset| ms。效果等价于把干声提前 —— 干声开头那段「起录后、伴奏起播前」
 *    的预备静音正好被吃掉。两条路都不能挂在 amix 之后：挂在后面等于没对齐。
 *  · offset = 0：两轨都不加延迟。
 *
 * `duration=first`：amix 的第一路输入始终是人声，混音长度就以人声为准
 * （用户中途点了结束，不会在成品里拖出一长段纯伴奏尾巴）。
 */
export function buildMixFilter(input: MixFilterInput): string {
  const { offsetMs, levels, reverb } = input;
  const sampleRate = AUDIO.sampleRate;
  const { vocalDelayMs, accompDelayMs } = mixTimeline(offsetMs);

  const vocalChain = [
    `aformat=sample_rates=${sampleRate}:channel_layouts=stereo`,
    'highpass=f=80',
    `volume=${levels.vocalLinear.toFixed(4)}`,
  ];
  const reverbFilter = REVERB_FILTER[reverb];
  if (reverbFilter) vocalChain.push(reverbFilter);
  if (vocalDelayMs > 0) vocalChain.push(`adelay=delays=${vocalDelayMs}:all=1`);

  const accompChain = [
    `aformat=sample_rates=${sampleRate}:channel_layouts=stereo`,
    `volume=${levels.accompLinear.toFixed(4)}`,
  ];
  if (accompDelayMs > 0) accompChain.push(`adelay=delays=${accompDelayMs}:all=1`);

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
    ...MP3_OUTPUT_ARGS,
    '-metadata',
    `title=${input.title}`,
    ...PROGRESS_OUTPUT_ARGS,
    input.outputPath,
  ];
}
