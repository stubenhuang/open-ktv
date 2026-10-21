//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Response } from 'express';
import type { ApiErrorCode, ApiErrorParams } from '../../shared/types.ts';
import { createLogger } from './logger.ts';

/**
 * 错误码清单在 shared/types.ts（ApiErrorCode）—— 前后端共用一份，
 * 服务端能返的码前端一定译得出来。这里只放「码 → 英文兜底文案」的表。
 */

export type { ApiErrorCode, ApiErrorParams };

export interface ApiErrorBody {
  code: ApiErrorCode;
  /** 英文兜底说明：给 curl / 脚本 / 非浏览器客户端看，界面文案不读它 */
  message: string;
  params?: ApiErrorParams;
}

/**
 * 每个码的英文模板。
 *
 * `{name}` 占位符与前端文案目录里的必须一一对应（`npm run check:i18n` 会比对
 * 占位符集合）。这里刻意用英文而不是中文：服务端不再对浏览器用户说话，
 * 而命令行用户读英文的成本比读翻译更低的概率更大。
 */
export const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  /* 通用 */
  endpoint_not_found: 'Endpoint does not exist',
  internal_error: 'Internal server error',
  validation_failed: 'Invalid request',
  token_required: 'An access token is required',

  /* 上传 */
  upload_too_large: 'File exceeds the {limit} upload limit. Compress or trim it first.',
  upload_missing_file: 'No file received',
  upload_failed: 'Upload failed: {reason}',

  /* 文件 */
  file_not_found: 'File does not exist or has been deleted',
  file_read_failed: 'Could not read the file: {reason}',

  /* 伴奏 */
  track_not_found: 'Track does not exist',
  track_already_ready: 'This track is already ready',
  track_processing: 'This track is still being processed, please wait',
  track_transcode_failed: 'Transcoding failed: {reason}',
  track_original_missing: 'The original file is gone. Delete this track and upload it again.',
  track_update_failed: 'Could not update the track: {reason}',
  track_title_empty: 'The title cannot be empty',
  track_title_too_long: 'The title is too long (at most {limit} characters)',
  pitch_not_allowed_while_processing:
    'This track is still being processed. Pitch shifting becomes available once it is ready.',
  pitch_rubberband_missing:
    'This ffmpeg build has no librubberband, so pitch shifting is unavailable.',

  /* 歌词 */
  lyrics_not_text: 'Lyrics must be text',
  lyrics_too_long: 'Lyrics are too long (at most {limit} characters)',
  lyrics_not_lrc:
    'This does not look like LRC: at least one line needs an [mm:ss] or [mm:ss.xx] timestamp. Plain-text lyrics cannot be sung along to.',
  lyrics_file_type: 'Only .lrc / .txt lyric files are supported',
  lyrics_source_disabled: 'The lyric source is disabled (KUGOU_LYRICS_ENABLED=0?)',
  lyrics_not_found: 'No timed LRC lyrics were found. You can upload a .lrc file instead.',

  /* 作品 */
  work_track_required: 'Pick a valid backing track',
  work_track_processing: 'This backing track is still transcoding and cannot be sung yet',
  work_recording_too_short: 'The recording is too short. Sing a full phrase before finishing.',
  work_recording_too_long: 'The recording exceeds the {limit}-minute limit and was rejected',
  work_title_empty: 'The work title cannot be empty',
  work_title_too_long: 'The work title is too long (at most {limit} characters)',
  work_mix_in_progress: 'The previous mix has not finished yet, please wait a few seconds',
  work_mix_failed: 'The last mix failed: {reason}',
  work_not_ready: 'This work is still being generated, please wait',
  work_not_found: 'Work does not exist',
  work_retake_track_deleted:
    'The backing track of this work has been deleted, so it cannot be re-taken (a re-take has to be re-mixed).',
  work_retake_range_invalid: 'The re-take range is not valid',
  work_retake_range_order: 'The end of the re-take range must come after its start',
  work_retake_segment_too_short: 'The re-take range is too short (at least {limit} seconds)',
  work_retake_parse_failed: 'Could not parse the re-take recording. Please record this segment again.',
  work_retake_segment_mismatch:
    'The uploaded segment is too far from the selected range. Please record it again.',
  work_retake_undo_failed: 'Could not undo the re-take: {reason}',

  /* 曲库点歌 */
  library_search_failed: 'Library search failed: {reason}',
  library_download_params_missing: 'providerId and itemId are required',
  library_source_not_configured:
    'This library source is not configured (did LIBRARY_SOURCES change?)',
  library_source_unavailable: 'The library source is unavailable: {reason}',
  library_item_not_found:
    'This backing track is not in the library (the source manifest may have changed, try searching again).',
  library_download_in_progress: 'This backing track is already downloading, please wait',
  library_task_not_found:
    'Task does not exist (the service may have restarted). Please pick the song again.',

  /* 手机入口 */
  mobile_entry_unavailable: 'No mobile entry is available',
  qr_generation_failed: 'Could not generate the QR code',
  certificate_unavailable: 'The certificate has not been generated yet (install openssl and restart)',
};

/** 把 `{name}` 占位符替换成 params（未知占位符原样留着，便于发现漏传） */
export function formatErrorMessage(code: ApiErrorCode, params?: ApiErrorParams): string {
  const template = ERROR_MESSAGES[code];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** 错误响应体：`{ code, message, params }` */
export function errorBody(code: ApiErrorCode, params?: ApiErrorParams): ApiErrorBody {
  const body: ApiErrorBody = { code, message: formatErrorMessage(code, params) };
  if (params && Object.keys(params).length > 0) body.params = params;
  return body;
}

/** 直接回一个错误响应 */
export function fail(
  res: Response,
  status: number,
  code: ApiErrorCode,
  params?: ApiErrorParams,
): void {
  res.status(status).json(errorBody(code, params));
}

const log = createLogger('http-error');

/**
 * 业务层抛出的、带状态码与机器可读码的错误。
 *
 * 上传链路（server/src/upload.ts）会在 catch 里读 `status` / `code` / `params`
 * 原样回给客户端，所以 ingestFile 之类的地方抛一个 HttpError 就够了，
 * 不用在路由里再判一次类型。
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly params?: ApiErrorParams;

  constructor(status: number, code: ApiErrorCode, params?: ApiErrorParams) {
    super(formatErrorMessage(code, params));
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

/** 从任意未知异常里取出「状态码 + 机器可读码 + 参数」，取不到就给兜底值 */
export function readHttpError(
  error: unknown,
  fallbackCode: ApiErrorCode = 'internal_error',
  fallbackStatus = 400,
): { status: number; code: ApiErrorCode; params?: ApiErrorParams; message: string } {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, params: error.params, message: error.message };
  }
  const candidate = error as { status?: unknown; code?: unknown; params?: unknown } | null;
  const status =
    typeof candidate?.status === 'number' && candidate.status >= 400 && candidate.status <= 599
      ? candidate.status
      : fallbackStatus;
  const code =
    typeof candidate?.code === 'string' && candidate.code in ERROR_MESSAGES
      ? (candidate.code as ApiErrorCode)
      : fallbackCode;
  const params =
    candidate?.params && typeof candidate.params === 'object'
      ? (candidate.params as ApiErrorParams)
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (code === fallbackCode) log.debug('按兜底错误码处理异常', { status, code, message });
  return { status, code, params, message };
}
