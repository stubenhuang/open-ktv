import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { classifyProbe } from '../server/src/classify.ts';
import { probeFile } from '../server/src/probe.ts';
import { buildTranscodeArgs } from '../server/src/transcode.ts';
import { cleanupDir, ffmpegOk, makeTempDir, sineArgs, summarize } from './helpers.ts';

let workDir = '';

before(async () => {
  workDir = await makeTempDir('transcode');
});

after(async () => {
  if (workDir) await cleanupDir(workDir);
});

describe('代理转码', () => {
  it('mkv(h264+aac) 转成浏览器可播的 mp4', async () => {
    const source = path.join(workDir, 'src.mkv');
    const output = path.join(workDir, 'proxy.mp4');

    await ffmpegOk([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=15:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-shortest',
      source,
    ]);

    await ffmpegOk(buildTranscodeArgs({ sourcePath: source, outputPath: output, target: 'video' }));
    const summary = await summarize(output);

    assert.equal(summary.videoCodec, 'h264');
    assert.equal(summary.audioCodec, 'aac');
    assert.equal(summary.sampleRate, 48_000);
    assert.equal(summary.channels, 2, '音频代理统一成 48k 立体声');
    assert.ok(summary.durationSec! > 0.5 && summary.durationSec! < 2, `时长异常：${summary.durationSec}`);

    // 用分类器反向确认产出的文件真的能直接播
    const verdict = classifyProbe(await probeFile(output), { extension: '.mp4' });
    assert.equal(verdict.playable, true, verdict.reason);
  });

  it('奇数分辨率的源被修正成偶数（h264 yuv420p 的硬要求）', async () => {
    const source = path.join(workDir, 'odd.mkv');
    const output = path.join(workDir, 'odd-out.mp4');

    // 641x361 这种奇数尺寸在 yuv420p 下根本没法编码，必须靠 scale 表达式修圆
    await ffmpegOk([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=15:duration=1',
      '-vf',
      'scale=641:361',
      '-pix_fmt',
      'yuv444p',
      '-c:v',
      'ffv1',
      '-an',
      source,
    ]);
    assert.equal((await summarize(source)).width, 641, '前置条件：源确实是奇数宽度');

    await ffmpegOk(buildTranscodeArgs({ sourcePath: source, outputPath: output, target: 'video' }));
    const summary = await summarize(output);

    assert.equal(summary.videoCodec, 'h264');
    assert.equal(summary.width! % 2, 0, `宽度必须偶数，实际 ${summary.width}`);
    assert.equal(summary.height! % 2, 0, `高度必须偶数，实际 ${summary.height}`);
    assert.equal(summary.width, 640);
    assert.equal(summary.hasAudio, false, '源没有音轨时也要能转成功（-map 0:a:0? 可选）');
  });

  it('flac 音源转成 mp3 代理', async () => {
    const source = path.join(workDir, 'src.flac');
    const output = path.join(workDir, 'proxy.mp3');

    await ffmpegOk(sineArgs(source, 1, 440, ['-c:a', 'flac']));
    await ffmpegOk(buildTranscodeArgs({ sourcePath: source, outputPath: output, target: 'audio' }));
    const summary = await summarize(output);

    assert.equal(summary.audioCodec, 'mp3');
    assert.equal(summary.sampleRate, 48_000);
    assert.equal(summary.channels, 2);
    assert.equal(summary.hasVideo, false);
  });
});
