import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_OFFSET_MS,
  VOCAL_PRESET_SPECS,
  anchorSpace,
  compressorParams,
  dbToLinear,
  deEssGainDb,
  deEssEnabled,
  describeReverb,
  effectiveOffsetMs,
  matchPreset,
  nearestReverbKind,
  needsVocalPreProcess,
  previewDurationSec,
  previewLinearGains,
  reverbDsp,
  reverbIrSpec,
  toPreviewParams,
  vocalChainLinearGain,
} from '../shared/mix.ts';
import { computeLevels } from '../server/src/mix.ts';
import {
  DEFAULT_MIX_PARAMS,
  REVERB_ANCHORS,
  REVERB_KINDS,
  VOCAL_PRESETS,
  type MixParams,
} from '../shared/types.ts';

const baseParams: MixParams = { ...DEFAULT_MIX_PARAMS };

describe('共享偏移合成（服务端 ffmpeg 与前端预览共用）', () => {
  it('用户微调 − 自动间隔，夹到 ±30s（负偏移不再被钳到 0）', () => {
    assert.equal(effectiveOffsetMs(150, 0), -150, '自动间隔从人声头部扣掉');
    assert.equal(effectiveOffsetMs(150, 1000), 850, '支持 ±1000ms 人工微调');
    assert.equal(effectiveOffsetMs(150, -1000), -1150, '负偏移叠加后仍可为负');
    assert.equal(effectiveOffsetMs(0, 1000), 1000);
    assert.equal(effectiveOffsetMs(0, -1000), -1000, '没有自动值时负微调全额生效');
    assert.equal(effectiveOffsetMs(0, 60_000), 30_000, '上限夹到 30s');
    assert.equal(effectiveOffsetMs(500, -60_000), -30_000, '下限夹到 -30s');
    assert.equal(effectiveOffsetMs(Number.NaN, 100), 100, 'NaN 当成 0 处理');
    assert.equal(MAX_OFFSET_MS, 30_000);
  });
});

describe('预览时长（对应服务端 duration=first）', () => {
  it('= 干声时长 + max(0, 对齐偏移)', () => {
    assert.equal(previewDurationSec(180, 150), 180.15);
    assert.equal(previewDurationSec(180, 0), 180);
    assert.equal(previewDurationSec(180, -500), 180, '负偏移延后的是伴奏，长度不增加');
  });

  it('脏数据不炸', () => {
    assert.equal(previewDurationSec(Number.NaN, 100), 0.1);
    assert.equal(previewDurationSec(10, Number.NaN), 10);
  });
});

describe('预览增益（与服务端 computeLevels 同公式）', () => {
  it('实测增益 × 用户滑块', () => {
    const gains = previewLinearGains(
      { vocalGain: 0.5, accompGain: 2, compression: 0 },
      { vocalGainDb: 6.0206, accompGainDb: -6.0206 },
    );
    // +6dB ≈ ×2，再乘 0.5 → ≈1
    assert.ok(Math.abs(gains.vocalLinear - 1) < 0.001, `实际 ${gains.vocalLinear}`);
    // -6dB ≈ ×0.5，再乘 2 → ≈1
    assert.ok(Math.abs(gains.accompLinear - 1) < 0.001, `实际 ${gains.accompLinear}`);
  });

  it('levels 为 null（老作品）时按 0dB 基准', () => {
    const gains = previewLinearGains({ vocalGain: 1, accompGain: 1, compression: 0 }, null);
    assert.equal(gains.vocalLinear, 1);
    assert.equal(gains.accompLinear, 1);
  });

  it('增益被夹在 0–4，脏参数不炸', () => {
    const loud = previewLinearGains({ vocalGain: 100, accompGain: 100, compression: 0 }, { vocalGainDb: 30, accompGainDb: 30 });
    assert.equal(loud.vocalLinear, 4);
    const nan = previewLinearGains({ vocalGain: Number.NaN, accompGain: 1, compression: 0 }, null);
    assert.equal(nan.vocalLinear, 1, 'NaN 增益回退 1');
  });

  it('与服务端 computeLevels 逐项一致（公式分叉会让试听和成品对不上）', () => {
    const cases = [
      [{ vocalGain: 0.5, accompGain: 2, compression: 0 }, { vocalGainDb: 6.0206, accompGainDb: -6.0206 }],
      [{ vocalGain: 100, accompGain: 0, compression: 0 }, { vocalGainDb: 30, accompGainDb: -12 }],
      [{ vocalGain: Number.NaN, accompGain: 1, compression: 0 }, { vocalGainDb: Number.NaN, accompGainDb: 0 }],
      // 开了压缩：makeup 必须两边都算进去，否则试听与成品电平分叉
      [{ vocalGain: 1, accompGain: 1, compression: 0.6 }, { vocalGainDb: -3, accompGainDb: 1 }],
      [{ vocalGain: 0.8, accompGain: 1.2, compression: 1 }, { vocalGainDb: 2, accompGainDb: -2 }],
    ] as const;
    for (const [params, levels] of cases) {
      assert.deepEqual(
        previewLinearGains(params, levels),
        computeLevels(params, levels.vocalGainDb, levels.accompGainDb),
      );
    }
  });

  it('dbToLinear 处理非有限值', () => {
    assert.equal(dbToLinear(0), 1);
    assert.equal(dbToLinear(Number.NaN), 1);
    assert.ok(Math.abs(dbToLinear(20) - 10) < 1e-9);
  });
});

