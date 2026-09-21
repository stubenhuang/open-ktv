import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runFfmpeg } from '../server/src/ffmpeg.ts';
import { measureLoudness, normalizeGainDb } from '../server/src/loudness.ts';
import { buildMixArgs, buildMixFilter, computeLevels, effectiveOffsetMs } from '../server/src/mix.ts';
import { MIX_LIMITS } from '../shared/types.ts';
import { cleanupDir, ffmpegOk, makeTempDir, sineArgs, summarize } from './helpers.ts';

let workDir = '';
let accompaniment = '';
let vocal = '';

before(async () => {
  workDir = await makeTempDir('mix');
  accompaniment = path.join(workDir, 'accomp.mp3');
  vocal = path.join(workDir, 'vocal.wav');
  await ffmpegOk(sineArgs(accompaniment, 3, 440, ['-c:a', 'libmp3lame', '-b:a', '192k']));
  await ffmpegOk(sineArgs(vocal, 2, 880, ['-c:a', 'pcm_s16le']));
});

after(async () => {
  if (workDir) await cleanupDir(workDir);
});

async function mixTo(outputName: string, offsetMs: number, vocalGain = 1, reverb: 'dry' | 'room' | 'hall' | 'stage' = 'dry') {
  const output = path.join(workDir, outputName);
  const levels = computeLevels({ vocalGain, accompGain: 1 }, 0, 0);
  await runFfmpeg({
    args: buildMixArgs({
      vocalPath: vocal,
      accompanimentPath: accompaniment,
      outputPath: output,
      title: '测试作品',
      offsetMs,
      levels,
      reverb,
    }),
    timeoutMs: 120_000,
    label: '测试混音',
  });
  return output;
}

describe('混音纯逻辑', () => {
  it('对齐偏移被夹在合理范围内', () => {
    assert.equal(effectiveOffsetMs(300, 0), 300);
    assert.equal(effectiveOffsetMs(300, -500), 0, '负偏移夹到 0');
    assert.equal(effectiveOffsetMs(0, 250), 250);
    assert.equal(effectiveOffsetMs(29_900, 500), 30_000, '上限夹到 30s');
    assert.equal(effectiveOffsetMs(Number.NaN, 100), 100, 'NaN 当成 0 处理');
  });

  it('人工微调范围是 ±1000ms', () => {
    assert.equal(MIX_LIMITS.userOffsetMs.min, -1000);
    assert.equal(MIX_LIMITS.userOffsetMs.max, 1000);
    assert.equal(effectiveOffsetMs(0, 1000), 1000, '+1000ms 微调要生效');
    assert.equal(effectiveOffsetMs(1000, 1000), 2000, '自动值 + 人工微调叠加');
    assert.equal(effectiveOffsetMs(0, -1000), 0, '负偏移仍夹到 0');
  });

  it('用户音量滑块乘在归一化增益之上', () => {
    // +6dB ≈ ×2
    const levels = computeLevels({ vocalGain: 0.5, accompGain: 2 }, 6.0206, -6.0206);
    assert.ok(Math.abs(levels.vocalLinear - 1) < 0.001, `实际 ${levels.vocalLinear}`);
    assert.ok(Math.abs(levels.accompLinear - 1) < 0.001, `实际 ${levels.accompLinear}`);
  });

  it('音量被夹在 0–4 之间，不会因为脏参数炸掉', () => {
    assert.equal(computeLevels({ vocalGain: 100, accompGain: 100 }, 30, 30).vocalLinear, 4);
    assert.equal(computeLevels({ vocalGain: -5, accompGain: -5 }, 0, 0).vocalLinear, 0);
    assert.equal(computeLevels({ vocalGain: Number.NaN, accompGain: 1 }, 0, 0).vocalLinear, 1);
  });

  it('adelay 挂在人声分支上（挂错地方等于没对齐）', () => {
    const filter = buildMixFilter({
      offsetMs: 500,
      levels: { vocalLinear: 1, accompLinear: 1 },
      reverb: 'dry',
    });
    const [vocalBranch, accompBranch] = filter.split(';');

    assert.match(vocalBranch!, /^\[0:a\]/);
    assert.match(vocalBranch!, /adelay=delays=500:all=1/);
    assert.doesNotMatch(accompBranch!, /adelay/, '伴奏分支不该被延迟');
    assert.match(filter, /amix=inputs=2:duration=first:normalize=0/);
    assert.match(filter, /alimiter=limit=0\.95/);
  });

  it('偏移为 0 时不加 adelay；混响按档次切换', () => {
    const dry = buildMixFilter({ offsetMs: 0, levels: { vocalLinear: 1, accompLinear: 1 }, reverb: 'dry' });
    assert.doesNotMatch(dry, /adelay/);
    assert.doesNotMatch(dry, /aecho/);

    const hall = buildMixFilter({ offsetMs: 0, levels: { vocalLinear: 1, accompLinear: 1 }, reverb: 'hall' });
    assert.match(hall, /aecho=/);
  });
});

