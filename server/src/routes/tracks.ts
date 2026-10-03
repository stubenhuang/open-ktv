import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { LRC_LIMITS, MAX_UPLOAD_BYTES } from '../../../shared/types.ts';
import { hasLrcTimeline, normalizeLrc } from '../../../shared/lrc.ts';
import { clampInt } from '../../../shared/numbers.ts';
import {
  countWorksForTrack,
  deleteTrack,
  getTrack,
  listTracks,
  updateTrack,
  type TrackRecord,
} from '../db.ts';
import { transcodeKey, trackToDetail, trackToListItem } from '../dto.ts';
import { isQueued } from '../jobs.ts';
import { createLogger } from '../logger.ts';
import { forgetTrackLoudness } from '../mixJob.ts';
import { decodeOriginalName } from '../naming.ts';
import { PROXIES_DIR } from '../paths.ts';
import { probeAndClassify } from '../probe.ts';
import type { ProxyTarget } from '../transcode.ts';
import { ingestFile, startTranscode } from '../tracks/ingest.ts';
import { uploadEndpoint } from '../upload.ts';
import { withRecord } from './guard.ts';
import type { LyricsLookup } from '../library/lyrics/types.ts';

const log = createLogger('track');

export interface TracksRouterDeps {
  /** 歌词源；null = 未启用（只能手动贴/传 .lrc） */
  lyrics?: LyricsLookup | null;
}

/**
 * 伴奏路由。
 *
 * 工厂而不是模块级常量：歌词源要能注入（测试用假的，生产用酷狗），
 * 而且「歌词从哪来」这件事不该由模块加载时的全局状态决定。
 */
export function createTracksRouter(deps: TracksRouterDeps = {}): Router {
  const router = Router();

/** 「取伴奏 → 404 → 业务处理」；404 文案只在这里写一份 */
const withTrack = (handler: (req: Request, res: Response, track: TrackRecord) => void) =>
  withRecord({ load: getTrack, notFound: '伴奏不存在', handler });

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
      const body = req.body as Record<string, string | undefined>;
      // 探测 / 命名 / 入库 / 按需转码全在 ingestFile 里 ——
      // 与「曲库点歌下载」共用同一条链路，两条入口的行为不会分叉
      const result = await ingestFile({
        tmpPath: file.path,
        originalName: file.originalname,
        title: body.title ?? null,
        artist: body.artist ?? null,
        mime: file.mimetype || null,
        size: file.size,
        source: 'upload',
      });
      res.status(201).json(trackToDetail(result.track));
    },
  }),
);

router.get('/', (_req, res) => {
  res.json(listTracks().map(trackToListItem));
});

router.get(
  '/:id',
  withTrack((_req, res, record) => {
    res.json(trackToDetail(record));
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
          res.json(trackToDetail(getTrack(record.id)!));
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
        res.status(202).json(trackToDetail(getTrack(record.id)!));
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        updateTrack(record.id, { status: 'failed', error: message });
        log.error(`重试伴奏 ${record.id} 失败`, { error });
        res.status(400).json({ error: message });
      }
    })();
  }),
);

/**
 * 解析并校验要入库的歌词文本。
 *
 * 返回 `{ ok: true, lyrics }` 或 `{ ok: false, error }`。
 * 空串 / null 表示「清除歌词」，是合法操作。
 */
function parseLyricsInput(
  raw: unknown,
): { ok: true; lyrics: string | null } | { ok: false; error: string } {
  // 显式清空：null 或空串
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, lyrics: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: '歌词必须是文本' };
  }
  if (raw.length > LRC_LIMITS.maxChars) {
    return { ok: false, error: `歌词太长了（最多 ${LRC_LIMITS.maxChars} 字）` };
  }

  const normalized = normalizeLrc(raw);
  // 规范化后一行时间戳都不剩 → 这不是 LRC，是纯文本歌词。
  // 不静默降级成「静态歌词」：演唱页要按时间轴滚动，存进去也放不出来。
  if (!hasLrcTimeline(normalized)) {
    return {
      ok: false,
      error:
        '这看起来不是 LRC 歌词：至少要有一行 [mm:ss] 或 [mm:ss.xx] 时间戳。' +
        '纯文本歌词无法跟唱，请先给每行加上时间戳。',
    };
  }
  return { ok: true, lyrics: normalized };
}

