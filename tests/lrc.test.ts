import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EMPTY_LRC,
  LAST_LINE_FALLBACK_MS,
  findActiveLineIndex,
  formatLrcTimestamp,
  hasLrcTimeline,
  lrcDisplayTimeMs,
  lyricCharLitCount,
  lyricClockMs,
  lyricLineProgress,
  lyricLineWindowMs,
  normalizeLrc,
  parseLrc,
} from '../shared/lrc.ts';

describe('parseLrc 时间戳', () => {
  it('识别 [mm:ss] / [mm:ss.xx] / [mm:ss.xxx]', () => {
    const doc = parseLrc(['[00:12]甲', '[00:15.30]乙', '[00:18.345]丙'].join('\n'));
    assert.deepEqual(
      doc.lines.map((line) => line.timeMs),
      [12_000, 15_300, 18_345],
    );
    assert.deepEqual(
      doc.lines.map((line) => line.text),
      ['甲', '乙', '丙'],
    );
  });

  it('1 位小数按 100ms、2 位按 10ms、3 位按 1ms', () => {
    const doc = parseLrc(['[00:01.5]一', '[00:02.50]二', '[00:03.500]三'].join('\n'));
    assert.deepEqual(
      doc.lines.map((line) => line.timeMs),
      [1_500, 2_500, 3_500],
    );
  });

  it('支持用冒号当小数分隔符（老工具输出）', () => {
    assert.equal(parseLrc('[00:12:34]甲').lines[0]!.timeMs, 12_340);
  });

  it('分钟数不补零也能认', () => {
    assert.equal(parseLrc('[0:12.00]甲').lines[0]!.timeMs, 12_000);
    assert.equal(parseLrc('[123:05.00]甲').lines[0]!.timeMs, 7_385_000);
  });

  it('一行挂多个时间戳会展开成多行（副歌复用）', () => {
    const doc = parseLrc('[00:12.00][01:20.00]同一句');
    assert.deepEqual(
      doc.lines.map((line) => ({ timeMs: line.timeMs, text: line.text })),
      [
        { timeMs: 12_000, text: '同一句' },
        { timeMs: 80_000, text: '同一句' },
      ],
    );
  });

  it('秒数 ≥ 60 的伪时间戳不当时间戳', () => {
    const doc = parseLrc('[00:99.00]这不是一行歌词');
    assert.deepEqual(doc.lines, []);
  });
});

describe('parseLrc 元数据与容忍度', () => {
  it('提取 ti / ar / al / offset', () => {
    const doc = parseLrc(
      ['[ti:晴天]', '[ar:周杰伦]', '[al:叶惠美]', '[by:某人]', '[offset:+500]', '[00:01.00]甲'].join('\n'),
    );
    assert.equal(doc.title, '晴天');
    assert.equal(doc.artist, '周杰伦');
    assert.equal(doc.album, '叶惠美');
    assert.equal(doc.offsetMs, 500);
    assert.equal(doc.lines.length, 1);
  });

  it('负数 offset 也能解析', () => {
    assert.equal(parseLrc('[offset:-750]').offsetMs, -750);
  });

  it('没有时间戳的纯文本行被跳过，不计入 lines', () => {
    const doc = parseLrc(['这是纯文本歌词', '没有任何时间戳'].join('\n'));
    assert.deepEqual(doc.lines, []);
  });

  it('空行、乱码标签、CRLF、BOM 都不炸', () => {
    const doc = parseLrc('\uFEFF[00:01.00]甲\r\n\r\n[乱码]\r\n[00:02.00]乙');
    assert.deepEqual(
      doc.lines.map((line) => line.text),
      ['甲', '乙'],
    );
  });

  it('空串 / null-ish 输入返回空文档', () => {
    assert.deepEqual(parseLrc(''), EMPTY_LRC);
    assert.deepEqual(parseLrc(''), { ...EMPTY_LRC, lines: [] });
  });

  it('带时间戳的空行被保留（间奏清屏标记）', () => {
    const doc = parseLrc('[00:01.00]甲\n[00:05.00]\n[00:09.00]乙');
    assert.deepEqual(
      doc.lines.map((line) => [line.timeMs, line.text]),
      [
        [1_000, '甲'],
        [5_000, ''],
        [9_000, '乙'],
      ],
    );
  });
});

