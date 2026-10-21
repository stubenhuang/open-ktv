//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runFfmpeg } from '../server/src/ffmpeg.ts';
import { measureLoudness, normalizeGainDb } from '../server/src/loudness.ts';
import {
  buildMixArgs,
  buildMixFilter,
  computeLevels,
  reverbActive,
} from '../server/src/mix.ts';
import { writeReverbIr } from '../server/src/mixJob.ts';
import {
  EQ_BANDS,
  anchorSpace,
  effectiveOffsetMs,
  mixTimeline,
  reverbDsp,
  reverbIrKey,
  reverbIrSpec,
} from '../shared/mix.ts';
import { MIX_LIMITS, REVERB_ANCHORS, REVERB_KINDS } from '../shared/types.ts';
import {
  burstVocalArgs,
  cleanupDir,
  decodeToFloat32,
  ffmpegOk,
  makeTempDir,
  rmsOfWindow,
  silenceArgs,
  sineArgs,
  summarize,
} from './helpers.ts';

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

/** buildMixFilter 的完整输入：用例只覆盖自己关心的字段，其余给中性值 */
function filterInput(overrides: Partial<Parameters<typeof buildMixFilter>[0]> = {}) {
  return {
    offsetMs: 0,
    levels: { vocalLinear: 1, accompLinear: 1 },
    // 空间 0 = 原声（旁通，不挂混响）
    reverbSpace: 0,
    reverbWet: 1,
    eqLowDb: 0,
    eqMidDb: 0,
    eqHighDb: 0,
    ...overrides,
  };
}

async function mixTo(
  outputName: string,
  offsetMs: number,
  vocalGain = 1,
  reverbSpace = 0,
  reverbWet = 1,
) {
  const output = path.join(workDir, outputName);
  const levels = computeLevels({ vocalGain, accompGain: 1, compression: 0 }, 0, 0);
  // 混响激活时先落一份 IR（和生产链路同一个入口），再当第三个输入喂给 ffmpeg
  let reverbIrPath: string | undefined;
  if (reverbActive(reverbSpace, reverbWet)) {
    reverbIrPath = path.join(workDir, `ir-${outputName}.wav`);
    await writeReverbIr(reverbSpace, reverbIrPath);
  }
  await runFfmpeg({
    args: buildMixArgs({
      ...filterInput({ offsetMs, levels, reverbSpace, reverbWet }),
      vocalPath: vocal,
      accompanimentPath: accompaniment,
      outputPath: output,
      title: '测试作品',
      ...(reverbIrPath ? { reverbIrPath } : {}),
    }),
    timeoutMs: 120_000,
    label: '测试混音',
  });
  return output;
}

