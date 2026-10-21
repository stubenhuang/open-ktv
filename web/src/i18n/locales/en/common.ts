//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Messages } from '../../types.ts';

/**
 * 分区文案：common
 *
 * 命名规范：`common.<语义>`，语义用 snake_case，保持稳定、可读、不随文案改动而改。
 * 详见 CONTRIBUTING.md 的「Internationalisation (i18n)」一节。
 */
const common: Messages = {
  /* --------------------------------- 动作 --------------------------------- */
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.confirm': 'Confirm',
  'common.close': 'Close',
  'common.retry': 'Retry',
  'common.edit': 'Edit',
  'common.done': 'Done',
  'common.back': 'Back',
  'common.undo': 'Undo',
  'common.search': 'Search',
  'common.clear': 'Clear',
  'common.upload': 'Upload',
  'common.download': 'Download',
  'common.play': 'Play',
  'common.pause': 'Pause',
  'common.stop': 'Stop',
  'common.start': 'Start',
  'common.submit': 'Submit',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.ok': 'Got it',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.all': 'All',
  'common.none': 'None',
  'common.more': 'More',
  'common.less': 'Show less',
  'common.expand': 'Show more',
  'common.collapse': 'Collapse',
  'common.loading': 'Loading…',
  'common.saving': 'Saving…',
  'common.uploading': 'Uploading…',
  'common.processing': 'Processing',
  'common.optional': 'optional',
  'common.required': 'required',
  'common.default': 'Default',

  /* --------------------------------- 状态 --------------------------------- */
  'common.ready': 'Ready',
  'common.failed': 'Failed',
  'common.pending': 'Queued',
  'common.unknown': 'Unknown',
  'common.enabled': 'Enabled',
  'common.disabled': 'Disabled',

  /* -------------------------------- 字段标签 -------------------------------- */
  'common.title': 'Title',
  'common.artist': 'Artist',
  'common.duration': 'Duration',
  'common.size': 'Size',
  'common.createdAt': 'Created',
  'common.status': 'Status',
  'common.name': 'Name',
  'common.kind': 'Type',
  'common.progress': 'Progress',

  /* --------------------------------- 单位 --------------------------------- */
  'common.unit.second': 's',
  'common.unit.millisecond': 'ms',
  'common.unit.semitone': 'semitones',
  'common.unit.percent': '%',

  /* -------------------------------- 无障碍标签 ------------------------------- */
  'common.a11y.loading': 'Loading',
  'common.a11y.dismiss': 'Dismiss',
  'common.a11y.required': 'required',
};

export default common;
