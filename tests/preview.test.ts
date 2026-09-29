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
import { computeLevels } from '../server/src/mix.ts';
import type { MixParams } from '../shared/types.ts';

const baseParams: MixParams = {
  vocalGain: 1,
  accompGain: 1,
  reverb: 'room',
  userOffsetMs: 0,
};

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

  it('与服务端 computeLevels 逐项一致（公式分叉会让试听和成品对不上）', () => {
    const cases = [
      [{ vocalGain: 0.5, accompGain: 2 }, { vocalGainDb: 6.0206, accompGainDb: -6.0206 }],
      [{ vocalGain: 100, accompGain: 0 }, { vocalGainDb: 30, accompGainDb: -12 }],
      [{ vocalGain: Number.NaN, accompGain: 1 }, { vocalGainDb: Number.NaN, accompGainDb: 0 }],
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
