//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Messages } from '../../types.ts';

/**
 * 分区文案：app
 *
 * 命名规范：`app.<语义>`，语义用 snake_case，保持稳定、可读、不随文案改动而改。
 * 详见 CONTRIBUTING.md 的「Internationalisation (i18n)」一节。
 */
const app: Messages = {
  'app.title': 'Open KTV',
  'app.subtitle': 'Karaoke, self-hosted',

  /* 语言自己的名字：语言选择器里永远用母语自称，不翻译 */
  'app.language': 'Language',
  'app.language.zh-CN': '简体中文',
  'app.language.en': 'English',

  /* 兜底：翻译缺失、网络层错误等「不属于任何分区」的句子 */
  'app.error.network': 'Cannot reach the backend service. Make sure the server is running.',
  'app.error.unknown': 'Something went wrong. Please try again.',
  'app.error.http': 'Request failed (HTTP {status})',
  'app.error.upload.network': 'Upload failed: the connection dropped',
  'app.error.upload.timeout': 'Upload timed out — the file may be too large',
  'app.error.translation.missing': '〔missing translation: {key}〕',
};

export default app;
