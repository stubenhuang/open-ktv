//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

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

/** 生成一段静音（测试里当「伴奏」用：把成品内容隔离成只有人声 + 混响尾） */
export function silenceArgs(filePath: string, seconds: number): string[] {
  return ['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${seconds}`, '-c:a', 'pcm_s16le', filePath];
}

/**
 * 生成「骤停」干声：前 burstSec 秒是正弦，之后静音，总长 totalSec。
 * 混响尾音只能在这种素材上量 —— 连续信号里分不出尾和声。
 */
export function burstVocalArgs(
  filePath: string,
  burstSec: number,
  totalSec: number,
  frequency = 880,
): string[] {
  return [
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:sample_rate=48000:duration=${burstSec}`,
    '-af',
    `apad=whole_dur=${totalSec}`,
    '-c:a',
    'pcm_s16le',
    filePath,
  ];
}

/**
 * 解码成单声道 f32le 样本（测试里量混响尾音用）。
 * 走临时文件而不是管道：runFfmpeg 的 stdout 要留给 -progress。
 */
export async function decodeToFloat32(
  filePath: string,
): Promise<{ sampleRate: number; samples: Float32Array }> {
  const raw = `${filePath}.f32`;
  await ffmpegOk(['-i', filePath, '-ac', '1', '-map', '0:a:0', '-f', 'f32le', raw]);
  const buffer = await fs.promises.readFile(raw);
  await fs.promises.rm(raw, { force: true });
  const summary = await summarize(filePath);
  const sampleRate = summary.sampleRate ?? 48000;
  return {
    sampleRate,
    samples: new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4),
  };
}

/** 一段样本在 [fromSec, toSec) 窗口内的 RMS（能量） */
export function rmsOfWindow(
  samples: Float32Array,
  sampleRate: number,
  fromSec: number,
  toSec: number,
): number {
  const from = Math.max(0, Math.floor(fromSec * sampleRate));
  const to = Math.min(samples.length, Math.floor(toSec * sampleRate));
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / (to - from));
}
