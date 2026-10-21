//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_MIX_PARAMS,
  REVERB_KINDS,
  VOCAL_PRESETS,
  type MixParams,
  type ProxyKind,
  type ReverbKind,
  type TrackKind,
  type TrackSource,
  type TrackStatus,
  type VocalPreset,
  type Work,
  type WorkLevels,
  type WorkStatus,
} from '../../shared/types.ts';
import { anchorSpace } from '../../shared/mix.ts';
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
  lyrics: string | null;
  lyrics_offset_ms: number;
  source: string;
  library_ref: string | null;
  /** 升降调（半音）；0 = 原调 */
  pitch_semitones: number;
  /** 移调伴奏的路径；null = 没有（原调，或还没生成好，或生成失败） */
  pitch_path: string | null;
  /** 移调失败的原因；null = 没失败 */
  pitch_error: string | null;
}

interface WorkRow {
  id: string;
  track_id: string | null;
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
  /** 对齐公式版本：1 = 旧公式（offset = auto + user，人声被 adelay 推后）；2 = 新公式（offset = user − auto，可为负） */
  align_ver: number;
  /**
   * 混音时伴奏处在哪个调（半音）的快照；0 = 原调。
   *
   * 快照而不是去问伴奏的当前设置：用户随时能改伴奏的升降调，而已经混好的
   * 成品里混的永远是「混音那一刻」的那一档。实时去问，老作品的徽章就会
   * 跟着伴奏乱变，说的和成品里放的不是一回事。
   */
  pitch_semitones: number;
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
  lyrics: string | null;
  lyricsOffsetMs: number;
  source: TrackSource;
  /**
   * 曲库来源标识，形如 `providerId:itemId`；手动上传的为 null。
   * 只走服务端内部：前端判「是否已在库」由接口直接回答，不下发这个内部键。
   */
  libraryRef: string | null;
  /** 升降调（半音，−12…+12）；0 = 原调 */
  pitchSemitones: number;
  /**
   * 移调伴奏的路径；null = 没有。
   *
   * 与 pitchSemitones 的组合才是「现在该播哪份文件」：
   * semitones ≠ 0 且 pitchPath 有值 → 播移调伴奏；否则播 playablePath。
   * 生成中（任务在跑）pitchPath 也是 null，所以播放不会中断 ——
   * 只是那几秒听到的仍是原调，演唱页会据此挡住「开始演唱」。
   */
  pitchPath: string | null;
  /** 移调失败的原因；null = 没失败 */
  pitchError: string | null;
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

/**
 * 关库（优雅关闭时调用）。
 *
 * SQLite 在最后一个连接关闭时会把 WAL 合并回主库 —— 不显式关的话，
 * 优雅退出后 `ktv.db-wal` 里仍留着未合并的页（下次开库才合并）。
 * 关失败只记日志：退出流程不能因为关库失败而卡住。
 */
export function closeDb(): void {
  if (!db) return;
  try {
    db.close();
    log.info('数据库已关闭（WAL 已合并）');
  } catch (error) {
    log.warn('关闭数据库失败', { error });
  } finally {
    db = null;
  }
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
      created_at    INTEGER NOT NULL,
      lyrics         TEXT,
      lyrics_offset_ms INTEGER NOT NULL DEFAULT 0,
      source        TEXT NOT NULL DEFAULT 'upload',
      library_ref   TEXT
    );

