//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Messages } from '../../types.ts';

/**
 * 分区文案：detail
 *
 * 命名规范：`detail.<语义>`，语义用 snake_case，保持稳定、可读、不随文案改动而改。
 * 详见 CONTRIBUTING.md 的「Internationalisation (i18n)」一节。
 */
const detail: Messages = {
  /* ------------------------------ 加载与失败 ------------------------------ */
  'detail.loadFailed': 'Could not load this work',
  'detail.loading': 'Loading this work…',
  'detail.mixFailed': 'Mix failed',
  'detail.renameFailed': 'Rename failed',
  'detail.deleteFailed': 'Delete failed',
  'detail.undoRetakeFailed': 'Could not undo the retake',

  /* -------------------------------- 导航 -------------------------------- */
  'detail.back': 'Back to my works',

  /* ------------------------------ 改名 / 删除 ----------------------------- */
  'detail.rename': 'Rename',
  'detail.renamed': 'Renamed',
  'detail.delete.title': 'Delete work',
  'detail.delete.message': 'Delete “{title}”? The raw vocal take and the finished MP3 will be deleted with it.',

  /* ------------------------------ 撤销重录 ------------------------------ */
  'detail.undoRetake.title': 'Undo retake',
  'detail.undoRetake.message':
    'Restore the vocal take from before the last retake? The current take will be replaced and the work will be mixed again automatically. (Only one step back: anything earlier has already been overwritten.)',
  'detail.undoRetake.confirm': 'Undo and mix again',
  'detail.undoRetake.hint': 'Restore the vocal take from before the last retake and mix again automatically',

  /* ------------------------------- 标题区 ------------------------------- */
  'detail.track.label': 'Track: {title}',
  'detail.duration.label': 'Duration {duration}',
  'detail.status.mixing': 'Mixing…',
  'detail.retake': 'Segment retake',

  /* ---------------------------- 失败与伴奏缺失 ---------------------------- */
  'detail.mixFailedReason': 'Mix failed: {reason}',
  'detail.mixFailedHints':
    'Common causes: the track file was deleted, the disk is full, or the vocal take is corrupted. Try adjusting the parameters and mixing again.',
  'detail.trackDeleted':
    'The track used by this work has been deleted. The finished MP3 can still be played or downloaded from your works, but live preview and re-mixing both need the track file, so adjustments are no longer offered here.',
};

export default detail;
