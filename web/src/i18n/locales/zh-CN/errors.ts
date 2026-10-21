//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Messages } from '../../types.ts';

/**
 * 分区文案：errors
 *
 * 命名规范：`errors.<语义>`，语义用 snake_case，保持稳定、可读、不随文案改动而改。
 * 详见 CONTRIBUTING.md 的「Internationalisation (i18n)」一节。
 *
 * **这些键不是随便起的，它们就是服务端的错误码**（shared/types.ts 的
 * ApiErrorCode，见 server/src/httpError.ts）。服务端只返回 `{ code, params }`，
 * 句子由这里拼：`t('error.' + code, params)`。
 *
 * 所以：新增一个错误码时，服务端与这里必须同时加，且占位符要一致 ——
 * `npm run check:i18n` 会拿服务端的英文模板和这里的占位符逐一对账。
 */
const errors: Messages = {
  /* --------------------------------- 通用 --------------------------------- */
  'error.endpoint_not_found': '接口不存在',
  'error.internal_error': '服务内部错误，请稍后重试',
  'error.validation_failed': '请求不合法',
  'error.token_required': '需要访问令牌',

  /* --------------------------------- 上传 --------------------------------- */
  'error.upload_too_large': '文件超过 {limit} 上限，请先压缩或裁剪后再上传',
  'error.upload_missing_file': '没有收到文件',
  'error.upload_failed': '上传失败：{reason}',

  /* --------------------------------- 文件 --------------------------------- */
  'error.file_not_found': '文件不存在或已被删除',
  'error.file_read_failed': '读取文件失败：{reason}',

  /* --------------------------------- 伴奏 --------------------------------- */
  'error.track_not_found': '伴奏不存在',
  'error.track_already_ready': '这个伴奏已经是可用状态了',
  'error.track_processing': '这个伴奏正在处理中，请稍候',
  'error.track_transcode_failed': '转码失败：{reason}',
  'error.track_original_missing': '原始文件已经不在了，只能删除后重新上传',
  'error.track_update_failed': '更新伴奏失败：{reason}',
  'error.track_title_empty': '歌名不能为空',
  'error.track_title_too_long': '歌名太长（最多 {limit} 字）',
  'error.pitch_not_allowed_while_processing': '这个伴奏还在处理中，转好之后才能调升降调',
  'error.pitch_rubberband_missing':
    '当前 ffmpeg 不带 rubberband，升降调不可用（其余功能不受影响）。换一个带 --enable-librubberband 的 ffmpeg 构建即可启用。',

  /* --------------------------------- 歌词 --------------------------------- */
  'error.lyrics_not_text': '歌词必须是文本',
  'error.lyrics_too_long': '歌词太长了（最多 {limit} 字）',
  'error.lyrics_not_lrc':
    '这看起来不是 LRC 歌词：至少要有一行 [mm:ss] 或 [mm:ss.xx] 时间戳。纯文本歌词无法跟唱，请先给每行加上时间戳。',
  'error.lyrics_file_type': '只支持 .lrc / .txt 歌词文件',
  'error.lyrics_source_disabled': '歌词源没有启用（KUGOU_LYRICS_ENABLED=0？）',
  'error.lyrics_not_found': '没找到带时间轴的 LRC 歌词，可以手动上传 .lrc 文件',

  /* --------------------------------- 作品 --------------------------------- */
  'error.work_track_required': '请指定一个有效的伴奏',
  'error.work_track_processing': '这个伴奏还在转码中，暂时不能演唱',
  'error.work_recording_too_short': '录音太短了，请完整唱一段再结束',
  'error.work_recording_too_long': '录音超过 {limit} 分钟上限，已拒绝',
  'error.work_title_empty': '作品名不能为空',
  'error.work_title_too_long': '作品名太长（最多 {limit} 字）',
  'error.work_mix_in_progress': '上一次合成还没结束，请稍等几秒',
  'error.work_mix_failed': '上一次合成失败了：{reason}',
  'error.work_not_ready': '作品还在生成中，请稍候',
  'error.work_not_found': '作品不存在',
  'error.work_retake_track_deleted': '伴奏已删除，这个作品不能再重录（重录后需要重新混音）',
  'error.work_retake_range_invalid': '重录区间的起止时间不正确',
  'error.work_retake_range_order': '重录区间的结束时间要晚于开始时间',
  'error.work_retake_segment_too_short': '重录区间太短（至少 {limit} 秒）',
  'error.work_retake_parse_failed': '重录文件解析失败，请重新录制这一段',
  'error.work_retake_segment_mismatch': '上传的重录片段和所选区间差得太远，请重新录制',
  'error.work_retake_undo_failed': '撤销重录失败：{reason}',

  /* -------------------------------- 曲库点歌 -------------------------------- */
  'error.library_search_failed': '曲库搜索失败：{reason}',
  'error.library_download_params_missing': '请求里缺少 providerId 或 itemId',
  'error.library_source_not_configured': '这个曲库源没有配置（可能改过 LIBRARY_SOURCES）',
  'error.library_source_unavailable': '曲库源不可用：{reason}',
  'error.library_item_not_found': '曲库里找不到这个伴奏（源站清单可能变了，请重新搜索）',
  'error.library_download_in_progress': '这个伴奏正在下载中，请稍候',
  'error.library_task_not_found': '任务不存在（服务可能重启过），请重新点歌',

  /* -------------------------------- 手机入口 -------------------------------- */
  'error.mobile_entry_unavailable': '现在没有可用的手机入口',
  'error.qr_generation_failed': '生成二维码失败',
  'error.certificate_unavailable': '证书还没生成（装好 openssl 后重启服务）',
};

export default errors;
