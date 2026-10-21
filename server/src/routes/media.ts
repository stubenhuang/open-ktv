//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { Router } from 'express';
import { getTrack } from '../db.ts';
import { sendMedia } from '../media.ts';
import { playableFileFor } from '../pitch.ts';

const router = Router();

/**
 * 伴奏播放源：ready 时才给，processing 时让前端继续轮询。
 *
 * 给的是 playableFileFor 解析出来的文件 —— 设了升降调且移调伴奏已生成时，
 * 它就是移调后的那份。于是演唱页、实时试听、手机端三处听到的伴奏
 * 与成品 MP3 里混的那一份永远一致（见 server/src/pitch.ts）。
 */
router.get('/track/:id', (req, res) => {
  const track = getTrack(req.params.id);
  if (!track) {
    res.status(404).json({ error: '伴奏不存在' });
    return;
  }
  if (track.status !== 'ready') {
    res.status(409).json({ error: track.error ?? '伴奏还在转码中，请稍候' });
    return;
  }
  sendMedia(res, playableFileFor(track));
});

export default router;
