//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

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
import { pitchStatusOf, transcodeKey, trackToDetail, trackToListItem } from '../dto.ts';
import { ensureFreeSpace } from '../disk.ts';
import { isQueued } from '../jobs.ts';
import { createLogger } from '../logger.ts';
import { detectFfmpegCapabilities } from '../ffmpegCapabilities.ts';
import { forgetTrackPitch, normalizeSemitones, startPitchShift } from '../pitch.ts';
import { forgetTrackLoudness } from '../mixJob.ts';
import { decodeOriginalName } from '../naming.ts';
import { PROXIES_DIR } from '../paths.ts';
import { probeAndClassify } from '../probe.ts';
import type { ProxyTarget } from '../transcode.ts';
import { ingestFile, startTranscode } from '../tracks/ingest.ts';
import { uploadEndpoint } from '../upload.ts';
import {
  fail,
  formatErrorMessage,
  readHttpError,
  type ApiErrorCode,
  type ApiErrorParams,
} from '../httpError.ts';
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
  withRecord({ load: getTrack, notFound: 'track_not_found', handler });

router.post(
  '/',
  uploadEndpoint({
    field: 'file',
    maxBytes: MAX_UPLOAD_BYTES,
    tmpPrefix: 'upload',
    sizeLimitCode: 'upload_too_large',
    missingFileCode: 'upload_missing_file',
    errorCode: 'upload_failed',
    logMessage: '上传处理失败',
    handle: async (req, res, file) => {
      const body = req.body as Record<string, string | undefined>;

      // 落盘前的空间预检：tmp 一份 + originals 一份 + 不能直接播的格式
      // 还要再转一份代理，所以按 3 倍估。不够就明说，别等 ffmpeg 写到
      // 一半才吐一句 "No space left on device"。
      await ensureFreeSpace(file.size * 3, '上传这个伴奏');

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
        // 手动上传只收音频（伴奏库不再支持视频）；点歌下载不走这个开关
        allowVideo: false,
      });
      res.status(201).json(trackToDetail(result.track));
    },
  }),
);

router.get('/', (_req, res) => {
  // workCount 给删除确认用：删伴奏不再拦截作品，但要把「会保留几个作品」说清楚
  res.json(listTracks().map((track) => trackToListItem(track, countWorksForTrack(track.id))));
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
      fail(res, 409, 'track_already_ready');
      return;
    }
    if (isQueued(transcodeKey(record.id))) {
      fail(res, 409, 'track_processing');
      return;
    }
    if (!fs.existsSync(record.originalPath)) {
      fail(res, 410, 'track_original_missing');
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
        const { code, params } = readHttpError(error, 'track_update_failed', 400);
        updateTrack(record.id, { status: 'failed', error: formatErrorMessage(code, params) });
        log.error(`重试伴奏 ${record.id} 失败`, { error });
        fail(res, 400, code, params);
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
): { ok: true; lyrics: string | null } | { ok: false; code: ApiErrorCode; params?: ApiErrorParams } {
  // 显式清空：null 或空串
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, lyrics: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false, code: 'lyrics_not_text' };
  }
  if (raw.length > LRC_LIMITS.maxChars) {
    return { ok: false, code: 'lyrics_too_long', params: { limit: LRC_LIMITS.maxChars } };
  }

  const normalized = normalizeLrc(raw);
  // 规范化后一行时间戳都不剩 → 这不是 LRC，是纯文本歌词。
  // 不静默降级成「静态歌词」：演唱页要按时间轴滚动，存进去也放不出来。
  if (!hasLrcTimeline(normalized)) {
    return { ok: false, code: 'lyrics_not_lrc' };
  }
  return { ok: true, lyrics: normalized };
}

router.patch(
  '/:id',
  // 异步：升降调分支要现探一次 ffmpeg 能力（探测带缓存，第一次约 0.1 秒）
  withTrack(async (req, res, record) => {
    try {
      await patchTrack(req, res, record);
    } catch (error) {
      log.error('更新伴奏失败', { id: record.id, error });
      const { status, code, params } = readHttpError(error, 'track_update_failed', 500);
      fail(res, status, code, params);
    }
  }),
);