    CREATE TABLE IF NOT EXISTS works (
      id             TEXT PRIMARY KEY,
      track_id       TEXT REFERENCES tracks(id) ON DELETE SET NULL,
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

  // 轻量迁移：老库按需补列。新增一列就在这里加一行 ——
  // 为一个小项目引入全量迁移框架是净负担，这些 ALTER 都是可安全重复执行的。
  ensureColumns(db, 'works', [
    // levels：实时预览用的实测增益，允许为空（老作品没有）
    { name: 'levels', ddl: 'ALTER TABLE works ADD COLUMN levels TEXT' },
  ]);
  const addedAlignVer = ensureColumns(db, 'works', [
    {
      name: 'align_ver',
      ddl: 'ALTER TABLE works ADD COLUMN align_ver INTEGER NOT NULL DEFAULT 1',
    },
  ]);
  // 升降调快照：这个作品混音时伴奏是哪个调。老作品补列后默认 0 = 原调，
  // 恰好就是事实（升降调上线前的作品混的都是原调）。
  ensureColumns(db, 'works', [
    { name: 'pitch_semitones', ddl: 'ALTER TABLE works ADD COLUMN pitch_semitones INTEGER NOT NULL DEFAULT 0' },
  ]);
  // 只有真的补过 align_ver（老库）才需要换算，新库插的就是版本 2
  if (addedAlignVer) migrateLegacyAlignment(db);

  // 删伴奏与作品解耦：外键要从「拦住删除」换成「删除时置空」。
  // 必须在 ensureColumns(works) 之后跑 —— 重建表时要连 levels / align_ver 一起拷。
  ensureWorksForeignKey(db);

  ensureColumns(db, 'tracks', [
    { name: 'lyrics', ddl: 'ALTER TABLE tracks ADD COLUMN lyrics TEXT' },
    {
      name: 'lyrics_offset_ms',
      ddl: 'ALTER TABLE tracks ADD COLUMN lyrics_offset_ms INTEGER NOT NULL DEFAULT 0',
    },
    {
      name: 'source',
      ddl: `ALTER TABLE tracks ADD COLUMN source TEXT NOT NULL DEFAULT 'upload'`,
    },
    { name: 'library_ref', ddl: 'ALTER TABLE tracks ADD COLUMN library_ref TEXT' },
    // 升降调：半音数 + 移调伴奏路径 + 失败原因。老库补列后 pitch_semitones 默认 0
    // （= 原调），于是老伴奏的行为与这次改动前逐字节一致。
    {
      name: 'pitch_semitones',
      ddl: 'ALTER TABLE tracks ADD COLUMN pitch_semitones INTEGER NOT NULL DEFAULT 0',
    },
    { name: 'pitch_path', ddl: 'ALTER TABLE tracks ADD COLUMN pitch_path TEXT' },
    { name: 'pitch_error', ddl: 'ALTER TABLE tracks ADD COLUMN pitch_error TEXT' },
  ]);

  // 点歌去重的底座：同一个曲库条目只允许入库一次。
  // 必须在 tracks 迁移之后建 —— 老库这列是刚补上的，提前建会报 no such column。
  // 局部唯一索引（WHERE library_ref IS NOT NULL）让手动上传的那一堆 NULL 不受约束。
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_library_ref
       ON tracks(library_ref) WHERE library_ref IS NOT NULL`,
  );
}

/**
 * works.track_id 的外键动作；老库是 NO ACTION（= 伴奏有作品就删不掉），新库是 SET NULL。
 */
function worksForeignKeyAction(connection: DatabaseSync): string | null {
  const rows = connection.prepare('PRAGMA foreign_key_list(works)').all() as unknown as {
    from: string;
    on_delete: string;
  }[];
  const foreignKey = rows.find((row) => row.from === 'track_id');
  return foreignKey ? foreignKey.on_delete.toUpperCase() : null;
}

/**
 * 把 works.track_id 的外键换成 ON DELETE SET NULL（老库一次性迁移）。
 *
 * 背景：以前「伴奏下有作品」会成为删除伴奏的拦截条件（409），作品和伴奏死死耦合。
 * 现在删伴奏不再拦截 —— 作品记录和成品 MP3 都留着，只是不能再混音。
 * 外键跟着改成 SET NULL，删除伴奏时由 SQLite 自动把作品的 track_id 抹平，
 * 不需要应用层记得去补这一刀。
 *
 * SQLite 改不了已建成表的外键动作，只能「建新表 → 拷数据 → 换名字」。
 * 整个重建包在一个事务里，中途失败就 ROLLBACK，老库原样不动。
 */
function ensureWorksForeignKey(connection: DatabaseSync): void {
  if (worksForeignKeyAction(connection) === 'SET NULL') return;

  log.info('老库迁移：works.track_id 外键改为 ON DELETE SET NULL（删伴奏不再拦截作品）');
  // 外键开关在事务里是 no-op，必须在 BEGIN 之前关、COMMIT 之后再开
  connection.exec('PRAGMA foreign_keys = OFF');
  try {
    connection.exec(`
      BEGIN;
      CREATE TABLE works_reborn (
        id             TEXT PRIMARY KEY,
        track_id       TEXT REFERENCES tracks(id) ON DELETE SET NULL,
        title          TEXT NOT NULL,
        vocal_path     TEXT NOT NULL,
        vocal_duration REAL NOT NULL,
        auto_offset_ms INTEGER NOT NULL,
        mix_params     TEXT NOT NULL,
        mp3_path       TEXT,
        status         TEXT NOT NULL,
        error          TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        levels         TEXT,
        align_ver      INTEGER NOT NULL DEFAULT 1,
        pitch_semitones INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO works_reborn (id, track_id, title, vocal_path, vocal_duration, auto_offset_ms,
                                mix_params, mp3_path, status, error, created_at, updated_at,
                                levels, align_ver, pitch_semitones)
        SELECT id, track_id, title, vocal_path, vocal_duration, auto_offset_ms,
               mix_params, mp3_path, status, error, created_at, updated_at, levels, align_ver,
               pitch_semitones
          FROM works;
      DROP TABLE works;
      ALTER TABLE works_reborn RENAME TO works;
      CREATE INDEX IF NOT EXISTS idx_works_track ON works(track_id);
      CREATE INDEX IF NOT EXISTS idx_works_created ON works(created_at DESC);
      COMMIT;
    `);
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  } finally {
    connection.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * 按需给表补列，返回是否真的补过。
 *
 * @param table 表名；只接受代码里写死的字面量（PRAGMA 不支持参数绑定）
 */
function ensureColumns(
  connection: DatabaseSync,
  table: string,
  columns: { name: string; ddl: string }[],
): boolean {
  const existing = connection
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as { name: string }[];
  const present = new Set(existing.map((column) => column.name));

  let changed = false;
  for (const column of columns) {
    if (present.has(column.name)) continue;
    connection.exec(column.ddl);
    log.info(`老库迁移：${table} 表已补上 ${column.name} 列`);
    changed = true;
  }
  return changed;
}

/**
 * 对齐公式迁移（一次性，只处理 align_ver = 1 的老作品）。
 *
 * 旧公式把干声**推后** `auto + userOld` 毫秒（符号搞反了，人声整体拖拍约 2×auto，
 * 且总量钳在 [0, MAX]——往负方向拖最多拖到 0，拖拍永远修不好）；
 * 新公式是 `user − auto`（人声提前 auto，可为负）。老作品的 auto_offset_ms
 * 本身就是「起录 → 伴奏起播」间隔的近似值，沿用它，userOffsetMs 这样换算：
 *
 *  · `auto + userOld ≥ 0`（没被钳过）：相对微调原样保留，
 *    `E_new = userOld − auto`——userOld = 0 的常见情况正好落在 −auto（正确对齐）；
 *  · `auto + userOld < 0`（当时已被拖拍逼着拖到下限）：直接给满自动修正，
 *    `userNew = 0 → E_new = −auto`——这正是他们当时想要而够不着的位置。
 *
 * 换算后 align_ver 置 2，之后按新公式读写。
 */
function migrateLegacyAlignment(db: DatabaseSync): void {
  const rows = db
    .prepare('SELECT id, auto_offset_ms, mix_params FROM works WHERE align_ver = 1')
    .all() as unknown as { id: string; auto_offset_ms: number; mix_params: string }[];
  const update = db.prepare('UPDATE works SET mix_params = ?, align_ver = 2 WHERE id = ?');
  for (const row of rows) {
    const params = parseMixParams(row.mix_params);
    const auto = Number.isFinite(Number(row.auto_offset_ms)) ? Number(row.auto_offset_ms) : 0;
    const userOld = Number.isFinite(params.userOffsetMs) ? params.userOffsetMs : 0;
    const userNew = auto + userOld < 0 ? 0 : Math.round(userOld);
    update.run(JSON.stringify({ ...params, userOffsetMs: userNew }), row.id);
  }
  db.exec('UPDATE works SET align_ver = 2 WHERE align_ver = 1');
  if (rows.length > 0) {
    log.info(`对齐公式迁移完成：${rows.length} 个老作品已换算到新公式`, {
      ids: rows.map((row) => row.id),
    });
  }
}

/**
 * 服务重启后收敛状态：上次跑到一半的转码 / 混音任务已经不可能继续，
 * 统一标记为 failed，避免前端永远转圈。
 */
export function recoverInterruptedJobs(): { tracks: number; works: number; pitches: number } {
  const c = connection();
  const message = '服务重启导致任务中断，请重试或删除后重新上传';
  const tracks = c
    .prepare(`UPDATE tracks SET status = 'failed', error = ? WHERE status = 'processing'`)
    .run(message);
  const works = c
    .prepare(`UPDATE works SET status = 'failed', error = ? WHERE status = 'mixing'`)
    .run(message);

  // 移调任务同理：跑到一半的 ffmpeg 不可能续上。只碰「要求了非原调、移调伴奏
  // 还没落库、而且没有失败原因」的那些 —— 这三条合起来正是「当时正在生成」。
  //  · pitch_path 有值的说明早就生成好了，不能连坐；
  //  · pitch_error 有值的是上一次真实失败（ffmpeg 报错那种），原因得留着，
  //    覆盖成「重启导致的」就把真相改了。
  // 把 pitch_path 抹掉但不改 pitch_semitones：用户选的调还在，重新设一次
  // （或删掉重来）就能再生成，而播放会安全地回落到原调。
  const pitches = c
    .prepare(
      `UPDATE tracks
          SET pitch_path = NULL, pitch_error = '服务重启导致移调中断，请重新设置一次升降调'
        WHERE pitch_semitones <> 0 AND pitch_path IS NULL AND pitch_error IS NULL`,
    )
    .run();

  return {
    tracks: Number(tracks.changes),
    works: Number(works.changes),
    pitches: Number(pitches.changes),
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
    lyrics: row.lyrics,
    lyricsOffsetMs: Number.isFinite(Number(row.lyrics_offset_ms))
      ? Number(row.lyrics_offset_ms)
      : 0,
    // 老库只有 'upload' 一种来源；脏值一律回落到 upload
    source: row.source === 'library' ? 'library' : 'upload',
    libraryRef: row.library_ref,
    pitchSemitones: Number.isFinite(Number(row.pitch_semitones))
      ? Number(row.pitch_semitones)
      : 0,
    pitchPath: row.pitch_path,
    pitchError: row.pitch_error,
  };
}

/**
 * 解析落库的 mix_params JSON。
 *
 * 每个字段都以 DEFAULT_MIX_PARAMS 为回落 —— **这是老作品零回归的关键**：
 * 它们的 JSON 里根本没有均衡 / 压缩这些键，回落成中性值之后，
 * 重新合成的出声与本次改动前逐字节一致（有测试守着）。
 * 解析不出数字（手改库、脏数据）也走同一条回落路径，不静默变成 0。
 *
 * 混响的迁移：老作品存的是 `reverb: 'hall'` 这样的档位名。它映射到
 * 空间轴上的锚点位置（i/7）+ 满湿度，插值在锚点原样返回锚点值，
 * 于是老作品重新合成的滤镜串与改动前逐字节一致（tests/db.test.ts 守着）。
 * 没有档位名也没有新字段 → 回落默认（room 锚点）。
 *
 * 库里可能还留着更早版本写下的键（例如已删掉的升降调），一律忽略：
 * 返回的对象只按当前 MixParams 的字段集构造。
 */
function parseMixParams(raw: string): MixParams {
  const fallback = DEFAULT_MIX_PARAMS;
  try {
    const parsed = JSON.parse(raw) as Partial<MixParams> & { reverb?: unknown };

    // 严格有限数：只认真正的 number。旧 helper 用 Number(value) 会把 null 当成 0
    //（湿度为 0 = 干声），这里不能犯这个错。
    const num = (value: unknown, base: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : base;
    const unit = (value: unknown, base: number): number =>
      Math.min(1, Math.max(0, num(value, base)));

    // 新字段优先；只有旧档位名时按锚点迁移（湿度 1 = 锚点原值）
    const legacyKind = REVERB_KINDS.includes(parsed.reverb as ReverbKind)
      ? (parsed.reverb as ReverbKind)
      : null;
    const reverbSpace = unit(parsed.reverbSpace, legacyKind ? anchorSpace(legacyKind) : fallback.reverbSpace);
    const reverbWet = unit(parsed.reverbWet, legacyKind ? 1 : fallback.reverbWet);

    return {
      vocalGain: num(parsed.vocalGain, fallback.vocalGain),
      accompGain: num(parsed.accompGain, fallback.accompGain),
      reverbSpace,
      reverbWet,
      userOffsetMs: num(parsed.userOffsetMs, fallback.userOffsetMs),
      vocalPreset: VOCAL_PRESETS.includes(parsed.vocalPreset as VocalPreset)
        ? (parsed.vocalPreset as VocalPreset)
        : fallback.vocalPreset,

      eqLowDb: num(parsed.eqLowDb, fallback.eqLowDb),
      eqMidDb: num(parsed.eqMidDb, fallback.eqMidDb),
      eqHighDb: num(parsed.eqHighDb, fallback.eqHighDb),
      compression: num(parsed.compression, fallback.compression),
      deEss: num(parsed.deEss, fallback.deEss),
      noiseReduction:
        typeof parsed.noiseReduction === 'boolean'
          ? parsed.noiseReduction
          : fallback.noiseReduction,
    };
  } catch {
    return { ...DEFAULT_MIX_PARAMS };
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
    // null = 伴奏已被删除（外键 SET NULL）；作品本身还留着
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
    // 老库没有这一列：补列时 DEFAULT 0，读出来就是 0（= 原调，符合事实）
    pitchSemitones: Number.isFinite(Number(row.pitch_semitones)) ? Number(row.pitch_semitones) : 0,
  };
}

/**
 * 累积一次「列 = 值」的 UPDATE。
 * tracks / works 的 patch 都是「只更新传进来的字段」，拼装逻辑没有区别。
 */
function updateBuilder(table: 'tracks' | 'works') {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  return {
    set(column: string, value: string | number | null): void {
      sets.push(`${column} = ?`);
      values.push(value);
    },
    /** 一个字段都没设置就什么都不做（避免生成空的 SET） */
    run(id: string): void {
      if (sets.length === 0) return;
      values.push(id);
      connection()
        .prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`)
        .run(...values);
    },
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
  /** 默认 'upload'：除点歌下载外都是手动上传 */
  source?: TrackSource;
  /** 曲库来源 `providerId:itemId`；手动上传留空 */
  libraryRef?: string | null;
  lyrics?: string | null;
  /** 升降调（半音）；默认 0 = 原调 */
  pitchSemitones?: number;
}

