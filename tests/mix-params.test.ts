import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeMixParams } from '../server/src/routes/works.ts';
import { DEFAULT_MIX_PARAMS, MIX_LIMITS, REVERB_KINDS, VOCAL_PRESETS, type MixParams } from '../shared/types.ts';

/** 造一份完整的 MixParams：只写要测的字段，其余用默认值 */
function mixParams(overrides: Partial<MixParams> = {}): MixParams {
  return { ...DEFAULT_MIX_PARAMS, ...overrides };
}

describe('sanitizeMixParams', () => {
  it('空输入 → 沿用 base（新作品用默认参数）', () => {
    assert.deepEqual(sanitizeMixParams(undefined, DEFAULT_MIX_PARAMS), DEFAULT_MIX_PARAMS);
    assert.deepEqual(sanitizeMixParams({}, DEFAULT_MIX_PARAMS), DEFAULT_MIX_PARAMS);
    assert.deepEqual(sanitizeMixParams(null, DEFAULT_MIX_PARAMS), DEFAULT_MIX_PARAMS);
  });

  it('合法参数原样通过', () => {
    const input = mixParams({ vocalGain: 1.25, accompGain: 0.75, reverb: 'hall', userOffsetMs: -300 });
    assert.deepEqual(sanitizeMixParams(input, DEFAULT_MIX_PARAMS), input);
  });

  it('增益被夹在 [0, 2]', () => {
    const result = sanitizeMixParams({ vocalGain: 99, accompGain: -3 }, DEFAULT_MIX_PARAMS);
    assert.equal(result.vocalGain, MIX_LIMITS.gain.max);
    assert.equal(result.accompGain, MIX_LIMITS.gain.min);

    const middle = sanitizeMixParams({ vocalGain: 0.5, accompGain: 1.5 }, DEFAULT_MIX_PARAMS);
    assert.equal(middle.vocalGain, 0.5);
    assert.equal(middle.accompGain, 1.5);
  });

  it('userOffsetMs 夹在 ±1000 并取整', () => {
    assert.equal(sanitizeMixParams({ userOffsetMs: 5000 }, DEFAULT_MIX_PARAMS).userOffsetMs, 1000);
    assert.equal(sanitizeMixParams({ userOffsetMs: -5000 }, DEFAULT_MIX_PARAMS).userOffsetMs, -1000);
    assert.equal(sanitizeMixParams({ userOffsetMs: 120.7 }, DEFAULT_MIX_PARAMS).userOffsetMs, 121);
    assert.equal(sanitizeMixParams({ userOffsetMs: -120.7 }, DEFAULT_MIX_PARAMS).userOffsetMs, -121);
  });

  it('脏数字回落 base，不是 0', () => {
    const base = mixParams({ vocalGain: 1.4, accompGain: 0.6, reverb: 'stage', userOffsetMs: 200 });
    const result = sanitizeMixParams(
      { vocalGain: 'abc', accompGain: Number.NaN, userOffsetMs: undefined },
      base,
    );
    assert.equal(result.vocalGain, 1.4, '解析不出用 base 的 1.4，而不是默认 1');
    assert.equal(result.accompGain, 0.6);
    assert.equal(result.userOffsetMs, 200);
  });

  it('混响档位白名单外的值回落 base', () => {
    assert.equal(sanitizeMixParams({ reverb: '教堂' }, DEFAULT_MIX_PARAMS).reverb, DEFAULT_MIX_PARAMS.reverb);
    assert.equal(sanitizeMixParams({ reverb: 'stage' }, DEFAULT_MIX_PARAMS).reverb, 'stage');
    // 白名单就是 REVERB_KINDS 本身：档位表扩到 8 种，这里要全量覆盖
    for (const reverb of REVERB_KINDS) {
      assert.equal(sanitizeMixParams({ reverb }, DEFAULT_MIX_PARAMS).reverb, reverb);
    }
    assert.equal(REVERB_KINDS.length, 8, '混响档位数应为 8');
  });

  it('未提供的字段沿用 base，不是默认值', () => {
    const base = mixParams({ vocalGain: 1.4, accompGain: 0.6, reverb: 'hall', userOffsetMs: -300 });
    const result = sanitizeMixParams({ vocalGain: 2 }, base);
    assert.deepEqual(result, { ...base, vocalGain: 2 });
  });

  it('未知键被忽略', () => {
    const result = sanitizeMixParams({ vocalGain: 1, evil: 'x' } as Record<string, unknown>, DEFAULT_MIX_PARAMS);
    // 返回的字段集合就是 MixParams 的全集，`evil` 不该漏出来
    assert.deepEqual(Object.keys(result).sort(), Object.keys(DEFAULT_MIX_PARAMS).sort());
    assert.equal('evil' in result, false);
  });

  it('均衡三段夹在 ±12 dB', () => {
    const result = sanitizeMixParams(
      { eqLowDb: 99, eqMidDb: -99, eqHighDb: 1.25 },
      DEFAULT_MIX_PARAMS,
    );
    assert.equal(result.eqLowDb, MIX_LIMITS.eqDb.max);
    assert.equal(result.eqMidDb, MIX_LIMITS.eqDb.min);
    assert.equal(result.eqHighDb, 1.25);
  });

  it('压缩量 / 去齿音强度夹在 0–1', () => {
    const result = sanitizeMixParams({ compression: 5, deEss: -2 }, DEFAULT_MIX_PARAMS);
    assert.equal(result.compression, MIX_LIMITS.amount.max);
    assert.equal(result.deEss, MIX_LIMITS.amount.min);
  });

  it('预设白名单：不认识的值回落 base', () => {
    assert.equal(
      sanitizeMixParams({ vocalPreset: '电音' }, DEFAULT_MIX_PARAMS).vocalPreset,
      DEFAULT_MIX_PARAMS.vocalPreset,
    );
    for (const preset of VOCAL_PRESETS) {
      assert.equal(sanitizeMixParams({ vocalPreset: preset }, DEFAULT_MIX_PARAMS).vocalPreset, preset);
    }
    assert.equal(VOCAL_PRESETS.length, 10, '预设数应为 10');
  });

  it('noiseReduction 只认真正的布尔值', () => {
    assert.equal(sanitizeMixParams({ noiseReduction: true }, DEFAULT_MIX_PARAMS).noiseReduction, true);
    assert.equal(sanitizeMixParams({ noiseReduction: false }, DEFAULT_MIX_PARAMS).noiseReduction, false);
    // 字符串 'false' 是真值，绝不能当成开启
    assert.equal(
      sanitizeMixParams({ noiseReduction: 'false' }, DEFAULT_MIX_PARAMS).noiseReduction,
      false,
    );
    assert.equal(sanitizeMixParams({ noiseReduction: 1 }, DEFAULT_MIX_PARAMS).noiseReduction, false);

    const base = mixParams({ noiseReduction: true });
    assert.equal(
      sanitizeMixParams({ noiseReduction: 'yes' }, base).noiseReduction,
      true,
      '非法值沿用 base 而不是强制关掉',
    );
  });
});
