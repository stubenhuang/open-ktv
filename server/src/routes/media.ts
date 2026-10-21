//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { Router } from 'express';
import { getTrack } from '../db.ts';
import { sendMedia } from '../media.ts';
import { playableFileFor } from '../pitch.ts';
import { fail } from '../httpError.ts';

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
    fail(res, 404, 'track_not_found');
    return;
  }
  if (track.status !== 'ready') {
    // track.error 是服务端记下来的转码失败原因；还在转码中则用固定码
    if (track.error) {
      fail(res, 409, 'track_transcode_failed', { reason: track.error });
    } else {
      fail(res, 409, 'track_processing');
    }
    return;
  }
  sendMedia(res, playableFileFor(track));
});

export default router;
