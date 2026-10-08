import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { effectiveOffsetMs } from '../shared/mix.ts';
import { DEFAULT_MIX_PARAMS } from '../shared/types.ts';
import { createIsolatedDataDir, removeIsolatedDataDir, sleep } from './isolated.ts';

/**
 * DATA_DIR 必须在 import config.ts/db.ts 之前设好（模块加载时求值），
 * 所以这里全部走动态 import —— 见 tests/isolated.ts 的说明。
 */
let dataDir = '';
let db: typeof import('../server/src/db.ts');

before(async () => {
  dataDir = await createIsolatedDataDir('db');
  db = await import('../server/src/db.ts');
  db.initDb();
});

after(async () => {
  if (dataDir) await removeIsolatedDataDir(dataDir);
});

function newTrack(id: string, overrides: Partial<Parameters<typeof db.insertTrack>[0]> = {}) {
  return {
    id,
    title: `歌${id}`,
    artist: null,
    kind: 'audio' as const,
    originalName: `${id}.mp3`,
    originalPath: `/tmp/${id}.mp3`,
    playablePath: `/tmp/${id}.mp3`,
    proxyKind: 'none' as const,
    mime: 'audio/mpeg',
    size: 2048,
    duration: 120.5,
    status: 'ready' as const,
    error: null,
    ...overrides,
  };
}

function newWork(id: string, trackId: string, overrides: Partial<Parameters<typeof db.insertWork>[0]> = {}) {
  return {
    id,
    trackId,
    title: `作品${id}`,
    vocalPath: `/tmp/${id}.wav`,
    vocalDuration: 60,
    autoOffsetMs: 150,
    mixParams: { ...DEFAULT_MIX_PARAMS },
    status: 'mixing' as const,
    ...overrides,
  };
}

describe('tracks 表', () => {
  it('insert / get / list 往返，null 字段也保得住', () => {
    db.insertTrack(newTrack('r1', { artist: null, duration: null, mime: null }));
    const record = db.getTrack('r1');

    assert.ok(record);
    assert.equal(record.title, '歌r1');
    assert.equal(record.artist, null);
    assert.equal(record.duration, null);
    assert.equal(record.mime, null);
    assert.equal(record.kind, 'audio');
    assert.equal(record.size, 2048);
    assert.equal(db.getTrack('不存在'), undefined);
  });

  it('listTracks 按创建时间倒序（新的在前）', async () => {
    db.insertTrack(newTrack('old'));
    await sleep(5);
    db.insertTrack(newTrack('new'));

    const ids = db.listTracks().map((track) => track.id);
    assert.ok(ids.indexOf('new') < ids.indexOf('old'), `实际顺序 ${ids.join(',')}`);
  });

  it('updateTrack 只改传入的字段，空 patch 不产生 SQL', () => {
    db.insertTrack(newTrack('u1', { title: '旧名字', artist: '旧歌手' }));
    db.updateTrack('u1', { title: '新名字' });

    const record = db.getTrack('u1')!;
    assert.equal(record.title, '新名字');
    assert.equal(record.artist, '旧歌手', '没传的字段不该被抹掉');

    db.updateTrack('u1', {}); // 不该抛错
    assert.equal(db.getTrack('u1')!.title, '新名字');

    db.updateTrack('u1', { artist: null });
    assert.equal(db.getTrack('u1')!.artist, null, '允许显式清空');
  });

  it('deleteTrack 删除记录', () => {
    db.insertTrack(newTrack('d1'));
    db.deleteTrack('d1');
    assert.equal(db.getTrack('d1'), undefined);
  });

  it('deleteTrack 不再被作品拦截：作品的 track_id 被置空，作品记录还在', () => {
    db.insertTrack(newTrack('d-keep'));
    db.insertWork(newWork('w-keep', 'd-keep'));

    db.deleteTrack('d-keep');

    assert.equal(db.getTrack('d-keep'), undefined, '伴奏没了');
    const survived = db.getWork('w-keep');
    assert.ok(survived, '作品记录要留着（成品 MP3 还能播放/下载）');
    assert.equal(survived.trackId, null, '外键 ON DELETE SET NULL 自动脱钩');
    assert.equal(survived.title, '作品w-keep', '作品自身的内容不该被抹掉');
  });
});

