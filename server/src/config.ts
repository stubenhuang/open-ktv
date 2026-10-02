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
  /**
   * 人声预处理（降噪、压缩、去齿音）单独限时。
   * 不并进 mix 的预算里：预处理与混音是两次独立的 ffmpeg 调用，
   * 混用一个总额会让「预处理慢」和「混音慢」无法区分。
   */
  preProcess: 5 * 60 * 1000,
} as const;

/* --------------------------------- 曲库源 --------------------------------- */

/**
 * 曲库源列表，逗号分隔。每一项是 `名字=清单URL` 或直接一个清单URL：
 *
 *   LIBRARY_SOURCES="我的库=https://nas.local/ktv/index.json,https://cdn.example.com/index.json"
 *
 * 名字可以省略（省略时用清单里的 name，再不行用主机名）。
 * 不配置就是空的 —— 点歌台会显示配置指引，其余功能完全不受影响。
 */
export const LIBRARY_SOURCES: string[] = (process.env.LIBRARY_SOURCES ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

/** 清单缓存时长：搜索是本地过滤，不需要每次敲字都打源站 */
export const LIBRARY_CACHE_TTL_MS = Number(process.env.LIBRARY_CACHE_TTL_MS ?? 10 * 60 * 1000);
/** 单次搜索里每个源的超时；超时即视为该源不可用，不影响其他源 */
export const LIBRARY_SEARCH_TIMEOUT_MS = Number(process.env.LIBRARY_SEARCH_TIMEOUT_MS ?? 5_000);
/** 单个伴奏的下载超时；大 MV 可能几百 MB，给得宽一些 */
export const LIBRARY_DOWNLOAD_TIMEOUT_MS = Number(
  process.env.LIBRARY_DOWNLOAD_TIMEOUT_MS ?? 15 * 60 * 1000,
);

export const FFMPEG_BIN = process.env.FFMPEG_BIN ?? 'ffmpeg';
export const FFPROBE_BIN = process.env.FFPROBE_BIN ?? 'ffprobe';
