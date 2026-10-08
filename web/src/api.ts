import type {
  LibraryItemDto,
  LibraryItemKind,
  LibrarySearchResult,
  LibrarySourceStatus,
  LibraryTaskDto,
  MixParams,
  Track,
  TrackDetail,
  TrackListItem,
  TrackSummary,
  Work,
  WorkListItem,
} from '../../shared/types';
import { log } from './log';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 300) };
  }
}

function errorMessage(data: unknown, fallback: string): string {
  const message = (data as { error?: unknown } | null)?.error;
  return typeof message === 'string' && message ? message : fallback;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    log.debug('api', '网络请求失败', path, error);
    throw new ApiError('连不上后端服务，请确认 npm run dev 已经在跑', 0);
  }

  const data = await readBody(response);
  if (!response.ok) {
    log.debug('api', '接口返回错误', path, response.status, errorMessage(data, ''));
    throw new ApiError(errorMessage(data, `请求失败（HTTP ${response.status}）`), response.status);
  }
  return data as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** 带进度回调的上传（fetch 没有上传进度，只能用 XHR） */
function upload<T>(path: string, form: FormData, onProgress?: (ratio: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.timeout = 30 * 60 * 1000;

    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    };

    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T);
        return;
      }
      reject(new ApiError(errorMessage(data, `上传失败（HTTP ${xhr.status}）`), xhr.status));
    };

    xhr.onerror = () => reject(new ApiError('上传失败：网络中断', 0));
    xhr.ontimeout = () => reject(new ApiError('上传超时，文件可能过大', 0));

    xhr.send(form);
  });
}

export interface CreateWorkInput {
  vocal: Blob;
  vocalFileName: string;
  trackId: string;
  autoOffsetMs: number;
  vocalDuration: number;
}

/** 点歌结果：要么排上了下载任务，要么这个条目已经在库里了 */
export type LibraryDownloadResult =
  | { taskId: string; title: string }
  | { alreadyImported: true; track: TrackDetail };

export const api = {
  listTracks: () => request<TrackListItem[]>('/api/tracks'),

  getTrack: (id: string) => request<TrackDetail>(`/api/tracks/${encodeURIComponent(id)}`),

  uploadTrack: (file: File, onProgress?: (ratio: number) => void) => {
    const form = new FormData();
    // 显式带上文件名，中文才不会被破坏
    form.append('file', file, file.name);
    return upload<TrackDetail>('/api/tracks', form, onProgress);
  },

  updateTrack: (
    id: string,
    patch: {
      title?: string;
      artist?: string;
      /** null 或空串 = 清除歌词 */
      lyrics?: string | null;
      /** 歌词全局微调（ms）：正值 = 歌词更晚显示 */
      lyricsOffsetMs?: number;
    },
  ) => request<TrackDetail>(`/api/tracks/${encodeURIComponent(id)}`, jsonInit('PATCH', patch)),

  /** 上传 .lrc 文件设置歌词（走 multipart，服务端与 PATCH 共用一套校验） */
  uploadLyrics: (id: string, file: File) => {
    const form = new FormData();
    form.append('lyrics', file, file.name);
    return upload<TrackDetail>(`/api/tracks/${encodeURIComponent(id)}/lyrics`, form);
  },

  /** 按歌名/歌手从歌词源（酷狗）自动匹配 LRC；找不到会 404 */
  fetchTrackLyrics: (id: string) =>
    request<TrackDetail>(`/api/tracks/${encodeURIComponent(id)}/lyrics/auto`, jsonInit('POST', {})),

  /** 救「转码跑到一半服务重启」：原文件还在，重新排一次转码 */
  retryTrack: (id: string) =>
    request<TrackDetail>(`/api/tracks/${encodeURIComponent(id)}/retry`, { method: 'POST' }),

  /** 删除伴奏；keptWorks = 一并保留下来的作品数（作品与伴奏已解耦） */
  deleteTrack: (id: string) =>
    request<{ ok: true; keptWorks: number }>(`/api/tracks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  listWorks: () => request<WorkListItem[]>('/api/works'),

  getWork: (id: string) => request<WorkListItem>(`/api/works/${encodeURIComponent(id)}`),

  createWork: (input: CreateWorkInput) => {
    const form = new FormData();
    form.append('vocal', input.vocal, input.vocalFileName);
    form.append('trackId', input.trackId);
    form.append('autoOffsetMs', String(Math.round(input.autoOffsetMs)));
    form.append('vocalDuration', String(input.vocalDuration));
    return upload<Work>('/api/works', form);
  },

  remixWork: (id: string, params: Partial<MixParams>) =>
    request<Work>(`/api/works/${encodeURIComponent(id)}/mix`, jsonInit('POST', params)),

  updateWork: (id: string, patch: { title?: string }) =>
    request<Work>(`/api/works/${encodeURIComponent(id)}`, jsonInit('PATCH', patch)),

  deleteWork: (id: string) =>
    request<{ ok: true }>(`/api/works/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /* --------------------------------- 曲库点歌 --------------------------------- */

  /** 当前配了哪些曲库源；空数组 = 用户还没配 LIBRARY_SOURCES */
  listLibrarySources: () =>
    request<{ sources: { id: string; label: string }[] }>('/api/library/sources'),

  searchLibrary: (q: string, kind?: LibraryItemKind | null) => {
    const params = new URLSearchParams({ q });
    if (kind) params.set('kind', kind);
    return request<LibrarySearchResult>(`/api/library/search?${params.toString()}`);
  },

  downloadFromLibrary: (providerId: string, itemId: string) =>
    request<LibraryDownloadResult>('/api/library/download', jsonInit('POST', { providerId, itemId })),

  getLibraryTask: (taskId: string) =>
    request<LibraryTaskDto>(`/api/library/tasks/${encodeURIComponent(taskId)}`),
};

export function trackMediaUrl(trackId: string): string {
  return `/api/media/track/${encodeURIComponent(trackId)}`;
}

/** cacheBust：重新混音后文件名不变，必须靠查询参数绕开浏览器缓存 */
export function workAudioUrl(workId: string, cacheBust?: number): string {
  const base = `/api/works/${encodeURIComponent(workId)}/audio`;
  return cacheBust ? `${base}?v=${cacheBust}` : base;
}

export function workVocalUrl(workId: string): string {
  return `/api/works/${encodeURIComponent(workId)}/vocal`;
}

export type {
  LibraryItemDto,
  LibraryItemKind,
  LibrarySearchResult,
  LibrarySourceStatus,
  LibraryTaskDto,
  Track,
  TrackDetail,
  TrackListItem,
  TrackSummary,
  Work,
  WorkListItem,
};
