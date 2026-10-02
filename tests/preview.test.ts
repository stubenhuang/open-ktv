import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_OFFSET_MS,
  REVERB_PREVIEW,
  VOCAL_PRESET_SPECS,
  compressorParams,
  dbToLinear,
  deEssGainDb,
  deEssEnabled,
  effectiveOffsetMs,
  matchPreset,
  needsVocalPreProcess,
  previewDurationSec,
  previewLinearGains,
  toPreviewParams,
  vocalChainLinearGain,
} from '../shared/mix.ts';
import { computeLevels } from '../server/src/mix.ts';
import { DEFAULT_MIX_PARAMS, VOCAL_PRESETS, type MixParams } from '../shared/types.ts';

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
    assert.equal(preview.reverb, 'room');
    assert.deepEqual(preview.levels, levels);
  });

  it('levels 为 null 也合法（老作品）', () => {
    const preview = toPreviewParams(baseParams, 150, null);
    assert.equal(preview.offsetMs, -150);
    assert.deepEqual(preview.levels, null);
  });
});

describe('预览混响参数表', () => {
  it('四档齐全，dry 旁通', () => {
    assert.equal(REVERB_PREVIEW.dry, null);
    for (const kind of ['room', 'hall', 'stage'] as const) {
      const spec = REVERB_PREVIEW[kind];
      assert.ok(spec, `${kind} 缺少参数`);
      assert.ok(spec.seconds > 0 && spec.wet > 0 && spec.wet < 1 && spec.decay > 0);
    }
  });

  it('尾巴长度递进：room < hall < stage', () => {
    assert.ok(REVERB_PREVIEW.room!.seconds < REVERB_PREVIEW.hall!.seconds);
    assert.ok(REVERB_PREVIEW.hall!.seconds < REVERB_PREVIEW.stage!.seconds);
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
        matchPreset({ ...VOCAL_PRESET_SPECS[preset], reverb: VOCAL_PRESET_SPECS[preset].reverb }),
        preset,
        `${preset} 应该能被自己的参数包命中`,
      );
    }

    // 在某个预设上动了均衡 → 不再匹配任何预设
    const tweaked = { ...VOCAL_PRESET_SPECS.magnetic, eqMidDb: VOCAL_PRESET_SPECS.magnetic.eqMidDb + 1 };
    assert.equal(matchPreset(tweaked), null);
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
