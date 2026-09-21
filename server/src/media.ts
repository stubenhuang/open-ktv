import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import { createLogger } from './logger.ts';

const log = createLogger('media');

const CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.weba': 'audio/webm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * 流式发送媒体文件。express 的 sendFile 原生支持 Range 请求，
 * 所以 <video> 拖进度条、<audio> seek 都能用。
 */
export function sendMedia(res: Response, filePath: string, downloadName?: string): void {
  if (!fs.existsSync(filePath)) {
    log.warn('媒体文件不存在', { filePath });
    res.status(404).json({ error: '文件不存在或已被删除' });
    return;
  }

  log.debug('发送媒体', { filePath, download: Boolean(downloadName) });
  res.type(contentTypeFor(filePath));
  res.setHeader('Accept-Ranges', 'bytes');
  // 重新混音后文件名不变，必须禁掉缓存，否则前端听到的还是旧版本
  res.setHeader('Cache-Control', 'no-store');
  if (downloadName) res.setHeader('Content-Disposition', contentDisposition(downloadName));

  res.sendFile(filePath, (error) => {
    if (!error) return;
    if (res.headersSent) {
      // 客户端中断（切换页面、拖动进度条）是常态，不必当成错误
      res.end();
      return;
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ECONNABORTED' || code === 'EPIPE') {
      res.end();
      return;
    }
    res.status(500).json({ error: `读取文件失败：${error.message}` });
  });
}
