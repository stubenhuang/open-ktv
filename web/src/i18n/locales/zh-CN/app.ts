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
  'app.subtitle': '简易版全民K歌',

  /* 语言自己的名字：语言选择器里永远用母语自称，不翻译 */
  'app.language': '语言',
  'app.language.zh-CN': '简体中文',
  'app.language.en': 'English',

  /* 兜底：翻译缺失、网络层错误等「不属于任何分区」的句子 */
  'app.error.network': '连不上后端服务，请确认服务已经在跑',
  'app.error.unknown': '出了点问题，请稍后重试',
  'app.error.http': '请求失败（HTTP {status}）',
  'app.error.upload.network': '上传失败：网络中断',
  'app.error.upload.timeout': '上传超时，文件可能过大',
  'app.error.translation.missing': '〔缺少翻译：{key}〕',
};

export default app;
