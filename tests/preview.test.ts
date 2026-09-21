import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_OFFSET_MS,
  REVERB_PREVIEW,
  dbToLinear,
  effectiveOffsetMs,
  previewDurationSec,
  previewLinearGains,
  toPreviewParams,
} from '../shared/mix.ts';
import type { MixParams } from '../shared/types.ts';

const baseParams: MixParams = {
  vocalGain: 1,
  accompGain: 1,
  reverb: 'room',
  userOffsetMs: 0,
};

describe('共享偏移合成（服务端 adelay 与前端预览共用）', () => {
  it('自动偏移 + 用户微调，夹到 [0, 30s]', () => {
    assert.equal(effectiveOffsetMs(150, 0), 150);
    assert.equal(effectiveOffsetMs(150, 1000), 1150, '支持 ±1000ms 人工微调');
    assert.equal(effectiveOffsetMs(150, -1000), 0, '负偏移夹到 0');
    assert.equal(effectiveOffsetMs(29_900, 1000), 30_000, '上限夹到 30s');
    assert.equal(effectiveOffsetMs(Number.NaN, 100), 100, 'NaN 当成 0 处理');
    assert.equal(MAX_OFFSET_MS, 30_000);
  });
});

describe('预览时长（对应服务端 duration=first）', () => {
  it('= 干声时长 + 对齐偏移', () => {
    assert.equal(previewDurationSec(180, 150), 180.15);
    assert.equal(previewDurationSec(180, 0), 180);
    assert.equal(previewDurationSec(180, -500), 180, '负偏移按 0 算');
  });

  it('脏数据不炸', () => {
    assert.equal(previewDurationSec(Number.NaN, 100), 0.1);
    assert.equal(previewDurationSec(10, Number.NaN), 10);
  });
});

describe('预览增益（与服务端 computeLevels 同公式）', () => {
  it('实测增益 × 用户滑块', () => {
    const gains = previewLinearGains(
      { vocalGain: 0.5, accompGain: 2 },
      { vocalGainDb: 6.0206, accompGainDb: -6.0206 },
    );
    // +6dB ≈ ×2，再乘 0.5 → ≈1
    assert.ok(Math.abs(gains.vocalLinear - 1) < 0.001, `实际 ${gains.vocalLinear}`);
    // -6dB ≈ ×0.5，再乘 2 → ≈1
    assert.ok(Math.abs(gains.accompLinear - 1) < 0.001, `实际 ${gains.accompLinear}`);
  });

  it('levels 为 null（老作品）时按 0dB 基准', () => {
    const gains = previewLinearGains({ vocalGain: 1, accompGain: 1 }, null);
    assert.equal(gains.vocalLinear, 1);
    assert.equal(gains.accompLinear, 1);
  });

  it('增益被夹在 0–4，脏参数不炸', () => {
    const loud = previewLinearGains({ vocalGain: 100, accompGain: 100 }, { vocalGainDb: 30, accompGainDb: 30 });
    assert.equal(loud.vocalLinear, 4);
    const nan = previewLinearGains({ vocalGain: Number.NaN, accompGain: 1 }, null);
    assert.equal(nan.vocalLinear, 1, 'NaN 增益回退 1');
  });

  it('dbToLinear 处理非有限值', () => {
    assert.equal(dbToLinear(0), 1);
    assert.equal(dbToLinear(Number.NaN), 1);
    assert.ok(Math.abs(dbToLinear(20) - 10) < 1e-9);
  });
});

describe('toPreviewParams', () => {
  it('偏移 = auto + user，并带上实测增益', () => {
    const levels = { vocalGainDb: -3, accompGainDb: 2 };
    const preview = toPreviewParams({ ...baseParams, userOffsetMs: 500 }, 150, levels);
    assert.equal(preview.offsetMs, 650);
    assert.equal(preview.reverb, 'room');
    assert.deepEqual(preview.levels, levels);
  });

  it('levels 为 null 也合法（老作品）', () => {
    const preview = toPreviewParams(baseParams, 150, null);
    assert.equal(preview.offsetMs, 150);
    assert.equal(preview.levels, null);
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
