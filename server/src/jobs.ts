/**
 * 极简单并发任务队列。
 *
 * 单机自用场景下，一次只跑一个 ffmpeg 是最稳的选择：
 * 不会把 CPU 占满导致耳返卡顿，也不会同时写多个大文件。
 */

import { createLogger } from './logger.ts';

const log = createLogger('job');

export type ProgressReporter = (ratio: number) => void;

interface QueueItem {
  key: string;
  task: (report: ProgressReporter) => Promise<void>;
  onError: (error: Error) => void;
}

const pending: QueueItem[] = [];
const progress = new Map<string, number>();
let active: QueueItem | null = null;

function pump(): void {
  if (active) return;
  const next = pending.shift();
  if (!next) return;

  active = next;
  const startedAt = Date.now();
  log.info(`开始 ${next.key}`);
  const report: ProgressReporter = (ratio) => {
    progress.set(next.key, Math.max(0, Math.min(1, ratio)));
  };

  next
    .task(report)
    .then(() => {
      log.info(`完成 ${next.key}`, { costSec: ((Date.now() - startedAt) / 1000).toFixed(1) });
    })
    .catch((error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error(`失败 ${next.key}`, { error: err });
      next.onError(err);
    })
    .finally(() => {
      active = null;
      // 让事件循环喘口气再取下个任务
      setImmediate(pump);
    });
}

export function enqueue(
  key: string,
  task: (report: ProgressReporter) => Promise<void>,
  onError: (error: Error) => void,
): void {
  pending.push({ key, task, onError });
  progress.set(key, 0);
  log.debug(`入队 ${key}`, { waiting: pending.length });
  setImmediate(pump);
}

/** 0–1 的进度；任务不在队列里返回 null */
export function getProgress(key: string): number | null {
  const value = progress.get(key);
  return value === undefined ? null : value;
}

export function queueState(): { active: string | null; waiting: number } {
  return { active: active?.key ?? null, waiting: pending.length };
}

/** 同一个 key 是否已经在排队或正在跑 */
export function isQueued(key: string): boolean {
  return active?.key === key || pending.some((item) => item.key === key);
}
