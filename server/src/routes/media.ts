import { Router } from 'express';
import { getTrack } from '../db.ts';
import { sendMedia } from '../media.ts';

const router = Router();

/** 伴奏播放源：ready 时才给，processing 时让前端继续轮询 */
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
  sendMedia(res, track.playablePath);
});

export default router;
