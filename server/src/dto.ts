import type {
  Track,
  TrackDetail,
  TrackListItem,
  TrackSummary,
  Work,
  WorkListItem,
} from '../../shared/types.ts';
import type { TrackRecord, WorkRecord } from './db.ts';
import { getProgress } from './jobs.ts';

export function transcodeKey(trackId: string): string {
  return `transcode:${trackId}`;
}

export function mixKey(workId: string): string {
  return `mix:${workId}`;
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
  };
}

/** 转码进度：只有 processing 时才去队列里问，其余状态给 null */
function trackProgress(record: TrackRecord): number | null {
  return record.status === 'processing' ? (getProgress(transcodeKey(record.id)) ?? 0) : null;
}

/** 单条伴奏（带歌词正文，不带进度） */
export function trackToDto(record: TrackRecord): Track {
  return { ...trackToSummary(record), lyrics: record.lyrics };
}

/** 列表项：带进度，不带歌词正文 */
export function trackToListItem(record: TrackRecord): TrackListItem {
  return { ...trackToSummary(record), progress: trackProgress(record) };
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
    status: record.status,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function workToListItem(record: WorkRecord, track?: TrackRecord): WorkListItem {
  return {
    ...workToDto(record),
    trackTitle: track?.title ?? null,
    trackKind: track?.kind ?? null,
  };
}