describe('toPreviewParams', () => {
  it('偏移 = user − auto，并带上实测增益', () => {
    const levels = { vocalGainDb: -3, accompGainDb: 2 };
    const preview = toPreviewParams({ ...baseParams, userOffsetMs: 500 }, 150, levels);
    assert.equal(preview.offsetMs, 350);
    assert.equal(preview.reverbSpace, DEFAULT_MIX_PARAMS.reverbSpace);
    assert.equal(preview.reverbWet, 1);
    assert.deepEqual(preview.levels, levels);
  });

  it('levels 为 null 也合法（老作品）', () => {
    const preview = toPreviewParams(baseParams, 150, null);
    assert.equal(preview.offsetMs, -150);
    assert.deepEqual(preview.levels, null);
  });
});

describe('混响：空间 × 湿度（锚点表 + 插值）', () => {
  it('8 个锚点均匀分布在空间轴上，顺序 = 空间由小到大', () => {
    assert.equal(REVERB_ANCHORS.length, 8);
    REVERB_ANCHORS.forEach((anchor, index) => {
      assert.equal(anchor.kind, REVERB_KINDS[index], `第 ${index} 个锚点应与档位表同序`);
      assert.ok(Math.abs(anchor.position - index / 7) < 1e-12, '锚点应落在 i/7 上');
    });
    // 非原声档的尾巴必须递增（档位表两端同序，试听与成品才对得上）
    const tails = REVERB_ANCHORS.filter((anchor) => anchor.kind !== 'dry').map((a) => a.tailSec);
    for (let i = 1; i < tails.length; i += 1) {
      assert.ok(tails[i]! > tails[i - 1]!, `第 ${i} 档的尾巴应比上一档长`);
    }
  });

  it('锚点 + 满湿度 = 锚点原值（老作品零回归的数值基础）', () => {
    for (const anchor of REVERB_ANCHORS) {
      const dsp = reverbDsp(anchorSpace(anchor.kind), 1);
      assert.equal(dsp.inGain, anchor.inGain, `${anchor.kind} 入增益`);
      assert.equal(dsp.outGain, anchor.outGain, `${anchor.kind} 出增益`);
      assert.equal(dsp.delayMs, anchor.delayMs, `${anchor.kind} 延迟`);
      assert.equal(dsp.decay, anchor.decay, `${anchor.kind} 衰减`);
      const ir = reverbIrSpec(anchorSpace(anchor.kind));
      assert.equal(ir.seconds, anchor.tailSec, `${anchor.kind} 尾巴`);
      assert.equal(ir.preDelayMs, anchor.preDelayMs, `${anchor.kind} 前延迟`);
      assert.equal(ir.decay, anchor.irDecay, `${anchor.kind} IR 衰减`);
      assert.equal(ir.wet, anchor.wet, `${anchor.kind} 湿度`);
    }
  });

  it('旁通规则：空间 0 或湿度 0 都不出声响', () => {
    assert.equal(reverbDsp(0, 1).bypass, true, '原声档旁通');
    assert.equal(reverbDsp(anchorSpace('canyon'), 0).bypass, true, '湿度 0 也是干声');
    assert.equal(reverbDsp(anchorSpace('room'), 1).bypass, false);
    // 湿度 0 时干声侧回到满电平（out=1、发送=0）
    const muted = reverbDsp(anchorSpace('hall'), 0);
    assert.equal(muted.inGain, 0);
    assert.equal(muted.outGain, 1);
    assert.equal(muted.wet, 0);
  });

  it('插值单调：尾巴与延迟随空间连续递增', () => {
    let previous = reverbDsp(0.01, 1);
    for (const space of [0.2, 0.4, 0.6, 0.8, 0.99]) {
      const current = reverbDsp(space, 1);
      assert.ok(current.delayMs > previous.delayMs, `延迟应随空间递增：${space}`);
      assert.ok(current.tailSec >= previous.tailSec, `尾巴应随空间不减：${space}`);
      previous = current;
    }
  });

  it('湿度是发送量：只缩放回声支路，不动空间形状', () => {
    const full = reverbDsp(0.5, 1);
    const half = reverbDsp(0.5, 0.5);
    assert.ok(Math.abs(half.inGain - full.inGain * 0.5) < 1e-9, '发送量减半');
    assert.ok(Math.abs(half.wet - full.wet * 0.5) < 1e-9, '试听湿度减半');
    assert.equal(half.delayMs, full.delayMs, '延迟不该随湿度变');
    assert.ok(half.outGain > full.outGain, '湿度越低干声越接近满电平');
  });

  it('nearestReverbKind / describeReverb：读数与摘要', () => {
    assert.equal(nearestReverbKind(0), 'dry');
    assert.equal(nearestReverbKind(anchorSpace('hall')), 'hall');
    assert.equal(nearestReverbKind(0.45), 'hall', '0.45 离 hall(3/7) 最近');
    assert.equal(describeReverb(anchorSpace('hall'), 1), '大厅');
    assert.equal(describeReverb(anchorSpace('hall'), 0.65), '大厅 65%');
    assert.equal(describeReverb(anchorSpace('canyon'), 0), '原声', '湿度 0 就是干声');
    assert.equal(describeReverb(0, 1), '原声');
  });
});

