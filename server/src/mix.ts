//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { MixParams } from '../../shared/types.ts';
import { AUDIO } from './config.ts';
import {
  EQ_BANDS,
  compressorParams,
  deEssEnabled,
  eqIsNeutral,
  linearGain,
  mixTimeline,
  reverbDsp,
  vocalChainLinearGain,
} from '../../shared/mix.ts';
import { MP3_OUTPUT_ARGS, PROGRESS_OUTPUT_ARGS } from './ffmpeg.ts';

/** 归一化目标：伴奏略高于人声，人声才有「贴着伴奏唱」的感觉 */
export const LOUDNESS_TARGET = {
  vocal: -18,
  accompaniment: -16,
} as const;

/*
 * 混响滤镜：与试听（web/src/audio/preview.ts 的 ConvolverNode）**同源**。
 *
 * 空间（0–1）+ 湿度（0–1）两个连续量经 shared/mix.ts 的插值产出 IR 规格与
 * 干湿增益；IR 本体由 shared/mix.ts 的 generateReverbIr 生成（前延迟静音 +
 * 指数衰减噪声，缩放系数复刻浏览器 ConvolverNode normalize=true 的等效增益），
 * mixJob 把它落成临时 WAV 当第三个输入，这里用 afir 做卷积：
 *
 *   [人声链] ──asplit──┬── volume=<dry> ────────────────┐
 *                      └── afir=wet=<wet>:irnorm=-1 ────┴── amix ──> …
 *                            （IR 来自 [2:a]）
 *
 * 两个必须写对的 afir 参数（都踩过坑）：
 *  - irnorm=-1：默认 1 会按「绝对值之和」把 IR 归一到几乎无声，必须关掉，
 *    用 generateReverbIr 已经烘好的缩放；
 *  - dry=1：afir 的 dry 不是「干声支路」而是**进 FIR 的输入增益**（命名坑），
 *    干声支路在这里由 asplit + volume 显式搭建，与试听的 dryGain 节点对应。
 *
 * 历史上这里用 aecho=in:out:delay:decay 拼单回声。那是对 ffmpeg aecho 语义的
 * 误读（in_gain 缩放干声、回声 = out_gain×decay 且只有一个），湿度控制不了
 * 成品混响量，成品因此总比试听「多一层」离散回声。现已废弃，锚点表里的
 * aecho 四元组也一并删除（shared/types.ts）。
 */

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
 * 混音图里 —— 需要担心延迟的是 acompressor / deesser / afftdn，
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
  /** 混响空间 0–1（REVERB_ANCHORS 八档之间的连续位置）；0 = 原声 */
  reverbSpace: number;
  /** 混响湿度 0–1；0 = 旁通（干声） */
  reverbWet: number;
  /** 均衡三段（dB）；全 0 时不挂滤镜 */
  eqLowDb: number;
  eqMidDb: number;
  eqHighDb: number;
}

