import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RETAKE_LIMITS } from '../shared/types.ts';
import { spliceIntoVocal } from '../server/src/vocalSplice.ts';

/**
 * 干声拼接（纯函数部分）。
 *
 * 这条链路守护两条硬约束：
 *  1. **输出长度 = 原干声长度** —— 干声后面的对齐偏移、伴奏时间轴全建立在
 *     「vocalDuration 不变」上，拼接偷偷改变时长，整首作品都会对不上；
 *  2. **边界必须交叉淡化** —— 波形硬切在采样点留台阶，耳机里就是一声咔哒。
 */

const RATE = 48000;
const FADE = Math.round(RETAKE_LIMITS.fadeSec * RATE); // 20ms

/** 造一条「斜变」测试信号：值 = 序号/长度，任何错位都能在数值里看出来 */
function ramp(length: number, base = 0): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = base + i / length;
  return out;
}

describe('spliceIntoVocal（干声拼接）', () => {
  it('输出长度恒等于原干声长度', () => {
    const old = ramp(RATE * 10);
    const seg = ramp(RATE * 3, 0.5);
    const out = spliceIntoVocal(old, seg, RATE * 4, RATE * 3, FADE);
    assert.equal(out.length, old.length);
  });

  it('中段确实是新素材，头尾原样保留', () => {
    const old = ramp(RATE * 10);
    const seg = ramp(RATE * 3, 0.5);
    const start = RATE * 4;
    const len = RATE * 3;
    const out = spliceIntoVocal(old, seg, start, len, FADE);

    // 头部原样
    assert.equal(out[start - 1], old[start - 1]);
    // 尾部原样
    assert.equal(out[start + len], old[start + len]);
    assert.equal(out[out.length - 1], old[old.length - 1]);
    // 中段 = 新素材（斜变信号，逐点对上）
    const midStart = start + FADE + 1;
    for (let i = midStart; i < start + len - FADE - 1; i += 1) {
      assert.equal(out[i], seg[i - start]);
    }
  });

  it('两端是线性交叉淡化（旧淡出/新淡入、新淡出/旧淡入）', () => {
    const old = ramp(RATE * 10);
    const seg = ramp(RATE * 3, 0.5);
    const start = RATE * 4;
    const len = RATE * 3;
    const out = spliceIntoVocal(old, seg, start, len, FADE);

    // 头部第一个淡化样本：权重 w = 1/(fade+1)，几乎全是旧素材
    const w0 = 1 / (FADE + 1);
    assert.ok(Math.abs(out[start] - (old[start]! * (1 - w0) + seg[0]! * w0)) < 1e-6);
    // 头部最后一个淡化样本：几乎全新素材
    const wLast = FADE / (FADE + 1);
    const headLast = start + FADE - 1;
    assert.ok(
      Math.abs(out[headLast] - (old[headLast]! * (1 - wLast) + seg[FADE - 1]! * wLast)) < 1e-6,
    );
    // 尾部最后一个淡化样本：几乎全是旧素材
    const tailLast = start + len - 1;
    assert.ok(
      Math.abs(
        out[tailLast] -
          (seg[len - 1]! * (1 - wLast) + old[tailLast]! * wLast),
      ) < 1e-6,
    );
  });

  it('片段短于目标长度 → 不足部分补静音', () => {
    const old = ramp(RATE * 10);
    const seg = ramp(RATE); // 只有 1 秒
    const start = RATE * 4;
    const len = RATE * 3;
    const out = spliceIntoVocal(old, seg, start, len, FADE);
    assert.equal(out.length, old.length);
    // 1 秒之后的区间应该是静音（补零），而不是旧素材
    assert.equal(out[start + RATE + 10], 0);
  });

  it('片段长于目标长度 → 超出部分被截断', () => {
    const old = ramp(RATE * 10);
    const seg = ramp(RATE * 5, 0.5); // 5 秒，目标只要 3 秒
    const start = RATE * 4;
    const len = RATE * 3;
    const out = spliceIntoVocal(old, seg, start, len, FADE);
    // 目标区间之后恢复旧素材：第 4 秒整（目标末端）起是旧信号
    assert.equal(out[start + len], old[start + len]);
  });

  it('片段太短（len < 2×fade）→ 淡化长度钳到 len/2，不越界', () => {
    const old = ramp(RATE * 10);
    const seg = ramp(Math.round(RATE * 0.05), 0.5); // 50ms 片段
    const start = RATE * 4;
    const len = Math.round(RATE * 0.05);
    const out = spliceIntoVocal(old, seg, start, len, FADE);
    assert.equal(out.length, old.length);
    // 50ms 片段 fade 钳到 25ms：中段（如果有）必须是新素材，边界没越界
    assert.equal(out[start - 1], old[start - 1]);
    assert.equal(out[start + len], old[start + len]);
  });

  it('片段顶到干声末尾 → 不写出界、头部原样', () => {
    const old = ramp(RATE * 10);
    const seg = ramp(RATE * 2, 0.5);
    const start = RATE * 8;
    const len = RATE * 2;
    const out = spliceIntoVocal(old, seg, start, len, FADE);
    assert.equal(out.length, old.length);
    // 片段前的原样
    assert.equal(out[start - 1], old[start - 1]);
    // 片段末端就是干声末端：最后一样本落在尾部淡化区里（新旧混合），
    // 只要没写出界、没变 NaN 就行 —— 这正是「钳制」要防的事
    const last = out[out.length - 1]!;
    assert.ok(Number.isFinite(last));
    assert.ok(last > -2 && last < 2);
  });

  it('从干声开头就替换（start = 0）→ 头部淡化区照常工作', () => {
    const old = ramp(RATE * 10);
    const seg = ramp(RATE * 2, 0.5);
    const out = spliceIntoVocal(old, seg, 0, RATE * 2, FADE);
    assert.equal(out.length, old.length);
    const w0 = 1 / (FADE + 1);
    assert.ok(Math.abs(out[0] - (old[0]! * (1 - w0) + seg[0]! * w0)) < 1e-6);
    assert.equal(out[RATE * 2], old[RATE * 2]);
  });

  it('零长度片段 → 原样返回（不炸）', () => {
    const old = ramp(RATE);
    const out = spliceIntoVocal(old, new Float32Array(0), 0, 0, FADE);
    assert.equal(out.length, old.length);
    assert.equal(out[10], old[10]);
  });

  it('不修改传入的 old / seg（纯函数）', () => {
    const old = ramp(RATE * 4);
    const seg = ramp(RATE, 0.5);
    const oldCopy = old.slice();
    const segCopy = seg.slice();
    spliceIntoVocal(old, seg, RATE, RATE, FADE);
    assert.deepEqual(Array.from(old), Array.from(oldCopy));
    assert.deepEqual(Array.from(seg), Array.from(segCopy));
  });
});
