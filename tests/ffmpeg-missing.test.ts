import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * FFMPEG_BIN 在 config.ts 模块加载时求值，所以必须先设环境变量再动态 import。
 * 这也是本文件独立存在的原因：别的测试文件要用真 ffmpeg。
 */
process.env.FFMPEG_BIN = '/definitely/not/ffmpeg';
const { runFfmpeg } = await import('../server/src/ffmpeg.ts');

describe('ffmpeg 缺失时的错误提示', () => {
  it('二进制找不到时给出可操作的报错', async () => {
    await assert.rejects(
      runFfmpeg({
        args: ['-version'],
        timeoutMs: 10_000,
        label: '测试缺失',
      }),
      /找不到 ffmpeg/,
    );
  });
});
