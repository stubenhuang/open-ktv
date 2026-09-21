import type { TrackListItem, Work, WorkListItem } from '../../shared/types.ts';
import type { TrackRecord, WorkRecord } from './db.ts';
import { getProgress } from './jobs.ts';

export function transcodeKey(trackId: string): string {
  return `transcode:${trackId}`;
}

export function mixKey(workId: string): string {
  return `mix:${workId}`;
}

export function trackToDto(record: TrackRecord): Omit<TrackListItem, 'progress'> {
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
  };
}

export function trackToListItem(record: TrackRecord): TrackListItem {
  return {
    ...trackToDto(record),
    progress: record.status === 'processing' ? (getProgress(transcodeKey(record.id)) ?? 0) : null,
  };
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