describe('works 外键迁移（删伴奏与作品解耦）', () => {
  it('老库（NOT NULL + NO ACTION）重建后：删伴奏不再拦，作品 track_id 置空', () => {
    // 先把 works 表换回老形态：track_id NOT NULL、外键 NO ACTION（= 有作品就删不掉）
    exec('DROP TABLE works');
    exec(`CREATE TABLE works (
      id TEXT PRIMARY KEY,
      track_id TEXT NOT NULL REFERENCES tracks(id),
      title TEXT NOT NULL,
      vocal_path TEXT NOT NULL,
      vocal_duration REAL NOT NULL,
      auto_offset_ms INTEGER NOT NULL,
      mix_params TEXT NOT NULL,
      mp3_path TEXT,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      levels TEXT,
      align_ver INTEGER NOT NULL DEFAULT 1
    )`);

    // 老外键下删伴奏应该被拦住（SQLite 约束错误）—— 这正是迁移要解决的问题
    db.insertTrack(newTrack('mig-old'));
    db.insertWork(newWork('mig-old-w', 'mig-old'));
    assert.throws(() => db.deleteTrack('mig-old'), /FOREIGN KEY|constraint/i);

    // 重新初始化：应检测到老外键并重建表
    db.initDb();

    // 数据还在（重建表不能丢作品）
    const work = db.getWork('mig-old-w');
    assert.ok(work, '迁移不能丢作品');
    assert.equal(work.title, '作品mig-old-w');

    // 现在可以删了，作品保留并脱钩
    db.deleteTrack('mig-old');
    assert.equal(db.getWork('mig-old-w')!.trackId, null);
    assert.equal(db.getTrack('mig-old'), undefined);

    // 新插入的作品照常带 track_id，外键仍然生效（伴奏不存在时插作品照样抛错）
    db.insertTrack(newTrack('mig-new'));
    db.insertWork(newWork('mig-new-w', 'mig-new'));
    assert.equal(db.getWork('mig-new-w')!.trackId, 'mig-new');
    assert.throws(() => db.insertWork(newWork('mig-bad', '不存在的伴奏')));
  });

  it('新库重复 initDb 不会反复重建表', () => {
    // 迁移是幂等的：第二次 initDb 检测到已是 SET NULL，什么都不做
    db.initDb();
    db.insertTrack(newTrack('idem'));
    db.insertWork(newWork('idem-w', 'idem'));
    db.initDb();
    db.deleteTrack('idem');
    assert.equal(db.getWork('idem-w')!.trackId, null);
  });
});

describe('tracks 歌词与曲库来源', () => {
  it('新伴奏默认：无歌词、微调 0、来源 upload', () => {
    db.insertTrack(newTrack('lyr-default'));
    const record = db.getTrack('lyr-default')!;
    assert.equal(record.lyrics, null);
    assert.equal(record.lyricsOffsetMs, 0);
    assert.equal(record.source, 'upload');
    assert.equal(record.libraryRef, null);
  });

  it('歌词与微调往返，可显式清除', () => {
    const lyrics = '[00:01.00]甲\n[00:05.00]乙';
    db.insertTrack(newTrack('lyr1', { lyrics }));

    assert.equal(db.getTrack('lyr1')!.lyrics, lyrics);
    assert.equal(db.getTrack('lyr1')!.lyricsOffsetMs, 0);

    db.updateTrack('lyr1', { lyricsOffsetMs: -450 });
    assert.equal(db.getTrack('lyr1')!.lyricsOffsetMs, -450);

    db.updateTrack('lyr1', { lyrics: null });
    assert.equal(db.getTrack('lyr1')!.lyrics, null, '允许显式清空歌词');
    assert.equal(db.getTrack('lyr1')!.lyricsOffsetMs, -450, '清歌词不该动微调');
  });

  it('leaves offset 为 0 时不会被误写', () => {
    db.insertTrack(newTrack('lyr2', { lyrics: '[00:01.00]甲' }));
    db.updateTrack('lyr2', { lyrics: '[00:02.00]乙' });
    assert.equal(db.getTrack('lyr2')!.lyricsOffsetMs, 0);
  });

  it('libraryRef 可查回，且同一曲库条目只能入库一次', () => {
    db.insertTrack(newTrack('lib1', { source: 'library', libraryRef: 'http-index:qingtian' }));
    const found = db.getTrackByLibraryRef('http-index:qingtian')!;
    assert.equal(found.id, 'lib1');
    assert.equal(found.source, 'library');

    assert.equal(db.getTrackByLibraryRef('http-index:没这个'), undefined);

    // 唯一索引挡住重复点歌
    assert.throws(
      () => db.insertTrack(newTrack('lib1-dup', { source: 'library', libraryRef: 'http-index:qingtian' })),
      /UNIQUE|constraint/i,
    );
  });

  it('手动上传的 libraryRef 都是 null，不受唯一索引约束', () => {
    // 局部唯一索引（WHERE library_ref IS NOT NULL）的意义就在这里：
    // 一堆 NULL 不该互相冲突
    db.insertTrack(newTrack('up1'));
    db.insertTrack(newTrack('up2'));
    db.insertTrack(newTrack('up3'));
    assert.equal(db.getTrack('up3')!.libraryRef, null);
  });

  it('老库迁移：补上歌词/来源列，老数据回落默认值', () => {
    db.insertTrack(newTrack('mig-track'));
    exec('DROP INDEX IF EXISTS idx_tracks_library_ref');
    exec('ALTER TABLE tracks DROP COLUMN library_ref');
    exec('ALTER TABLE tracks DROP COLUMN source');
    exec('ALTER TABLE tracks DROP COLUMN lyrics');
    exec('ALTER TABLE tracks DROP COLUMN lyrics_offset_ms');

    db.initDb();

    const record = db.getTrack('mig-track')!;
    assert.equal(record.lyrics, null);
    assert.equal(record.lyricsOffsetMs, 0, '老行补列后取默认 0');
    assert.equal(record.source, 'upload', '老行补列后取默认 upload');
    assert.equal(record.libraryRef, null);

    // 迁移后唯一索引重新建起来了
    db.insertTrack(newTrack('lib-mig', { source: 'library', libraryRef: 'http-index:x' }));
    assert.throws(
      () => db.insertTrack(newTrack('lib-mig-dup', { source: 'library', libraryRef: 'http-index:x' })),
      /UNIQUE|constraint/i,
    );

    // 重复 initDb 幂等
    db.initDb();
    assert.equal(db.getTrack('mig-track')!.source, 'upload');
  });
});

