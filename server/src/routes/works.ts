import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  DEFAULT_MIX_PARAMS,
  MAX_RECORD_MS,
  MIN_RECORD_MS,
  MIX_LIMITS,
  REVERB_KINDS,
  VOCAL_PRESETS,
  type MixParams,
  type ReverbKind,
  type VocalPreset,
} from '../../../shared/types.ts';
import {
  deleteWork,
  getTrack,
  getWork,
  insertWork,
  listWorks,
  updateWork,
  type WorkRecord,
} from '../db.ts';
import { mixKey, workToDto, workToListItem } from '../dto.ts';
import { clampNumber } from '../../../shared/numbers.ts';
import { isQueued, enqueue } from '../jobs.ts';
import { createLogger } from '../logger.ts';
import { sendMedia } from '../media.ts';
import { mixWorkToMp3, workMp3Path } from '../mixJob.ts';
import { decodeOriginalName, safeExtension } from '../naming.ts';
import { VOCALS_DIR } from '../paths.ts';
import { probeFile } from '../probe.ts';
import { uploadEndpoint } from '../upload.ts';
import { withRecord } from './guard.ts';

const log = createLogger('work');

const router = Router();

/** 干声上限：15 分钟 48k 单声道 16bit WAV 约 86MB，留足余量 */
const MAX_VOCAL_BYTES = 256 * 1024 * 1024;

/** 「取作品 → 404 → 业务处理」；404 文案只在这里写一份 */
const withWork = (handler: (req: Request, res: Response, work: WorkRecord) => void) =>
  withRecord({ load: getWork, notFound: '作品不存在', handler });

export function sanitizeMixParams(input: unknown, base: MixParams): MixParams {
  const raw = (input ?? {}) as Record<string, unknown>;
  const reverb = REVERB_KINDS.includes(raw.reverb as ReverbKind)
    ? (raw.reverb as ReverbKind)
    : base.reverb;
  const vocalPreset = VOCAL_PRESETS.includes(raw.vocalPreset as VocalPreset)
    ? (raw.vocalPreset as VocalPreset)
    : base.vocalPreset;

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

    // 升降调必须是整数半音：rubberband 接受任意比值，但半音才是用户心智里的单位，
    // 而且小数会让「+1 半音」这种显示变得很难看
    pitchSemitones: Math.round(
      clampNumber(
        raw.pitchSemitones,
        MIX_LIMITS.semitones.min,
        MIX_LIMITS.semitones.max,
        base.pitchSemitones,
      ),
    ),
    accompSemitones: Math.round(
      clampNumber(
        raw.accompSemitones,
        MIX_LIMITS.semitones.min,
        MIX_LIMITS.semitones.max,
        base.accompSemitones,
      ),
    ),

    vocalPreset,
    eqLowDb: clampNumber(raw.eqLowDb, MIX_LIMITS.eqDb.min, MIX_LIMITS.eqDb.max, base.eqLowDb),
    eqMidDb: clampNumber(raw.eqMidDb, MIX_LIMITS.eqDb.min, MIX_LIMITS.eqDb.max, base.eqMidDb),
    eqHighDb: clampNumber(raw.eqHighDb, MIX_LIMITS.eqDb.min, MIX_LIMITS.eqDb.max, base.eqHighDb),
    compression: clampNumber(
      raw.compression,
      MIX_LIMITS.amount.min,
      MIX_LIMITS.amount.max,
      base.compression,
    ),
    deEss: clampNumber(raw.deEss, MIX_LIMITS.amount.min, MIX_LIMITS.amount.max, base.deEss),
    // 布尔开关：只认真正的 true / false，字符串 'false' 不该被当成开启
    noiseReduction:
      typeof raw.noiseReduction === 'boolean' ? raw.noiseReduction : base.noiseReduction,
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

router.post(
  '/',
  uploadEndpoint({
    field: 'vocal',
    maxBytes: MAX_VOCAL_BYTES,
    tmpPrefix: 'vocal',
    sizeLimitMessage: '录音文件超过 256MB，可能是录制时间过长',
    missingFileMessage: '没有收到录音文件（表单字段名应为 vocal）',
    errorLabel: '上传录音失败',
    logMessage: '创建作品失败',
    handle: async (req, res, file) => {
      const body = req.body as Record<string, string | undefined>;
      const trackId = (body.trackId ?? '').trim();
      const track = trackId ? getTrack(trackId) : undefined;

      if (!track) {
        res.status(400).json({ error: '请指定一个有效的伴奏' });
        return;
      }
      if (track.status !== 'ready') {
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
        res.status(400).json({ error: '录音太短了，请完整唱一段再结束' });
        return;
      }
      if (durationSec * 1000 > MAX_RECORD_MS + 5000) {
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
    },
  }),
);

router.get('/', (_req, res) => {
  const items = listWorks().map((work) => workToListItem(work, getTrack(work.trackId)));
  res.json(items);
});

router.get(
  '/:id',
  withWork((_req, res, work) => {
    const track = getTrack(work.trackId);
    res.json({ ...workToDto(work), trackTitle: track?.title ?? null, trackKind: track?.kind ?? null });
  }),
);

router.patch(
  '/:id',
  withWork((req, res, work) => {
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

    res.json(workToDto(getWork(work.id)!));
  }),
);

router.post(
  '/:id/mix',
  withWork((req, res, work) => {
    if (isQueued(mixKey(work.id))) {
      res.status(409).json({ error: '上一次合成还没结束，请稍等几秒' });
      return;
    }

    const mixParams = sanitizeMixParams(req.body, work.mixParams);
    updateWork(work.id, { mixParams, status: 'mixing', error: null });
    startMix(work.id);

    res.status(202).json(workToDto(getWork(work.id)!));
  }),
);

router.get(
  '/:id/audio',
  withWork((req, res, work) => {
    if (work.status !== 'ready' || !work.mp3Path) {
      res.status(409).json({ error: work.error ?? '作品还在生成中，请稍候' });
      return;
    }
    const download = req.query.download === '1';
    sendMedia(res, work.mp3Path, download ? `${work.title}.mp3` : undefined);
  }),
);

router.get(
  '/:id/vocal',
  withWork((req, res, work) => {
    sendMedia(res, work.vocalPath, req.query.download === '1' ? `${work.title}-干声.wav` : undefined);
  }),
);

router.delete(
  '/:id',
  withWork((_req, res, work) => {
    deleteWork(work.id);
    void fs.promises.rm(work.vocalPath, { force: true });
    void fs.promises.rm(workMp3Path(work.id), { force: true });

    log.info(`删除作品 ${work.title}`, { id: work.id });
    res.json({ ok: true });
  }),
);

export default router;
