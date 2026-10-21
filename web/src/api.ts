//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type {
  LibraryItemDto,
  LibraryItemKind,
  LibrarySearchResult,
  LibrarySourceStatus,
  LibraryTaskDto,
  MixParams,
  NetworkInfo,
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
  /** 服务端给的机器可读码（如 token_required）；普通错误没有 */
  code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/* --------------------------------- 访问令牌 --------------------------------- */

/**
 * 访问令牌（ACCESS_TOKEN 配了才用得上；没配时这一切全是空转）。
 *
 * 三个来源：
 *  1. URL 上的 `?token=` —— 手机扫的二维码由服务端生成时已带上（见
 *     server/src/routes/network.ts），落地第一件事就是收进 localStorage；
 *  2. localStorage —— 之后所有请求都靠它，刷新不丢；
 *  3. 用户手输 —— 收到 401 token_required 时弹输入框（见 TokenGate）。
 *
 * 令牌送两路：JSON/XHR 请求走 header `x-access-token`；`<audio>/<video>/
 * <img>` 的 src 带不了 header，只能拼 query（withToken）。
 */

const TOKEN_KEY = 'ktv.access-token';

function readToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    // 隐私模式等读不了 storage 的场合：当没有令牌，请求会 401，走手输流程
    return '';
  }
}

function writeToken(token: string): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 存不下就算了：当前会话仍可用（内存里的这份继续生效）
  }
}

// 模块级缓存：每个请求都读一遍 localStorage 没必要，写入时同步更新即可
let accessToken = '';

/** 启动时把 URL 上的 token 收进来（二维码带来的那次落地） */
function captureTokenFromUrl(): void {
  if (typeof window === 'undefined') return;
  const fromUrl = new URLSearchParams(window.location.search).get('token');
  if (fromUrl && fromUrl !== accessToken) {
    accessToken = fromUrl;
    writeToken(fromUrl);
    // 地址栏里留着令牌不值当：它已经进了 storage，而且会跟着分享链接外泄
    const clean = new URL(window.location.href);
    clean.searchParams.delete('token');
    window.history.replaceState(null, '', clean.toString());
  }
}

captureTokenFromUrl();
if (!accessToken) accessToken = readToken();

/** 当前持有的令牌（空串 = 没有） */
export function currentAccessToken(): string {
  return accessToken;
}

/** 记下用户手输的令牌（TokenGate 提交时调） */
export function saveAccessToken(token: string): void {
  accessToken = token.trim();
  writeToken(accessToken);
}

type TokenRequiredListener = (required: boolean) => void;
const tokenRequiredListeners = new Set<TokenRequiredListener>();
let tokenRequired = false;

/** 订阅「服务端要令牌」状态（TokenGate 用） */
export function onTokenRequiredChange(listener: TokenRequiredListener): () => void {
  tokenRequiredListeners.add(listener);
  return () => tokenRequiredListeners.delete(listener);
}

export function isTokenRequired(): boolean {
  return tokenRequired;
}

function markTokenRequired(): void {
  if (tokenRequired) return;
  tokenRequired = true;
  for (const listener of tokenRequiredListeners) listener(true);
}