describe('works 表', () => {
  it('外键生效：伴奏不存在时插入作品会抛错', () => {
    assert.throws(() => db.insertWork(newWork('w-fk', '不存在的伴奏')));
  });

  it('insert / get 往返，mixParams 原样回来', () => {
    db.insertTrack(newTrack('wt'));
    db.insertWork(newWork('w1', 'wt', { autoOffsetMs: 320 }));

    const work = db.getWork('w1')!;
    assert.equal(work.trackId, 'wt');
    assert.equal(work.vocalDuration, 60);
    assert.equal(work.autoOffsetMs, 320);
    assert.deepEqual(work.mixParams, DEFAULT_MIX_PARAMS);
    assert.equal(work.mp3Path, null);
    assert.equal(work.levels, null);
    assert.equal(work.createdAt > 0, true);
  });

  it('脏 mix_params / 脏 levels 回落默认值而不是崩掉', () => {
    db.insertTrack(newTrack('wt2'));
    db.insertWork(newWork('w2', 'wt2'));

    // 直接写坏数据，模拟老库 / 手改库
    const raw = db.getWork('w2')!;
    assert.ok(raw, '前置条件：作品存在');
    exec(`UPDATE works SET mix_params = '{}' WHERE id = 'w2'`);
    exec(`UPDATE works SET levels = '不是 JSON' WHERE id = 'w2'`);

    const work = db.getWork('w2')!;
    assert.deepEqual(work.mixParams, DEFAULT_MIX_PARAMS);
    assert.equal(work.levels, null, '解析不出 levels 时按没有实测增益处理');
  });

  it('updateWork 写 title / status / levels / mp3Path', () => {
    db.insertTrack(newTrack('wt3'));
    db.insertWork(newWork('w3', 'wt3'));

    db.updateWork('w3', {
      title: '改过的名字',
      status: 'ready',
      mp3Path: '/tmp/w3.mp3',
      levels: { vocalGainDb: -2.5, accompGainDb: 1 },
    });

    const work = db.getWork('w3')!;
    assert.equal(work.title, '改过的名字');
    assert.equal(work.status, 'ready');
    assert.equal(work.mp3Path, '/tmp/w3.mp3');
    assert.deepEqual(work.levels, { vocalGainDb: -2.5, accompGainDb: 1 });

    db.updateWork('w3', { levels: null });
    assert.equal(db.getWork('w3')!.levels, null);
  });

  it('countWorksForTrack 统计数量，删作品后归零', () => {
    db.insertTrack(newTrack('wt4'));
    db.insertWork(newWork('a', 'wt4'));
    db.insertWork(newWork('b', 'wt4'));

    assert.equal(db.countWorksForTrack('wt4'), 2);
    assert.equal(db.countWorksForTrack('没这个伴奏'), 0);

    db.deleteWork('a');
    assert.equal(db.countWorksForTrack('wt4'), 1);
  });

  it('老库迁移：align_ver=1 的旧公式作品换算到新公式', () => {
    db.insertTrack(newTrack('mig-t'));
    db.insertWork(
      newWork('mig-w', 'mig-t', {
        autoOffsetMs: 200,
        mixParams: { ...DEFAULT_MIX_PARAMS },
      }),
    );

    // 模拟老库：抹掉 align_ver 列（作品随之回到版本 1），再重新初始化触发迁移
    exec('ALTER TABLE works DROP COLUMN align_ver');
    db.initDb();

    const work = db.getWork('mig-w')!;
    assert.equal(work.autoOffsetMs, 200, 'auto 间隔原样保留');
    // 没拖过滑块的常见情况：userOld=0 原样保留，E_new = 0 − 200 = −200（旧公式是 +200）
    assert.equal(work.mixParams.userOffsetMs, 0);
    assert.equal(effectiveOffsetMs(work.autoOffsetMs, work.mixParams.userOffsetMs), -200);

    // 当时被拖拍逼着拖到下限的老作品（auto + userOld < 0，被旧公式钳到 0）：
    // 直接给满自动修正 —— E_new = −auto，正是当时够不着的位置
    exec('ALTER TABLE works DROP COLUMN align_ver');
    exec(
      `UPDATE works SET mix_params = '{"vocalGain":1,"accompGain":1,"reverb":"room","userOffsetMs":-1000}' WHERE id = 'mig-w'`,
    );
    db.initDb();
    const clamped = db.getWork('mig-w')!;
    assert.equal(clamped.mixParams.userOffsetMs, 0);
    assert.equal(effectiveOffsetMs(clamped.autoOffsetMs, clamped.mixParams.userOffsetMs), -200);

    // 拖过但没触下限的老微调：相对位置原样保留（E_new = userOld − auto）
    exec('ALTER TABLE works DROP COLUMN align_ver');
    exec(
      `UPDATE works SET mix_params = '{"vocalGain":1,"accompGain":1,"reverb":"room","userOffsetMs":-100}' WHERE id = 'mig-w'`,
    );
    db.initDb();
    const tuned = db.getWork('mig-w')!;
    assert.equal(tuned.mixParams.userOffsetMs, -100);
    assert.equal(effectiveOffsetMs(tuned.autoOffsetMs, tuned.mixParams.userOffsetMs), -300);
  });
});

