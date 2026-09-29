/**
 * 曲库下载任务的状态表（进程内）。
 *
 * 为什么不复用 jobs.ts：那个队列的公共接口只有「进度 + 是否在跑」
 * （getProgress / isQueued / queueState），README 明确把这套极简设计
 * 说成是有意为之。为了「记住下载结果与 trackId」去污染它不划算。
 *
 * 代价是这张表随进程消亡 —— 服务重启后前端轮询会拿到 404，界面提示重试即可。
 * 这与既有的「重启把处理中的任务一律标 failed，让前端别永远转圈」是同一套哲学。
 *
 * 对外只暴露 taskId（随机 uuid）。jobs 的 key 里带着清单地址和音频地址，
 * 里面全是 `:` 和 `/`，塞进 URL 路径会把路由打乱。
 */

import { randomUUID } from 'node:crypto';
import type { LibraryTaskDto, LibraryTaskState } from '../../../shared/types.ts';

/** 下发契约在 shared/types.ts，前后端共用一份 */
export type { LibraryTaskDto, LibraryTaskState };

export interface LibraryTask {
  /** 对外的任务 id（uuid），前端轮询用 */
  taskId: string;
  /** jobs.ts 队列里的 key；里面有清单地址，**不下发**给前端 */
  jobKey: string;
  title: string;
  state: LibraryTaskState;
  /** 0–1；running 时以任务队列的进度为准（见 routes/library.ts） */
  progress: number;
  /** 成功后指向入库的伴奏 id */
  trackId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 转成下发形态：剥掉 jobKey */
export function toLibraryTaskDto(task: LibraryTask, progress = task.progress): LibraryTaskDto {
  return {
    taskId: task.taskId,
    title: task.title,
    state: task.state,
    progress,
    trackId: task.trackId,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/** 同时保留的任务上限；超出时先丢最老的已结束任务 */
const MAX_TASKS = 50;

const tasks = new Map<string, LibraryTask>();

export function downloadJobKey(providerId: string, itemId: string): string {
  return `download:${providerId}:${itemId}`;
}

export function createTask(jobKey: string, title: string): LibraryTask {
  const now = Date.now();
  const task: LibraryTask = {
    taskId: randomUUID(),
    jobKey,
    title,
    state: 'queued',
    progress: 0,
    trackId: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  tasks.set(task.taskId, task);
  pruneTasks();
  return task;
}

export function patchTask(taskId: string, patch: Partial<Omit<LibraryTask, 'taskId'>>): void {
  const task = tasks.get(taskId);
  if (!task) return;
  Object.assign(task, patch, { updatedAt: Date.now() });
}

export function getTask(taskId: string): LibraryTask | undefined {
  return tasks.get(taskId);
}

/** 测试用 */
export function clearTasks(): void {
  tasks.clear();
}

/** 超过上限时丢最老的「已结束」任务；还在跑的一个都不能丢 */
function pruneTasks(): void {
  if (tasks.size <= MAX_TASKS) return;
  const finished = [...tasks.values()]
    .filter((task) => task.state === 'done' || task.state === 'failed')
    .sort((a, b) => a.updatedAt - b.updatedAt);
  for (const task of finished) {
    if (tasks.size <= MAX_TASKS) break;
    tasks.delete(task.taskId);
  }
}
