//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { setApiLocale } from '../api';
import { FALLBACK_LOCALE, LOCALES, localeLabelsIn, translate } from './catalog';
import { createFormatters, pluralCategory } from './format';
import type { Formatters } from './format';
import type { Locale, MessageVars } from './types';

export type { Locale, MessageVars } from './types';

/* ----------------------------- 语言探测与持久化 ----------------------------- */

const STORAGE_KEY = 'ktv.locale';

/** URL 参数名：`?lang=en` —— 分享链接时可以直接指定界面语言 */
export const LANG_PARAM = 'lang';

function readStoredLocale(): Locale | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'zh-CN' || stored === 'en' ? stored : null;
  } catch {
    // 隐私模式下读不了 storage：当没有偏好，走浏览器语言
    return null;
  }
}

function writeStoredLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // 存不下就算了：本次会话仍然生效
  }
}

/** 地址栏上的 `?lang=`（有效时收进 storage，让后续刷新也走同一种语言） */
function readLangParam(): Locale | null {
  try {
    const value = new URLSearchParams(window.location.search).get(LANG_PARAM);
    return value === 'zh-CN' || value === 'en' ? value : null;
  } catch {
    return null;
  }
}

function browserLocales(): string[] {
  if (typeof navigator === 'undefined') return [];
  return [...(navigator.languages ?? []), navigator.language].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

/**
 * 启动时定下来用哪种语言。
 *
 * 优先级（从高到低）：
 *   1. `?lang=` —— 分享的链接要能带语言；
 *   2. localStorage —— 用户上次选过；
 *   3. `navigator.languages` —— 浏览器的偏好；
 *   4. 参考语言（简体中文）。
 */
function detectLocale(): Locale {
  if (typeof window === 'undefined') return FALLBACK_LOCALE;
  const fromParam = readLangParam();
  if (fromParam) return fromParam;
  const stored = readStoredLocale();
  if (stored) return stored;
  const matched = matchBrowser();
  return matched ?? FALLBACK_LOCALE;
}

function matchBrowser(): Locale | null {
  const candidates = browserLocales();
  for (const candidate of candidates) {
    if (candidate === 'zh-CN' || candidate === 'en') return candidate;
    const base = candidate.split('-')[0];
    const hit = LOCALES.find((locale) => locale.split('-')[0] === base);
    if (hit) return hit;
  }
  return null;
}

/* --------------------------------- Context --------------------------------- */

export interface I18n {
  /** 当前语言（BCP-47） */
  locale: Locale;
  /** 受支持的语言清单 */
  locales: readonly Locale[];
  /** 在当前语言下，各语言怎么显示（语言选择器用） */
  localeLabels: Record<Locale, string>;
  setLocale(next: Locale): void;
  /** 查一条文案；`{name}` 占位符用 vars 填充 */
  t(key: string, vars?: MessageVars): string;
  /** 复数：解析 `key.zero|one|two|few|many|other`，见 format.ts */
  plural(key: string, count: number, vars?: MessageVars): string;
  /** 数字 / 日期 / 时长 / 大小 / 列表的本地化格式化 */
  fmt: Formatters;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    writeStoredLocale(next);
  }, []);

  const value = useMemo<I18n>(() => {
    const fmt = createFormatters(locale);
    return {
      locale,
      locales: LOCALES,
      localeLabels: localeLabelsIn(locale),
      setLocale,
      t: (key, vars) => translate(locale, key, vars),
      plural: (key, count, vars) => {
        const category = pluralCategory(locale, count);
        const specific = translate(locale, `${key}.${category}`, { count, ...vars });
        // 该语言没有为这个复数形式单独写文案时，退回不带后缀的那条
        return specific === `${key}.${category}`
          ? translate(locale, key, { count, ...vars })
          : specific;
      },
      fmt,
    };
  }, [locale, setLocale]);

  /* `<html lang>` 是给读屏软件、搜索引擎和浏览器翻译按钮看的 —— 必须跟实际语言同步 */
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = translate(locale, 'app.title');
    // api.ts 不在 React 树里，拿不到 context：语言变化时把当前语言推给它，
    // 服务端错误码才能按用户的语言拼成句子（见 ApiError.localized）
    setApiLocale(locale);
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** 取 i18n 上下文。组件里一律用它，不要在模块顶层缓存文案 */
export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error('useI18n 必须在 <I18nProvider> 内部调用（见 web/src/main.tsx）');
  }
  return value;
}

/** 非 React 场景（api.ts 的错误映射之类）用的独立翻译函数 */
export function translateWith(locale: Locale, key: string, vars?: MessageVars): string {
  return translate(locale, key, vars);
}
