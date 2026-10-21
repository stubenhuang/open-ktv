//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { interpolate } from './format.ts';
import type { Locale, MessageVars, Messages } from './types.ts';
// 显式写到 index.ts：Node 原生跑 TS 时（`node --test tests/i18n.test.ts`）
// 不做 bundler 那种「目录 → index」的解析，少了后缀会 ERR_UNSUPPORTED_DIR_IMPORT。
// Vite 与 tsc 两种解析器都认这个写法。
import zhCN from './locales/zh-CN/index.ts';
import en from './locales/en/index.ts';

/**
 * 支持的语言清单（BCP-47）。
 *
 * 新增一种语言：在 `locales/` 下建同名目录、把 import 与条目加进来，
 * 并在下面的 `LANGUAGE_NAMES` 里给出它**在自己语言里**的名字（语言选择器用它显示）。
 */
export const LOCALES = ['zh-CN', 'en'] as const;

/** 参考语言：缺翻译时的回落目标 */
export const FALLBACK_LOCALE: Locale = 'zh-CN';

export type MessageKey = keyof typeof zhCN;

/** 各语言目录，按 Locale 索引 */
export const CATALOGS: Record<Locale, Messages> = {
  'zh-CN': zhCN,
  en,
};

/**
 * 语言选择器里的显示名。
 *
 * 语言一律用**母语自称**（中文界面里也写 `English`）—— 这是 i18n 的惯例：
 * 找一种语言的人认得它自己的写法。表由维护者手工维护：加一种语言时在这里
 * 加一行，并在 I18nProvider 的 localeLabels 里同步。
 */
const LANGUAGE_NAMES: Record<Locale, string> = {
  'zh-CN': '简体中文',
  en: 'English',
};

/** 当前界面语言下，各语言怎么显示（语言选择器用） */
export function localeLabelsIn(locale: Locale): Record<Locale, string> {
  if (locale === 'zh-CN') return { ...LANGUAGE_NAMES };
  // 非中文界面用「语言（母语名）」双写，只懂中文的人也能找到中文入口
  return {
    'zh-CN': `${LANGUAGE_NAMES['zh-CN']} (Chinese)`,
    en: LANGUAGE_NAMES.en,
  };
}

/** 这个标签是不是受支持的语言 */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * 浏览器偏好 → 语言标签。
 *
 * `navigator.languages` 给的是带地区的完整标签（`zh-CN`、`en-US`），按顺序取第一个
 * 能对上的；地区不同但主语言相同也算命中（`en-GB` → `en`）。
 */
export function matchLocale(candidates: readonly string[]): Locale | null {
  for (const candidate of candidates) {
    if (isLocale(candidate)) return candidate;
    const base = candidate.split('-')[0];
    const hit = LOCALES.find((locale) => locale.split('-')[0] === base);
    if (hit) return hit;
  }
  return null;
}

/**
 * 查一条文案。
 *
 * 顺序：当前语言 → 参考语言（简体中文）→ 键本身。
 * 最后那一档不是摆设：翻译进行到一半时，缺的键会显示成键名，
 * 在 `npm run check:i18n` 报出来之前就能在界面上看见。
 */
export function lookup(locale: Locale, key: string): string | undefined {
  return CATALOGS[locale][key] ?? CATALOGS[FALLBACK_LOCALE][key];
}

/**
 * 查一条文案并填好占位符。
 *
 * 顺序：当前语言 → 参考语言（简体中文）→ 键本身。
 * 最后那一档不是摆设：翻译进行到一半时，缺的键会显示成键名，
 * 在 `npm run check:i18n` 报出来之前就能在界面上看见。
 *
 * 不依赖 React —— 所以 `labels.ts`、`api.ts` 这些拿不到 context 的模块也能用。
 */
export function translate(locale: Locale, key: string, vars?: MessageVars): string {
  const message = lookup(locale, key);
  // 缺键时把键本身当文案返回：界面上会明晃晃显示 `library.upload`，
  // 比静默显示空串好定位；权威校验在 scripts/check-i18n.mjs（CI 里跑）。
  if (message === undefined) return key;
  return interpolate(message, vars);
}