/** 混响是否挂滤镜（空间 0 或湿度 0 = 干声旁通；IR 输入也只在此时才出现） */
export function reverbActive(space: number, wet: number): boolean {
  return !reverbDsp(space, wet).bypass;
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
 *
 * 混响（详见文件头）：激活时人声链 asplit 成干/湿两支，湿支过 afir 卷积
 * （IR = 输入 [2:a]，由 mixJob 生成落盘），干湿增益用共享的 reverbDsp；
 * 旁通时人声链与原版逐字节一致（老作品干声零回归）。
 */
export function buildMixFilter(input: MixFilterInput): string {
  const { offsetMs, levels, reverbSpace, reverbWet, eqLowDb, eqMidDb, eqHighDb } = input;
  const sampleRate = AUDIO.sampleRate;
  const { vocalDelayMs, accompDelayMs } = mixTimeline(offsetMs);
  const reverb = reverbDsp(reverbSpace, reverbWet);

  // 人声共用的处理链（零延迟滤镜，可以留在混音图里）
  const vocalProcess = [
    `aformat=sample_rates=${sampleRate}:channel_layouts=stereo`,
    'highpass=f=80',
    // 均衡是零延迟的 biquad，可以留在这里；带延迟的处理全在预处理 pass 里
    ...buildEqChain(eqLowDb, eqMidDb, eqHighDb),
    `volume=${levels.vocalLinear.toFixed(4)}`,
  ];

  // filter_complex 是「;」分隔的语句列表：每个语句自己带输入/输出标签，
  // 多输入滤镜（afir 的 IR、amix 的干湿两支）必须独立成句，不能逗号串在链中。
  const statements: string[] = [];
  if (reverb.bypass) {
    const chain = [...vocalProcess];
    if (vocalDelayMs > 0) chain.push(`adelay=delays=${vocalDelayMs}:all=1`);
    statements.push(`[0:a]${chain.join(',')}[v]`);
  } else {
    // 干湿分离：与试听音频图同构（dryGain 节点 / convolver→wetGain 节点）。
    // afir 的 dry 是「进 FIR 的输入增益」不是干声支路（命名坑），干声支路
    // 由 asplit + volume 显式搭建；irnorm=-1 关掉它默认的绝对值归一，
    // 用 generateReverbIr 已经烘好的缩放（与试听同一份 IR）。
    statements.push(`[0:a]${vocalProcess.join(',')},asplit=2[vdry][vwet]`);
    statements.push(`[vwet][2:a]afir=dry=1:wet=${reverb.wet.toFixed(4)}:irnorm=-1[vw]`);
    statements.push(`[vdry]volume=${reverb.dry.toFixed(4)}[vd]`);
    const delayTail = vocalDelayMs > 0 ? `,adelay=delays=${vocalDelayMs}:all=1` : '';
    statements.push(
      `[vd][vw]amix=inputs=2:duration=first:normalize=0:dropout_transition=0${delayTail}[v]`,
    );
  }

  const accompChain = [
    `aformat=sample_rates=${sampleRate}:channel_layouts=stereo`,
    `volume=${levels.accompLinear.toFixed(4)}`,
  ];
  if (accompDelayMs > 0) accompChain.push(`adelay=delays=${accompDelayMs}:all=1`);
  statements.push(`[1:a]${accompChain.join(',')}[a]`);

  statements.push(
    '[v][a]amix=inputs=2:duration=first:normalize=0:dropout_transition=0,' +
      'alimiter=limit=0.95:level=0[m]',
  );
  return statements.join(';');
}

export interface MixArgsInput extends MixFilterInput {
  vocalPath: string;
  accompanimentPath: string;
  outputPath: string;
  title: string;
  /**
   * 混响 IR 的 WAV 路径（立体声浮点，由 mixJob 用 shared/mix.ts 的
   * generateReverbIr 生成）。混响激活时必填——滤镜里的 afir 引用 [2:a]；
   * 旁通时不传，输入列表与滤镜串都和旧版一致。
   */
  reverbIrPath?: string;
}

export function buildMixArgs(input: MixArgsInput): string[] {
  const withReverb = reverbActive(input.reverbSpace, input.reverbWet);
  if (withReverb && !input.reverbIrPath) {
    // 滤镜里的 afir 引用 [2:a]，少了这个输入 ffmpeg 只会报一句难懂的
    // "Invalid file index"，在这里把契约说清楚
    throw new Error('混响已激活但没提供 reverbIrPath（混响 IR 的 WAV 路径）');
  }
  const irInput = withReverb ? ['-i', input.reverbIrPath!] : [];
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-i',
    input.vocalPath,
    '-i',
    input.accompanimentPath,
    ...irInput,
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
  compression: number;
  deEss: number;
  noiseReduction: boolean;
}

/**
 * 人声预处理链：降噪 → 压缩 → 去齿音。
 *
 * 顺序有讲究：先降噪再进动态处理（否则压缩器会被底噪触发）。
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
