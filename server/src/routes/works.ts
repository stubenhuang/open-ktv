//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

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
  RETAKE_LIMITS,
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
import { ensureFreeSpace } from '../disk.ts';
import { clampNumber } from '../../../shared/numbers.ts';
import { anchorSpace, describePitch, describeReverb } from '../../../shared/mix.ts';
import { isQueued, enqueue } from '../jobs.ts';
import { createLogger } from '../logger.ts';
import { sendMedia } from '../media.ts';
import { mixWorkToMp3, workMp3Path } from '../mixJob.ts';
import { decodeOriginalName, safeExtension } from '../naming.ts';
import { effectivePitchSemitones } from '../pitch.ts';
import { VOCALS_DIR } from '../paths.ts';
import { probeFile } from '../probe.ts';
import { uploadEndpoint } from '../upload.ts';
import { spliceRetakeIntoVocal, undoRetake, backupVocalPath } from '../vocalSplice.ts';
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
  // 新字段（空间/湿度）优先；只带旧档位名时按锚点迁移（老客户端/陈旧标签页）
  const legacyKind = REVERB_KINDS.includes(raw.reverb as ReverbKind)
    ? (raw.reverb as ReverbKind)
    : null;
  const reverbSpace = clampNumber(
    raw.reverbSpace,
    MIX_LIMITS.reverb.space.min,
    MIX_LIMITS.reverb.space.max,
    legacyKind ? anchorSpace(legacyKind) : base.reverbSpace,
  );
  const reverbWet = clampNumber(
    raw.reverbWet,
    MIX_LIMITS.reverb.wet.min,
    MIX_LIMITS.reverb.wet.max,
    legacyKind ? 1 : base.reverbWet,
  );
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
    reverbSpace,
    reverbWet,
    userOffsetMs: Math.round(
      clampNumber(
        raw.userOffsetMs,
        MIX_LIMITS.userOffsetMs.min,
        MIX_LIMITS.userOffsetMs.max,
        base.userOffsetMs,
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

/**
 * 成品 MP3 的文件大小；文件丢失 / 还没合成出来时给 null。
 *
 * 列表接口要展示「4.2 MB」这类信息，又不想为它单独存一列 —— 文件就在
 * 本地磁盘上，stat 一下就行。只对 ready 的作品查：mixing / failed 时
 * mp3Path 要么是 null 要么是上一次的旧文件，查了也是错信息。
 */
function mp3Size(work: WorkRecord): number | null {
  if (work.status !== 'ready' || !work.mp3Path) return null;
  try {
    return fs.statSync(work.mp3Path).size;
  } catch {
    // 文件被外部删掉：大小这个字段不要就是了，别让整个列表 500
    return null;
  }
}

/** 入队一次混音；任务内部重新读库，保证用的是最新的 mixParams */
function startMix(workId: string): void {
  enqueue(
    mixKey(workId),
    async (report) => {
      const work = getWork(workId);
      if (!work) throw new Error('作品记录已不存在');
      if (!work.trackId) throw new Error('伴奏已删除，这个作品不能再重新合成');
      const track = getTrack(work.trackId);
      if (!track) throw new Error('对应的伴奏已被删除');

      // 快照「这一版混的是哪个调」。必须在 mixWorkToMp3 之前：移调还在生成中
      // （pitchPath 为空）时混进去的其实是原调，effectivePitchSemitones 会据实
      // 给 0。所有重新合成的入口都走这里，所以徽章永远和成品对得上。
      const pitchSemitones = effectivePitchSemitones(track);
      if (work.pitchSemitones !== pitchSemitones) {
        updateWork(workId, { pitchSemitones });
        work.pitchSemitones = pitchSemitones;
      }

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
          `混响 ${describeReverb(work.mixParams.reverbSpace, work.mixParams.reverbWet)}` +
          `｜${describePitch(work.pitchSemitones)}`,
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

      // 落盘前预检：干声 WAV + 混音时的预处理 WAV + 成品 mp3，按 2 倍估
      await ensureFreeSpace(file.size * 2, '保存这条录音');
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
        // 这份干声是照哪个调唱的，作品自己记一份（startMix 会按混音时的实情再校正一次）
        pitchSemitones: effectivePitchSemitones(track),
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
  // 伴奏被删掉的作品（track_id 为 null）照样列出来：成品 MP3 还能播放/下载
  const items = listWorks().map((work) =>
    workToListItem(work, work.trackId ? getTrack(work.trackId) : undefined, mp3Size(work)),
  );
  res.json(items);
});

router.get(
  '/:id',
  withWork((_req, res, work) => {
    const track = work.trackId ? getTrack(work.trackId) : undefined;
    // 走 workToListItem：字段与列表项同构（含 hasPrevVocal），前端一份类型通吃
    res.json(workToListItem(work, track, mp3Size(work)));
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

router.post(
  '/:id/retake',
  uploadEndpoint({
    field: 'segment',
    maxBytes: MAX_VOCAL_BYTES,
    tmpPrefix: 'retake',
    sizeLimitMessage: '重录片段超过 256MB，可能是录制时间过长',
    missingFileMessage: '没有收到重录片段（表单字段名应为 segment）',
    errorLabel: '上传重录片段失败',
    logMessage: '分段重录失败',
    handle: async (req, res, file) => {
      // params.id 在通配路由下可能是数组，取第一段（与 withRecord 同口径）
      const rawId = req.params.id;
      const workId = Array.isArray(rawId) ? (rawId[0] ?? '') : rawId;
      const work = getWork(workId);
      if (!work) {
        res.status(404).json({ error: '作品不存在' });
        return;
      }
      if (!work.trackId) {
        res.status(409).json({ error: '伴奏已删除，这个作品不能再重录（重录后需要重新混音）' });
        return;
      }
      // 正在合成时拼接会读到「半截状态」：混音任务自己会重新读库，但 startMix 又排一次
      // 会互相覆盖 mp3，所以直接挡住（与 /:id/mix 同一口径）
      if (isQueued(mixKey(work.id))) {
        res.status(409).json({ error: '上一次合成还没结束，请稍等几秒' });
        return;
      }

      const body = req.body as Record<string, string | undefined>;
      const duration = work.vocalDuration;
      // 区间一律夹到干声时长内：超出部分没有旧干声可替换（补录结尾是另一件事）
      const startSec = clampNumber(body.startSec, 0, duration, Number.NaN);
      const endSec = clampNumber(body.endSec, 0, duration, Number.NaN);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
        res.status(400).json({ error: '重录区间的起止时间不正确' });
        return;
      }
      if (!(endSec > startSec)) {
        res.status(400).json({ error: '重录区间的结束时间要晚于开始时间' });
        return;
      }
      if (endSec - startSec < RETAKE_LIMITS.minSegmentSec) {
        res.status(400).json({ error: `重录区间太短（至少 ${RETAKE_LIMITS.minSegmentSec} 秒）` });
        return;
      }

      // 片段文件本身没坏就行；时长和区间差得远只告警不拒绝 —— 拼接以目标
      // 长度为准（不足补静音、超出截断），客户端裁窗口的舍入误差不是错误
      const probed = await probeFile(file.path);
      const segmentDuration = Number(probed.format?.duration);
      if (!Number.isFinite(segmentDuration) || segmentDuration <= 0) {
        res.status(400).json({ error: '重录文件解析失败，请重新录制这一段' });
        return;
      }
      if (segmentDuration < (endSec - startSec) * 0.3) {
        res.status(400).json({ error: '上传的重录片段和所选区间差得太远，请重新录制' });
        return;
      }

      await spliceRetakeIntoVocal({ work, segmentPath: file.path, startSec, endSec });
      // 干声时长分毫未动，只翻状态重新出片；成品 MP3 在合成成功前一直是上一版
      updateWork(work.id, { status: 'mixing', error: null });
      startMix(work.id);
      log.info(`分段重录 ${work.title}`, { id: work.id, startSec, endSec });
      res.status(202).json(workToDto(getWork(work.id)!));
    },
  }),
);

router.post(
  '/:id/retake-undo',
  withWork((_req, res, work) => {
    if (isQueued(mixKey(work.id))) {
      res.status(409).json({ error: '上一次合成还没结束，请稍等几秒' });
      return;
    }
    try {
      undoRetake(work);
    } catch (error) {
      // 典型是「没有可撤销的重录备份」——备份被上一次撤销消费掉了
      res.status(409).json({ error: error instanceof Error ? error.message : '撤销失败' });
      return;
    }
    updateWork(work.id, { status: 'mixing', error: null });
    startMix(work.id);
    log.info(`撤销重录 ${work.title}`, { id: work.id });
    res.status(202).json(workToDto(getWork(work.id)!));
  }),
);

router.delete(
  '/:id',
  withWork((_req, res, work) => {
    deleteWork(work.id);
    void fs.promises.rm(work.vocalPath, { force: true });
    void fs.promises.rm(backupVocalPath(work.vocalPath), { force: true });
    void fs.promises.rm(workMp3Path(work.id), { force: true });

    log.info(`删除作品 ${work.title}`, { id: work.id });
    res.json({ ok: true });
  }),
);

export default router;