/** 给带不了 header 的 URL（媒体 src / 下载链接）拼上令牌 */
function withToken(url: string): string {
  if (!accessToken) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(accessToken)}`;
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
    response = await fetch(path, {
      ...init,
      headers: {
        ...init?.headers,
        ...(accessToken ? { 'x-access-token': accessToken } : {}),
      },
    });
  } catch (error) {
    log.debug('api', '网络请求失败', path, error);
    throw new ApiError('连不上后端服务，请确认 npm run dev 已经在跑', 0);
  }

  const data = await readBody(response);
  if (!response.ok) {
    log.debug('api', '接口返回错误', path, response.status, errorMessage(data, ''));
    const code = (data as { code?: unknown } | null)?.code;
    if (response.status === 401 && code === 'token_required') {
      // 服务端要令牌而我们没有（或给错了）：广播出去，让 TokenGate 弹输入框
      markTokenRequired();
    }
    throw new ApiError(
      errorMessage(data, `请求失败（HTTP ${response.status}）`),
      response.status,
      typeof code === 'string' ? code : null,
    );
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
    if (accessToken) xhr.setRequestHeader('x-access-token', accessToken);

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
      const code = (data as { code?: unknown } | null)?.code;
      reject(
        new ApiError(
          errorMessage(data, `上传失败（HTTP ${xhr.status}）`),
          xhr.status,
          typeof code === 'string' ? code : null,
        ),
      );
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
      /** 升降调（半音，−12…+12）；0 = 原调 */
      pitchSemitones?: number;
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

  /**
   * 分段重录：把一段新录音拼进干声的 [startSec, endSec)（干声时间轴，秒）。
   * 服务端拼接完成后自动重新混音，返回时作品状态已是 mixing。
   */
  retakeWork: (id: string, input: { vocal: Blob; startSec: number; endSec: number }) => {
    const form = new FormData();
    form.append('segment', input.vocal, 'segment.wav');
    form.append('startSec', String(input.startSec));
    form.append('endSec', String(input.endSec));
    return upload<Work>(`/api/works/${encodeURIComponent(id)}/retake`, form);
  },

  /** 撤销上一步分段重录（恢复重录前的干声并重新混音；只回退一级） */
  undoRetake: (id: string) =>
    request<Work>(`/api/works/${encodeURIComponent(id)}/retake-undo`, jsonInit('POST', {})),

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

  /* --------------------------------- 手机演唱 --------------------------------- */

  /** 局域网地址与手机入口（桌面页渲染二维码用） */
  getNetwork: () => request<NetworkInfo>('/api/network'),
};

/** 手机端二维码图片地址（服务端现生成 SVG；码里已含令牌，见 network.ts） */
export function networkQrUrl(): string {
  return withToken('/api/network/qr.svg');
}

/** 自签名证书下载地址（iPhone 想彻底信任时装它） */
export function networkCertUrl(): string {
  return withToken('/api/network/cert.crt');
}

/**
 * 伴奏播放地址。
 *
 * @param version 伴奏「换了文件」的版本号。同一个 URL 下浏览器不会重新加载
 *   `<audio>`，而升降调恰恰是在同一个 URL 后面换文件（移调伴奏生成好之后）——
 *   所以调用方在移调状态变化时要把这个值涨一下，元素才会重新拉一份。
 */
export function trackMediaUrl(trackId: string, version?: number | string): string {
  const base = `/api/media/track/${encodeURIComponent(trackId)}`;
  return withToken(version === undefined ? base : `${base}?v=${encodeURIComponent(String(version))}`);
}

/** 服务端能力（ffmpeg 有没有 rubberband → 升降调能不能用） */
export function health(): Promise<{
  ok: boolean;
  queue: { active: string | null; waiting: number };
  disk: { freeBytes: number | null };
  capabilities: { rubberband: boolean };
}> {
  return request('/api/health');
}

/** cacheBust：重新混音后文件名不变，必须靠查询参数绕开浏览器缓存 */
export function workAudioUrl(workId: string, cacheBust?: number): string {
  const base = `/api/works/${encodeURIComponent(workId)}/audio`;
  return withToken(cacheBust ? `${base}?v=${cacheBust}` : base);
}

export function workVocalUrl(workId: string): string {
  return withToken(`/api/works/${encodeURIComponent(workId)}/vocal`);
}

/**
 * 带 `download=1` 的成品 / 干声下载地址。
 *
 * 单独给函数而不是让调用方拼 `${workAudioUrl(id)}?download=1`：令牌也是
 * 拼在 query 上的，两处各拼一半会产出 `?token=x?download=1` 这种坏地址。
 */
export function workAudioDownloadUrl(workId: string): string {
  return withToken(`/api/works/${encodeURIComponent(workId)}/audio?download=1`);
}

export function workVocalDownloadUrl(workId: string): string {
  return withToken(`/api/works/${encodeURIComponent(workId)}/vocal?download=1`);
}

export type {
  LibraryItemDto,
  LibraryItemKind,
  LibrarySearchResult,
  LibrarySourceStatus,
  LibraryTaskDto,
  NetworkInfo,
  Track,
  TrackDetail,
  TrackListItem,
  TrackSummary,
  Work,
  WorkListItem,
};
