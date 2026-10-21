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
 * 中文没有单数变形，`.one` 与 `.other` 同文 —— 但两种语言的键集必须完全一致，
 * 所以英语用到的形式这里也要照写。
 */
const library: Messages = {
  /* --------------------------------- 页头 --------------------------------- */
  'library.title': '伴奏库',
  'library.subtitle': '上传伴奏、带上歌词，就能去演唱；没有想唱的，去点歌台搜一首。',
  'library.upload': '上传伴奏',
  'library.uploadAria': '上传伴奏：点击选择文件，或把音频文件拖到这里',

  /* -------------------------------- 列表加载 -------------------------------- */
  'library.loadFailed': '加载伴奏列表失败',

  /* -------------------------------- 上传条目 -------------------------------- */
  'library.upload.itemDone': '✓ 已上传',
  'library.upload.itemProgress': '上传中 {percent}',
  'library.upload.dismissAria': '收起 {name} 的上传状态',
  'library.upload.failed': '上传失败',
  'library.upload.lyricsFailed': '伴奏已上传，但歌词没上去：{reason}',

  /* 一批上传完成后的汇总提示（成功数走复数） */
  'library.upload.summary.done': '已上传 {count} 个伴奏，可以在下面试听 / 演唱了',
  'library.upload.summary.done.one': '已上传 {count} 个伴奏，可以在下面试听 / 演唱了',
  'library.upload.summary.done.other': '已上传 {count} 个伴奏，可以在下面试听 / 演唱了',
  'library.upload.summary.partial': '已上传 {count} 个伴奏，{failed} 个失败',
  'library.upload.summary.partial.one': '已上传 {count} 个伴奏，{failed} 个失败',
  'library.upload.summary.partial.other': '已上传 {count} 个伴奏，{failed} 个失败',

  /* -------------------------------- 拖拽上传区 -------------------------------- */
  'library.dropzone.title': '把音频文件拖到这里，或点击选择',
  'library.dropzone.hint': '支持 mp3 / wav / flac / m4a 等常见音频，可一次多选；.lrc 歌词可以一起拖进来',

  /* 拖拽进来但用不上的文件：说明白忽略了什么、为什么 */
  'library.drop.ignored': '忽略了 {count} 个文件：{files}（伴奏库只收音频和 .lrc 歌词）',
  'library.drop.lyricsOnlyFirst': '歌词只取了第一个：{name}',
  /* 多条提示之间的分隔符：中文用全角分号，英语用半分号 + 空格 */
  'library.drop.noteSeparator': '；',

  /* --------------------------------- 删除 --------------------------------- */
  'library.delete.title': '删除伴奏',
  'library.delete.message': '确定删除伴奏「{title}」吗？原文件也会一起删掉。{worksNote}',
  'library.delete.worksNote':
    '\n它下面的 {count} 个作品会保留（成品 MP3 仍可播放 / 下载），但不能再调整效果或重新合成。',
  'library.delete.worksNote.one':
    '\n它下面的 {count} 个作品会保留（成品 MP3 仍可播放 / 下载），但不能再调整效果或重新合成。',
  'library.delete.worksNote.other':
    '\n它下面的 {count} 个作品会保留（成品 MP3 仍可播放 / 下载），但不能再调整效果或重新合成。',
  'library.delete.done': '已删除伴奏「{title}」',
  'library.delete.notice': '已删除伴奏「{title}」，保留 {count} 个作品（成品仍可播放 / 下载，但不能重新合成）。',
  'library.delete.notice.one': '已删除伴奏「{title}」，保留 {count} 个作品（成品仍可播放 / 下载，但不能重新合成）。',
  'library.delete.notice.other':
    '已删除伴奏「{title}」，保留 {count} 个作品（成品仍可播放 / 下载，但不能重新合成）。',
  'library.delete.failed': '删除失败',

  /* -------------------------------- 重试转码 -------------------------------- */
  'library.retry.button': '重试处理',
  'library.retry.failed': '重试失败',

  /* -------------------------------- 列表计数 -------------------------------- */
  'library.trackCount': '共 {count} 首',
  'library.trackCount.one': '共 {count} 首',
  'library.trackCount.other': '共 {count} 首',
  'library.workCount': '{count} 个作品',
  'library.workCount.one': '{count} 个作品',
  'library.workCount.other': '{count} 个作品',

  /* -------------------------------- 过滤工具条 -------------------------------- */
  'library.filter.placeholder': '按歌名 / 歌手过滤…',
  'library.filter.aria': '按歌名或歌手过滤伴奏',
  'library.filter.count': '{shown} / {total} 首',
  'library.filter.clear': '清空过滤',
  'library.filter.noMatch.title': '没有匹配的伴奏',
  'library.filter.noMatch.description': '曲库里没有和「{query}」相关的歌名或歌手。',

  /* --------------------------------- 排序 --------------------------------- */
  'library.sort.aria': '排序方式',
  'library.sort.recent': '最近上传',
  'library.sort.title': '按歌名',
  'library.sort.duration': '按时长',

  /* -------------------------------- 空状态 -------------------------------- */
  'library.empty.title': '还没有伴奏',
  'library.empty.description': '先上传一首，然后就能开唱了。也可以去点歌台看看有没有现成的。',
  'library.empty.uploadFirst': '上传第一首',
  'library.empty.goDiscover': '去点歌台',

  /* -------------------------------- 列表行 -------------------------------- */
  'library.kind.video': '视频伴奏',
  'library.kind.audio': '音频伴奏',
  'library.hasLyrics': '有歌词',
  'library.worksBadge.title': '删除伴奏时这些作品会保留，但不能重新合成',
  'library.processing.title': '正在转码成浏览器能直接播放的格式',
  'library.processing.progress': '处理中 {percent}',
  'library.status.failed': '处理失败',
  'library.preview': '试听',
  'library.stopPreview': '停止试听',
  'library.goSing': '去演唱',
};

export default library;
