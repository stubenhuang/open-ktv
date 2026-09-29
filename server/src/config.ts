import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录 */
export const ROOT_DIR = path.resolve(here, '..', '..');

/**
 * 数据目录。默认在项目内，可用 DATA_DIR 整体搬走
 * （测试也靠它把库指到临时目录，不碰真实数据）。
 */
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT_DIR, 'data');
export const WEB_DIST_DIR = path.join(ROOT_DIR, 'web', 'dist');

export const PORT = Number(process.env.PORT ?? 8787);
/** 单机自用：默认只绑本机回环，不暴露到局域网 */
export const HOST = process.env.HOST ?? '127.0.0.1';

/** 输出音频统一规格 */
export const AUDIO = {
  sampleRate: 48_000,
  channels: 2,
  mp3Bitrate: '192k',
} as const;

/** 代理转码参数（音频代理的 mp3 规格走 AUDIO，见 ffmpeg.ts 的 MP3_OUTPUT_ARGS） */
export const TRANSCODE = {
  videoPreset: 'veryfast',
  videoCrf: 23,
  maxVideoWidth: 1920,
  videoAudioBitrate: '192k',
} as const;

export const JOB_TIMEOUT_MS = {
  transcode: 30 * 60 * 1000,
  mix: 5 * 60 * 1000,
} as const;

export const FFMPEG_BIN = process.env.FFMPEG_BIN ?? 'ffmpeg';
export const FFPROBE_BIN = process.env.FFPROBE_BIN ?? 'ffprobe';
