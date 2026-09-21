import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import {
  DEFAULT_MIX_PARAMS,
  MAX_RECORD_MS,
  MIN_RECORD_MS,
  MIX_LIMITS,
  type MixParams,
  type ReverbKind,
} from '../../../shared/types.ts';
import { deleteWork, getTrack, getWork, insertWork, listWorks, updateWork } from '../db.ts';
import { mixKey, workToDto, workToListItem } from '../dto.ts';
import { isQueued, enqueue } from '../jobs.ts';
import { createLogger } from '../logger.ts';
import { sendMedia } from '../media.ts';
import { mixWorkToMp3, workMp3Path } from '../mixJob.ts';
import { VOCALS_DIR, TMP_DIR } from '../paths.ts';
import { probeFile } from '../probe.ts';
import { decodeOriginalName, safeExtension } from '../naming.ts';

const log = createLogger('work');

const router = Router();

const REVERBS: ReverbKind[] = ['dry', 'room', 'hall', 'stage'];
/** 干声上限：15 分钟 48k 单声道 16bit WAV 约 86MB，留足余量 */
const MAX_VOCAL_BYTES = 256 * 1024 * 1024;

const uploadVocal = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, TMP_DIR),
    filename: (_req, _file, callback) => callback(null, `vocal-${randomUUID()}`),
  }),
  limits: { fileSize: MAX_VOCAL_BYTES, files: 1 },
}).single('vocal');

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function sanitizeMixParams(input: unknown, base: MixParams): MixParams {
  const raw = (input ?? {}) as Record<string, unknown>;
  const reverb = REVERBS.includes(raw.reverb as ReverbKind)
    ? (raw.reverb as ReverbKind)
    : base.reverb;

  return {
    vocalGain: clampNumber(raw.vocalGain, MIX_LIMITS.gain.min, MIX_LIMITS.gain.max, base.vocalGain),
    accompGain: clampNumber(
      raw.accompGain,
      MIX_LIMITS.gain.min,
      MIX_LIMITS.gain.max,
      base.accompGain,
    ),
    reverb,
    userOffsetMs: Math.round(
      clampNumber(
        raw.userOffsetMs,
        MIX_LIMITS.userOffsetMs.min,
        MIX_LIMITS.userOffsetMs.max,
        base.userOffsetMs,
      ),
    ),
  };
}

function formatStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 入队一次混音；任务内部重新读库，保证用的是最新的 mixParams */
function startMix(workId: string): void {
  enqueue(
    mixKey(workId),
    async (report) => {
      const work = getWork(workId);
      if (!work) throw new Error('作品记录已不存在');
      const track = getTrack(work.trackId);
      if (!track) throw new Error('对应的伴奏已被删除');

      const result = await mixWorkToMp3({ work, track, onProgress: report });
      updateWork(workId, {
        status: 'ready',
        error: null,
        mp3Path: result.outputPath,
        // 实测增益跟着作品走：前端实时预览复算同一套电平，试听才和成品对得上
        levels: { vocalGainDb: result.vocalGainDb, accompGainDb: result.accompGainDb },
      });
      log.info(
        `${work.title}｜对齐偏移 ${result.offsetMs}ms｜人声 ${result.vocalGainDb.toFixed(1)}dB ` +
          `×${work.mixParams.vocalGain}｜伴奏 ${result.accompGainDb.toFixed(1)}dB ×${work.mixParams.accompGain}｜` +
          `混响 ${work.mixParams.reverb}`,
        { id: workId, trackId: work.trackId },
      );
    },
    (error) => {
      updateWork(workId, { status: 'failed', error: error.message });
    },
  );
}

