import fs from 'node:fs';
import path from 'node:path';
import {
  effectiveOffsetMs,
  generateReverbIr,
  needsVocalPreProcess,
  previewDurationSec,
  reverbIrKey,
  reverbIrSpec,
} from '../../shared/mix.ts';
import { encodeWavBytesFloat } from '../../shared/wav.ts';
import { AUDIO, JOB_TIMEOUT_MS } from './config.ts';
import type { TrackRecord, WorkRecord } from './db.ts';
import { runFfmpeg } from './ffmpeg.ts';
import { createLogger } from './logger.ts';
import { measureLoudness, normalizeGainDb } from './loudness.ts';
import {
  buildMixArgs,
  buildVocalPreProcessArgs,
  computeLevels,
  LOUDNESS_TARGET,
  type MixLevels,
  reverbActive,
} from './mix.ts';
import { TMP_DIR, WORKS_DIR } from './paths.ts';

const log = createLogger('mix');

export function workMp3Path(workId: string): string {
  return path.join(WORKS_DIR, `${workId}.mp3`);
}

/** 预处理阶段占总进度的比例；剩下留给混音（混音通常是大头） */
const PRE_PROCESS_SHARE = 0.4;

/**
 * 混响 IR 的临时文件路径（每次合成立即重新生成，不做磁盘缓存）。
 *
 * 生成成本可以忽略： canyon 档 6.5s 立体声 48k 也就 60 万个浮点样本，
 * 比一次 ffmpeg seek 还快。缓存反而要多一套失效/清理逻辑，不值得。
 */
export function reverbIrPath(workId: string): string {
  return path.join(TMP_DIR, `reverb-ir-${workId}.wav`);
}

/**
 * 把当前空间对应的混响 IR 写成 WAV（立体声浮点 48k）。
 *
 * 规格必须走**量化键**（reverbIrKey）—— 试听侧按量化键缓存 IR、按原始空间
 * 算干湿增益，服务端用同一个键，两端的 IR 才逐位同源。生成公式与缩放系数
 * 都在 shared/mix.ts（generateReverbIr），试听那边用的是同一个函数。
 *
 * 浮点而不是 16 位：IR 幅度只有千分之几（复刻浏览器卷积器的等效增益），
 * 16 位量化的噪声会听得出来。
 */
export async function writeReverbIr(space: number, destPath: string): Promise<void> {
  const spec = reverbIrSpec(reverbIrKey(space));
  const channels = generateReverbIr(spec, AUDIO.sampleRate, AUDIO.channels);
  await fs.promises.writeFile(destPath, Buffer.from(encodeWavBytesFloat(channels, AUDIO.sampleRate)));
  log.debug('混响 IR 已生成', {
    destPath,
    tailSec: spec.seconds,
    preDelayMs: spec.preDelayMs,
    decay: spec.decay,
  });
}

export interface MixResult {
  outputPath: string;
  offsetMs: number;
  levels: MixLevels;
  vocalGainDb: number;
  accompGainDb: number;
}

/* ---------------------------------- 缓存 ---------------------------------- */

/**
 * 伴奏响度测量结果缓存：伴奏文件本身不可变，量一次就够了。
 * 重新生成作品（改音量/混响）时能省掉一次全曲解码。
 */
const loudnessCache = new Map<string, Awaited<ReturnType<typeof measureLoudness>>>();
const LOUDNESS_CACHE_LIMIT = 200;

async function accompanimentLoudness(track: TrackRecord) {
  const cached = loudnessCache.get(track.id);
  if (cached) return cached;

  const measured = await measureLoudness(track.originalPath);
  if (loudnessCache.size >= LOUDNESS_CACHE_LIMIT) loudnessCache.clear();
  loudnessCache.set(track.id, measured);
  return measured;
}

/** 删除伴奏时调用：把它留下的响度缓存清掉 */
export function forgetTrackLoudness(trackId: string): void {
  loudnessCache.delete(trackId);
}

/* --------------------------------- 主流程 --------------------------------- */

/**
 * 把干声和伴奏混成一个 MP3。
 *
 * 先跑必要的预处理 pass（带延迟的滤镜都在那里，见 mix.ts 的说明），
 * 再执行混音图；最后先写 tmp 再 rename —— 不会出现「半截 mp3」被下载到。
 */
