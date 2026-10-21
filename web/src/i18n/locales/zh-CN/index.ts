//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Messages } from '../../types.ts';
// 显式带 .ts 后缀：`node --test tests/i18n.test.ts` 用 Node 原生 ESM 解析，
// 不做 bundler 那种「目录 → index / 无后缀 → .ts」的猜测，少了后缀就跑不起来。
// Vite 与 tsc 两种解析器都认这个写法（见 tsconfig.json 的 allowImportingTsExtensions）。
import app from './app.ts';
import audio from './audio.ts';
import common from './common.ts';
import components from './components.ts';
import detail from './detail.ts';
import discover from './discover.ts';
import errors from './errors.ts';
import library from './library.ts';
import mobile from './mobile.ts';
import nav from './nav.ts';
import retake from './retake.ts';
import sing from './sing.ts';
import works from './works.ts';

/**
 * 简体中文 —— 参考语言（reference catalogue）。
 *
 * 每一种语言都必须包含这里的全部键；`npm run check:i18n` 会逐键比对。
 * 新增分区时：在这里加一个 import + 一行 merge，再在 `en/` 下建同名文件。
 */
const zhCN: Messages = {
  ...app,
  ...audio,
  ...common,
  ...components,
  ...detail,
  ...discover,
  ...errors,
  ...library,
  ...mobile,
  ...nav,
  ...retake,
  ...sing,
  ...works,
};

export default zhCN;
