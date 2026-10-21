//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Messages } from '../../types.ts';

/**
 * 分区文案：common
 *
 * 命名规范：`common.<语义>`，语义用 snake_case，保持稳定、可读、不随文案改动而改。
 * 详见 CONTRIBUTING.md 的「Internationalisation (i18n)」一节。
 *
 * 这个分区由维护者统一持有 —— 各个功能分区（library / discover / works / …）不要
 * 往这里加键，避免两个人同时改同一个文件。某个分区需要「保存」但语义不同时，
 * 在自己分区里定义 `xxx.save`。
 */
const common: Messages = {
  /* --------------------------------- 动作 --------------------------------- */
  'common.save': '保存',
  'common.cancel': '取消',
  'common.delete': '删除',
  'common.confirm': '确定',
  'common.close': '关闭',
  'common.retry': '重试',
  'common.edit': '编辑',
  'common.done': '完成',
  'common.back': '返回',
  'common.undo': '撤销',
  'common.search': '搜索',
  'common.clear': '清空',
  'common.upload': '上传',
  'common.download': '下载',
  'common.play': '播放',
  'common.pause': '暂停',
  'common.stop': '停止',
  'common.start': '开始',
  'common.submit': '提交',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.ok': '知道了',
  'common.yes': '是',
  'common.no': '否',
  'common.all': '全部',
  'common.none': '无',
  'common.more': '更多',
  'common.less': '收起',
  'common.expand': '展开',
  'common.collapse': '收起',
  'common.loading': '正在加载…',
  'common.saving': '正在保存…',
  'common.uploading': '正在上传…',
  'common.processing': '处理中',
  'common.optional': '可选',
  'common.required': '必填',
  'common.default': '默认',

  /* --------------------------------- 状态 --------------------------------- */
  'common.ready': '已就绪',
  'common.failed': '失败',
  'common.pending': '排队中',
  'common.unknown': '未知',
  'common.enabled': '已开启',
  'common.disabled': '已关闭',

  /* -------------------------------- 字段标签 -------------------------------- */
  'common.title': '歌名',
  'common.artist': '歌手',
  'common.duration': '时长',
  'common.size': '大小',
  'common.createdAt': '创建时间',
  'common.status': '状态',
  'common.name': '名称',
  'common.kind': '类型',
  'common.progress': '进度',

  /* --------------------------------- 单位 --------------------------------- */
  'common.unit.second': '秒',
  'common.unit.millisecond': '毫秒',
  'common.unit.semitone': '半音',
  'common.unit.percent': '%',

  /* -------------------------------- 无障碍标签 ------------------------------- */
  'common.a11y.loading': '正在加载',
  'common.a11y.dismiss': '关闭',
  'common.a11y.required': '必填项',
};

export default common;
