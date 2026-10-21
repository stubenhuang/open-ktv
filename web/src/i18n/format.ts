//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Locale, MessageVars, PluralCategory } from './types.ts';

/* --------------------------------- 插值 --------------------------------- */

/**
 * 把 `{name}` 占位符替换成变量值。
 *
 * 未知占位符原样留着（而不是替换成空串）—— 少传一个变量时应该看得出是漏了，
 * 而不是 silently 产出一句缺词的话。null / undefined 走空串，让调用方可以直接传
 * `track.artist ?? null` 这类可空值。
 */
export function interpolate(message: string, vars?: MessageVars): string {
  if (!vars) return message;
  return message.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) return match;
    if (value === null) return '';
    return String(value);
  });
}

/* --------------------------------- 复数 --------------------------------- */

const pluralRulesCache = new Map<Locale, Intl.PluralRules>();

function pluralRules(locale: Locale): Intl.PluralRules {
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
  }
  return rules;
}

/** 某个数量在该语言里落在哪个复数形式（英语的 one/other，中文只有 other） */
export function pluralCategory(locale: Locale, count: number): PluralCategory {
  return pluralRules(locale).select(count) as PluralCategory;
}

/* ------------------------------- 格式化助手 ------------------------------- */

const numberFormatters = new Map<string, Intl.NumberFormat>();

function numberFormatter(locale: Locale, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}:${JSON.stringify(options)}`;
  let formatter = numberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(locale: Locale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}:${JSON.stringify(options)}`;
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    dateFormatters.set(key, formatter);
  }
  return formatter;
}

/** 列表连接词（「、」/ ", "） */
const listFormatters = new Map<Locale, Intl.ListFormat>();

function listFormatter(locale: Locale): Intl.ListFormat {
  let formatter = listFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
    listFormatters.set(locale, formatter);
  }
  return formatter;
}

/**
 * 面向界面的一切格式化助手。
 *
 * 规则：**不许在组件里手拼数字 / 单位 / 日期**。手拼出来的东西在另一种语言下
 * 几乎一定是错的（中文的「1.5 分钟」和英语的 "1.5 min" 不是一回事），所以全部走
 * `Intl`，并在这里按语言缓存 formatter 实例（构造 Intl 对象不便宜）。
 */
export interface Formatters {
  /** 普通数字（保留小数） */
  number(value: number, fractionDigits?: number): string;
  /** 整数（四舍五入） */
  integer(value: number): string;
  /** 百分比。value 传 0…1；`signed` 给「+12%」这种带符号的场合 */
  percent(value: number, fractionDigits?: number): string;
  signedPercent(value: number, fractionDigits?: number): string;
  /** 带符号的整数（升降调、对齐微调都靠它） */
  signed(value: number): string;
  /** 文件大小：1024 进制，一个单位 */
  bytes(value: number): string;
  /** 时长：`m:ss` 或 `h:mm:ss`（超过一小时自动加小时段） */
  duration(seconds: number): string;
  /** 秒数读数：固定一位小数，用于「至少 1.5 秒」这类阈值说明 */
  seconds(seconds: number): string;
  /** 毫秒读数：对齐微调用 */
  milliseconds(ms: number): string;
  /** 日期 + 时间（作品创建时间） */
  dateTime(timestamp: number): string;
  /** 仅日期 */
  date(timestamp: number): string;
  /** 「A、B 和 C」 */
  list(items: string[]): string;
  /** 当前语言下复数落在哪个形式 */
  plural(count: number): PluralCategory;
}

export function createFormatters(locale: Locale): Formatters {
  return {
    number: (value, fractionDigits = 1) =>
      numberFormatter(locale, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(value),
    integer: (value) => numberFormatter(locale, { maximumFractionDigits: 0 }).format(value),
    percent: (value, fractionDigits = 0) =>
      numberFormatter(locale, {
        style: 'percent',
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      }).format(value),
    signedPercent: (value, fractionDigits = 0) =>
      numberFormatter(locale, {
        style: 'percent',
        signDisplay: 'exceptZero',
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      }).format(value),
    signed: (value) =>
      numberFormatter(locale, { signDisplay: 'exceptZero', maximumFractionDigits: 1 }).format(value),
    bytes(value) {
      // NaN / 负数 / 0 一律按 0 字节：脏数据不该在列表里显示成 "NaN KB"
      const magnitude = Number.isFinite(value) && value > 0 ? value : 0;
      const tier =
        magnitude < 1024
          ? { unit: 'byte', by: 1, digits: 0 }
          : magnitude < 1024 ** 2
            ? { unit: 'kilobyte', by: 1024, digits: 1 }
            : magnitude < 1024 ** 3
              ? { unit: 'megabyte', by: 1024 ** 2, digits: 1 }
              : { unit: 'gigabyte', by: 1024 ** 3, digits: 1 };
      return numberFormatter(locale, {
        style: 'unit',
        unit: tier.unit,
        // 字节用 long：中文「512字节」、英文 "512 bytes"，单复数也对。
        // KB 及以上用 short：全用 long 会变成「1.5 千字节」这种没人写的说法。
        unitDisplay: tier.unit === 'byte' ? 'long' : 'short',
        minimumFractionDigits: tier.digits,
        maximumFractionDigits: tier.digits,
      }).format(magnitude / tier.by);
    },
    duration(seconds) {
      const total = Math.max(0, Math.round(seconds));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const secs = total % 60;
      const pad = (n: number) => String(n).padStart(2, '0');
      const body = hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
      // 中文用「分:秒」的数字写法即可，英语里 h/m/s 的缩写要靠 units 表达；
      // 这里统一用数字时钟式，避免为每种语言拼一套单位词。
      return body;
    },
    seconds: (value) => `${numberFormatter(locale, { maximumFractionDigits: 1 }).format(value)}`,
    milliseconds: (value) => `${numberFormatter(locale, { maximumFractionDigits: 0 }).format(value)}`,
    dateTime: (timestamp) =>
      dateFormatter(locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(timestamp)),
    date: (timestamp) =>
      dateFormatter(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp)),
    list: (items) => listFormatter(locale).format(items),
    plural: (count) => pluralCategory(locale, count),
  };
}
