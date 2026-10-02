import fs from 'node:fs';
import path from 'node:path';
import {
  effectiveOffsetMs,
  needsVocalPreProcess,
  previewDurationSec,
} from '../../shared/mix.ts';
import { JOB_TIMEOUT_MS } from './config.ts';
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
} from './mix.ts';
import { TMP_DIR, WORKS_DIR } from './paths.ts';

const log = createLogger('mix');

export function workMp3Path(workId: string): string {
  return path.join(WORKS_DIR, `${workId}.mp3`);
}

/** 预处理阶段占总进度的比例；剩下留给混音（混音通常是大头） */
const PRE_PROCESS_SHARE = 0.4;

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
          reverb: work.mixParams.reverb,
          eqLowDb: work.mixParams.eqLowDb,
          eqMidDb: work.mixParams.eqMidDb,
          eqHighDb: work.mixParams.eqHighDb,
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
