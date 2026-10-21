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
  'error.endpoint_not_found': 'Endpoint does not exist',
  'error.internal_error': 'Internal server error. Please try again.',
  'error.validation_failed': 'Invalid request',
  'error.token_required': 'An access token is required',

  /* --------------------------------- 上传 --------------------------------- */
  'error.upload_too_large': 'The file exceeds the {limit} upload limit. Compress or trim it first.',
  'error.upload_missing_file': 'No file was received',
  'error.upload_failed': 'Upload failed: {reason}',

  /* --------------------------------- 文件 --------------------------------- */
  'error.file_not_found': 'The file does not exist or has been deleted',
  'error.file_read_failed': 'Could not read the file: {reason}',

  /* --------------------------------- 伴奏 --------------------------------- */
  'error.track_not_found': 'This backing track does not exist',
  'error.track_already_ready': 'This backing track is already ready',
  'error.track_processing': 'This backing track is still being processed, please wait',
  'error.track_transcode_failed': 'Transcoding failed: {reason}',
  'error.track_original_missing': 'The original file is gone. Delete this track and upload it again.',
  'error.track_update_failed': 'Could not update the backing track: {reason}',
  'error.track_title_empty': 'The title cannot be empty',
  'error.track_title_too_long': 'The title is too long (at most {limit} characters)',
  'error.pitch_not_allowed_while_processing':
    'This backing track is still being processed. Pitch shifting becomes available once it is ready.',
  'error.pitch_rubberband_missing':
    'This ffmpeg build has no librubberband, so pitch shifting is unavailable. Everything else still works — use a build with --enable-librubberband to turn it on.',

  /* --------------------------------- 歌词 --------------------------------- */
  'error.lyrics_not_text': 'Lyrics must be text',
  'error.lyrics_too_long': 'The lyrics are too long (at most {limit} characters)',
  'error.lyrics_not_lrc':
    'This does not look like LRC: at least one line needs an [mm:ss] or [mm:ss.xx] timestamp. Plain-text lyrics cannot be sung along to.',
  'error.lyrics_file_type': 'Only .lrc / .txt lyric files are supported',
  'error.lyrics_source_disabled': 'The lyric source is disabled (KUGOU_LYRICS_ENABLED=0?)',
  'error.lyrics_not_found': 'No timed LRC lyrics were found. You can upload a .lrc file instead.',

  /* --------------------------------- 作品 --------------------------------- */
  'error.work_track_required': 'Pick a valid backing track',
  'error.work_track_processing': 'This backing track is still transcoding and cannot be sung yet',
  'error.work_recording_too_short': 'The recording is too short. Sing a full phrase before finishing.',
  'error.work_recording_too_long': 'The recording exceeds the {limit}-minute limit and was rejected',
  'error.work_title_empty': 'The work title cannot be empty',
  'error.work_title_too_long': 'The work title is too long (at most {limit} characters)',
  'error.work_mix_in_progress': 'The previous mix has not finished yet, please wait a few seconds',
  'error.work_mix_failed': 'The last mix failed: {reason}',
  'error.work_not_ready': 'This work is still being generated, please wait',
  'error.work_not_found': 'This work does not exist',
  'error.work_retake_track_deleted':
    'The backing track of this work has been deleted, so it cannot be re-taken (a re-take has to be re-mixed).',
  'error.work_retake_range_invalid': 'The re-take range is not valid',
  'error.work_retake_range_order': 'The end of the re-take range must come after its start',
  'error.work_retake_segment_too_short': 'The re-take range is too short (at least {limit} seconds)',
  'error.work_retake_parse_failed': 'Could not parse the re-take recording. Please record this segment again.',
  'error.work_retake_segment_mismatch': 'The uploaded segment is too far from the selected range. Please record it again.',
  'error.work_retake_undo_failed': 'Could not undo the re-take: {reason}',

  /* -------------------------------- 曲库点歌 -------------------------------- */
  'error.library_search_failed': 'Library search failed: {reason}',
  'error.library_download_params_missing': 'providerId and itemId are required',
  'error.library_source_not_configured':
    'This library source is not configured (did LIBRARY_SOURCES change?)',
  'error.library_source_unavailable': 'The library source is unavailable: {reason}',
  'error.library_item_not_found':
    'This backing track is not in the library (the source manifest may have changed, try searching again).',
  'error.library_download_in_progress': 'This backing track is already downloading, please wait',
  'error.library_task_not_found':
    'Task does not exist (the service may have restarted). Please pick the song again.',

  /* -------------------------------- 手机入口 -------------------------------- */
  'error.mobile_entry_unavailable': 'There is no mobile entry available right now',
  'error.qr_generation_failed': 'Could not generate the QR code',
  'error.certificate_unavailable': 'The certificate has not been generated yet (install openssl and restart)',
};

export default errors;