describe('混音端到端（真实 ffmpeg）', () => {
  it('输出 192kbps 立体声 MP3', async () => {
    const output = await mixTo('out-basic.mp3', 0, 1, 'dry');
    const summary = await summarize(output);

    assert.equal(summary.audioCodec, 'mp3');
    assert.equal(summary.sampleRate, 48_000);
    assert.equal(summary.channels, 2);
    assert.equal(summary.hasVideo, false);
  });

  it('duration=first：成品长度跟人声走，不会拖出纯伴奏尾巴', async () => {
    // 伴奏 3s，人声 2s，偏移 0 → 成品约 2s
    const output = await mixTo('out-short.mp3', 0, 1, 'dry');
    const { durationSec } = await summarize(output);

    assert.ok(durationSec! > 1.7 && durationSec! < 2.4, `成品应约为 2s，实际 ${durationSec}s`);
  });

  it('对齐偏移会把成品整体拉长（人声被推后）', async () => {
    const output = await mixTo('out-offset.mp3', 500, 1, 'dry');
    const { durationSec } = await summarize(output);

    assert.ok(
      durationSec! > 2.2 && durationSec! < 2.9,
      `人声 2s + 偏移 0.5s 应约为 2.5s，实际 ${durationSec}s`,
    );
  });

  it('四档混响都能成功出片', async () => {
    for (const reverb of ['dry', 'room', 'hall', 'stage'] as const) {
      const output = await mixTo(`out-reverb-${reverb}.mp3`, 150, 1, reverb);
      const summary = await summarize(output);
      assert.equal(summary.audioCodec, 'mp3', `混响 ${reverb} 出片失败`);
      assert.ok(summary.durationSec! > 1.7, `混响 ${reverb} 时长异常：${summary.durationSec}`);
    }
  });

  it('人声音量拉到 0 时不出错（等于只要伴奏）', async () => {
    const output = await mixTo('out-muted-vocal.mp3', 0, 0, 'dry');
    const summary = await summarize(output);
    assert.equal(summary.audioCodec, 'mp3');
    assert.ok(summary.durationSec! > 1.7);
  });
});

describe('响度测量与归一化', () => {
  it('能分辨大声和轻声，并算出方向正确的增益', async () => {
    // ffmpeg 的 sine 源振幅只有 1/8（-18dBFS），必须显式加音量才能造出「大声」样本
    const loudFile = path.join(workDir, 'loud.wav');
    const quietFile = path.join(workDir, 'quiet.wav');
    await ffmpegOk(sineArgs(loudFile, 3, 440, ['-af', 'volume=18dB', '-c:a', 'pcm_s16le']));
    await ffmpegOk(sineArgs(quietFile, 3, 440, ['-af', 'volume=-12dB', '-c:a', 'pcm_s16le']));

    const [loud, quiet] = await Promise.all([measureLoudness(loudFile), measureLoudness(quietFile)]);

    assert.ok(Number.isFinite(loud.inputI), '大声文件测不到响度');
    assert.ok(Number.isFinite(quiet.inputI), '轻声文件测不到响度');
    assert.ok(loud.inputI > quiet.inputI + 20, `响度差应超过 20 LU：${loud.inputI} vs ${quiet.inputI}`);

    assert.ok(normalizeGainDb(loud, -18) < 0, '太响应该被压下来');
    assert.ok(normalizeGainDb(quiet, -18) > 0, '太轻应该被推上去');
  });

  it('静音文件返回 0dB 而不是 NaN / Infinity', () => {
    assert.equal(normalizeGainDb({ inputI: Number.NEGATIVE_INFINITY, inputTp: Number.NEGATIVE_INFINITY }, -18), 0);
  });

  it('真峰值贴顶时不再盲目推响度', () => {
    // 响度很低但峰值已经是 -0.5dBTP：只能推 -1 - (-0.5) = -0.5dB
    const gain = normalizeGainDb({ inputI: -40, inputTp: -0.5 }, -18);
    assert.ok(Math.abs(gain - -0.5) < 0.001, `实际 ${gain}`);
  });
});
