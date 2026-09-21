import { DatabaseSync } from 'node:sqlite';
import type {
  MixParams,
  ProxyKind,
  ReverbKind,
  TrackKind,
  TrackStatus,
  Work,
  WorkLevels,
  WorkStatus,
} from '../../shared/types.ts';
import { createLogger } from './logger.ts';
import { DB_FILE, ensureDirs } from './paths.ts';

const log = createLogger('db');

interface TrackRow {
  id: string;
  title: string;
  artist: string | null;
  kind: string;
  original_name: string;
  original_path: string;
  playable_path: string;
  proxy_kind: string;
  mime: string | null;
  size: number;
  duration: number | null;
  status: string;
  error: string | null;
  created_at: number;
}

interface WorkRow {
  id: string;
  track_id: string;
  title: string;
  vocal_path: string;
  vocal_duration: number;
  auto_offset_ms: number;
  mix_params: string;
  levels: string | null;
  mp3_path: string | null;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/** 完整伴奏记录（含磁盘路径，只在服务端内部使用） */
export interface TrackRecord {
  id: string;
  title: string;
  artist: string | null;
  kind: TrackKind;
  originalName: string;
  originalPath: string;
  playablePath: string;
  proxyKind: ProxyKind;
  mime: string | null;
  size: number;
  duration: number | null;
  status: TrackStatus;
  error: string | null;
  createdAt: number;
}

/** 完整作品记录（含磁盘路径） */
export interface WorkRecord extends Work {
  vocalPath: string;
  mp3Path: string | null;
}

let db: DatabaseSync | null = null;

function connection(): DatabaseSync {
  if (!db) throw new Error('数据库尚未初始化，请先调用 initDb()');
  return db;
}

export function initDb(): void {
  ensureDirs();
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  log.info('数据库已就绪', { file: DB_FILE });
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      artist        TEXT,
      kind          TEXT NOT NULL,
      original_name TEXT NOT NULL,
      original_path TEXT NOT NULL,
      playable_path TEXT NOT NULL,
      proxy_kind    TEXT NOT NULL,
      mime          TEXT,
      size          INTEGER NOT NULL,
      duration      REAL,
      status        TEXT NOT NULL,
      error         TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS works (
      id             TEXT PRIMARY KEY,
      track_id       TEXT NOT NULL REFERENCES tracks(id),
      title          TEXT NOT NULL,
      vocal_path     TEXT NOT NULL,
      vocal_duration REAL NOT NULL,
      auto_offset_ms INTEGER NOT NULL,
      mix_params     TEXT NOT NULL,
      mp3_path       TEXT,
      status         TEXT NOT NULL,
      error          TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_works_track ON works(track_id);
    CREATE INDEX IF NOT EXISTS idx_works_created ON works(created_at DESC);
  `);

  // 轻量迁移：老库补 levels 列（实时预览用的实测增益，允许为空）
  const workColumns = db
    .prepare('PRAGMA table_info(works)')
    .all() as unknown as { name: string }[];
  if (!workColumns.some((column) => column.name === 'levels')) {
    db.exec('ALTER TABLE works ADD COLUMN levels TEXT');
    log.info('老库迁移：works 表已补上 levels 列');
  }
}

/**
 * 服务重启后收敛状态：上次跑到一半的转码 / 混音任务已经不可能继续，
 * 统一标记为 failed，避免前端永远转圈。
 */
export function recoverInterruptedJobs(): { tracks: number; works: number } {
  const c = connection();
  const message = '服务重启导致任务中断，请重试或删除后重新上传';
  const tracks = c
    .prepare(`UPDATE tracks SET status = 'failed', error = ? WHERE status = 'processing'`)
    .run(message);
  const works = c
    .prepare(`UPDATE works SET status = 'failed', error = ? WHERE status = 'mixing'`)
    .run(message);
  return {
    tracks: Number(tracks.changes),
    works: Number(works.changes),
  };
}

function toTrack(row: TrackRow): TrackRecord {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    kind: row.kind as TrackKind,
    originalName: row.original_name,
    originalPath: row.original_path,
    playablePath: row.playable_path,
    proxyKind: row.proxy_kind as ProxyKind,
    mime: row.mime,
    size: Number(row.size),
    duration: row.duration === null ? null : Number(row.duration),
    status: row.status as TrackStatus,
    error: row.error,
    createdAt: Number(row.created_at),
  };
}

function parseMixParams(raw: string): MixParams {
  try {
    const parsed = JSON.parse(raw) as Partial<MixParams>;
    return {
      vocalGain: Number(parsed.vocalGain ?? 1),
      accompGain: Number(parsed.accompGain ?? 1),
      reverb: (parsed.reverb ?? 'room') as ReverbKind,
      userOffsetMs: Number(parsed.userOffsetMs ?? 0),
    };
  } catch {
    return { vocalGain: 1, accompGain: 1, reverb: 'room', userOffsetMs: 0 };
  }
}

function parseLevels(raw: string | null): WorkLevels | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkLevels>;
    const vocalGainDb = Number(parsed.vocalGainDb);
    const accompGainDb = Number(parsed.accompGainDb);
    if (!Number.isFinite(vocalGainDb) || !Number.isFinite(accompGainDb)) return null;
    return { vocalGainDb, accompGainDb };
  } catch {
    return null;
  }
}

function toWork(row: WorkRow): WorkRecord {
  return {
    id: row.id,
    trackId: row.track_id,
    title: row.title,
    vocalPath: row.vocal_path,
    vocalDuration: Number(row.vocal_duration),
    autoOffsetMs: Number(row.auto_offset_ms),
    mixParams: parseMixParams(row.mix_params),
    levels: parseLevels(row.levels),
    mp3Path: row.mp3_path,
    status: row.status as WorkStatus,
    error: row.error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/* ---------------------------------- tracks --------------------------------- */

export interface NewTrack {
  id: string;
  title: string;
  artist: string | null;
  kind: TrackKind;
  originalName: string;
  originalPath: string;
  playablePath: string;
  proxyKind: ProxyKind;
  mime: string | null;
  size: number;
  duration: number | null;
  status: TrackStatus;
  error: string | null;
}

export function insertTrack(input: NewTrack): void {
  connection()
    .prepare(
      `INSERT INTO tracks (id, title, artist, kind, original_name, original_path, playable_path,
                           proxy_kind, mime, size, duration, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.title,
      input.artist,
      input.kind,
      input.originalName,
      input.originalPath,
      input.playablePath,
      input.proxyKind,
      input.mime,
      input.size,
      input.duration,
      input.status,
      input.error,
      Date.now(),
    );
}

export function listTracks(): TrackRecord[] {
  const rows = connection()
    .prepare('SELECT * FROM tracks ORDER BY created_at DESC')
    .all() as unknown as TrackRow[];
  return rows.map(toTrack);
}

export function getTrack(id: string): TrackRecord | undefined {
  const row = connection().prepare('SELECT * FROM tracks WHERE id = ?').get(id) as
    | TrackRow
    | undefined;
  return row ? toTrack(row) : undefined;
}

export interface TrackPatch {
  title?: string;
  artist?: string | null;
  playablePath?: string;
  proxyKind?: ProxyKind;
  duration?: number | null;
  status?: TrackStatus;
  error?: string | null;
}

export function updateTrack(id: string, patch: TrackPatch): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  const push = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.title !== undefined) push('title', patch.title);
  if (patch.artist !== undefined) push('artist', patch.artist);
  if (patch.playablePath !== undefined) push('playable_path', patch.playablePath);
  if (patch.proxyKind !== undefined) push('proxy_kind', patch.proxyKind);
  if (patch.duration !== undefined) push('duration', patch.duration);
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.error !== undefined) push('error', patch.error);

  if (sets.length === 0) return;
  values.push(id);
  connection()
    .prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);
}