describe('修音与音效链：共享公式（服务端 ffmpeg 与前端预览共用）', () => {
  it('compressorParams：0 就是关；量越大阈值越低、压缩比越高', () => {
    const off = compressorParams(0);
    assert.equal(off.enabled, false);
    assert.equal(off.makeupDb, 0);
    assert.equal(compressorParams(Number.NaN).enabled, false);

    const full = compressorParams(1);
    assert.equal(full.enabled, true);
    assert.equal(full.thresholdDb, -24);
    assert.equal(full.ratio, 6);
    assert.equal(full.makeupDb, 6);

    // 单调：量越大压得越狠（阈值更低、比值更高、补偿更多）
    let previous = compressorParams(0.01);
    for (const amount of [0.2, 0.4, 0.6, 0.8, 1]) {
      const current = compressorParams(amount);
      assert.ok(current.thresholdDb < previous.thresholdDb, `阈值应随量单调下降：${amount}`);
      assert.ok(current.ratio > previous.ratio, `压缩比应随量单调上升：${amount}`);
      assert.ok(current.makeupDb > previous.makeupDb, `补偿应随量单调上升：${amount}`);
      previous = current;
    }
  });

  it('压缩量为 0 时人声增益与不压缩完全一致（老作品零回归）', () => {
    for (const [gain, levelDb] of [
      [1, 0],
      [0.5, -6],
      [2, 3],
    ] as const) {
      assert.equal(
        vocalChainLinearGain(gain, levelDb, 0),
        dbToLinear(levelDb) * gain,
        `压缩为 0 时不该有任何额外增益（gain=${gain}, level=${levelDb}）`,
      );
    }
  });

  it('压缩的 makeup 并进人声增益，而不是让 acompressor 自己做', () => {
    // 阈值 -24 / 比值 6 / 补偿 6dB：增益里必须带上 dbToLinear(6)
    const expected = Math.min(4, dbToLinear(0) * 1 * dbToLinear(6));
    assert.ok(Math.abs(vocalChainLinearGain(1, 0, 1) - expected) < 1e-9);

    // 仍然被 0–4 夹住
    assert.equal(vocalChainLinearGain(100, 30, 1), 4);
    // 脏增益先回落到 1，再乘 makeup —— makeup 是链路合法的一部分，不该被连带丢掉
    assert.ok(
      Math.abs(vocalChainLinearGain(Number.NaN, 0, 1) - dbToLinear(6)) < 1e-9,
      `实际 ${vocalChainLinearGain(Number.NaN, 0, 1)}`,
    );
  });

  it('deEssGainDb：0 关闭，越大高频压得越多，且不超过 8dB', () => {
    assert.equal(deEssGainDb(0), 0);
    assert.equal(deEssEnabled(0), false);
    assert.equal(deEssEnabled(Number.NaN), false);

    assert.equal(deEssGainDb(1), -8);
    assert.equal(deEssEnabled(0.01), true);

    let previous = deEssGainDb(0.01);
    for (const amount of [0.25, 0.5, 0.75, 1]) {
      const current = deEssGainDb(amount);
      assert.ok(current < previous, `下压量应随强度单调增加：${amount}`);
      assert.ok(current >= -8, '再强也不该超过 8dB，否则高频会糊掉');
      previous = current;
    }
  });

  it('预设参数包齐全，natural 是全中性', () => {
    for (const preset of VOCAL_PRESETS) {
      const spec = VOCAL_PRESET_SPECS[preset];
      assert.ok(spec, `${preset} 缺少参数包`);
      assert.ok(Number.isFinite(spec.eqLowDb) && Number.isFinite(spec.eqMidDb));
      assert.ok(spec.compression >= 0 && spec.compression <= 1);
      assert.ok(spec.deEss >= 0 && spec.deEss <= 1);
    }

    const natural = VOCAL_PRESET_SPECS.natural;
    assert.equal(natural.eqLowDb, 0);
    assert.equal(natural.eqMidDb, 0);
    assert.equal(natural.eqHighDb, 0);
    assert.equal(natural.compression, 0);
    assert.equal(natural.deEss, 0);
  });

  it('matchPreset 按数值反推：手调过之后不再谎报命中', () => {
    for (const preset of VOCAL_PRESETS) {
      assert.equal(
        matchPreset(VOCAL_PRESET_SPECS[preset]),
        preset,
        `${preset} 应该能被自己的参数包命中`,
      );
    }

    // 在某个预设上动了均衡 → 不再匹配任何预设
    const tweaked = { ...VOCAL_PRESET_SPECS.magnetic, eqMidDb: VOCAL_PRESET_SPECS.magnetic.eqMidDb + 1 };
    assert.equal(matchPreset(tweaked), null);

    // 拖了一下混响空间/湿度 → 同样掉出预设（连续量容差比滑块步进还小）
    const nudgedSpace = {
      ...VOCAL_PRESET_SPECS.magnetic,
      reverbSpace: VOCAL_PRESET_SPECS.magnetic.reverbSpace + 0.01,
    };
    assert.equal(matchPreset(nudgedSpace), null, '拖一格空间就该掉出预设');
    const nudgedWet = {
      ...VOCAL_PRESET_SPECS.magnetic,
      reverbWet: VOCAL_PRESET_SPECS.magnetic.reverbWet - 0.01,
    };
    assert.equal(matchPreset(nudgedWet), null, '拖一格湿度也该掉出预设');

    // 浏览器会把 range 的 DOM 值吸附到 0.01 栅格：锚点最近的栅格点
    // （偏差 0.0014）也不该冒充预设 —— 容差必须比这个偏差还小
    const snapped = {
      ...VOCAL_PRESET_SPECS.magnetic,
      reverbSpace: Math.round(VOCAL_PRESET_SPECS.magnetic.reverbSpace * 100) / 100,
    };
    assert.equal(matchPreset(snapped), null, '吸附到栅格的值不该还命中预设');
  });

  it('10 个预设的混响起点两两不同（否则两个按钮会同时高亮）', () => {
    const points = VOCAL_PRESETS.map((preset) => {
      const spec = VOCAL_PRESET_SPECS[preset];
      return `${spec.reverbSpace}:${spec.reverbWet}`;
    });
    assert.equal(new Set(points).size, VOCAL_PRESETS.length, '混响起点必须两两不同');
    // 空间要真的铺开：至少覆盖 5 个不同的档位，不是全挤在小房间
    const spaces = new Set(VOCAL_PRESETS.map((p) => VOCAL_PRESET_SPECS[p].reverbSpace));
    assert.ok(spaces.size >= 5, `10 种预设应覆盖至少 5 个空间档，实际 ${spaces.size}`);
  });

  it('needsVocalPreProcess：全中性时不跑预处理（老作品走原路径）', () => {
    const neutral = { compression: 0, deEss: 0, noiseReduction: false };
    assert.equal(needsVocalPreProcess(neutral), false, '什么都不开就不该多跑一次 ffmpeg');

    assert.equal(needsVocalPreProcess({ ...neutral, compression: 0.05 }), true);
    assert.equal(needsVocalPreProcess({ ...neutral, deEss: 0.05 }), true);
    assert.equal(needsVocalPreProcess({ ...neutral, noiseReduction: true }), true);
  });

  it('toPreviewParams 把新参数原样带进预览（预设不参与 DSP）', () => {
    const preview = toPreviewParams(
      {
        ...DEFAULT_MIX_PARAMS,
        eqLowDb: 3,
        eqMidDb: -2,
        eqHighDb: 1.5,
        compression: 0.5,
        deEss: 0.25,
        noiseReduction: true,
      },
      0,
      null,
    );
    assert.equal(preview.eqLowDb, 3);
    assert.equal(preview.eqMidDb, -2);
    assert.equal(preview.eqHighDb, 1.5);
    assert.equal(preview.compression, 0.5);
    assert.equal(preview.deEss, 0.25);
    assert.equal(preview.noiseReduction, true);
    // 预设只是 UI 便利，不能成为 PreviewParams 的输入（少一个会分叉的来源）
    assert.equal('vocalPreset' in preview, false);
  });
});
