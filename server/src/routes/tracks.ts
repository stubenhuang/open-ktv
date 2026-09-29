import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { MAX_UPLOAD_BYTES } from '../../../shared/types.ts';
import { findAudioStream } from '../classify.ts';
import {
  countWorksForTrack,
  deleteTrack,
  getTrack,
  insertTrack,
  listTracks,
  updateTrack,
  type TrackRecord,
} from '../db.ts';
import { transcodeKey, trackToListItem } from '../dto.ts';
import { isQueued, enqueue } from '../jobs.ts';
import { createLogger } from '../logger.ts';
import { forgetTrackLoudness } from '../mixJob.ts';
import { decodeOriginalName, parseNameParts, safeExtension } from '../naming.ts';
import { ORIGINALS_DIR, PROXIES_DIR } from '../paths.ts';
import { probeAndClassify } from '../probe.ts';
import { proxyPathFor, transcodeToProxy, type ProxyTarget } from '../transcode.ts';
import { uploadEndpoint } from '../upload.ts';
import { withRecord } from './guard.ts';

const log = createLogger('track');

const router = Router();

/** 「取伴奏 → 404 → 业务处理」；404 文案只在这里写一份 */
const withTrack = (handler: (req: Request, res: Response, track: TrackRecord) => void) =>
  withRecord({ load: getTrack, notFound: '伴奏不存在', handler });

function startTranscode(trackId: string, sourcePath: string, durationSec: number | null, target: ProxyTarget): void {
  const outputPath = proxyPathFor(trackId, target);

  enqueue(
    transcodeKey(trackId),
    async (report) => {
      await fs.promises.rm(outputPath, { force: true });
      await transcodeToProxy({ sourcePath, outputPath, target, durationSec, onProgress: report });
      updateTrack(trackId, {
        status: 'ready',
        error: null,
        playablePath: outputPath,
        proxyKind: target,
      });
    },
    (error) => {
      updateTrack(trackId, { status: 'failed', error: error.message });
      void fs.promises.rm(outputPath, { force: true });
    },
  );
}

router.post(
  '/',
  uploadEndpoint({
    field: 'file',
    maxBytes: MAX_UPLOAD_BYTES,
    tmpPrefix: 'upload',
    sizeLimitMessage: `文件超过 ${(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024).toFixed(0)}GB 上限，请先压缩或裁剪后再上传`,
    missingFileMessage: '没有收到文件（表单字段名应为 file）',
    errorLabel: '上传失败',
    logMessage: '上传处理失败',
    handle: async (req, res, file) => {
      // multipart 的 filename 默认按 latin1 解出来，中文必须先还原
      const originalName = decodeOriginalName(file.originalname);
      const probed = await probeAndClassify(file.path, {
        extension: path.extname(originalName).toLowerCase(),
      });

      if (!findAudioStream(probed.raw)) {
        res.status(400).json({ error: '这个文件里没有音频轨，无法作为伴奏使用' });
        return;
      }

      const { title: parsedTitle, artist: parsedArtist } = parseNameParts(originalName);
      const id = randomUUID();
      const extension = safeExtension(originalName, probed.kind === 'video' ? '.mp4' : '.mp3');
      const originalPath = path.join(ORIGINALS_DIR, `${id}${extension}`);
      await fs.promises.rename(file.path, originalPath);

      const body = req.body as Record<string, string | undefined>;
      const title = (body.title ?? '').trim() || parsedTitle;
      const artist = (body.artist ?? '').trim() || parsedArtist;

      const target: ProxyTarget = probed.kind === 'video' ? 'video' : 'audio';
      const needsProxy = !probed.playable;

      insertTrack({
        id,
        title,
        artist,
        kind: probed.kind,
        originalName,
        originalPath,
        playablePath: needsProxy ? proxyPathFor(id, target) : originalPath,
        proxyKind: needsProxy ? target : 'none',
        mime: file.mimetype || null,
        size: file.size,
        duration: probed.durationSec,
        status: needsProxy ? 'processing' : 'ready',
        error: null,
      });

      if (needsProxy) {
        startTranscode(id, originalPath, probed.durationSec, target);
      }

      const record = getTrack(id)!;
      log.info(`${title}（${probed.kind}）→ ${needsProxy ? `转码 ${target}` : '直接可用'}：${probed.reason}`, {
        id,
        artist: artist ?? undefined,
        durationSec: probed.durationSec ?? undefined,
        size: file.size,
      });
      res.status(201).json(trackToListItem(record));
    },
  }),
);