export function deleteTrack(id: string): void {
  connection().prepare('DELETE FROM tracks WHERE id = ?').run(id);
}

export function countWorksForTrack(trackId: string): number {
  const row = connection()
    .prepare('SELECT COUNT(*) AS n FROM works WHERE track_id = ?')
    .get(trackId) as { n: number } | undefined;
  return row ? Number(row.n) : 0;
}

/* ----------------------------------- works ---------------------------------- */

export interface NewWork {
  id: string;
  trackId: string;
  title: string;
  vocalPath: string;
  vocalDuration: number;
  autoOffsetMs: number;
  mixParams: MixParams;
  status: WorkStatus;
}

export function insertWork(input: NewWork): void {
  const now = Date.now();
  connection()
    .prepare(
      `INSERT INTO works (id, track_id, title, vocal_path, vocal_duration, auto_offset_ms,
                          mix_params, mp3_path, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
    )
    .run(
      input.id,
      input.trackId,
      input.title,
      input.vocalPath,
      input.vocalDuration,
      input.autoOffsetMs,
      JSON.stringify(input.mixParams),
      input.status,
      now,
      now,
    );
}

export function listWorks(): WorkRecord[] {
  const rows = connection()
    .prepare('SELECT * FROM works ORDER BY created_at DESC')
    .all() as unknown as WorkRow[];
  return rows.map(toWork);
}

export function getWork(id: string): WorkRecord | undefined {
  const row = connection().prepare('SELECT * FROM works WHERE id = ?').get(id) as
    | WorkRow
    | undefined;
  return row ? toWork(row) : undefined;
}

export interface WorkPatch {
  title?: string;
  mixParams?: MixParams;
  levels?: WorkLevels | null;
  mp3Path?: string | null;
  status?: WorkStatus;
  error?: string | null;
}

export function updateWork(id: string, patch: WorkPatch): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  const push = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.title !== undefined) push('title', patch.title);
  if (patch.mixParams !== undefined) push('mix_params', JSON.stringify(patch.mixParams));
  if (patch.levels !== undefined) {
    push('levels', patch.levels ? JSON.stringify(patch.levels) : null);
  }
  if (patch.mp3Path !== undefined) push('mp3_path', patch.mp3Path);
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.error !== undefined) push('error', patch.error);

  push('updated_at', Date.now());
  values.push(id);
  connection()
    .prepare(`UPDATE works SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);
}

export function deleteWork(id: string): void {
  connection().prepare('DELETE FROM works WHERE id = ?').run(id);
}
