import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_MEASURED_GAP_MS, resolveRecordGapMs } from '../shared/mix.ts';

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