describe('混音纯逻辑', () => {
  it('对齐偏移 = 用户微调 − 自动间隔，夹在 ±30s（负偏移是正常用法）', () => {
    // 旧公式是 auto + user 且钳到 [0, 30s]：负修正永远无效，拖拍修不好
    assert.equal(effectiveOffsetMs(300, 0), -300, '自动间隔要从人声头部扣掉');
    assert.equal(effectiveOffsetMs(300, -500), -800, '负偏移叠加，不再钳到 0');
    assert.equal(effectiveOffsetMs(0, 250), 250);
    assert.equal(effectiveOffsetMs(0, 60_000), 30_000, '上限夹到 30s');
    assert.equal(effectiveOffsetMs(29_900, -500), -30_000, '下限夹到 -30s');
    assert.equal(effectiveOffsetMs(500, -60_000), -30_000, '下限钳制');
    assert.equal(effectiveOffsetMs(Number.NaN, 100), 100, 'NaN 当成 0 处理');
    assert.equal(effectiveOffsetMs(300, Number.NaN), -300, 'user NaN 也当成 0');
  });

  it('人工微调范围是 ±1000ms', () => {
    assert.equal(MIX_LIMITS.userOffsetMs.min, -1000);
    assert.equal(MIX_LIMITS.userOffsetMs.max, 1000);
    assert.equal(effectiveOffsetMs(0, 1000), 1000, '+1000ms 微调要生效');
    assert.equal(effectiveOffsetMs(1000, 1000), 0, '自动值 − 人工微调');
    assert.equal(effectiveOffsetMs(0, -1000), -1000, '负偏移不再被钳掉');
  });

  it('mixTimeline：正偏移延后人声，负偏移延后伴奏（ffmpeg 没有负 adelay）', () => {
    assert.deepEqual(mixTimeline(0), { vocalDelayMs: 0, accompDelayMs: 0 });
    assert.deepEqual(mixTimeline(500), { vocalDelayMs: 500, accompDelayMs: 0 });
    assert.deepEqual(mixTimeline(-500), { vocalDelayMs: 0, accompDelayMs: 500 });
    assert.deepEqual(mixTimeline(Number.NaN), { vocalDelayMs: 0, accompDelayMs: 0 });
  });

  it('用户音量滑块乘在归一化增益之上', () => {
    // +6dB ≈ ×2
    const levels = computeLevels({ vocalGain: 0.5, accompGain: 2, compression: 0 }, 6.0206, -6.0206);
    assert.ok(Math.abs(levels.vocalLinear - 1) < 0.001, `实际 ${levels.vocalLinear}`);
    assert.ok(Math.abs(levels.accompLinear - 1) < 0.001, `实际 ${levels.accompLinear}`);
  });

  it('音量被夹在 0–4 之间，不会因为脏参数炸掉', () => {
    assert.equal(computeLevels({ vocalGain: 100, accompGain: 100, compression: 0 }, 30, 30).vocalLinear, 4);
    assert.equal(computeLevels({ vocalGain: -5, accompGain: -5, compression: 0 }, 0, 0).vocalLinear, 0);
    assert.equal(
      computeLevels({ vocalGain: Number.NaN, accompGain: 1, compression: 0 }, 0, 0).vocalLinear,
      1,
    );
  });

  it('正偏移：adelay 挂人声分支（挂错地方等于没对齐）', () => {
    const filter = buildMixFilter(filterInput({ offsetMs: 500 }));
    const [vocalBranch, accompBranch] = filter.split(';');

    assert.match(vocalBranch!, /^\[0:a\]/);
    assert.match(vocalBranch!, /adelay=delays=500:all=1/);
    assert.doesNotMatch(accompBranch!, /adelay/, '伴奏分支不该被延迟');
    assert.match(filter, /amix=inputs=2:duration=first:normalize=0/);
    assert.match(filter, /alimiter=limit=0\.95/);
  });

  it('负偏移：adelay 挂伴奏分支（延后伴奏 ≡ 把人声提前）', () => {
    const filter = buildMixFilter(filterInput({ offsetMs: -350 }));
    const [vocalBranch, accompBranch] = filter.split(';');

    assert.doesNotMatch(vocalBranch!, /adelay/, '人声分支不该被延迟');
    assert.match(accompBranch!, /^\[1:a\]/);
    assert.match(accompBranch!, /adelay=delays=350:all=1/);
    // 人声仍是 amix 第一路：duration=first 的长度口径不变
    assert.match(filter, /\[v\]\[a\]amix=inputs=2:duration=first/);
  });

  it('偏移为 0 时不加 adelay；空间 0 / 湿度 0 都不挂混响', () => {
    const dry = buildMixFilter(filterInput());
    assert.doesNotMatch(dry, /adelay/);
    assert.doesNotMatch(dry, /afir/);
    assert.doesNotMatch(dry, /asplit/);

    // 湿度 0 也是干声（旁通），和空间 0 同路
    const muted = buildMixFilter(filterInput({ reverbSpace: anchorSpace('hall'), reverbWet: 0 }));
    assert.doesNotMatch(muted, /afir/);
    assert.doesNotMatch(muted, /asplit/);

    const hall = buildMixFilter(filterInput({ reverbSpace: anchorSpace('hall') }));
    assert.match(hall, /afir=/);
  });

  it('混响激活 = 干湿分离 + afir 卷积（IR 走第三个输入 [2:a]）', () => {
    const space = 0.58;
    const wet = 0.9;
    const dsp = reverbDsp(space, wet);
    const filter = buildMixFilter(filterInput({ reverbSpace: space, reverbWet: wet }));

    // 人声链末尾 asplit 成干/湿两支
    assert.match(filter, /,asplit=2\[vdry\]\[vwet\]/);
    // 湿支：afir 吃 IR 输入 [2:a]；irnorm=-1 必须显式（默认 1 会把 IR 归到无声）
    assert.match(filter, /\[vwet\]\[2:a\]afir=dry=1:wet=0\.4977:irnorm=-1\[vw\]/);
    // 干支：共享公式 1 − wet/2（与试听 dryGain 同一个数）
    assert.match(filter, /\[vdry\]volume=0\.7511\[vd\]/);
    // 干湿先合一次，再进和伴奏的 amix；人声仍是第一路（duration=first）
    assert.match(
      filter,
      /\[vd\]\[vw\]amix=inputs=2:duration=first:normalize=0:dropout_transition=0\[v\]/,
    );
    assert.match(filter, /\[v\]\[a\]amix=inputs=2:duration=first:normalize=0/);
    assert.match(filter, /alimiter=limit=0\.95/);
    assert.equal(dsp.bypass, false);

    // 旁通时滤镜串里不该出现第三个输入的踪迹（输入列表也不加，见 buildMixArgs）
    const dryFilter = buildMixFilter(filterInput());
    assert.doesNotMatch(dryFilter, /\[2:a\]/);
  });

  it('buildMixArgs：混响激活时才追加 IR 输入；旁通时与旧版一致', () => {
    const base = {
      ...filterInput({ reverbSpace: anchorSpace('hall') }),
      vocalPath: 'v.wav',
      accompanimentPath: 'a.mp3',
      outputPath: 'o.mp3',
      title: 't',
    };

    const withReverb = buildMixArgs({ ...base, reverbIrPath: 'ir.wav' });
    // 输入顺序：干声 [0]、伴奏 [1]、IR [2]
    const irIndex = withReverb.lastIndexOf('ir.wav');
    assert.ok(irIndex > withReverb.lastIndexOf('a.mp3'), 'IR 必须是第三个输入');
    assert.equal(withReverb[withReverb.indexOf('-i', irIndex - 1) + 1], 'ir.wav');

    const dry = buildMixArgs({ ...base, reverbSpace: 0 });
    assert.equal(dry.includes('-i'), true);
    assert.ok(!dry.includes('ir.wav'), '干声不该追加 IR 输入');
    assert.equal(dry.filter((arg) => arg === '-i').length, 2, '只有干声和伴奏两个输入');

    // 激活却没给 IR 路径：直接报清楚的错，别让 ffmpeg 抛「Invalid file index」
    assert.throws(() => buildMixArgs(base), /reverbIrPath/);
  });

  it('正偏移 + 混响：adelay 挂在干湿合流之后（对齐语义不变）', () => {
    const filter = buildMixFilter(filterInput({ offsetMs: 500, reverbSpace: anchorSpace('stage') }));
    const statements = filter.split(';');
    // adelay 必须在 [vd][vw]amix 之后，挂在人声分支上
    const amixIndex = statements.findIndex((line) => line.startsWith('[vd][vw]amix'));
    assert.ok(amixIndex >= 0, `应有干湿合流语句，实际 ${filter}`);
    assert.match(statements[amixIndex]!, /,adelay=delays=500:all=1\[v\]$/);
    // 伴奏分支（[1:a] 开头那句）不该被延迟
    const accomp = statements.find((line) => line.startsWith('[1:a]'));
    assert.ok(accomp && !/adelay/.test(accomp), '正偏移时伴奏不该被延迟');
    // 人声仍是 amix 第一路：duration=first 的长度口径不变
    assert.match(filter, /\[v\]\[a\]amix=inputs=2:duration=first/);
  });

  /**
   * 混响档位的守卫：8 个锚点的 IR 规格（尾巴/前延迟/衰减）与试听
   * （reverbIrSpec → generateReverbIr）用的是同一张表，成品与试听同源。
   */
  it('8 个锚点的 IR 规格与档位表一一对应（成品与试听同源的数值基础）', () => {
    assert.equal(REVERB_ANCHORS.length, 8, '混响档位数应为 8');
    for (const anchor of REVERB_ANCHORS) {
      const ir = reverbIrSpec(anchorSpace(anchor.kind));
      assert.equal(ir.seconds, anchor.tailSec, `${anchor.kind} 尾巴`);
      assert.equal(ir.preDelayMs, anchor.preDelayMs, `${anchor.kind} 前延迟`);
      assert.equal(ir.decay, anchor.irDecay, `${anchor.kind} IR 衰减`);
      assert.equal(ir.wet, anchor.wet, `${anchor.kind} 满湿度`);
    }
  });

  it('空间连续可调：尾巴随空间单调不减，湿度只改干湿增益不动形状', () => {
    const specOf = (space: number) => reverbIrSpec(reverbIrKey(space));
    let previous = specOf(0.01);
    for (const space of [0.2, 0.35, 0.5, 0.65, 0.8, 0.99]) {
      const current = specOf(space);
      assert.ok(current.seconds >= previous.seconds, `尾巴应随空间不减：${space}`);
      previous = current;
    }
    // 湿度减半：发送量减半、干声回升，空间形状（IR 规格）不动
    const full = reverbDsp(0.5, 1);
    const half = reverbDsp(0.5, 0.5);
    assert.ok(Math.abs(half.wet - full.wet * 0.5) < 1e-9, '湿度减半 = 发送量减半');
    assert.equal(half.tailSec, full.tailSec, '尾巴不该随湿度变');
    assert.equal(half.preDelayMs, full.preDelayMs, '前延迟不该随湿度变');
    assert.equal(half.irDecay, full.irDecay, 'IR 衰减不该随湿度变');
    assert.ok(half.dry > full.dry, '湿度越低干声越接近满电平');
  });

  it('均衡三段只在非中性时挂上，且频率与前端 BiquadFilterNode 一致', () => {
    const neutral = buildMixFilter(filterInput());
    assert.doesNotMatch(neutral, /equalizer=/, '全 0 不该挂均衡滤镜');

    const shaped = buildMixFilter(filterInput({ eqLowDb: 3, eqMidDb: -2, eqHighDb: 2.5 }));
    const vocalBranch = shaped.split(';')[0]!;
    // 三段频率必须来自共享的 EQ_BANDS（前端高/中/低架用的是同一组数值）
    assert.match(vocalBranch, new RegExp(`equalizer=f=${EQ_BANDS.low.frequency}:`));
    assert.match(vocalBranch, new RegExp(`equalizer=f=${EQ_BANDS.mid.frequency}:`));
    assert.match(vocalBranch, new RegExp(`equalizer=f=${EQ_BANDS.high.frequency}:`));
    assert.match(vocalBranch, /g=3\.00/);
    assert.match(vocalBranch, /g=-2\.00/);
    assert.match(vocalBranch, /g=2\.50/);
    // 均衡是零延迟的 biquad，必须留在混音图内（带延迟的处理才去预处理 pass）
    assert.doesNotMatch(shaped.split(';')[1]!, /equalizer=/, '伴奏不该被均衡');
  });
});

