//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Messages } from '../../types.ts';

/**
 * 分区文案：works
 *
 * 命名规范：`works.<语义>`，语义用 snake_case，保持稳定、可读、不随文案改动而改。
 * 详见 CONTRIBUTING.md 的「Internationalisation (i18n)」一节。
 */
const works: Messages = {
  /* --------------------------------- 页头 --------------------------------- */
  'works.title': 'My works',
  'works.subtitle': 'Every take is saved as an MP3, so you can listen back, download or tweak it whenever you like.',
  'works.goLibrary': 'Go to the library',
  /*
   * 计数走 plural('works.count', n)：中文没有单数变形，`.one` 与 `.other` 同文，
   * 但两种语言的键集必须完全一致，所以都写上；不带后缀的那条是 plural() 的兜底形。
   */
  'works.count': '{count} works',
  'works.count.one': '{count} work',
  'works.count.other': '{count} works',
  /* 筛选后的计数按**总数**取复数（「3 of 5 works」的中心词是 5） */
  'works.count.filtered': '{visible} of {total} works',
  'works.count.filtered.one': '{visible} of {total} work',
  'works.count.filtered.other': '{visible} of {total} works',

  /* ------------------------------ 加载与操作失败 ----------------------------- */
  'works.loadFailed': 'Could not load your works',
  'works.deleteFailed': 'Delete failed',
  'works.renameFailed': 'Rename failed',
  'works.retryFailed': 'Retry failed',

  /* -------------------------------- 作品状态 -------------------------------- */
  /* 「已就绪 / 失败」两档复用 common.ready / common.failed，这里只放合成相关的 */
  'works.status.mixing': 'Mixing',
  'works.status.failed': 'Mix failed',
  'works.play.mixing': 'Mixing…',

  /* ------------------------------ 删除确认对话框 ----------------------------- */
  'works.delete.title': 'Delete work',
  'works.delete.message': 'Delete “{title}”? The raw vocal take and the finished MP3 will be deleted with it.',
  'works.deleted': 'Deleted “{title}”',

  /* -------------------------------- 内联改名 -------------------------------- */
  'works.rename.label': 'Work name',
  'works.rename.empty': 'The work name cannot be empty',
  'works.renamed': 'Renamed',

  /* ------------------------------ 列表行元信息 ------------------------------ */
  'works.track.label': 'Track: {title}',
  'works.track.deleted': 'Track deleted',
  'works.meta.duration': 'Duration {duration}',
  'works.meta.size': 'MP3 {size}',
  'works.meta.vocalPreset': 'Vocal preset: {preset}',
  'works.meta.reverb': 'Reverb: {reverb}',
  'works.meta.sungAt': 'Sung {time}',
  'works.sung.relative': 'Sung {when}',
  'works.remix.hint': 'Last mixed: {time}',
  'works.pitch.shifted': 'The track was pitch-shifted by {pitch} during mixing',
  'works.mixFailedReason': 'Mix failed: {reason}',

  /* ------------------------------- 行内操作 -------------------------------- */
  'works.action.adjust': 'Adjust effects',
  'works.action.adjustHint': 'Preview the result, tweak the parameters and mix again',
  'works.action.downloadMp3': 'Download MP3',
  'works.action.downloadDisabled': 'This work is not ready yet, so it cannot be downloaded',
  'works.action.vocal': 'Raw vocal',
  'works.action.vocalHint': 'Download the raw vocal WAV (the unprocessed take)',
  'works.action.retry': 'Retry mix',
  'works.action.rename': 'Rename',
  'works.action.renameAria': 'Rename “{title}”',
  'works.action.deleteAria': 'Delete “{title}”',

  /* ---------------------------- 搜索 / 排序 / 筛选 --------------------------- */
  'works.search.placeholder': 'Search works, tracks or artists…',
  'works.search.aria': 'Search works by title, track or artist',
  'works.search.clear': 'Clear the search query',
  'works.sort.aria': 'Sort by',
  'works.sort.recent': 'Most recent',
  'works.sort.oldest': 'Oldest first',
  'works.sort.title': 'By title',
  'works.sort.duration': 'By duration',
  'works.clearFilters': 'Clear filters',

  /* -------------------------------- 空状态 -------------------------------- */
  'works.empty.title': 'No works yet',
  'works.empty.description': 'Pick a track from the library, put on your headphones and record your first take.',
  'works.empty.noMatch.title': 'No matching works',
  'works.empty.noMatch.byQuery': 'No work title, track or artist matches “{query}”.',
  'works.empty.noMatch.byStatus': 'No works under the current status filter — try another status.',
};

export default works;
