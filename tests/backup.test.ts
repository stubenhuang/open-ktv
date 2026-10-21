//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { createIsolatedDataDir, removeIsolatedDataDir } from './isolated.ts';

/**
 * 备份脚本的端到端验证：对临时 DATA_DIR 真跑一次 scripts/backup.mjs，
 * 解包后确认（a）tar 里有快照与媒体目录；（b）快照里能读出库里已有的记录。
 *
 * 守的是 README 里那句「备份直接拷 data/ 就行」被推翻之后的新契约：
 * 备份必须包含 WAL 里未合并的写入（VACUUM INTO 快照），且恢复出来能用。
 */

let dataDir = '';
let workDir = '';

before(async () => {
  dataDir = await createIsolatedDataDir('backup');
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'open-ktv-backup-out-'));

  const { initDb, insertTrack } = await import('../server/src/db.ts');
  initDb();
  // 插一条记录：备份→恢复后它必须还在（证明快照不是空库）
  insertTrack({
    id: 'backup-test-track',
    title: '备份测试歌',
    artist: '测试歌手',
    kind: 'audio',
    originalName: 'test.mp3',
    originalPath: path.join(dataDir, 'originals', 'test.mp3'),
    playablePath: path.join(dataDir, 'originals', 'test.mp3'),
    proxyKind: 'none',
    mime: 'audio/mpeg',
    size: 1024,
    duration: 12,
    status: 'ready',
    error: null,
  });
  // 一个媒体文件：tar 里应该出现
  fs.writeFileSync(path.join(dataDir, 'originals', 'test.mp3'), 'fake-mp3');
});

after(async () => {
  if (dataDir) await removeIsolatedDataDir(dataDir);
  if (workDir) await fs.promises.rm(workDir, { recursive: true, force: true });
});

function runBackup(outputPath: string) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/backup.mjs', outputPath], {
    env: { ...process.env, DATA_DIR: dataDir },
    encoding: 'utf8',
  });
}

describe('备份脚本', () => {
  it('产出 tar.gz，内含数据库快照与媒体目录', async () => {
    const output = path.join(workDir, 'out.tar.gz');
    const result = runBackup(output);

    assert.equal(result.status, 0, `备份失败：${result.stderr}`);
    assert.ok(fs.existsSync(output), '备份文件没生成');

    const list = spawnSync('tar', ['-tzf', output], { encoding: 'utf8' });
    assert.equal(list.status, 0, `tar 列表失败：${list.stderr}`);
    const entries = list.stdout.split('\n').filter(Boolean);
    assert.ok(entries.includes('ktv.db'), 'tar 里应有 ktv.db');
    assert.ok(entries.some((entry) => entry.startsWith('originals/')), 'tar 里应有 originals/');
    // tmp / certs 不该进去
    assert.ok(!entries.some((entry) => entry.startsWith('tmp/')), 'tmp/ 不应进备份');
    assert.ok(!entries.some((entry) => entry.startsWith('certs/')), 'certs/ 不应进备份');
  });

  it('快照含未合并的写入：恢复出来能读到备份时插入的记录', async () => {
    const output = path.join(workDir, 'restore.tar.gz');
    assert.equal(runBackup(output).status, 0, '备份失败');

    const restoreDir = path.join(workDir, 'restored');
    fs.mkdirSync(restoreDir, { recursive: true });
    const extract = spawnSync('tar', ['-xzf', output, '-C', restoreDir], { encoding: 'utf8' });
    assert.equal(extract.status, 0, `解包失败：${extract.stderr}`);

    // 备份完成后插一条新记录：模拟「WAL 里还没合并的写入」。
    // 然后重打一次包，新记录必须出现在快照里 —— 这正是直接拷文件会丢的部分。
    const { insertTrack } = await import('../server/src/db.ts');
    insertTrack({
      id: 'backup-test-track-2',
      title: '备份后新插入',
      artist: null,
      kind: 'audio',
      originalName: 'later.mp3',
      originalPath: path.join(dataDir, 'originals', 'later.mp3'),
      playablePath: path.join(dataDir, 'originals', 'later.mp3'),
      proxyKind: 'none',
      mime: 'audio/mpeg',
      size: 10,
      duration: 3,
      status: 'ready',
      error: null,
    });

    const output2 = path.join(workDir, 'out2.tar.gz');
    assert.equal(runBackup(output2).status, 0, '第二次备份失败');

    const restoreDir2 = path.join(workDir, 'restored2');
    fs.mkdirSync(restoreDir2, { recursive: true });
    assert.equal(
      spawnSync('tar', ['-xzf', output2, '-C', restoreDir2], { encoding: 'utf8' }).status,
      0,
    );

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(restoreDir2, 'ktv.db'));
    try {
      const row = db.prepare('SELECT title FROM tracks WHERE id = ?').get('backup-test-track-2');
      assert.equal(row?.title, '备份后新插入', '快照必须包含备份时刻的写入');
    } finally {
      db.close();
    }
  });

  it('输出路径落在数据目录里时被拒绝', () => {
    const inside = path.join(dataDir, 'oops.tar.gz');
    const result = runBackup(inside);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /不能放在数据目录里/);
    assert.ok(!fs.existsSync(inside), '不该真的生成文件');
  });
});
