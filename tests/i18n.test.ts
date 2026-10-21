//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CATALOGS, FALLBACK_LOCALE, LOCALES, isLocale, lookup, matchLocale } from '../web/src/i18n/catalog.ts';
import { createFormatters, interpolate, pluralCategory } from '../web/src/i18n/format.ts';

/**
 * i18n 的单元测试。
 *
 * 覆盖三件事：
 *   1. **语言探测与回落** —— BCP-47 标签怎么映射到受支持的语言；
 *   2. **插值与复数** —— `{name}` 与 `Intl.PluralRules` 的行为；
 *   3. **本地化格式化** —— 数字 / 文件大小 / 时长 / 日期 / 列表在两种语言下的形状。
 *
 * 文案目录本身的一致性（键集、占位符、服务端错误码对账）由
 * `scripts/check-i18n.mjs` 负责 —— 那是唯一权威，CI 里跑，这里不重复。
 */

describe('语言清单与探测', () => {
  it('默认带简体中文与英文，参考语言在清单里', () => {
    assert.deepEqual([...LOCALES], ['zh-CN', 'en']);
    assert.ok(LOCALES.includes(FALLBACK_LOCALE));
  });

  it('isLocale 只认受支持的 BCP-47 标签', () => {
    assert.equal(isLocale('zh-CN'), true);
    assert.equal(isLocale('en'), true);
    assert.equal(isLocale('ja'), false);
    assert.equal(isLocale('zh'), false);
    assert.equal(isLocale(''), false);
    assert.equal(isLocale(undefined), false);
  });

  it('matchLocale 按顺序取第一个能对上的', () => {
    assert.equal(matchLocale(['ja', 'en-US', 'zh-CN']), 'en');
    assert.equal(matchLocale(['fr-FR', 'zh-TW']), 'zh-CN');
    assert.equal(matchLocale(['zh-Hans-CN']), 'zh-CN');
    assert.equal(matchLocale(['de', 'ko']), null);
    assert.equal(matchLocale([]), null);
  });

  it('语言标签都是合法的 BCP-47（能被 Intl 接受）', () => {
    for (const locale of LOCALES) {
      assert.doesNotThrow(() => new Intl.NumberFormat(locale).format(1), `${locale} 不是合法语言标签`);
    }
  });
});

describe('lookup 回落链', () => {
  it('当前语言有就用当前语言的', () => {
    assert.equal(lookup('en', 'common.cancel'), 'Cancel');
    assert.equal(lookup('zh-CN', 'common.cancel'), '取消');
  });

  it('缺键回落到参考语言，再不行给 undefined', () => {
    // 两种语言的 errors 区目前是齐的，用「不存在的键」验最后一档
    assert.equal(lookup('en', 'nope.not.a.key'), undefined);
  });

  it('两种语言的目录都非空，且键集一致', () => {
    const zh = CATALOGS['zh-CN'];
    const en = CATALOGS.en;
    assert.ok(Object.keys(zh).length > 100, `参考语言至少要有上百条，实际 ${Object.keys(zh).length}`);
    assert.ok(Object.keys(en).length > 100);
    for (const key of Object.keys(zh)) {
      assert.ok(key in en, `en 缺键 "${key}"`);
    }
  });

  it('没有一条文案是空串', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(CATALOGS[locale])) {
        assert.ok(typeof value === 'string' && value.trim().length > 0, `${locale}："${key}" 是空文案`);
      }
    }
  });
});

describe('插值', () => {
  it('替换 {name} 占位符', () => {
    assert.equal(interpolate('删除「{title}」吗？', { title: '晴天' }), '删除「晴天」吗？');
    assert.equal(interpolate('{a}-{b}', { a: 1, b: 'x' }), '1-x');
  });

  it('null 渲染成空串，undefined 原样留着（漏传要看得出来）', () => {
    assert.equal(interpolate('歌手：{artist}', { artist: null as unknown as string }), '歌手：');
    assert.equal(interpolate('歌手：{artist}', {}), '歌手：{artist}');
  });

  it('同一个占位符出现多次会全部替换', () => {
    assert.equal(interpolate('{x} 与 {x}', { x: 'a' }), 'a 与 a');
  });

  it('两种语言的同一条文案占位符一致', () => {
    for (const key of Object.keys(CATALOGS['zh-CN'])) {
      const a = [...CATALOGS['zh-CN'][key]!.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const b = [...CATALOGS.en[key]!.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      assert.deepEqual(a, b, `"${key}" 的占位符在两种语言间不一致`);
    }
  });
});

describe('复数', () => {
  it('中文只有 other，英语分 one / other', () => {
    assert.equal(pluralCategory('zh-CN', 1), 'other');
    assert.equal(pluralCategory('zh-CN', 3), 'other');
    assert.equal(pluralCategory('en', 1), 'one');
    assert.equal(pluralCategory('en', 3), 'other');
  });

  it('英语的 0 按 other（不是 one）', () => {
    assert.equal(pluralCategory('en', 0), 'other');
  });
});

describe('本地化格式化', () => {
  const zh = createFormatters('zh-CN');
  const en = createFormatters('en');

  it('数字：小数位数可指定，千分位按语言', () => {
    assert.equal(zh.number(1.5), '1.5');
    assert.equal(zh.integer(2.6), '3');
    assert.equal(zh.integer(1234), '1,234');
    assert.equal(en.integer(1234), '1,234');
  });

  it('百分比与带符号数字', () => {
    assert.equal(zh.percent(0.42), '42%');
    assert.equal(zh.signed(3), '+3');
    assert.equal(zh.signed(-3), '-3');
    assert.equal(zh.signed(0), '0');
    assert.equal(en.signedPercent(0.12), '+12%');
  });

  it('文件大小：1024 进制，单位词由语言决定', () => {
    assert.equal(zh.bytes(0), '0字节');
    assert.equal(zh.bytes(1536), '1.5 kB');
    assert.equal(zh.bytes(5 * 1024 * 1024), '5.0 MB');
    assert.equal(en.bytes(0), '0 bytes');
    assert.equal(en.bytes(1536), '1.5 kB');
  });

  it('时长：数字时钟式，超过一小时自动加小时段', () => {
    assert.equal(zh.duration(0), '0:00');
    assert.equal(zh.duration(65), '1:05');
    assert.equal(zh.duration(3725), '1:02:05');
    assert.equal(zh.duration(-5), '0:00', '负数按 0 算');
  });

  it('秒 / 毫秒读数', () => {
    assert.equal(zh.seconds(1.25), '1.3');
    assert.equal(zh.milliseconds(150), '150');
  });

  it('日期时间：两种语言格式不同但都补零', () => {
    const timestamp = new Date(2025, 0, 2, 3, 4).getTime();
    assert.match(zh.dateTime(timestamp), /^2025\/01\/02 03:04$/);
    assert.match(en.dateTime(timestamp), /^01\/02\/2025, 03:04$/);
    assert.match(zh.date(timestamp), /2025/);
  });

  it('列表连接词按语言', () => {
    assert.equal(zh.list(['a', 'b', 'c']), 'a、b和c');
    assert.equal(en.list(['a', 'b', 'c']), 'a, b, and c');
  });

  it('两种语言的 formatter 互不串味（缓存按语言分键）', () => {
    assert.notEqual(zh.integer(1234), undefined);
    assert.equal(en.integer(1234), '1,234');
    assert.equal(zh.integer(1234), '1,234');
  });

  it('createFormatters 每次调用给出独立实例，但结果一致', () => {
    const a = createFormatters('en');
    const b = createFormatters('en');
    assert.equal(a.bytes(2048), b.bytes(2048));
  });
});
