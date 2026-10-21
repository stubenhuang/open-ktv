//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { killRunningChildren, runningChildCount, runProcess } from '../server/src/process.ts';

/**
 * 子进程登记与收尾。
 *
 * 守住的是「优雅关闭不留 ffmpeg 孤儿」这条：runProcess 起来的进程必须
 * 进了登记表（shutdown 靠它知道要收什么），被信号收掉后必须摘表
 * （否则计数只涨不消，关闭流程的日志会撒谎）。
 */
describe('子进程登记表', () => {
  it('跑起来的进程被登记，killRunningChildren 后退出并摘表', async () => {
    const done = runProcess({
      bin: 'sleep',
      args: ['30'],
      timeoutMs: 60_000,
      label: 'test-sleep',
      missingBinMessage: '找不到 sleep',
    });

    // spawn 是同步的，此刻一定已经登记
    assert.equal(runningChildCount(), 1);

    await killRunningChildren();

    const result = await done;
    // 被信号收走：runProcess 的 code 为 null（见 ChildProcess 语义）
    assert.equal(result.code, null);
    assert.equal(runningChildCount(), 0, 'close 后必须摘表');
  });

  it('没有子进程时 killRunningChildren 立即返回', async () => {
    await killRunningChildren();
    assert.equal(runningChildCount(), 0);
  });

  it('正常结束的进程也会摘表', async () => {
    const result = await runProcess({
      bin: 'sleep',
      args: ['0'],
      timeoutMs: 10_000,
      label: 'test-sleep-short',
      missingBinMessage: '找不到 sleep',
    });
    assert.equal(result.code, 0);
    assert.equal(runningChildCount(), 0);
  });
});
