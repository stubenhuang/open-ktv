import path from 'node:path';
import { JOB_TIMEOUT_MS, TRANSCODE } from './config.ts';
import { runFfmpeg } from './ffmpeg.ts';
import { PROXIES_DIR } from './paths.ts';

export type ProxyTarget = 'video' | 'audio';

export function proxyPathFor(id: string, target: ProxyTarget): string {
  return path.join(PROXIES_DIR, `${id}.${target === 'video' ? 'mp4' : 'mp3'}`);
}

/**
 * 转码成浏览器能播的代理文件。
 * 视频：h264 + aac + faststart，最大宽度 1920，宽度强制偶数（h264 yuv420p 要求）。
 * 音频：直接出 mp3 192k 立体声。
 */
export function buildTranscodeArgs(input: {
  sourcePath: string;
  outputPath: string;
  target: ProxyTarget;
}): string[] {
  const common = ['-y', '-hide_banner', '-nostdin', '-i', input.sourcePath];

  if (input.target === 'audio') {
    return [
      ...common,
      '-vn',
      '-c:a',
      'libmp3lame',
      '-b:a',
      TRANSCODE.audioBitrate,
      '-ar',
      '48000',
      '-ac',
      '2',
      '-id3v2_version',
      '3',
      '-progress',
      'pipe:1',
      '-nostats',
      input.outputPath,
    ];
  }

  return [
    ...common,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-preset',
    TRANSCODE.videoPreset,
    '-crf',
    String(TRANSCODE.videoCrf),
    '-pix_fmt',
    'yuv420p',
    '-vf',
    `scale='trunc(min(${TRANSCODE.maxVideoWidth},iw)/2)*2':-2`,
    '-c:a',
    'aac',
    '-b:a',
    TRANSCODE.videoAudioBitrate,
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    input.outputPath,
  ];
}

export async function transcodeToProxy(input: {
  sourcePath: string;
  outputPath: string;
  target: ProxyTarget;
  durationSec: number | null;
  onProgress: (ratio: number) => void;
}): Promise<void> {
  await runFfmpeg({
    args: buildTranscodeArgs(input),
    timeoutMs: JOB_TIMEOUT_MS.transcode,
    totalDurationSec: input.durationSec,
    onProgress: input.onProgress,
    label: `转码 ${input.target}`,
  });
}