router.get('/', (_req, res) => {
  res.json(listTracks().map(trackToListItem));
});

router.get(
  '/:id',
  withTrack((_req, res, record) => {
    res.json(trackToListItem(record));
  }),
);

/**
 * 重试失败的伴奏。
 *
 * 主要救「转码跑到一半服务重启」这种情况：原文件还在磁盘上，
 * 重新探测一次就能再排一次转码，不用让用户重新上传。
 */
router.post(
  '/:id/retry',
  withTrack((_req, res, record) => {
    if (record.status === 'ready') {
      res.status(409).json({ error: '这个伴奏已经是可用状态了' });
      return;
    }
    if (isQueued(transcodeKey(record.id))) {
      res.status(409).json({ error: '这个伴奏正在处理中，请稍候' });
      return;
    }
    if (!fs.existsSync(record.originalPath)) {
      res.status(410).json({ error: '原始文件已经不在了，只能删除后重新上传' });
      return;
    }

    void (async () => {
      try {
        const probed = await probeAndClassify(record.originalPath, {
          extension: path.extname(record.originalName).toLowerCase(),
        });

        if (probed.playable) {
          updateTrack(record.id, {
            status: 'ready',
            error: null,
            playablePath: record.originalPath,
            proxyKind: 'none',
            duration: probed.durationSec,
          });
          res.json(trackToListItem(getTrack(record.id)!));
          return;
        }

        const target: ProxyTarget = probed.kind === 'video' ? 'video' : 'audio';
        updateTrack(record.id, {
          status: 'processing',
          error: null,
          proxyKind: target,
          duration: probed.durationSec,
        });
        startTranscode(record.id, record.originalPath, probed.durationSec, target);
        log.info(`重试伴奏 ${record.id}（${record.title}）→ 转码 ${target}`);
        res.status(202).json(trackToListItem(getTrack(record.id)!));
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        updateTrack(record.id, { status: 'failed', error: message });
        log.error(`重试伴奏 ${record.id} 失败`, { error });
        res.status(400).json({ error: message });
      }
    })();
  }),
);

router.patch(
  '/:id',
  withTrack((req, res, record) => {
    const body = req.body as { title?: unknown; artist?: unknown };
    const patch: { title?: string; artist?: string | null } = {};

    if (body.title !== undefined) {
      const title = String(body.title).trim();
      if (!title) {
        res.status(400).json({ error: '歌名不能为空' });
        return;
      }
      if (title.length > 120) {
        res.status(400).json({ error: '歌名太长（最多 120 字）' });
        return;
      }
      patch.title = title;
    }

    if (body.artist !== undefined) {
      const artist = String(body.artist ?? '').trim();
      patch.artist = artist || null;
    }

    updateTrack(record.id, patch);
    res.json(trackToListItem(getTrack(record.id)!));
  }),
);

router.delete(
  '/:id',
  withTrack((_req, res, record) => {
    const workCount = countWorksForTrack(record.id);
    if (workCount > 0) {
      res.status(409).json({
        error: `这个伴奏下还有 ${workCount} 个作品，请先到作品库删除它们再删伴奏`,
      });
      return;
    }

    deleteTrack(record.id);
    forgetTrackLoudness(record.id);
    void fs.promises.rm(record.originalPath, { force: true });
    if (record.playablePath !== record.originalPath) {
      void fs.promises.rm(record.playablePath, { force: true });
    }
    // 兜底：把可能残留的两种代理文件都清一遍
    void fs.promises.rm(path.join(PROXIES_DIR, `${record.id}.mp4`), { force: true });
    void fs.promises.rm(path.join(PROXIES_DIR, `${record.id}.mp3`), { force: true });

    log.info(`删除伴奏 ${record.title}`, { id: record.id });
    res.json({ ok: true });
  }),
);

export default router;