router.post('/', (req, res) => {
  uploadVocal(req, res, (uploadError: unknown) => {
    const cleanup = () => {
      if (req.file) void fs.promises.rm(req.file.path, { force: true });
    };

    if (uploadError) {
      cleanup();
      const err = uploadError as { code?: string; message?: string };
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: '录音文件超过 256MB，可能是录制时间过长' });
        return;
      }
      res.status(400).json({ error: `上传录音失败：${err.message ?? '未知错误'}` });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: '没有收到录音文件（表单字段名应为 vocal）' });
      return;
    }

    void (async () => {
      try {
        const body = req.body as Record<string, string | undefined>;
        const trackId = (body.trackId ?? '').trim();
        const track = trackId ? getTrack(trackId) : undefined;

        if (!track) {
          cleanup();
          res.status(400).json({ error: '请指定一个有效的伴奏' });
          return;
        }
        if (track.status !== 'ready') {
          cleanup();
          res.status(409).json({ error: '这个伴奏还在转码中，暂时不能演唱' });
          return;
        }

        // 用 ffprobe 拿真实时长，顺便验证录音文件没坏
        const probed = await probeFile(file.path);
        const probeDuration = Number(probed.format?.duration);
        const clientDuration = Number(body.vocalDuration);
        const durationSec = Number.isFinite(probeDuration) && probeDuration > 0
          ? probeDuration
          : Number.isFinite(clientDuration) && clientDuration > 0
            ? clientDuration
            : 0;

        if (durationSec * 1000 < MIN_RECORD_MS) {
          cleanup();
          res.status(400).json({ error: '录音太短了，请完整唱一段再结束' });
          return;
        }
        if (durationSec * 1000 > MAX_RECORD_MS + 5000) {
          cleanup();
          res.status(400).json({ error: '录音超过 15 分钟上限，已拒绝' });
          return;
        }

        const id = randomUUID();
        const extension = safeExtension(decodeOriginalName(file.originalname), '.wav');
        const vocalPath = path.join(VOCALS_DIR, `${id}${extension}`);
        await fs.promises.rename(file.path, vocalPath);

        const autoOffsetMs = Math.round(clampNumber(body.autoOffsetMs, 0, 30_000, 0));
        const mixParams = sanitizeMixParams(undefined, DEFAULT_MIX_PARAMS);

        insertWork({
          id,
          trackId: track.id,
          title: `${track.title}（我的演唱 ${formatStamp(new Date())}）`,
          vocalPath,
          vocalDuration: durationSec,
          autoOffsetMs,
          mixParams,
          status: 'mixing',
        });

        startMix(id);
        log.info(`新作品 ${id}`, {
          trackId: track.id,
          title: track.title,
          vocalDurationSec: Number(durationSec.toFixed(2)),
          autoOffsetMs,
        });
        res.status(202).json(workToDto(getWork(id)!));
      } catch (error) {
        cleanup();
        const message = error instanceof Error ? error.message : '未知错误';
        log.error('创建作品失败', { error });
        res.status(400).json({ error: message });
      }
    })();
  });
});

router.get('/', (_req, res) => {
  const items = listWorks().map((work) => workToListItem(work, getTrack(work.trackId)));
  res.json(items);
});

router.get('/:id', (req, res) => {
  const work = getWork(req.params.id);
  if (!work) {
    res.status(404).json({ error: '作品不存在' });
    return;
  }
  const track = getTrack(work.trackId);
  res.json({ ...workToDto(work), trackTitle: track?.title ?? null, trackKind: track?.kind ?? null });
});

router.patch('/:id', (req, res) => {
  const work = getWork(req.params.id);
  if (!work) {
    res.status(404).json({ error: '作品不存在' });
    return;
  }

  const body = req.body as { title?: unknown };
  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) {
      res.status(400).json({ error: '作品名不能为空' });
      return;
    }
    if (title.length > 120) {
      res.status(400).json({ error: '作品名太长（最多 120 字）' });
      return;
    }
    updateWork(work.id, { title });
  }

  const updated = getWork(work.id)!;
  res.json(workToDto(updated));
});

router.post('/:id/mix', (req, res) => {
  const work = getWork(req.params.id);
  if (!work) {
    res.status(404).json({ error: '作品不存在' });
    return;
  }
  if (isQueued(mixKey(work.id))) {
    res.status(409).json({ error: '上一次重新生成还没结束，请稍等几秒' });
    return;
  }

  const mixParams = sanitizeMixParams(req.body, work.mixParams);
  updateWork(work.id, { mixParams, status: 'mixing', error: null });
  startMix(work.id);

  res.status(202).json(workToDto(getWork(work.id)!));
});

router.get('/:id/audio', (req, res) => {
  const work = getWork(req.params.id);
  if (!work) {
    res.status(404).json({ error: '作品不存在' });
    return;
  }
  if (work.status !== 'ready' || !work.mp3Path) {
    res.status(409).json({ error: work.error ?? '作品还在生成中，请稍候' });
    return;
  }
  const download = req.query.download === '1';
  sendMedia(res, work.mp3Path, download ? `${work.title}.mp3` : undefined);
});

router.get('/:id/vocal', (req, res) => {
  const work = getWork(req.params.id);
  if (!work) {
    res.status(404).json({ error: '作品不存在' });
    return;
  }
  sendMedia(res, work.vocalPath, req.query.download === '1' ? `${work.title}-干声.wav` : undefined);
});

router.delete('/:id', (req, res) => {
  const work = getWork(req.params.id);
  if (!work) {
    res.status(404).json({ error: '作品不存在' });
    return;
  }

  deleteWork(work.id);
  void fs.promises.rm(work.vocalPath, { force: true });
  void fs.promises.rm(workMp3Path(work.id), { force: true });

  log.info(`删除作品 ${work.title}`, { id: work.id });
  res.json({ ok: true });
});

export default router;
