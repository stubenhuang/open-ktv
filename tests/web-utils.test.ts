import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatTimer,
  isBuiltinMic,
  lyricTrackOffsetY,
} from '../web/src/utils.ts';

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

describe('歌词滚动布局', () => {
  it('当前行落在可视区正中间', () => {
    // 5 行可视区、行高 34：容器高 170，中线 85
    // 第 0 行：轨道上移到 68，该行中心 = 68 + 17 = 85 ✓
    assert.equal(lyricTrackOffsetY(0), 68);
    // 第 2 行：68 − 68 = 0，该行中心 = 0 + 2*34 + 17 = 85 ✓
    assert.equal(lyricTrackOffsetY(2), 0);
    assert.equal(lyricTrackOffsetY(3), -34);
  });

  it('还没进第一句（−1）按第 0 行定位，不把轨道推到屏幕外', () => {
    assert.equal(lyricTrackOffsetY(-1), lyricTrackOffsetY(0));
  });

  it('行数越多，轨道越往上移（单调递减）', () => {
    const values = [0, 1, 2, 3, 4].map((index) => lyricTrackOffsetY(index));
    for (let i = 1; i < values.length; i += 1) {
      assert.ok(values[i]! < values[i - 1]!, `第 ${i} 行应比第 ${i - 1} 行更高`);
    }
  });

  it('行高与可视行数可覆盖，脏输入回落默认', () => {
    assert.equal(lyricTrackOffsetY(0, 40, 3), 40);
    assert.equal(lyricTrackOffsetY(1, 40, 3), 0);
    assert.equal(lyricTrackOffsetY(Number.NaN), lyricTrackOffsetY(0));
    assert.equal(lyricTrackOffsetY(0, 0, 0), 0);
  });
});

describe('isBuiltinMic（演唱只用外置输入）', () => {
  it('Apple 机身内置麦克风的几种叫法都认得出来', () => {
    // 本机实测：macOS 中文系统 + Chrome 的 label 就是「系统设备名 (传输类型)」
    assert.equal(isBuiltinMic('abc123', 'MacBook Pro麦克风 (Built-in)'), true);
    assert.equal(isBuiltinMic('abc123', 'MacBook Pro Microphone (Built-in)'), true);
    assert.equal(isBuiltinMic('abc123', 'MacBook Air的麦克风（内置）'), true);
    assert.equal(isBuiltinMic('abc123', 'iMac Microphone (Built-in)'), true);
    // 老机型 / 英文系统
    assert.equal(isBuiltinMic('abc123', '内置麦克风'), true);
    assert.equal(isBuiltinMic('abc123', 'Internal Microphone (Built-in)'), true);
    assert.equal(isBuiltinMic('abc123', 'Built-in Audio Input'), true);
  });

  it('外置设备不会被误杀', () => {
    assert.equal(isBuiltinMic('usb-1', 'Blue Yeti (USB)'), false);
    assert.equal(isBuiltinMic('usb-2', 'AirPods Pro (Bluetooth)'), false);
    assert.equal(isBuiltinMic('usb-3', 'MixPre-3 II (Thunderbolt)'), false);
    assert.equal(isBuiltinMic('usb-4', 'USB Audio Device'), false);
    // 声卡上的「麦克风」二字不该触发内置判定
    assert.equal(isBuiltinMic('usb-5', 'Scarlett Solo 麦克风输入 (USB)'), false);
  });

  it('3.5mm 口的外接麦：名字写着「外置」，传输类型却是 Built-in（真实踩过的坑）', () => {
    // macOS 把这个口的 Transport 也报成 Built-in，Chrome 的 label 就成了
    // 「外置麦克风 (Built-in)」——只看 (Built-in) 后缀会把用户真正的麦克风藏掉
    assert.equal(isBuiltinMic('jack-1', '外置麦克风 (Built-in)'), false);
    assert.equal(isBuiltinMic('jack-1', '外置麦克风'), false);
    assert.equal(isBuiltinMic('jack-1', '外接麦克风 (Built-in)'), false);
    assert.equal(isBuiltinMic('jack-1', 'External Microphone (Built-in)'), false);
  });

  it('Chrome 的「系统默认设备」别名算内置', () => {
    // 它指向哪个物理设备无从判断，而默认就是内置那个
    assert.equal(isBuiltinMic('default', 'Default - 麦克风'), true);
    assert.equal(isBuiltinMic('default', '任何名字'), true);
  });

  it('label 为空（还没授权）不算内置，宁可多列也不清空列表', () => {
    assert.equal(isBuiltinMic('some-id', ''), false);
    assert.equal(isBuiltinMic('some-id', undefined as unknown as string), false);
  });
});