export async function mixWorkToMp3(input: {
  work: WorkRecord;
  track: TrackRecord;
  onProgress: (ratio: number) => void;
}): Promise<MixResult> {
  const { work, track, onProgress } = input;
  const params = work.mixParams;

  const wantsVocalPre = needsVocalPreProcess(params);

  // 预处理占 PRE_PROCESS_SHARE，混音吃掉剩下的
  const stepShare = wantsVocalPre ? PRE_PROCESS_SHARE : 0;
  let finishedSteps = 0;

  /** 把一个子步骤的 0–1 映射到整次合成的大进度上 */
  const stepProgress = (ratio: number) => {
    onProgress(finishedSteps * stepShare + Math.max(0, Math.min(1, ratio)) * stepShare);
  };
  const mixProgress = (ratio: number) => {
    const base = finishedSteps * stepShare;
    onProgress(base + Math.max(0, Math.min(1, ratio)) * (1 - base));
  };

  /** 本次合成产生的中间文件，结束（无论成败）都要清掉 */
  const intermediates: string[] = [];
  let vocalPath = work.vocalPath;
  const accompanimentPath = track.originalPath;

  // 混响激活时才生成 IR（旁通 = 干声，滤镜串与输入列表都和旧版一致）
  const irPath = reverbActive(params.reverbSpace, params.reverbWet)
    ? reverbIrPath(work.id)
    : null;

  try {
    if (wantsVocalPre) {
      const prepared = path.join(TMP_DIR, `vocalpre-${work.id}.wav`);
      intermediates.push(prepared);
      await fs.promises.rm(prepared, { force: true });

      log.debug('人声预处理', {
        workId: work.id,
        compression: params.compression,
        deEss: params.deEss,
        noiseReduction: params.noiseReduction,
      });
      await runFfmpeg({
        args: buildVocalPreProcessArgs({
          sourcePath: work.vocalPath,
          outputPath: prepared,
          compression: params.compression,
          deEss: params.deEss,
          noiseReduction: params.noiseReduction,
        }),
        timeoutMs: JOB_TIMEOUT_MS.preProcess,
        totalDurationSec: work.vocalDuration,
        onProgress: stepProgress,
        label: '人声预处理',
      });
      vocalPath = prepared;
      finishedSteps += 1;
    }

    const [vocalLoudness, accompLoudness] = await Promise.all([
      // 量的始终是**原始**干声：压缩的补偿已经并进人声线性增益，
      // 拿预处理后的文件再量一遍只会把补偿算两次
      measureLoudness(work.vocalPath),
      accompanimentLoudness(track),
    ]);

    const vocalGainDb = normalizeGainDb(vocalLoudness, LOUDNESS_TARGET.vocal);
    const accompGainDb = normalizeGainDb(accompLoudness, LOUDNESS_TARGET.accompaniment);
    const offsetMs = effectiveOffsetMs(work.autoOffsetMs, work.mixParams.userOffsetMs);
    const levels = computeLevels(work.mixParams, vocalGainDb, accompGainDb);

    log.debug('响度与增益', {
      workId: work.id,
      vocalI: vocalLoudness.inputI,
      vocalTp: vocalLoudness.inputTp,
      accompI: accompLoudness.inputI,
      accompTp: accompLoudness.inputTp,
      vocalGainDb,
      accompGainDb,
      offsetMs,
    });

    const tmpOutput = path.join(TMP_DIR, `mix-${work.id}.mp3`);
    const finalOutput = workMp3Path(work.id);
    await fs.promises.rm(tmpOutput, { force: true });

    if (irPath) {
      intermediates.push(irPath);
      await fs.promises.rm(irPath, { force: true });
      await writeReverbIr(params.reverbSpace, irPath);
    }

    log.debug('开始混音', { workId: work.id, tmpOutput, timeoutSec: JOB_TIMEOUT_MS.mix / 1000 });
    try {
      await runFfmpeg({
        args: buildMixArgs({
          vocalPath,
          accompanimentPath,
          outputPath: tmpOutput,
          title: work.title,
          offsetMs,
          levels,
          reverbSpace: work.mixParams.reverbSpace,
          reverbWet: work.mixParams.reverbWet,
          eqLowDb: work.mixParams.eqLowDb,
          eqMidDb: work.mixParams.eqMidDb,
          eqHighDb: work.mixParams.eqHighDb,
          ...(irPath ? { reverbIrPath: irPath } : {}),
        }),
        timeoutMs: JOB_TIMEOUT_MS.mix,
        // 成品时长 = 干声时长 + max(0, 偏移)；负偏移延后的是伴奏，人声没被推后
        // （与 duration=first 一致，公式与前端预览共用 shared/mix.ts）
        totalDurationSec: Math.max(1, previewDurationSec(work.vocalDuration, offsetMs)),
        onProgress: mixProgress,
        label: '混音',
      });
      await fs.promises.rename(tmpOutput, finalOutput);
      log.debug('混音完成', { workId: work.id, output: finalOutput });
    } catch (error) {
      await fs.promises.rm(tmpOutput, { force: true });
      log.warn('混音失败，已清理临时文件', { workId: work.id, error });
      throw error;
    }

    onProgress(1);
    return { outputPath: finalOutput, offsetMs, levels, vocalGainDb, accompGainDb };
  } finally {
    // 原始 vocals/*.wav 绝不改写；这里只清本次产生的中间产物
    await Promise.all(intermediates.map((file) => fs.promises.rm(file, { force: true })));
  }
}
