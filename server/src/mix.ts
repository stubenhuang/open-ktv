import type { MixParams, ReverbKind } from '../../shared/types.ts';
import { AUDIO } from './config.ts';
import {
  EQ_BANDS,
  compressorParams,
  deEssEnabled,
  eqIsNeutral,
  linearGain,
  mixTimeline,
  semitonesToRatio,
  vocalChainLinearGain,
} from '../../shared/mix.ts';
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

/** 实测归一化增益 × 用户滑块 × 压缩补偿；公式本体在 shared/mix.ts（前端实时预览要用同一套） */
export function computeLevels(
  mixParams: Pick<MixParams, 'vocalGain' | 'accompGain' | 'compression'>,
  vocalGainDb: number,
  accompGainDb: number,
): MixLevels {
  return {
    vocalLinear: vocalChainLinearGain(mixParams.vocalGain, vocalGainDb, mixParams.compression),
    accompLinear: linearGain(mixParams.accompGain, accompGainDb),
  };
}

/**
 * 人声均衡三段。
 *
 * 均衡用的是双二阶（biquad）滤波，**没有内部延迟**，所以可以安全地留在
 * 混音图里 —— 需要担心延迟的是 rubberband / acompressor / deesser / afftdn，
 * 那些都进了人声预处理 pass（见 buildVocalPreProcessArgs）。
 * 频率与类型必须与前端预览的 BiquadFilterNode 一致（共用 EQ_BANDS）。
 */
function buildEqChain(lowDb: number, midDb: number, highDb: number): string[] {
  if (eqIsNeutral(lowDb, midDb, highDb)) return [];
  const band = (frequency: number, q: number, gainDb: number) =>
    `equalizer=f=${frequency}:t=q:w=${q}:g=${gainDb.toFixed(2)}`;
  return [
    band(EQ_BANDS.low.frequency, EQ_BANDS.low.q, lowDb),
    band(EQ_BANDS.mid.frequency, EQ_BANDS.mid.q, midDb),
    band(EQ_BANDS.high.frequency, EQ_BANDS.high.q, highDb),
  ];
}

export interface MixFilterInput {
  /** 合成后的总对齐偏移（userOffsetMs − autoOffsetMs），ms；正值推后人声，负值延后伴奏 */
  offsetMs: number;
  levels: MixLevels;
  reverb: ReverbKind;
  /** 均衡三段（dB）；全 0 时不挂滤镜 */
  eqLowDb: number;
  eqMidDb: number;
  eqHighDb: number;
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
  const { offsetMs, levels, reverb, eqLowDb, eqMidDb, eqHighDb } = input;
  const sampleRate = AUDIO.sampleRate;
  const { vocalDelayMs, accompDelayMs } = mixTimeline(offsetMs);

  const vocalChain = [
    `aformat=sample_rates=${sampleRate}:channel_layouts=stereo`,
    'highpass=f=80',
    // 均衡是零延迟的 biquad，可以留在这里；带延迟的处理全在预处理 pass 里
    ...buildEqChain(eqLowDb, eqMidDb, eqHighDb),
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

/* ------------------------------ 预处理 pass ------------------------------ */

/**
 * 为什么要有预处理 pass。
 *
 * 本项目最值钱的资产是「干声与伴奏的精确对齐」，而下面这些滤镜都带**内部延迟**：
 *   · rubberband —— 相位声码器，天生有前瞻
 *   · acompressor —— 前瞻式动态处理
 *   · deesser / afftdn —— 检测 + FFT 窗口
 * 把它们挂进混音图，adelay 算出来的毫秒数就不再是真正的对齐量，而且
 * 每个滤镜的延迟还不一样、随参数变，根本没法用一个常量补。
 *
 * 所以：这些处理统统放进一次独立的 ffmpeg 运行，产出中间 WAV；
 * 混音图拿到的是已经处理好的文件，mixTimeline 的语义一个字都不用改。
 *
 * 附带好处：**原始 vocals/*.wav 永远不被改写**，参数随时可以重新调
 * （这是 README 承诺的「干声是任意重新混音的前提」）。
 */

/**
 * 预处理产物的统一规格：与混音图输入一致，16bit PCM 便于快速再处理。
 *
 * `-f wav` 必须显式给：写「先 .part 再 rename」的过程中文件名是
 * `xxx.wav.part`，ffmpeg 靠扩展名推不出格式会直接报
 * 「Unable to choose an output format」。显式指定后叫什么名字都行。
 */
const PRE_PROCESS_OUTPUT_ARGS = [
  '-ar',
  String(AUDIO.sampleRate),
  '-ac',
  String(AUDIO.channels),
  '-c:a',
  'pcm_s16le',
  '-f',
  'wav',
];

export interface VocalPreProcessInput {
  sourcePath: string;
  outputPath: string;
  /** 已按能力探测结果清零（不支持 rubberband 时传 0） */
  pitchSemitones: number;
  compression: number;
  deEss: number;
  noiseReduction: boolean;
}

/**
 * 人声预处理链：降噪 → 压缩 → 去齿音 → 升降调。
 *
 * 顺序有讲究：先降噪再进动态处理（否则压缩器会被底噪触发），
 * 升降调放最后（避免让前面的处理工作在变调后的音色上）。
 * 压缩的 makeup 不在这里做 —— 它并进了人声的线性增益，见 vocalChainLinearGain。
 */
export function buildVocalPreProcessArgs(input: VocalPreProcessInput): string[] {
  const chain: string[] = [`aformat=sample_rates=${AUDIO.sampleRate}:channel_layouts=stereo`];

  if (input.noiseReduction) {
    // afftdn：FFT 降噪。nr 给 12dB，nv=-40 是噪声底，过激会吃掉气息
    chain.push('afftdn=nr=12:nf=-40');
  }

  const compressor = compressorParams(input.compression);
  if (compressor.enabled) {
    chain.push(
      `acompressor=threshold=${compressor.thresholdDb.toFixed(2)}dB` +
        `:ratio=${compressor.ratio.toFixed(2)}:attack=10:release=200`,
    );
  }

  if (deEssEnabled(input.deEss)) {
    chain.push(`deesser=i=${Math.max(0, Math.min(1, input.deEss)).toFixed(2)}:m=0.5:f=0.5:s=o`);
  }

  const semitones = Math.round(Number(input.pitchSemitones) || 0);
  if (semitones !== 0) {
    chain.push(`rubberband=pitch=${semitonesToRatio(semitones).toFixed(6)}:tempo=1`);
  }

  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-i',
    input.sourcePath,
    '-af',
    chain.join(','),
    ...PRE_PROCESS_OUTPUT_ARGS,
    ...PROGRESS_OUTPUT_ARGS,
    input.outputPath,
  ];
}

export interface AccompPreProcessInput {
  sourcePath: string;
  outputPath: string;
  /** 已按能力探测结果清零 */
  accompSemitones: number;
}

/**
 * 伴奏升降调。
 *
 * 只动伴奏、不动人声是**正确**的：用户是在按新调唱，录下来的人声本来就在新调上。
 * 这恰好解决了「这首伴奏的调我唱不上去」这个以前完全无解的问题。
 */
export function buildAccompPreProcessArgs(input: AccompPreProcessInput): string[] {
  const semitones = Math.round(Number(input.accompSemitones) || 0);
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-i',
    input.sourcePath,
    '-af',
    `rubberband=pitch=${semitonesToRatio(semitones).toFixed(6)}:tempo=1`,
    ...PRE_PROCESS_OUTPUT_ARGS,
    ...PROGRESS_OUTPUT_ARGS,
    input.outputPath,
  ];
}
