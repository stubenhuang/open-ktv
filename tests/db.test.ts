import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
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
    mixParams: { vocalGain: 1, accompGain: 1, reverb: 'room' as const, userOffsetMs: 0 },
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
    assert.deepEqual(work.mixParams, { vocalGain: 1, accompGain: 1, reverb: 'room', userOffsetMs: 0 });
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
    assert.deepEqual(work.mixParams, { vocalGain: 1, accompGain: 1, reverb: 'room', userOffsetMs: 0 });
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
