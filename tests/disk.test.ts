import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createIsolatedDataDir, removeIsolatedDataDir } from './isolated.ts';

/**
 * 磁盘预检。
 *
 * 守两条契约：量得到的余量必须是正数（bavail×bsize 的算法没绕反）；
 * 「要得比剩的多」时必须抛出**说人话**的错（剩多少、要多少），
 * 而不是把 ffmpeg 的 "No space left on device" 透传给用户。
 */

let dataDir = '';
let disk: typeof import('../server/src/disk.ts');

before(async () => {
  // 先设 DATA_DIR 再 import —— config.ts 是加载时求值的
  dataDir = await createIsolatedDataDir('disk');
  disk = await import('../server/src/disk.ts');
});

after(async () => {
  if (dataDir) await removeIsolatedDataDir(dataDir);
});

describe('磁盘预检', () => {
  it('readableBytes：按 1024 进制格式化', () => {
    assert.equal(disk.readableBytes(0), '0KB');
    assert.equal(disk.readableBytes(1024 * 1024 * 1024 * 2.5), '2.50GB');
    assert.equal(disk.readableBytes(1024 * 1024 * 12), '12.0MB');
    assert.equal(disk.readableBytes(1024 * 700), '700KB');
    assert.equal(disk.readableBytes(Number.NaN), '未知');
  });

  it('freeBytes：数据目录所在文件系统有正数余量', async () => {
    const free = await disk.freeBytes(dataDir);
    assert.ok(free > 0, '余量必须是正数');
  });

  it('ensureFreeSpace：要得比剩的多时抛出带余量的文案', async () => {
    const free = await disk.freeBytes(dataDir);
    // 比当前余量多要 1 字节：必然触发「不足」分支
    await assert.rejects(
      disk.ensureFreeSpace(free + 1, '测试操作'),
      (error: Error) => {
        assert.match(error.message, /磁盘剩余空间不足/);
        assert.match(error.message, /测试操作约需/);
        return true;
      },
    );
  });

  it('ensureFreeSpace：空间够时静默放行', async () => {
    await disk.ensureFreeSpace(1024, '测试操作');
  });
});