describe('parseLrc 排序与去重', () => {
  it('乱序输入会被排成时间升序', () => {
    const doc = parseLrc(['[00:30.00]丙', '[00:10.00]甲', '[00:20.00]乙'].join('\n'));
    assert.deepEqual(
      doc.lines.map((line) => line.text),
      ['甲', '乙', '丙'],
    );
  });

  it('同一时刻保留后出现的那条', () => {
    const doc = parseLrc(['[00:10.00]旧的', '[00:10.00]新的'].join('\n'));
    assert.equal(doc.lines.length, 1);
    assert.equal(doc.lines[0]!.text, '新的');
  });
});

describe('normalizeLrc', () => {
  it('时间戳统一成 [mm:ss.xx]，顺序稳定', () => {
    const output = normalizeLrc(['[00:30]丙', '[00:10.5]甲'].join('\n'));
    assert.equal(output, ['[00:10.50]甲', '[00:30.00]丙'].join('\n'));
  });

  it('保留元数据，丢掉无关标签', () => {
    const output = normalizeLrc(['[ti:晴天]', '[by:某人]', '[00:01.00]甲'].join('\n'));
    assert.equal(output, ['[ti:晴天]', '[00:01.00]甲'].join('\n'));
  });

  it('offset 为 0 时不输出该标签', () => {
    assert.equal(normalizeLrc('[offset:0]\n[00:01.00]甲'), '[00:01.00]甲');
  });

  it('幂等：规范化两次结果相同（“同一份歌词贴两次”得到同一串）', () => {
    const messy = ['[00:30]丙', '[by:x]', '', '[00:10.000]甲', '[00:10.00]甲'].join('\n');
    const once = normalizeLrc(messy);
    assert.equal(normalizeLrc(once), once);
    assert.equal(once, ['[00:10.00]甲', '[00:30.00]丙'].join('\n'));
  });

  it('纯文本歌词规范化后为空串（服务端据此拒绝入库）', () => {
    assert.equal(normalizeLrc('没有时间戳的歌词'), '');
  });
});

describe('hasLrcTimeline', () => {
  it('有带时间戳的行才算 true', () => {
    assert.equal(hasLrcTimeline('[00:01.00]甲'), true);
    assert.equal(hasLrcTimeline('纯文本'), false);
    assert.equal(hasLrcTimeline(''), false);
    assert.equal(hasLrcTimeline(null), false);
    assert.equal(hasLrcTimeline(undefined), false);
  });
});

describe('findActiveLineIndex', () => {
  const lines = parseLrc(['[00:10.00]甲', '[00:20.00]乙', '[00:30.00]丙'].join('\n')).lines;

  it('第一行之前返回 -1（不该有高亮）', () => {
    assert.equal(findActiveLineIndex(lines, 0), -1);
    assert.equal(findActiveLineIndex(lines, 9_999), -1);
  });

  it('恰好等于某行时间时命中该行', () => {
    assert.equal(findActiveLineIndex(lines, 10_000), 0);
    assert.equal(findActiveLineIndex(lines, 20_000), 1);
  });

  it('落在区间内命中前一行', () => {
    assert.equal(findActiveLineIndex(lines, 19_999), 0);
  });

  it('超过最后一行后一直停在最后一行', () => {
    assert.equal(findActiveLineIndex(lines, 30_000), 2);
    assert.equal(findActiveLineIndex(lines, 9_999_999), 2);
  });

  it('空数组返回 -1，脏时间当 0 处理', () => {
    assert.equal(findActiveLineIndex([], 1_000), -1);
    assert.equal(findActiveLineIndex(lines, Number.NaN), -1);
  });
});

