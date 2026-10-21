//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import fs from 'node:fs';
import type {
  PitchStatus,
  Track,
  TrackDetail,
  TrackListItem,
  TrackSummary,
  Work,
  WorkListItem,
} from '../../shared/types.ts';
import { pitchActive } from '../../shared/mix.ts';
import type { TrackRecord, WorkRecord } from './db.ts';
import { getProgress, isQueued } from './jobs.ts';
import { backupVocalPath } from './vocalSplice.ts';

export function transcodeKey(trackId: string): string {
  return `transcode:${trackId}`;
}

export function mixKey(workId: string): string {
  return `mix:${workId}`;
}

/** 移调任务的任务键（与 transcode/mix 同一套命名） */
export function pitchKey(trackId: string): string {
  return `pitch:${trackId}`;
}

/**
 * 伴奏的公共字段：不含歌词正文，只给一个 hasLyrics 布尔值。
 *
 * 列表接口刻意不下发歌词正文 —— 一个几百首的库每次轮询都带上全部 LRC
 * 会把响应撑大几十倍，而列表页根本不需要歌词内容。
 */
export function trackToSummary(record: TrackRecord): TrackSummary {
  return {
    id: record.id,
    title: record.title,
    artist: record.artist,
    kind: record.kind,
    originalName: record.originalName,
    mime: record.mime,
    size: record.size,
    duration: record.duration,
    status: record.status,
    proxyKind: record.proxyKind,
    error: record.error,
    createdAt: record.createdAt,
    lyricsOffsetMs: record.lyricsOffsetMs,
    hasLyrics: Boolean(record.lyrics),
    source: record.source,
    pitchSemitones: record.pitchSemitones,
    pitchStatus: pitchStatusOf(record),
    pitchError: record.pitchError,
  };
}

/**
 * 移调状态：原调 / 已生成 → ready；任务在跑 → processing；其余 → failed。
 *
 * 「任务不在队列里、又没有移调文件」一律算失败：要么是生成报过错，
 * 要么是服务重启把任务冲掉了（recoverInterruptedJobs 会补一句原因）。
 * 这时播放回落到原调，用户重新设一次升降调就能再来。
 */
export function pitchStatusOf(record: TrackRecord): PitchStatus {
  if (!pitchActive(record.pitchSemitones)) return 'ready';
  if (record.pitchPath) return 'ready';
  if (isQueued(pitchKey(record.id))) return 'processing';
  return 'failed';
}

/** 转码进度：只有 processing 时才去队列里问，其余状态给 null */
function trackProgress(record: TrackRecord): number | null {
  return record.status === 'processing' ? (getProgress(transcodeKey(record.id)) ?? 0) : null;
}

/** 单条伴奏（带歌词正文，不带进度） */
export function trackToDto(record: TrackRecord): Track {
  return { ...trackToSummary(record), lyrics: record.lyrics };
}

/** 列表项：带进度与作品数，不带歌词正文 */
export function trackToListItem(record: TrackRecord, workCount: number): TrackListItem {
  return { ...trackToSummary(record), progress: trackProgress(record), workCount };
}

/** 单条伴奏详情：歌词正文与转码进度都要（演唱页两者都用得上） */
export function trackToDetail(record: TrackRecord): TrackDetail {
  return { ...trackToSummary(record), lyrics: record.lyrics, progress: trackProgress(record) };
}

export function workToDto(record: WorkRecord): Work {
  return {
    id: record.id,
    trackId: record.trackId,
    title: record.title,
    vocalDuration: record.vocalDuration,
    autoOffsetMs: record.autoOffsetMs,
    mixParams: record.mixParams,
    levels: record.levels,
    // 混音时伴奏的调（快照，见 Work.pitchSemitones）
    pitchSemitones: record.pitchSemitones,
    status: record.status,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function workToListItem(
  record: WorkRecord,
  track?: TrackRecord,
  mp3SizeBytes?: number | null,
): WorkListItem {
  return {
    ...workToDto(record),
    trackTitle: track?.title ?? null,
    trackKind: track?.kind ?? null,
    trackArtist: track?.artist ?? null,
    // 这个作品混音时伴奏处在哪个调（0 = 原调 / 伴奏已删）。卡片上要显示出来 ——
    // 否则「这版怎么听起来调不一样」在作品库里根本看不出来。
    // 取自作品自己的快照（Work.pitchSemitones），不是伴奏的当前设置：用户之后
    // 改伴奏的升降调，不能反悔成老作品徽章上的数字，否则徽章就和成品对不上了。
    trackPitchSemitones: record.pitchSemitones,
    sizeBytes: mp3SizeBytes ?? null,
    // 「撤销重录」的入口判据：备份干声在不在（路径见 vocalSplice.ts）
    hasPrevVocal: fs.existsSync(backupVocalPath(record.vocalPath)),
  };
}
