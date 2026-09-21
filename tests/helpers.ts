import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg } from '../server/src/ffmpeg.ts';
import { probeFile } from '../server/src/probe.ts';

export async function makeTempDir(prefix: string): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), `open-ktv-${prefix}-`));
}

export async function cleanupDir(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

/** 跑一次 ffmpeg，失败就带着 stderr 抛出，方便定位 */
export async function ffmpegOk(args: string[], label = 'test-ffmpeg'): Promise<void> {
  await runFfmpeg({ args: ['-y', '-hide_banner', '-loglevel', 'error', ...args], timeoutMs: 120_000, label });
}

export interface MediaSummary {
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  channels: number | null;
  sampleRate: number | null;
  durationSec: number | null;
  formatName: string;
}

export async function summarize(filePath: string): Promise<MediaSummary> {
  const raw = await probeFile(filePath);
  const video = (raw.streams ?? []).find(
    (stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
  );
  const audio = (raw.streams ?? []).find((stream) => stream.codec_type === 'audio');

  return {
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    channels: audio?.channels ?? null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    durationSec: Number(raw.format?.duration) || null,
    formatName: raw.format?.format_name ?? '',
  };
}

/** 生成一段正弦波（测试用的「伴奏」或「干声」） */
export function sineArgs(
  filePath: string,
  seconds: number,
  frequency: number,
  outputArgs: string[] = [],
): string[] {
  return [
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:sample_rate=48000:duration=${seconds}`,
    '-ac',
    '1',
    ...outputArgs,
    filePath,
  ];
}