describe('歌词时间轴换算（offset 标签与用户微调）', () => {
  it('[offset:] 正值 = 歌词更早显示', () => {
    // 第 10 秒的歌词，标签 +500 → 第 9.5 秒就该亮
    assert.equal(lrcDisplayTimeMs(10_000, 500, 0), 9_500);
  });

  it('userOffsetMs 正值 = 歌词更晚显示', () => {
    assert.equal(lrcDisplayTimeMs(10_000, 0, 500), 10_500);
  });

  it('两者方向相反，可互相抵消', () => {
    assert.equal(lrcDisplayTimeMs(10_000, 500, 500), 10_000);
  });

  it('lyricClockMs 是 lrcDisplayTimeMs 的逆运算', () => {
    const lines = parseLrc('[00:10.00]甲').lines;
    const tag = 500;
    const user = 300;
    const displayAt = lrcDisplayTimeMs(10_000, tag, user);

    // 恰好到达显示时刻 → 该行亮
    assert.equal(findActiveLineIndex(lines, lyricClockMs(displayAt, tag, user)), 0);
    // 差 1ms 还没到 → 不亮
    assert.equal(findActiveLineIndex(lines, lyricClockMs(displayAt - 1, tag, user)), -1);
  });

  it('脏输入一律当 0，不产生 NaN', () => {
    assert.equal(lrcDisplayTimeMs(Number.NaN, Number.NaN, Number.NaN), 0);
    assert.equal(lyricClockMs(Number.NaN, Number.NaN, Number.NaN), 0);
  });
});

describe('formatLrcTimestamp', () => {
  it('毫秒 → mm:ss.xx，负数与小数按四舍五入收敛', () => {
    assert.equal(formatLrcTimestamp(0), '00:00.00');
    assert.equal(formatLrcTimestamp(12_345), '00:12.34');
    assert.equal(formatLrcTimestamp(80_000), '01:20.00');
    assert.equal(formatLrcTimestamp(-5), '00:00.00');
    assert.equal(formatLrcTimestamp(Number.NaN), '00:00.00');
  });
});

describe('逐字填充：lyricLineWindowMs（行内起止时刻）', () => {
  const lines = parseLrc(['[00:01.00]一', '[00:03.00]二', '[00:05.00]三'].join('\n')).lines;

  it('行窗口 = 本行到下一行的显示时刻', () => {
    assert.deepEqual(lyricLineWindowMs(lines, 0, 0, 0, 9_000), { startMs: 1_000, endMs: 3_000 });
    assert.deepEqual(lyricLineWindowMs(lines, 1, 0, 0, 9_000), { startMs: 3_000, endMs: 5_000 });
  });

  it('末行借媒体时长（fallbackEndMs）', () => {
    assert.deepEqual(lyricLineWindowMs(lines, 2, 0, 0, 9_000), { startMs: 5_000, endMs: 9_000 });
  });

  it('媒体时长拿不到（0/NaN）或比本行还早 → 按 LAST_LINE_FALLBACK_MS 兜底', () => {
    assert.deepEqual(lyricLineWindowMs(lines, 2, 0, 0, 0), { startMs: 5_000, endMs: 9_000 });
    assert.deepEqual(lyricLineWindowMs(lines, 2, 0, 0, Number.NaN), { startMs: 5_000, endMs: 9_000 });
    assert.deepEqual(lyricLineWindowMs(lines, 2, 0, 0, 2_000), { startMs: 5_000, endMs: 9_000 });
  });

  it('和 lrcDisplayTimeMs 同一套符号：offset/用户微调一起平移', () => {
    // [offset:] +500 更早、用户微调 +300 更晚 → 整段窗口一起平移 −200ms
    assert.deepEqual(lyricLineWindowMs(lines, 0, 500, 300, 0), { startMs: 800, endMs: 2_800 });
    assert.deepEqual(lyricLineWindowMs(lines, 0, -200, 0, 0), { startMs: 1_200, endMs: 3_200 });
  });

  it('越界下标不炸（渲染层兜底）', () => {
    assert.deepEqual(lyricLineWindowMs(lines, 9, 0, 0, 0), { startMs: 0, endMs: LAST_LINE_FALLBACK_MS });
    assert.deepEqual(lyricLineWindowMs([], 0, 0, 0, 0), { startMs: 0, endMs: LAST_LINE_FALLBACK_MS });
  });
});

