import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Router } from 'express';
import { LRC_LIMITS, MAX_UPLOAD_BYTES } from '../../../shared/types.ts';
import { hasLrcTimeline, normalizeLrc } from '../../../shared/lrc.ts';
import { clampInt } from '../../../shared/numbers.ts';
import {
  LIBRARY_DOWNLOAD_TIMEOUT_MS,
  LIBRARY_SEARCH_TIMEOUT_MS,
} from '../config.ts';
import { getTrackByLibraryRef } from '../db.ts';
import { trackToDetail } from '../dto.ts';
import { enqueue, getProgress, isQueued } from '../jobs.ts';
import { createLogger } from '../logger.ts';
import { TMP_DIR } from '../paths.ts';
import { ingestFile, discardTmp } from '../tracks/ingest.ts';
import { downloadToFile, fetchText } from '../library/download.ts';
import type { LibraryRegistry } from '../library/registry.ts';
import { createTask, downloadJobKey, getTask, patchTask, toLibraryTaskDto } from '../library/tasks.ts';
import { libraryRef, type LibraryItem, type LibraryItemKind } from '../library/types.ts';

const log = createLogger('library');

/** 搜索返回条数上限（防止一个很大的清单把响应撑爆） */
const MAX_SEARCH_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 60;

/**
 * 猜一个文件名给 ingest 用。
 *
 * 歌名/歌手是清单里显式给的（比从文件名猜准），这里真正需要的只是**扩展名** ——
 * ingest 用它做格式判定与落盘命名。拿不到就交给 ingest 按 kind 兜底。
 */
function fileNameFor(item: LibraryItem): string {
  try {
    const base = path.basename(new URL(item.url).pathname);
    if (base && base !== '/') return decodeURIComponent(base);
  } catch {
    // URL 解析不了就交给兜底
  }
  return item.kind === 'video' ? 'karaoke.mp4' : 'karaoke.mp3';
}

export function createLibraryRouter(registry: LibraryRegistry): Router {
  const router = Router();

  /** 当前配了哪些源；没配时前端据此显示配置指引 */
  router.get('/sources', (_req, res) => {
    res.json({
      sources: registry.providers.map((provider) => ({ id: provider.id, label: provider.label })),
    });
  });

  router.get('/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const kindRaw = req.query.kind;
    const kind: LibraryItemKind | null =
      kindRaw === 'audio' || kindRaw === 'video' ? kindRaw : null;
    const limit = clampInt(req.query.limit, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);

    try {
      const result = await registry.searchAll({ q, kind, limit });
      res.json(result);
    } catch (error) {
      // searchAll 内部已经逐源兜底了，走到这里基本是意料之外的问题
      log.error('曲库搜索失败', { error });
      res.status(500).json({ error: '曲库搜索失败' });
    }
  });

  /**
   * 点歌：把条目下载到本地并入库。
   *
   * 立即返回 taskId（202），真正的下载/入库/转码走单并发任务队列 ——
   * 大 MV 几百 MB，同步等会把请求挂死。
   */
  router.post('/download', async (req, res) => {
    const body = req.body as { providerId?: unknown; itemId?: unknown };
    const providerId = typeof body.providerId === 'string' ? body.providerId : '';
    const itemId = typeof body.itemId === 'string' ? body.itemId : '';
    if (!providerId || !itemId) {
      res.status(400).json({ error: '缺少 providerId 或 itemId' });
      return;
    }

    const provider = registry.find(providerId);
    if (!provider) {
      res.status(404).json({ error: '这个曲库源没有配置（可能改过 LIBRARY_SOURCES）' });
      return;
    }

    // 去重：这个条目点过就直接回已有的伴奏，不再下一份
    const ref = libraryRef(providerId, itemId);
    const existing = getTrackByLibraryRef(ref);
    if (existing) {
      res.json({ track: trackToDetail(existing), alreadyImported: true });
      return;
    }

    let item: LibraryItem | undefined;
    try {
      item = await provider.resolve(itemId);
    } catch (error) {
      res.status(502).json({
        error: `曲库源不可用：${error instanceof Error ? error.message : '未知错误'}`,
      });
      return;
    }
    if (!item) {
      res.status(404).json({ error: '曲库里找不到这个伴奏（源站清单可能变了，请重新搜索）' });
      return;
    }

    const jobKey = downloadJobKey(providerId, itemId);
    if (isQueued(jobKey)) {
      res.status(409).json({ error: '这个伴奏正在下载中，请稍候' });
      return;
    }

    const task = createTask(jobKey, item.title);

    enqueue(
      jobKey,
      async (report) => {
        patchTask(task.taskId, { state: 'running' });
        const tmpPath = path.join(TMP_DIR, `library-${randomUUID()}`);

        try {
          const bytes = await downloadToFile({
            url: item.url,
            destPath: tmpPath,
            maxBytes: MAX_UPLOAD_BYTES,
            timeoutMs: LIBRARY_DOWNLOAD_TIMEOUT_MS,
            onProgress: report,
          });

          // 歌词是附赠的：源站给了就顺手带上，拉不到就算了
          let lyrics: string | null = null;
          if (item.lrcUrl) {
            const raw = await fetchText(item.lrcUrl, LRC_LIMITS.maxBytes, LIBRARY_SEARCH_TIMEOUT_MS);
            if (raw) {
              const normalized = normalizeLrc(raw);
              lyrics = hasLrcTimeline(normalized) ? normalized : null;
            }
          }

          const result = await ingestFile({
            tmpPath,
            originalName: fileNameFor(item),
            title: item.title,
            artist: item.artist,
            mime: null,
            size: bytes,
            source: 'library',
            libraryRef: ref,
            lyrics,
          });

          patchTask(task.taskId, { state: 'done', progress: 1, trackId: result.track.id });
          log.info(`点歌完成：${item.title}`, {
            trackId: result.track.id,
            providerId,
            itemId,
            withLyrics: Boolean(lyrics),
          });
        } catch (error) {
          // ingestFile 成功时已经把 tmp 移走了；失败时这里负责清干净
          await discardTmp(tmpPath);
          throw error;
        }
      },
      (error) => {
        patchTask(task.taskId, { state: 'failed', error: error.message });
      },
    );

    res.status(202).json({ taskId: task.taskId, title: item.title });
  });

  /** 轮询下载进度；任务表在进程内，重启后 404 让前端提示重试 */
  router.get('/tasks/:taskId', (req, res) => {
    const rawId = req.params.taskId;
    const taskId = Array.isArray(rawId) ? (rawId[0] ?? '') : (rawId ?? '');
    const task = getTask(taskId);
    if (!task) {
      res.status(404).json({ error: '任务不存在（服务可能重启过），请重新点歌' });
      return;
    }

    // 运行中直接读任务队列的进度：省得在下载循环里每块都写一次状态
    const progress =
      task.state === 'running' ? (getProgress(task.jobKey) ?? task.progress) : task.progress;
    res.json(toLibraryTaskDto(task, progress));
  });

  return router;
}
