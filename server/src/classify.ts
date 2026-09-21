import type { ProxyKind, TrackKind } from '../../shared/types.ts';

export interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  width?: number;
  height?: number;
  channels?: number;
  sample_rate?: string;
  duration?: string;
  disposition?: Record<string, number>;
}

export interface FfprobeResult {
  streams?: FfprobeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
  };
}

export interface Classification {
  kind: TrackKind;
  /** 秒；探测不到时长时为 null */
  durationSec: number | null;
  /** 浏览器能否直接播 */
  playable: boolean;
  /** playable 时为 'none'，否则是需要的代理类型 */
  proxyKind: ProxyKind;
  /** 人类可读的判定原因，写进日志 */
  reason: string;
}

/** 这些“视频流”其实是封面图，不算真视频 */
const IMAGE_CODECS = new Set(['mjpeg', 'png', 'bmp', 'gif', 'webp', 'tiff', 'svg']);

const VIDEO_CODECS_MP4 = new Set(['h264', 'av1']);
const VIDEO_CODECS_WEBM = new Set(['vp8', 'vp9', 'av1']);
const AUDIO_CODECS_MP4 = new Set(['aac', 'mp3', 'opus']);
const AUDIO_CODECS_WEBM = new Set(['opus', 'vorbis']);
const AUDIO_CODECS_OGG = new Set(['opus', 'vorbis']);

function containerTokens(format: FfprobeResult['format']): string[] {
  return (format?.format_name ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function isIsoBmff(tokens: string[]): boolean {
  return tokens.some((token) => ['mp4', 'mov', 'm4a', 'm4v', '3gp', '3g2', 'mj2'].includes(token));
}

/** 找到真正的视频流（排除封面图） */
export function findVideoStream(result: FfprobeResult): FfprobeStream | undefined {
  return (result.streams ?? []).find((stream) => {
    if (stream.codec_type !== 'video') return false;
    if (stream.disposition?.attached_pic === 1) return false;
    const codec = (stream.codec_name ?? '').toLowerCase();
    if (IMAGE_CODECS.has(codec)) return false;
    return true;
  });
}

export function findAudioStream(result: FfprobeResult): FfprobeStream | undefined {
  return (result.streams ?? []).find((stream) => stream.codec_type === 'audio');
}

function pickDuration(result: FfprobeResult): number | null {
  const fromFormat = Number(result.format?.duration);
  if (Number.isFinite(fromFormat) && fromFormat > 0) return fromFormat;

  let best: number | null = null;
  for (const stream of result.streams ?? []) {
    const value = Number(stream.duration);
    if (Number.isFinite(value) && value > 0 && (best === null || value > best)) best = value;
  }
  return best;
}

function videoPlayable(
  tokens: string[],
  videoCodec: string,
  audioCodec: string | null,
  ext: string,
): { playable: boolean; reason: string } {
  if (isIsoBmff(tokens)) {
    if (!VIDEO_CODECS_MP4.has(videoCodec)) {
      return { playable: false, reason: `mp4 容器里的视频编码 ${videoCodec} 浏览器不保证支持` };
    }
    if (audioCodec && !AUDIO_CODECS_MP4.has(audioCodec)) {
      return { playable: false, reason: `mp4 容器里的音频编码 ${audioCodec} 浏览器不保证支持` };
    }
    return { playable: true, reason: 'mp4/h264 可直接播放' };
  }

  // 注意：ffprobe 对 mkv 和 webm 都报 "matroska,webm"，
  // 光看 format_name 分不出来，必须靠文件扩展名兜底。
  if (tokens.includes('matroska') || tokens.includes('webm')) {
    const isRealWebm = ext === '.webm' || ext === '.weba';
    if (!isRealWebm) {
      return { playable: false, reason: 'mkv 容器浏览器放不了，需要转成 mp4' };
    }
    if (!VIDEO_CODECS_WEBM.has(videoCodec)) {
      return { playable: false, reason: `webm 容器里的视频编码 ${videoCodec} 不支持` };
    }
    if (audioCodec && !AUDIO_CODECS_WEBM.has(audioCodec)) {
      return { playable: false, reason: `webm 容器里的音频编码 ${audioCodec} 不支持` };
    }
    return { playable: true, reason: 'webm 可直接播放' };
  }

  return { playable: false, reason: `容器 ${tokens.join(',') || '未知'} 浏览器放不了，需要转成 mp4` };
}

function audioPlayable(
  tokens: string[],
  audioCodec: string,
): { playable: boolean; reason: string } {
  if (tokens.includes('mp3') && audioCodec === 'mp3') {
    return { playable: true, reason: 'mp3 可直接播放' };
  }
  if (tokens.includes('wav') && audioCodec.startsWith('pcm_')) {
    return { playable: true, reason: 'wav/pcm 可直接播放' };
  }
  if (tokens.includes('flac') && audioCodec === 'flac') {
    return { playable: true, reason: 'flac 可直接播放' };
  }
  if (tokens.includes('ogg') && AUDIO_CODECS_OGG.has(audioCodec)) {
    return { playable: true, reason: 'ogg 可直接播放' };
  }
  if (isIsoBmff(tokens) && audioCodec === 'aac') {
    return { playable: true, reason: 'm4a/aac 可直接播放' };
  }
  return { playable: false, reason: `音频编码 ${audioCodec}（容器 ${tokens.join(',') || '未知'}）需要转成 mp3` };
}

/**
 * 纯函数：把 ffprobe 的 JSON 结果翻译成「这是什么、浏览器能不能直接播」。
 * 判定偏保守 —— 宁可多转一次码，也不要让用户在演唱页黑屏。
 *
 * @param options.extension 原始文件名的小写扩展名（含点）。必要参数：
 *   ffprobe 对 mkv / webm 都报 "matroska,webm"，只有扩展名能区分二者。
 */
export function classifyProbe(
  result: FfprobeResult,
  options: { extension?: string } = {},
): Classification {
  const ext = (options.extension ?? '').toLowerCase();
  const tokens = containerTokens(result.format);
  const durationSec = pickDuration(result);
  const video = findVideoStream(result);
  const audio = findAudioStream(result);
  const audioCodec = audio?.codec_name?.toLowerCase() ?? null;

  if (video) {
    const videoCodec = (video.codec_name ?? '').toLowerCase();
    const verdict = videoPlayable(tokens, videoCodec, audioCodec, ext);
    return {
      kind: 'video',
      durationSec,
      playable: verdict.playable,
      proxyKind: verdict.playable ? 'none' : 'video',
      reason: verdict.reason,
    };
  }

  if (!audio || !audioCodec) {
    // 既没有真视频也没有音频流：可能是纯图片或损坏文件
    return {
      kind: 'audio',
      durationSec,
      playable: false,
      proxyKind: 'audio',
      reason: '文件里找不到音频流，可能已损坏或只有封面图',
    };
  }

  const verdict = audioPlayable(tokens, audioCodec);
  return {
    kind: 'audio',
    durationSec,
    playable: verdict.playable,
    proxyKind: verdict.playable ? 'none' : 'audio',
    reason: verdict.reason,
  };
}