describe('混音端到端（真实 ffmpeg）', () => {
  it('输出 192kbps 立体声 MP3', async () => {
    const output = await mixTo('out-basic.mp3', 0, 1, 0);
    const summary = await summarize(output);

    assert.equal(summary.audioCodec, 'mp3');
    assert.equal(summary.sampleRate, 48_000);
    assert.equal(summary.channels, 2);
    assert.equal(summary.hasVideo, false);
  });

  it('duration=first：成品长度跟人声走，不会拖出纯伴奏尾巴', async () => {
    // 伴奏 3s，人声 2s，偏移 0 → 成品约 2s
    const output = await mixTo('out-short.mp3', 0, 1, 0);
    const { durationSec } = await summarize(output);

    assert.ok(durationSec! > 1.7 && durationSec! < 2.4, `成品应约为 2s，实际 ${durationSec}s`);
  });

  it('对齐偏移会把成品整体拉长（人声被推后）', async () => {
    const output = await mixTo('out-offset.mp3', 500, 1, 0);
    const { durationSec } = await summarize(output);

    assert.ok(
      durationSec! > 2.2 && durationSec! < 2.9,
      `人声 2s + 偏移 0.5s 应约为 2.5s，实际 ${durationSec}s`,
    );
  });

  it('负偏移：延后伴奏，成品长度仍跟人声走（duration=first）', async () => {
    // 伴奏 3s、人声 2s、偏移 -0.5s → 伴奏晚 0.5s 进场，成品仍约 2s
    const output = await mixTo('out-neg-offset.mp3', -500, 1, 0);
    const { durationSec } = await summarize(output);

    assert.ok(
      durationSec! > 1.7 && durationSec! < 2.4,
      `负偏移不该拉长成品，应约为 2s，实际 ${durationSec}s`,
    );
  });

  it('八档混响都能成功出片（空间 0 旁通，其余挂 afir 卷积）', async () => {
    for (const kind of REVERB_KINDS) {
      const output = await mixTo(
        `out-reverb-${kind}.mp3`,
        150,
        1,
        anchorSpace(kind),
        1,
      );
      const summary = await summarize(output);
      assert.equal(summary.audioCodec, 'mp3', `混响 ${kind} 出片失败`);
      assert.ok(summary.durationSec! > 1.7, `混响 ${kind} 时长异常：${summary.durationSec}`);
    }
  });

  it('连续空间 / 半湿度也能出片（插值参数不是纸上谈兵）', async () => {
    const output = await mixTo('out-reverb-interp.mp3', 150, 1, 0.5, 0.5);
    const summary = await summarize(output);
    assert.equal(summary.audioCodec, 'mp3');
    assert.ok(summary.durationSec! > 1.7, `时长异常：${summary.durationSec}`);
  });

  /**
   * 本 bug 的守门测试：成品 MP3 必须真的带有衰减混响尾。
   *
   * 曾经的故障形态是服务端用 aecho 拼「单次 slap 回声」—— 干声一停声音就没了，
   * 湿度还控制不了它；而试听是长长的指数衰减尾，用户听成「成品多一层混响」。
   * 这里用「骤停干声 + 静音伴奏」把内容隔离成 人声+尾，直接量尾音能量：
   *  - 尾音窗口必须显著有能量（不能是个 slap 就没了）；
   *  - 必须随时间衰减（hall 1.3s 尾：前段比后段响）；
   *  - 干声渲染的同一窗口必须基本安静（尾确实是混响加上去的）。
   */
  it('混响尾音回归：骤停干声之后仍有能量且随时间衰减（不再是无尾 slap）', async () => {
    const accomp = path.join(workDir, 'silence-accomp.wav');
    const burst = path.join(workDir, 'burst-vocal.wav');
    await ffmpegOk(silenceArgs(accomp, 2.5));
    await ffmpegOk(burstVocalArgs(burst, 0.3, 2.5));

    const levels = computeLevels({ vocalGain: 1, accompGain: 1, compression: 0 }, 0, 0);
    const render = async (name: string, reverbSpace: number, reverbWet: number) => {
      const output = path.join(workDir, name);
      const irPath = path.join(workDir, `ir-${name}.wav`);
      await writeReverbIr(reverbSpace, irPath);
      await runFfmpeg({
        args: buildMixArgs({
          offsetMs: 0,
          levels,
          reverbSpace,
          reverbWet,
          eqLowDb: 0,
          eqMidDb: 0,
          eqHighDb: 0,
          vocalPath: burst,
          accompanimentPath: accomp,
          outputPath: output,
          title: '尾音测试',
          reverbIrPath: irPath,
        }),
        timeoutMs: 120_000,
        label: '尾音测试混音',
      });
      return output;
    };

    const wet = await decodeToFloat32(await render('out-tail-wet.mp3', anchorSpace('hall'), 1));
    const dry = await decodeToFloat32(await render('out-tail-dry.mp3', 0, 1));

    const voiceWet = rmsOfWindow(wet.samples, wet.sampleRate, 0.05, 0.28);
    const tailNear = rmsOfWindow(wet.samples, wet.sampleRate, 0.4, 0.7);
    const tailFar = rmsOfWindow(wet.samples, wet.sampleRate, 1.0, 1.3);
    const tailDryNear = rmsOfWindow(dry.samples, dry.sampleRate, 0.4, 0.7);
    const tailDryFar = rmsOfWindow(dry.samples, dry.sampleRate, 1.0, 1.3);

    assert.ok(voiceWet > 0.01, `人声窗口应有能量，实际 ${voiceWet}`);
    // 尾音必须真的存在：干声渲染的同一窗口基本是 MP3 噪声底
    assert.ok(
      tailNear > tailDryNear * 10 && tailNear > 1e-4,
      `0.4–0.7s 应有明显混响尾：湿 ${tailNear} vs 干 ${tailDryNear}`,
    );
    // 且不能只是个 slap：hall 的 1.3s 尾在 1.0–1.3s 仍该有可测能量
    assert.ok(
      tailFar > tailDryFar * 10 && tailFar > 1e-4,
      `1.0–1.3s 仍应有尾音，实际 ${tailFar}`,
    );
    // 衰减：近段比远段响（指数衰减尾，不是恒定噪声）
    assert.ok(tailNear > tailFar * 1.5, `尾音应衰减：近 ${tailNear} vs 远 ${tailFar}`);
  });

  it('人声音量拉到 0 时不出错（等于只要伴奏）', async () => {
    const output = await mixTo('out-muted-vocal.mp3', 0, 0, 0);
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
