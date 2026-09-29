import fs from 'node:fs';
import path from 'node:path';
import { effectiveOffsetMs, previewDurationSec } from '../../shared/mix.ts';
import { JOB_TIMEOUT_MS } from './config.ts';
import type { TrackRecord, WorkRecord } from './db.ts';
import { runFfmpeg } from './ffmpeg.ts';
import { createLogger } from './logger.ts';
import { measureLoudness, normalizeGainDb } from './loudness.ts';
import { buildMixArgs, computeLevels, LOUDNESS_TARGET, type MixLevels } from './mix.ts';
import { TMP_DIR, WORKS_DIR } from './paths.ts';

const log = createLogger('mix');

export function workMp3Path(workId: string): string {
  return path.join(WORKS_DIR, `${workId}.mp3`);
}

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

export function forgetTrackLoudness(trackId: string): void {
  loudnessCache.delete(trackId);
}

export interface MixResult {
  outputPath: string;
  offsetMs: number;
  levels: MixLevels;
  vocalGainDb: number;
  accompGainDb: number;
}

/**
 * 把干声和伴奏混成一个 MP3。
 * 先写到临时目录，成功后 rename —— 不会出现「半截 mp3」被用户下载到。
 */
export async function mixWorkToMp3(input: {
  work: WorkRecord;
  track: TrackRecord;
  onProgress: (ratio: number) => void;
}): Promise<MixResult> {
  const { work, track, onProgress } = input;

  const [vocalLoudness, accompLoudness] = await Promise.all([
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
        vocalPath: work.vocalPath,
        accompanimentPath: track.originalPath,
        outputPath: tmpOutput,
        title: work.title,
        offsetMs,
        levels,
        reverb: work.mixParams.reverb,
      }),
      timeoutMs: JOB_TIMEOUT_MS.mix,
      // 成品时长 = 干声时长 + max(0, 偏移)；负偏移延后的是伴奏，人声没被推后
      // （与 duration=first 一致，公式与前端预览共用 shared/mix.ts）
      totalDurationSec: Math.max(1, previewDurationSec(work.vocalDuration, offsetMs)),
      onProgress,
      label: '混音',
    });
    await fs.promises.rename(tmpOutput, finalOutput);
    log.debug('混音完成', { workId: work.id, output: finalOutput });
  } catch (error) {
    await fs.promises.rm(tmpOutput, { force: true });
    log.warn('混音失败，已清理临时文件', { workId: work.id, error });
    throw error;
  }

  return { outputPath: finalOutput, offsetMs, levels, vocalGainDb, accompGainDb };
}
