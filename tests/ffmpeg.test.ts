import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runFfmpeg } from '../server/src/ffmpeg.ts';
import { cleanupDir, ffmpegOk, makeTempDir, sineArgs } from './helpers.ts';

let workDir = '';
let wav = '';

before(async () => {
  workDir = await makeTempDir('ffmpeg');
  wav = path.join(workDir, 'tone.wav');
  await ffmpegOk(sineArgs(wav, 2, 440, ['-c:a', 'pcm_s16le']));
});

after(async () => {
  if (workDir) await cleanupDir(workDir);
});

describe('runFfmpeg', () => {
  it('成功时 resolve', async () => {
    await runFfmpeg({
      args: ['-y', '-hide_banner', '-i', wav, '-f', 'null', '-'],
      timeoutMs: 60_000,
      label: '测试空输出',
    });
  });

  it('成功时补发一次 100% 进度', async () => {
    const ratios: number[] = [];
    await runFfmpeg({
      args: ['-y', '-hide_banner', '-i', wav, '-f', 'null', '-'],
      timeoutMs: 60_000,
      totalDurationSec: 2,
      onProgress: (ratio) => ratios.push(ratio),
      label: '测试进度',
    });

    assert.ok(ratios.length > 0, '一次进度都没收到');
    assert.equal(ratios.at(-1), 1, '结束时必须是 1');
    for (const ratio of ratios) {
      assert.ok(ratio >= 0 && ratio <= 1, `进度越界：${ratio}`);
    }
    // 单调不回退（-progress 按时间顺序打印）
    for (let i = 1; i < ratios.length; i += 1) {
      assert.ok(ratios[i]! >= ratios[i - 1]!, `进度回退：${ratios[i - 1]} → ${ratios[i]}`);
    }
  });

  it('没有 totalDurationSec 时只补发最终的 100%', async () => {
    const ratios: number[] = [];
    await runFfmpeg({
      args: ['-y', '-hide_banner', '-i', wav, '-f', 'null', '-'],
      timeoutMs: 60_000,
      onProgress: (ratio) => ratios.push(ratio),
      label: '测试无进度',
    });
    // 没有总时长就没法算中间进度，但成功时仍会补一次 1（队列据此显示 100%）
    assert.deepEqual(ratios, [1]);
  });

  it('ffmpeg 非零退出时 reject，消息带退出码和 stderr 尾部', async () => {
    await assert.rejects(
      runFfmpeg({
        args: ['-y', '-hide_banner', '-i', path.join(workDir, '不存在的文件.mp3'), '-f', 'null', '-'],
        timeoutMs: 60_000,
        label: '测试失败',
      }),
      (error: Error) => {
        assert.match(error.message, /测试失败 失败（退出码 [1-9]\d*）/);
        return true;
      },
    );
  });

  it('超时会被杀掉并 reject', async () => {
    // 无限长的正弦波流：不靠时长，必须靠超时杀掉
    await assert.rejects(
      runFfmpeg({
        args: [
          '-hide_banner',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440',
          '-f',
          'null',
          '-',
        ],
        timeoutMs: 300,
        label: '测试超时',
      }),
      /测试超时 超时（0s）已中止/,
    );
  });
});
