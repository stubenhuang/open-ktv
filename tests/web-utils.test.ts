import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatBytes, formatDateTime, formatDuration, formatTimer } from '../web/src/utils.ts';

describe('formatDuration（秒 → mm:ss）', () => {
  it('正常时长', () => {
    assert.equal(formatDuration(9), '00:09');
    assert.equal(formatDuration(65), '01:05');
    assert.equal(formatDuration(599), '09:59');
    assert.equal(formatDuration(215.4), '03:35', '四舍五入到秒');
  });

  it('0 秒按「没有时长」处理', () => {
    // 实现里 0 是 falsy，和 null 一样给占位符
    assert.equal(formatDuration(0), '--:--');
  });

  it('超过一小时给 h:mm:ss', () => {
    assert.equal(formatDuration(3600), '1:00:00');
    assert.equal(formatDuration(3725), '1:02:05');
  });

  it('脏数据给占位符', () => {
    assert.equal(formatDuration(null), '--:--');
    assert.equal(formatDuration(undefined), '--:--');
    assert.equal(formatDuration(Number.NaN), '--:--');
    assert.equal(formatDuration(-5), '--:--');
  });
});

describe('formatTimer（毫秒 → mm:ss.mmm）', () => {
  it('毫秒精度', () => {
    assert.equal(formatTimer(0), '00:00.000');
    assert.equal(formatTimer(1), '00:00.001');
    assert.equal(formatTimer(999), '00:00.999');
    assert.equal(formatTimer(1000), '00:01.000');
    assert.equal(formatTimer(65_000), '01:05.000');
    assert.equal(formatTimer(3_600_000), '60:00.000', '计时器不显示小时，只累加分钟');
  });

  it('负数按 0 算', () => {
    assert.equal(formatTimer(-100), '00:00.000');
  });
});

describe('formatBytes', () => {
  it('各单位', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
    assert.equal(formatBytes(2.5 * 1024 ** 3), '2.5 GB');
  });

  it('脏数据', () => {
    assert.equal(formatBytes(Number.NaN), '0 B');
    assert.equal(formatBytes(-1), '0 B');
  });

  it('超过 GB 不再放大单位', () => {
    assert.equal(formatBytes(1024 ** 4), '1024.0 GB');
  });
});

describe('formatDateTime', () => {
  it('按本地时区格式化并补零', () => {
    const timestamp = new Date(2025, 0, 2, 3, 4, 5).getTime();
    const date = new Date(timestamp);
    const pad = (value: number) => String(value).padStart(2, '0');
    const want = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    assert.equal(formatDateTime(timestamp), want);
  });

  it('月份/日期/小时/分钟都补零', () => {
    const text = formatDateTime(new Date(2025, 8, 9, 7, 5).getTime());
    assert.match(text, /^2025-09-09 07:05$/);
  });
});