describe('逐字填充：lyricLineProgress（行内进度）', () => {
  it('行内从 0 长到 1', () => {
    assert.equal(lyricLineProgress(1_000, 1_000, 3_000), 0);
    assert.equal(lyricLineProgress(1_500, 1_000, 3_000), 0.25);
    assert.equal(lyricLineProgress(2_999, 1_000, 3_000), 1999 / 2000);
    assert.equal(lyricLineProgress(3_000, 1_000, 3_000), 1);
  });

  it('行外钳制在 0/1', () => {
    assert.equal(lyricLineProgress(0, 1_000, 3_000), 0);
    assert.equal(lyricLineProgress(9_999, 1_000, 3_000), 1);
  });

  it('零长度窗口：行一旦开始就当唱完，不除出 Infinity/NaN', () => {
    assert.equal(lyricLineProgress(2_000, 2_000, 2_000), 1);
    assert.equal(lyricLineProgress(1_999, 2_000, 2_000), 0);
    assert.equal(lyricLineProgress(2_000, 2_000, 1_000), 1);
  });

  it('脏输入一律当 0，不产生 NaN', () => {
    assert.equal(lyricLineProgress(Number.NaN, 1_000, 2_000), 0);
    assert.equal(lyricLineProgress(1_500, Number.NaN, Number.NaN), 0);
  });

  it('窗口公式反推：progress=1 的时刻正好是下一行的起点', () => {
    // 上一行窗口 [1000,3000)，progress=1 时下一行开始 —— 两行填充无缝衔接
    assert.equal(lyricLineProgress(3_000, 1_000, 3_000), 1);
    assert.equal(lyricLineProgress(3_000, 3_000, 5_000), 0);
  });
});

describe('逐字填充：lyricCharLitCount（点亮字数）', () => {
  it('按进度向下取整逐字翻亮', () => {
    assert.equal(lyricCharLitCount(0, 5), 0);
    assert.equal(lyricCharLitCount(0.19, 5), 0);
    assert.equal(lyricCharLitCount(0.2, 5), 1);
    assert.equal(lyricCharLitCount(0.6, 5), 3);
    assert.equal(lyricCharLitCount(0.99, 5), 4);
    assert.equal(lyricCharLitCount(1, 5), 5);
  });

  it('钳制在 0–charCount', () => {
    assert.equal(lyricCharLitCount(-0.5, 5), 0);
    assert.equal(lyricCharLitCount(1.5, 5), 5);
  });

  it('间奏空行（0 字）与脏进度返回 0', () => {
    assert.equal(lyricCharLitCount(0.5, 0), 0);
    assert.equal(lyricCharLitCount(0.5, -3), 0);
    assert.equal(lyricCharLitCount(Number.NaN, 5), 0);
    assert.equal(lyricCharLitCount(Number.NaN, Number.NaN), 0);
  });

  it('整行唱完刚好点亮最后一个字（收尾不会差一字）', () => {
    const text = '海阔天空';
    const { startMs, endMs } = { startMs: 0, endMs: 4_000 };
    for (let t = startMs; t <= endMs; t += 40) {
      const lit = lyricCharLitCount(lyricLineProgress(t, startMs, endMs), [...text].length);
      assert.ok(lit >= 0 && lit <= [...text].length);
    }
    assert.equal(
      lyricCharLitCount(lyricLineProgress(endMs, startMs, endMs), [...text].length),
      [...text].length,
    );
  });
});
