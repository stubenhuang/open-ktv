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
  'works.title': '我的作品',
  'works.subtitle': '每唱一次都会存下一版 MP3，随时回听、下载或调整效果。',
  'works.goLibrary': '去伴奏库',
  /*
   * 计数走 plural('works.count', n)：中文没有单数变形，`.one` 与 `.other` 同文，
   * 但两种语言的键集必须完全一致，所以都写上；不带后缀的那条是 plural() 的兜底形。
   */
  'works.count': '共 {count} 部',
  'works.count.one': '共 {count} 部',
  'works.count.other': '共 {count} 部',
  /* 筛选后的计数按**总数**取复数（「3 / 5 部」的中心词是 5） */
  'works.count.filtered': '{visible} / {total} 部',
  'works.count.filtered.one': '{visible} / {total} 部',
  'works.count.filtered.other': '{visible} / {total} 部',

  /* ------------------------------ 加载与操作失败 ----------------------------- */
  'works.loadFailed': '加载作品失败',
  'works.deleteFailed': '删除失败',
  'works.renameFailed': '重命名失败',
  'works.retryFailed': '重试失败',

  /* -------------------------------- 作品状态 -------------------------------- */
  /* 「已就绪 / 失败」两档复用 common.ready / common.failed，这里只放合成相关的 */
  'works.status.mixing': '合成中',
  'works.status.failed': '合成失败',
  'works.play.mixing': '正在合成',

  /* ------------------------------ 删除确认对话框 ----------------------------- */
  'works.delete.title': '删除作品',
  'works.delete.message': '确定删除作品「{title}」吗？录音干声和成品 MP3 都会一起删掉。',
  'works.deleted': '已删除作品「{title}」',

  /* -------------------------------- 内联改名 -------------------------------- */
  'works.rename.label': '作品名',
  'works.rename.empty': '作品名不能为空',
  'works.renamed': '已改名',

  /* ------------------------------ 列表行元信息 ------------------------------ */
  'works.track.label': '伴奏：{title}',
  'works.track.deleted': '伴奏已删除',
  'works.meta.duration': '时长 {duration}',
  'works.meta.size': '成品 MP3 {size}',
  'works.meta.vocalPreset': '人声预设：{preset}',
  'works.meta.reverb': '混响：{reverb}',
  'works.meta.sungAt': '演唱于 {time}',
  'works.sung.relative': '{when}演唱',
  'works.remix.hint': '最近混音：{time}',
  'works.pitch.shifted': '混音时伴奏移调了 {pitch}',
  'works.mixFailedReason': '合成失败：{reason}',

  /* ------------------------------- 行内操作 -------------------------------- */
  'works.action.adjust': '调整效果',
  'works.action.adjustHint': '试听效果、调整参数并重新合成',
  'works.action.downloadMp3': '下载 MP3',
  'works.action.downloadDisabled': '作品还没就绪，不能下载',
  'works.action.vocal': '干声',
  'works.action.vocalHint': '下载干声 WAV（未经处理的原始录音）',
  'works.action.retry': '重试合成',
  'works.action.rename': '改名',
  'works.action.renameAria': '把「{title}」改名',
  'works.action.deleteAria': '删除「{title}」',

  /* ---------------------------- 搜索 / 排序 / 筛选 --------------------------- */
  'works.search.placeholder': '搜索作品名 / 伴奏 / 歌手…',
  'works.search.aria': '按作品名、伴奏名或歌手搜索作品',
  'works.search.clear': '清空搜索词',
  'works.sort.aria': '排序方式',
  'works.sort.recent': '最近演唱',
  'works.sort.oldest': '最早演唱',
  'works.sort.title': '按歌名',
  'works.sort.duration': '按时长',
  'works.clearFilters': '清空筛选',

  /* -------------------------------- 空状态 -------------------------------- */
  'works.empty.title': '还没有作品',
  'works.empty.description': '去伴奏库选一首，戴上耳机开始你的第一次演唱吧。',
  'works.empty.noMatch.title': '没有匹配的作品',
  'works.empty.noMatch.byQuery': '没有和「{query}」相关的作品名、伴奏或歌手。',
  'works.empty.noMatch.byStatus': '当前状态过滤下没有作品，换个状态看看。',
};

export default works;
