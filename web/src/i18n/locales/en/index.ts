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
 * English catalogue.
 *
 * 分区与 `zh-CN` 一一对应，键集必须完全一致（`npm run check:i18n` 把关）。
 * 缺键时运行时会回落到简体中文，不会白屏 —— 但那是兜底，不是许可。
 */
const en: Messages = {
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

export default en;
