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
  'detail.loadFailed': '加载作品失败',
  'detail.loading': '正在加载作品…',
  'detail.mixFailed': '合成失败',
  'detail.renameFailed': '重命名失败',
  'detail.deleteFailed': '删除失败',
  'detail.undoRetakeFailed': '撤销重录失败',

  /* -------------------------------- 导航 -------------------------------- */
  'detail.back': '返回作品库',

  /* ------------------------------ 改名 / 删除 ----------------------------- */
  'detail.rename': '改名',
  'detail.renamed': '已改名',
  'detail.delete.title': '删除作品',
  'detail.delete.message': '确定删除作品「{title}」吗？录音干声和成品 MP3 都会一起删掉。',

  /* ------------------------------ 撤销重录 ------------------------------ */
  'detail.undoRetake.title': '撤销重录',
  'detail.undoRetake.message':
    '确定恢复到上一步重录前的干声吗？当前干声会被替换掉，并自动重新混音。（只回退一级：再往前的一版已经被覆盖。）',
  'detail.undoRetake.confirm': '撤销并重新混音',
  'detail.undoRetake.hint': '恢复上一步重录前的干声，并自动重新混音',

  /* ------------------------------- 标题区 ------------------------------- */
  'detail.track.label': '伴奏：{title}',
  'detail.duration.label': '时长 {duration}',
  'detail.status.mixing': '正在合成…',
  'detail.retake': '分段重录',

  /* ---------------------------- 失败与伴奏缺失 ---------------------------- */
  'detail.mixFailedReason': '合成失败：{reason}',
  'detail.mixFailedHints': '常见原因：伴奏文件被删了、磁盘写满、或者干声文件损坏。可以调一下参数再点「合成」试试。',
  'detail.trackDeleted':
    '这个作品用的伴奏已经被删除了。已生成的 MP3 还能在作品库里播放 / 下载，但实时试听和重新合成都需要伴奏文件，所以这里不再提供调整。',
};

export default detail;