export function insertTrack(input: NewTrack): void {
  connection()
    .prepare(
      `INSERT INTO tracks (id, title, artist, kind, original_name, original_path, playable_path,
                           proxy_kind, mime, size, duration, status, error, created_at,
                           lyrics, lyrics_offset_ms, source, library_ref, pitch_semitones)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
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
      input.lyrics ?? null,
      input.source ?? 'upload',
      input.libraryRef ?? null,
      Math.round(Number(input.pitchSemitones) || 0),
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

/** 按曲库来源键找伴奏；点歌去重用（唯一索引保证最多一条） */
export function getTrackByLibraryRef(libraryRef: string): TrackRecord | undefined {
  const row = connection()
    .prepare('SELECT * FROM tracks WHERE library_ref = ?')
    .get(libraryRef) as TrackRow | undefined;
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
  /** null = 清除歌词 */
  lyrics?: string | null;
  lyricsOffsetMs?: number;
  /** 升降调（半音） */
  pitchSemitones?: number;
  /** 移调伴奏路径；null = 作废（换调 / 回原调 / 生成失败） */
  pitchPath?: string | null;
  /** 移调失败原因；null = 清掉 */
  pitchError?: string | null;
}

export function updateTrack(id: string, patch: TrackPatch): void {
  const builder = updateBuilder('tracks');

  if (patch.title !== undefined) builder.set('title', patch.title);
  if (patch.artist !== undefined) builder.set('artist', patch.artist);
  if (patch.playablePath !== undefined) builder.set('playable_path', patch.playablePath);
  if (patch.proxyKind !== undefined) builder.set('proxy_kind', patch.proxyKind);
  if (patch.duration !== undefined) builder.set('duration', patch.duration);
  if (patch.status !== undefined) builder.set('status', patch.status);
  if (patch.error !== undefined) builder.set('error', patch.error);
  if (patch.lyrics !== undefined) builder.set('lyrics', patch.lyrics);
  if (patch.lyricsOffsetMs !== undefined) builder.set('lyrics_offset_ms', patch.lyricsOffsetMs);
  if (patch.pitchSemitones !== undefined) {
    builder.set('pitch_semitones', Math.round(Number(patch.pitchSemitones) || 0));
  }
  if (patch.pitchPath !== undefined) builder.set('pitch_path', patch.pitchPath);
  if (patch.pitchError !== undefined) builder.set('pitch_error', patch.pitchError);

  builder.run(id);
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
  /** 混音时伴奏处在哪个调（半音）的快照；0 = 原调 */
  pitchSemitones?: number;
}

export function insertWork(input: NewWork): void {
  const now = Date.now();
  connection()
    .prepare(
      `INSERT INTO works (id, track_id, title, vocal_path, vocal_duration, auto_offset_ms,
                          mix_params, mp3_path, status, error, created_at, updated_at, align_ver,
                          pitch_semitones)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, 2, ?)`,
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
      Math.round(Number(input.pitchSemitones) || 0),
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
  /** 混音时伴奏的调（半音）快照；每次混音前刷新 */
  pitchSemitones?: number;
}

export function updateWork(id: string, patch: WorkPatch): void {
  const builder = updateBuilder('works');

  if (patch.title !== undefined) builder.set('title', patch.title);
  if (patch.mixParams !== undefined) builder.set('mix_params', JSON.stringify(patch.mixParams));
  if (patch.levels !== undefined) {
    builder.set('levels', patch.levels ? JSON.stringify(patch.levels) : null);
  }
  if (patch.mp3Path !== undefined) builder.set('mp3_path', patch.mp3Path);
  if (patch.status !== undefined) builder.set('status', patch.status);
  if (patch.error !== undefined) builder.set('error', patch.error);
  if (patch.pitchSemitones !== undefined) {
    builder.set('pitch_semitones', Math.round(Number(patch.pitchSemitones) || 0));
  }

  builder.set('updated_at', Date.now());
  builder.run(id);
}

export function deleteWork(id: string): void {
  connection().prepare('DELETE FROM works WHERE id = ?').run(id);
}