describe('recoverInterruptedJobs', () => {
  it('只把 processing / mixing 标记为 failed，并返回计数', () => {
    db.insertTrack(newTrack('rec-t', { status: 'processing' }));
    db.insertTrack(newTrack('rec-ready', { status: 'ready' }));
    db.insertTrack(newTrack('rec-failed', { status: 'failed' }));
    db.insertWork(newWork('rec-w', 'rec-t', { status: 'mixing' }));

    const recovered = db.recoverInterruptedJobs();
    // 前面用例留下的 mixing 作品也会被一并收敛，所以只断言本用例相关的部分
    assert.equal(recovered.tracks, 1);
    assert.ok(recovered.works >= 1, `实际 ${recovered.works}`);

    assert.equal(db.getTrack('rec-t')!.status, 'failed');
    assert.match(db.getTrack('rec-t')!.error!, /重启/);
    assert.equal(db.getWork('rec-w')!.status, 'failed');
    // 其他状态不该被碰
    assert.equal(db.getTrack('rec-ready')!.status, 'ready');
    assert.equal(db.getTrack('rec-failed')!.status, 'failed');

    // 再跑一次没有可恢复的，计数归零
    assert.deepEqual(db.recoverInterruptedJobs(), { tracks: 0, works: 0 });
  });
});

/** 测试专用：绕过封装直接执行 SQL，用来构造脏数据（WAL 下同文件可再开一个连接） */
function exec(sql: string): void {
  const connection = new DatabaseSync(path.join(dataDir, 'ktv.db'));
  try {
    connection.exec(sql);
  } finally {
    connection.close();
  }
}
