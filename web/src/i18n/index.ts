//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

/**
 * i18n 的对外出口。
 *
 * 组件里只用两样东西：
 *
 * ```tsx
 * import { useI18n } from '../i18n';
 * const { t, fmt, locale } = useI18n();
 * ```
 *
 * 规则（详见 CONTRIBUTING.md「Internationalisation」）：
 *   - 界面文案一律走 `t('area.key')`，不许在 JSX 里写死中文或英文；
 *   - 数字 / 时长 / 文件大小 / 日期 / 列表一律走 `fmt.*`，不许手拼；
 *   - 文案放在 `locales/<语言>/<分区>.ts`，新增语言 = 新增一个目录 + 两行登记。
 */
export { I18nProvider, useI18n, translateWith, LANG_PARAM } from './I18nProvider';
export type { I18n } from './I18nProvider';
export { LOCALES, FALLBACK_LOCALE, CATALOGS, isLocale, matchLocale, lookup } from './catalog';
export type { MessageKey } from './catalog';
export { interpolate, pluralCategory, createFormatters } from './format';
export type { Formatters } from './format';
export type { Locale, Messages, MessageVars, PluralCategory } from './types';
