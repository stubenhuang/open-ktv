//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Messages } from '../../types.ts';

/**
 * 分区文案：nav
 *
 * 命名规范：`nav.<语义>`，语义用 snake_case，保持稳定、可读、不随文案改动而改。
 * 详见 CONTRIBUTING.md 的「Internationalisation (i18n)」一节。
 */
const nav: Messages = {
  'nav.library': 'Library',
  'nav.discover': 'Discover',
  'nav.works': 'My works',
  'nav.mobile': 'Sing on phone',
  'nav.skipToContent': 'Skip to main content',
};

export default nav;