/** PATCH /:id 的业务本体（拆出来只是为了上面那层 try/catch 好写） */
async function patchTrack(req: Request, res: Response, record: TrackRecord): Promise<void> {
  const body = req.body as {
    title?: unknown;
    artist?: unknown;
    lyrics?: unknown;
    lyricsOffsetMs?: unknown;
    pitchSemitones?: unknown;
  };
  const patch: {
    title?: string;
    artist?: string | null;
    lyrics?: string | null;
    lyricsOffsetMs?: number;
    pitchSemitones?: number;
    pitchPath?: string | null;
    pitchError?: string | null;
  } = {};

  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) {
      fail(res, 400, 'track_title_empty');
      return;
    }
    if (title.length > 120) {
      fail(res, 400, 'track_title_too_long', { limit: 120 });
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
      fail(res, 400, parsed.code, parsed.params);
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

  if (body.pitchSemitones !== undefined) {
    const semitones = normalizeSemitones(body.pitchSemitones, record.pitchSemitones);
    // 值没变也要分两种情况：失败的移调要能重试（用户点了「重试」就是原值再发一次），
    // 已经好了的就当没发生（不重复排任务、不重复生成文件）。
    const wantsRetry = semitones === record.pitchSemitones && pitchStatusOf(record) === 'failed';

    if (semitones !== record.pitchSemitones || wantsRetry) {
      if (record.status !== 'ready') {
        fail(res, 409, 'pitch_not_allowed_while_processing');
        return;
      }
      if (semitones !== 0 && !(await detectFfmpegCapabilities()).rubberband) {
        fail(res, 400, 'pitch_rubberband_missing');
        return;
      }

      patch.pitchSemitones = semitones;
      // 换调 = 换一份伴奏：先把旧的移调结果作废（播放立刻回落到原调），
      // 生成成功后由任务把新路径写回来
      patch.pitchPath = null;
      patch.pitchError = null;
      // 顺手删掉磁盘上的旧文件：同时只留一份移调伴奏，别让 data/proxies 越堆越多
      forgetTrackPitch(record.id, record.pitchPath);

      if (semitones !== 0) {
        // 任务里重新读库，这里传的只是「用什么源、移到哪个调」
        startPitchShift({
          trackId: record.id,
          sourcePath: record.originalPath,
          semitones,
          kind: record.kind,
          durationSec: record.duration,
        });
        log.info(`伴奏 ${record.id}（${record.title}）升降调 → ${semitones > 0 ? '+' : ''}${semitones} 半音`);
      }
    }
  }

  updateTrack(record.id, patch);
  res.json(trackToDetail(getTrack(record.id)!));
}

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
  sizeLimitCode: 'upload_too_large',
  missingFileCode: 'upload_missing_file',
  errorCode: 'upload_failed',
  logMessage: '上传歌词失败',
  handle: async (uploadReq, uploadRes, file) => {
    // 上传期间伴奏可能被删掉，这里重新取一次
    const record = getTrack(readId(uploadReq));
    if (!record) {
      fail(uploadRes, 404, 'track_not_found');
      return;
    }

    const extension = path.extname(decodeOriginalName(file.originalname)).toLowerCase();
    if (extension && extension !== '.lrc' && extension !== '.txt') {
      fail(uploadRes, 400, 'lyrics_file_type');
      return;
    }

    // LRC 一律按 UTF-8 读（UTF-8 是 LRC 的事实标准，BOM 由 parseLrc 剥掉）
    const text = await fs.promises.readFile(file.path, 'utf8');
    const parsed = parseLyricsInput(text);
    if (!parsed.ok) {
      fail(uploadRes, 400, parsed.code, parsed.params);
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
    fail(res, 404, 'track_not_found');
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
      fail(res, 400, 'lyrics_source_disabled');
      return;
    }

    const found = await deps.lyrics.find({
      title: record.title,
      artist: record.artist,
      durationSec: record.duration,
    });
    if (!found) {
      fail(res, 404, 'lyrics_not_found');
      return;
    }

    const parsed = parseLyricsInput(found);
    if (!parsed.ok) {
      // find 返回的理论上都是规范化过的；真出事按「没找到」处理，别把 500 抛给用户
      fail(res, 404, 'lyrics_not_found');
      return;
    }

    updateTrack(record.id, { lyrics: parsed.lyrics });
    log.info(`伴奏 ${record.id} 的歌词已更新（来自歌词源）`, { id: record.id });
    res.json(trackToDetail(getTrack(record.id)!));
  }),
);

/**
 * 删除伴奏。
 *
 * 与作品解耦：以前「伴奏下有 N 个作品」会 409 拦住，用户得先去作品库删一圈。
 * 现在直接删 —— 作品记录和成品 MP3 都保留（由 works.track_id 的
 * ON DELETE SET NULL 自动脱钩），只是不能再试听 / 重新合成，
 * 作品库那边会把它们标成「伴奏已删除」。
 */
router.delete(
  '/:id',
  withTrack((_req, res, record) => {
    // 删前数一下：日志和响应都要告诉调用方留下了几个作品
    const keptWorks = countWorksForTrack(record.id);

    deleteTrack(record.id);
    forgetTrackLoudness(record.id);
    // 移调伴奏也是这个伴奏的派生文件，一起清掉（路径在库里，见 server/src/pitch.ts）
    forgetTrackPitch(record.id, record.pitchPath);
    void fs.promises.rm(record.originalPath, { force: true });
    if (record.playablePath !== record.originalPath) {
      void fs.promises.rm(record.playablePath, { force: true });
    }
    // 兜底：把可能残留的两种代理文件都清一遍
    void fs.promises.rm(path.join(PROXIES_DIR, `${record.id}.mp4`), { force: true });
    void fs.promises.rm(path.join(PROXIES_DIR, `${record.id}.mp3`), { force: true });
    // 移调伴奏同理（库里记的路径万一和磁盘对不上，这两行兜底）
    void fs.promises.rm(path.join(PROXIES_DIR, `${record.id}.pitch.mp4`), { force: true });
    void fs.promises.rm(path.join(PROXIES_DIR, `${record.id}.pitch.mp3`), { force: true });

    log.info(`删除伴奏 ${record.title}`, { id: record.id, keptWorks });
    res.json({ ok: true, keptWorks });
  }),
);

  return router;
}
