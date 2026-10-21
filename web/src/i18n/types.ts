//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

/**
 * i18n 的基础类型。
 *
 * 这里刻意不依赖任何第三方 i18n 库：项目的运行时依赖只有 package.json 里那七个，
 * 翻译目录 + 一个 React context 就够用了，而且能拿到完整的 TypeScript 键检查。
 */

/**
 * BCP-47 语言标签。定义在 shared/types.ts（服务端也要用它选兜底文案），
 * 这里转出来只是为了 import 路径短。新增语言时同步改 catalog.ts 的 LOCALES。
 */
export type { Locale } from '../../../shared/types.ts';

/** 一份语言目录：扁平的「点分键 → 文案」映射 */
export type Messages = Record<string, string>;

/** 插值变量：`{name}` 占位符的取值 */
export type MessageVars = Record<string, string | number>;

/** 复数取哪个形式，由 Intl.PluralRules 决定 */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
