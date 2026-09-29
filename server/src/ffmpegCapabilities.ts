/**
 * ffmpeg 能力探测。
 *
 * 为什么需要：README 只要求「ffmpeg 在 PATH 里」，但升降调用到的 rubberband
 * 是编译期开关（`--enable-librubberband`），并非所有发行版都带。
 * 缺了就**优雅降级**（禁用升降调并告诉用户），绝不能让整个混音失败 ——
 * 用户根本看不懂「No such filter: 'rubberband'」。
 *
 * 探测方式是真的跑一次滤镜而不是 grep `-filters`：
 * 列表里有、跑起来报错的构建也是有的，实测才算数。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FFMPEG_BIN } from './config.ts';
import { createLogger } from './logger.ts';

const log = createLogger('ffmpeg');

const execFileAsync = promisify(execFile);

export interface FfmpegCapabilities {
  /** 支持 rubberband 滤镜（人声/伴奏升降调） */
  rubberband: boolean;
}

const FALLBACK: FfmpegCapabilities = { rubberband: false };

let detected: FfmpegCapabilities | null = null;

/**
 * 跑一次空转的 rubberband，能过就是支持。
 * 失败原因（滤镜缺失 / ffmpeg 缺失）在这里不作区分 —— 都按「不支持」降级，
 * 具体原因在启动日志里已经由其它探测报过了。
 */
async function probeRubberband(): Promise<boolean> {
  try {
    await execFileAsync(
      FFMPEG_BIN,
      [
        '-hide_banner',
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=0.1',
        '-af',
        'rubberband=pitch=1.05:tempo=1',
        '-f',
        'null',
        '-',
      ],
      { timeout: 20_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测一次并缓存。启动时调一次即可；没探测过时按「不支持」处理
 * （宁可少一个功能，也不要在用户点合成时才炸）。
 */
export async function detectFfmpegCapabilities(): Promise<FfmpegCapabilities> {
  if (detected) return detected;

  const rubberband = await probeRubberband();
  detected = { rubberband };
  if (rubberband) {
    log.info('ffmpeg 支持 rubberband：升降调可用');
  } else {
    log.warn(
      'ffmpeg 不支持 rubberband：升降调将被禁用（其余功能不受影响）。' +
        '需要的话换一个带 --enable-librubberband 的 ffmpeg 构建。',
    );
  }
  return detected;
}

/** 同步读缓存；没探测过就返回保守值 */
export function getFfmpegCapabilities(): FfmpegCapabilities {
  return detected ?? FALLBACK;
}

/** 测试用：重置探测缓存 */
export function resetFfmpegCapabilities(): void {
  detected = null;
}