router.patch(
  '/:id',
  withTrack((req, res, record) => {
    const body = req.body as { title?: unknown; artist?: unknown; lyrics?: unknown; lyricsOffsetMs?: unknown };
    const patch: {
      title?: string;
      artist?: string | null;
      lyrics?: string | null;
      lyricsOffsetMs?: number;
    } = {};

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

    if (body.lyrics !== undefined) {
      const parsed = parseLyricsInput(body.lyrics);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      patch.lyrics = parsed.lyrics;
    }

    if (body.lyricsOffsetMs !== undefined) {
      patch.lyricsOffsetMs = clampInt(
        body.lyricsOffsetMs,
        LRC_LIMITS.offsetMs.min,
        LRC_LIMITS.offsetMs.max,
        record.lyricsOffsetMs,
      );
    }

    updateTrack(record.id, patch);
    res.json(trackToDetail(getTrack(record.id)!));
  }),
);

/** 路由参数里的 id（通配路由下可能是数组，只取第一段） */
function readId(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
}

/**
 * 上传 .lrc 文件设置歌词。
 *
 * 单独一个端点（而不是塞进 PATCH）是因为它要走 multipart ——
 * 复用 uploadEndpoint 就能白拿「临时文件 + 大小上限 + 失败清理」那一整套。
 * 校验逻辑与 PATCH 共用 parseLyricsInput，两条路的口径不会分叉。
 *
 * multer 实例在模块加载时建一次即可，不能每个请求都 new 一个。
 */
const receiveLyrics = uploadEndpoint({
  field: 'lyrics',
  maxBytes: LRC_LIMITS.maxBytes,
  tmpPrefix: 'lrc',
  sizeLimitMessage: `歌词文件超过 ${Math.round(LRC_LIMITS.maxBytes / 1024)}KB 上限`,
  missingFileMessage: '没有收到歌词文件（表单字段名应为 lyrics）',
  errorLabel: '上传歌词失败',
  logMessage: '上传歌词失败',
  handle: async (uploadReq, uploadRes, file) => {
    // 上传期间伴奏可能被删掉，这里重新取一次
    const record = getTrack(readId(uploadReq));
    if (!record) {
      uploadRes.status(404).json({ error: '伴奏不存在' });
      return;
    }

    const extension = path.extname(decodeOriginalName(file.originalname)).toLowerCase();
    if (extension && extension !== '.lrc' && extension !== '.txt') {
      uploadRes.status(400).json({ error: '只支持 .lrc / .txt 歌词文件' });
      return;
    }

    // LRC 一律按 UTF-8 读（UTF-8 是 LRC 的事实标准，BOM 由 parseLrc 剥掉）
    const text = await fs.promises.readFile(file.path, 'utf8');
    const parsed = parseLyricsInput(text);
    if (!parsed.ok) {
      uploadRes.status(400).json({ error: parsed.error });
      return;
    }

    updateTrack(record.id, { lyrics: parsed.lyrics });
    log.info(`伴奏 ${record.id} 的歌词已更新（来自文件）`, {
      id: record.id,
      bytes: file.size,
    });
    uploadRes.json(trackToDetail(getTrack(record.id)!));
  },
});

router.post('/:id/lyrics', (req, res) => {
  // 先判 404 再收文件：给不存在的伴奏传几十 KB 上去纯属浪费
  if (!getTrack(readId(req))) {
    res.status(404).json({ error: '伴奏不存在' });
    return;
  }
  receiveLyrics(req, res);
});

/**
 * 自动补歌词：按歌名/歌手问歌词源（默认酷狗），找到就入库。
 *
 * 与点歌时的自动走同一条 find —— 上传的伴奏当时没歌词，后来想补就用这个。
 * 时长已知（入库时探测过），传给歌词源用来挑对版本，比点歌时更准。
 */
router.post(
  '/:id/lyrics/auto',
  withTrack(async (_req, res, record) => {
    if (!deps.lyrics) {
      res.status(400).json({ error: '歌词源没有启用（KUGOU_LYRICS_ENABLED=0？）' });
      return;
    }

    const found = await deps.lyrics.find({
      title: record.title,
      artist: record.artist,
      durationSec: record.duration,
    });
    if (!found) {
      res.status(404).json({
        error: '没找到带时间轴的 LRC 歌词，可以手动上传 .lrc 文件',
      });
      return;
    }

    const parsed = parseLyricsInput(found);
    if (!parsed.ok) {
      // find 返回的理论上都是规范化过的；真出事按「没找到」处理，别把 500 抛给用户
      res.status(404).json({ error: '匹配到的歌词不可用，可以手动上传 .lrc 文件' });
      return;
    }

    updateTrack(record.id, { lyrics: parsed.lyrics });
    log.info(`伴奏 ${record.id} 的歌词已更新（来自歌词源）`, { id: record.id });
    res.json(trackToDetail(getTrack(record.id)!));
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

  return router;
}
