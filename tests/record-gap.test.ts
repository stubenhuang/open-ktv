//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_MEASURED_GAP_MS,
  resolveRecordGapMs,
  segmentSpliceOffsetSec,
} from '../shared/mix.ts';

/**
 * 「起录 → 伴奏真正起播」间隔的收敛。
 *
 * 这一段是手机/桌面两端录音对齐的共同底座：干声 WAV 的 t=0 是起录时刻，
 * 服务端最终偏移 = userOffsetMs − autoOffsetMs，所以这个数测错了，
 * 整首演唱都会相对伴奏整体挪位。两端引擎量的时钟不同（渲染时钟 vs 墙钟），
 * 但「什么算异常」必须是同一个口径，所以钳制逻辑只有这一份。
 */
describe('resolveRecordGapMs（起播间隔收敛）', () => {
  const preroll = 150;

  it('正常情况：伴奏在起录 180ms 后起播 → 180', () => {
    assert.equal(
      resolveRecordGapMs({ captureStartPerf: 1000, accompStartPerf: 1180, prerollMs: preroll }),
      180,
    );
  });

  it('没测到起播信号 → 回退到预备静音常量', () => {
    assert.equal(
      resolveRecordGapMs({ captureStartPerf: 1000, accompStartPerf: null, prerollMs: preroll }),
      preroll,
    );
  });

  it('间隔为负（事件早 firing / 读到残留）→ 钳到 0，不把人声推到伴奏前面', () => {
    assert.equal(
      resolveRecordGapMs({ captureStartPerf: 1000, accompStartPerf: 900, prerollMs: preroll }),
      0,
    );
  });

  it('异常大的间隔（seek 卡住等）→ 钳到 MAX_MEASURED_GAP_MS', () => {
    assert.equal(
      resolveRecordGapMs({ captureStartPerf: 0, accompStartPerf: 60_000, prerollMs: preroll }),
      MAX_MEASURED_GAP_MS,
    );
    assert.equal(MAX_MEASURED_GAP_MS, 10_000);
  });

  it('四舍五入到毫秒（墙钟是浮点）', () => {
    assert.equal(
      resolveRecordGapMs({ captureStartPerf: 1000.4, accompStartPerf: 1234.56, prerollMs: preroll }),
      234,
    );
  });

  it('恰好等于预备静音（最理想情况：play() 毫无延迟）', () => {
    assert.equal(
      resolveRecordGapMs({ captureStartPerf: 500, accompStartPerf: 650, prerollMs: preroll }),
      150,
    );
  });
});

/**
 * 分段重录的落点偏移。
 *
 * 重录把伴奏 seek 到歌内 P 再起录，新录音 t' ↔ 干声时间 t' + spliceOffset。
 * 这个数错一整段 lead-in，用户就会听到「新录的那句整体挪位」——
 * 而它是前端上传前唯一的计算，服务端只按目标区间盲拼。
 */
describe('segmentSpliceOffsetSec（重录落点偏移）', () => {
  it('两次起播间隔相同 → 偏移就是 seek 位置', () => {
    assert.equal(segmentSpliceOffsetSec(30, 200, 200), 30);
  });

  it('重录起播更快（G_new < G）→ 偏移略大于 seek 位置', () => {
    // 30 + (200 − 150)/1000：新录音里内容要再往后放 50ms
    assert.equal(segmentSpliceOffsetSec(30, 200, 150), 30.05);
  });

  it('重录起播更慢（G_new > G）→ 偏移略小于 seek 位置', () => {
    assert.equal(segmentSpliceOffsetSec(30, 200, 260), 29.94);
  });

  it('G_new 没测到回退到预备静音 150ms → 与原 G 的差照算', () => {
    assert.equal(segmentSpliceOffsetSec(30, 200, 150), 30.05);
  });

  it('seek 被钳到 0（片段就在歌头）→ 只剩两次间隔之差', () => {
    assert.equal(segmentSpliceOffsetSec(0, 200, 180), 0.02);
  });

  it('非有限输入按 0 处理，不产出 NaN', () => {
    assert.equal(segmentSpliceOffsetSec(Number.NaN, Number.NaN, Number.NaN), 0);
  });
});
