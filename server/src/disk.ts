//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import fs from 'node:fs';
import { DATA_DIR } from './config.ts';
import { createLogger } from './logger.ts';

const log = createLogger('disk');

/**
 * 磁盘空间预检。
 *
 * 这个项目的磁盘账很不线性：上传一个 1GB 的伴奏，tmp 里先落一份、
 * originals 里存一份、不能直接播的格式还要再转一份代理，混音时又有
 * 预处理 WAV + 成品 mp3。以前全程不查剩余空间，写满时 ffmpeg 只报一句
 * 晦涩的 "No space left on device"，用户完全不知道该清什么。
 *
 * 所以在上传 / 下载 / 混音这几个「已知要落多少字节」的点前面先问一句：
 * 够不够？不够就明说「剩多少、要多少」。
 */

/** 人类可读的体积（1024 进制） */
export function readableBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}

/**
 * 某个路径所在文件系统的可用空间（字节）。
 *
 * 用 `bavail`（无特权用户可用的块）而不是 `bfree`：后者含 root 保留块，
 * 我们这进程写不进去，报了也是虚高。
 */
export async function freeBytes(dir: string): Promise<number> {
  const stats = await fs.promises.statfs(dir);
  return stats.bavail * stats.bsize;
}

/**
 * 空间不够就抛出带文案的 Error。
 *
 * 量不到空间（statfs 失败）时**放行**并记日志：预检是优化不是关卡，
 * 不该因为问不出余量就把上传全拦了。真正写满时 ffmpeg 仍会报错，
 * 那条路本来就有。
 */
export async function ensureFreeSpace(requiredBytes: number, hint: string): Promise<void> {
  let free: number;
  try {
    // 查的是数据目录所在的文件系统 —— DATA_DIR 可以用环境变量指到别块盘上
    free = await freeBytes(DATA_DIR);
  } catch (error) {
    log.warn('查不到磁盘剩余空间，跳过预检', { error });
    return;
  }
  if (free >= requiredBytes) return;

  throw new Error(
    `磁盘剩余空间不足（剩 ${readableBytes(free)}，${hint}约需 ${readableBytes(requiredBytes)}）。` +
      '清理掉不听的作品/伴奏，或者换个空间充足的磁盘再说。',
  );
}
