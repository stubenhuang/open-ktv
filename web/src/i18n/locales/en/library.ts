//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Messages } from '../../types.ts';

/**
 * 分区文案：library
 *
 * 命名规范：`library.<语义>`，语义用 snake_case，保持稳定、可读、不随文案改动而改。
 * 详见 CONTRIBUTING.md 的「Internationalisation (i18n)」一节。
 *
 * 只放伴奏库页（web/src/pages/LibraryPage.tsx）的文案。上传弹窗、编辑弹窗是
 * 跨页面组件，文案在 `components` 分区。
 *
 * 复数键（`plural('key', n)` 用的那些）同时保留不带后缀的通用形：`plural()`
 * 在该语言没有对应形式时回落到它，`check:i18n` 也拿它当锚点校验键是否存在。
 */
const library: Messages = {
  /* --------------------------------- 页头 --------------------------------- */
  'library.title': 'Library',
  'library.subtitle':
    'Upload a track with its lyrics and you are ready to sing. If nothing here is what you want, search the Discover page.',
  'library.upload': 'Upload track',
  'library.uploadAria': 'Upload tracks: click to pick files, or drop audio files here',

  /* -------------------------------- 列表加载 -------------------------------- */
  'library.loadFailed': 'Could not load the track list',

  /* -------------------------------- 上传条目 -------------------------------- */
  'library.upload.itemDone': '✓ Uploaded',
  'library.upload.itemProgress': 'Uploading {percent}',
  'library.upload.dismissAria': 'Dismiss the upload status for {name}',
  'library.upload.failed': 'Upload failed',
  'library.upload.lyricsFailed': 'The track was uploaded, but the lyrics did not make it: {reason}',

  /* 一批上传完成后的汇总提示（成功数走复数） */
  'library.upload.summary.done': 'Uploaded {count} tracks — preview them or start singing below.',
  'library.upload.summary.done.one': 'Uploaded {count} track — preview it or start singing below.',
  'library.upload.summary.done.other': 'Uploaded {count} tracks — preview them or start singing below.',
  'library.upload.summary.partial': 'Uploaded {count} tracks, {failed} failed',
  'library.upload.summary.partial.one': 'Uploaded {count} track, {failed} failed',
  'library.upload.summary.partial.other': 'Uploaded {count} tracks, {failed} failed',

  /* -------------------------------- 拖拽上传区 -------------------------------- */
  'library.dropzone.title': 'Drop audio files here, or click to choose',
  'library.dropzone.hint':
    'mp3 / wav / flac / m4a and other common audio, several files at once; .lrc lyrics can be dropped in together',

  /* 拖拽进来但用不上的文件：说明白忽略了什么、为什么 */
  'library.drop.ignored': 'Ignored {count} files: {files} — the library only takes audio and .lrc lyrics',
  'library.drop.lyricsOnlyFirst': 'Only the first lyrics file is used: {name}',
  /* 多条提示之间的分隔符：中文用全角分号，英语用半分号 + 空格 */
  'library.drop.noteSeparator': '; ',

  /* --------------------------------- 删除 --------------------------------- */
  'library.delete.title': 'Delete track',
  'library.delete.message': 'Delete the track “{title}”? The original file goes with it.{worksNote}',
  'library.delete.worksNote':
    '\nIts {count} works are kept (the finished MP3s still play and download), but you can no longer adjust effects or re-mix them.',
  'library.delete.worksNote.one':
    '\nIts {count} work is kept (the finished MP3 still plays and downloads), but you can no longer adjust effects or re-mix it.',
  'library.delete.worksNote.other':
    '\nIts {count} works are kept (the finished MP3s still play and download), but you can no longer adjust effects or re-mix them.',
  'library.delete.done': 'Deleted the track “{title}”',
  'library.delete.notice':
    'Deleted the track “{title}” and kept {count} works (the finished MP3s still play and download, but they can no longer be re-mixed).',
  'library.delete.notice.one':
    'Deleted the track “{title}” and kept {count} work (the finished MP3 still plays and downloads, but it can no longer be re-mixed).',
  'library.delete.notice.other':
    'Deleted the track “{title}” and kept {count} works (the finished MP3s still play and download, but they can no longer be re-mixed).',
  'library.delete.failed': 'Delete failed',

  /* -------------------------------- 重试转码 -------------------------------- */
  'library.retry.button': 'Retry processing',
  'library.retry.failed': 'Retry failed',

  /* -------------------------------- 列表计数 -------------------------------- */
  'library.trackCount': '{count} tracks',
  'library.trackCount.one': '{count} track',
  'library.trackCount.other': '{count} tracks',
  'library.workCount': '{count} works',
  'library.workCount.one': '{count} work',
  'library.workCount.other': '{count} works',

  /* -------------------------------- 过滤工具条 -------------------------------- */
  'library.filter.placeholder': 'Filter by title or artist…',
  'library.filter.aria': 'Filter tracks by title or artist',
  'library.filter.count': '{shown} of {total}',
  'library.filter.clear': 'Clear filter',
  'library.filter.noMatch.title': 'No matching tracks',
  'library.filter.noMatch.description': 'Nothing in the library matches “{query}” by title or artist.',

  /* --------------------------------- 排序 --------------------------------- */
  'library.sort.aria': 'Sort by',
  'library.sort.recent': 'Recently uploaded',
  'library.sort.title': 'Title',
  'library.sort.duration': 'Duration',

  /* -------------------------------- 空状态 -------------------------------- */
  'library.empty.title': 'No tracks yet',
  'library.empty.description':
    'Upload one first and you can start singing. Or check the Discover page for something ready to use.',
  'library.empty.uploadFirst': 'Upload the first one',
  'library.empty.goDiscover': 'Go to Discover',

  /* -------------------------------- 列表行 -------------------------------- */
  'library.kind.video': 'Video track',
  'library.kind.audio': 'Audio track',
  'library.hasLyrics': 'Lyrics',
  'library.worksBadge.title':
    'Works under this track are kept when you delete it, but they can no longer be re-mixed',
  'library.processing.title': 'Transcoding into a format the browser can play directly',
  'library.processing.progress': 'Processing {percent}',
  'library.status.failed': 'Processing failed',
  'library.preview': 'Preview',
  'library.stopPreview': 'Stop preview',
  'library.goSing': 'Sing now',
};

export default library;
