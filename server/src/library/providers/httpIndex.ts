/**
 * HTTP 清单源（参考 provider 实现）。
 *
 * 协议刻意做到最笨：源站只需要在一份静态 JSON 里列出伴奏，**不需要实现
 * 任何服务端逻辑**。所以 NAS、对象存储、局域网 HTTP、静态站点都能当源用，
 * 也不需要任何鉴权或反爬对抗。
 *
 * 清单格式（version 目前只有 1）：
 * {
 *   "version": 1,
 *   "name": "我的伴奏库",
 *   "items": [
 *     { "id": "qingtian", "title": "晴天", "artist": "周杰伦",
 *       "durationSec": 269, "kind": "audio",
 *       "url": "qingtian.mp3",              // 相对/绝对都行，按清单地址解析
 *       "lrc": "qingtian.lrc",              // 可选
 *       "sizeBytes": 12345678 }             // 可选
 *   ]
 * }
 *
 * 说明：
 *  - `id` 可省略，省略时用 `url` 兜底 —— 去重键必须在源内稳定唯一。
 *  - 清单结果按 TTL 缓存在内存里，搜索是纯本地过滤，不会每敲一个字就打源站。
 *  - 拉取失败时**回退到过期缓存**：源站抖一下不该让整个曲库变空。
 */

import { LIBRARY_CACHE_TTL_MS, LIBRARY_SEARCH_TIMEOUT_MS } from '../../config.ts';
import { createLogger } from '../../logger.ts';
import type { LibraryItem, LibraryProvider, LibraryQuery } from '../types.ts';

const log = createLogger('library');

/** 清单文件大小上限；正常清单几百 KB，20MB 足够容纳几万首 */
const MAX_MANIFEST_BYTES = 20 * 1024 * 1024;

interface ManifestItem {
  id?: unknown;
  title?: unknown;
  artist?: unknown;
  durationSec?: unknown;
  kind?: unknown;
  url?: unknown;
  lrc?: unknown;
  sizeBytes?: unknown;
}

interface Manifest {
  version?: unknown;
  name?: unknown;
  items?: unknown;
}

interface CacheEntry {
  /** 拉取完成时刻（ms） */
  at: number;
  name: string;
  items: LibraryItem[];
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function asNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** 把清单里的相对地址按清单地址绝对化；非法地址返回 null */
function absolutize(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base);
    // 只允许 http(s)：清单是外部内容，别让它把 file:// 之类引进来
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** 把一条清单原始条目转成 LibraryItem；缺关键字段就丢掉这条 */
function parseManifestItem(raw: ManifestItem, providerId: string, base: string): LibraryItem | null {
  const title = asText(raw.title);
  const rawUrl = asText(raw.url);
  if (!title || !rawUrl) return null;

  const url = absolutize(rawUrl, base);
  if (!url) return null;

  // id 缺失时用 url 兜底：去重键必须稳定唯一
  const itemId = asText(raw.id) ?? url;
  const lrcRaw = asText(raw.lrc);
  const lrcUrl = lrcRaw ? absolutize(lrcRaw, base) : null;

  return {
    providerId,
    itemId,
    title,
    artist: asText(raw.artist),
    durationSec: asNumber(raw.durationSec),
    kind: raw.kind === 'video' ? 'video' : 'audio',
    url,
    lrcUrl,
    sizeBytes: asNumber(raw.sizeBytes),
  };
}

export interface HttpIndexProviderOptions {
  id: string;
  /** 清单地址 */
  manifestUrl: string;
  /** 覆盖清单里的 name */
  label?: string;
  /** 缓存时长；测试里设 0 可以每次都重拉 */
  cacheTtlMs?: number;
  searchTimeoutMs?: number;
}

export class HttpIndexProvider implements LibraryProvider {
  readonly id: string;
  readonly manifestUrl: string;

  private readonly labelOverride: string | undefined;
  private readonly cacheTtlMs: number;
  private readonly searchTimeoutMs: number;

  private cache: CacheEntry | null = null;
  /** 单飞：并发搜索时只发一次清单请求 */
  private inFlight: Promise<CacheEntry> | null = null;

  constructor(options: HttpIndexProviderOptions) {
    this.id = options.id;
    this.manifestUrl = options.manifestUrl;
    this.labelOverride = options.label;
    this.cacheTtlMs = options.cacheTtlMs ?? LIBRARY_CACHE_TTL_MS;
    this.searchTimeoutMs = options.searchTimeoutMs ?? LIBRARY_SEARCH_TIMEOUT_MS;
  }

  get label(): string {
    return this.labelOverride ?? this.cache?.name ?? new URL(this.manifestUrl).host;
  }

  /** 取清单（带 TTL 缓存 + 单飞 + 失败回退过期缓存） */
  private async manifest(): Promise<CacheEntry> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.cacheTtlMs) return this.cache;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchManifest()
      .then((entry) => {
        this.cache = entry;
        return entry;
      })
      .catch((error: unknown) => {
        // 有过期缓存就先用着：源站抖一下不该让整个曲库变空
        if (this.cache) {
          log.warn(`曲库源 ${this.id} 拉取失败，暂时沿用 ${Math.round((now - this.cache.at) / 1000)}s 前的缓存`, {
            error,
          });
          return this.cache;
        }
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async fetchManifest(): Promise<CacheEntry> {
    const response = await fetch(this.manifestUrl, {
      signal: AbortSignal.timeout(this.searchTimeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`清单拉取失败（HTTP ${response.status}）`);
    }

    const text = await response.text();
    if (text.length > MAX_MANIFEST_BYTES) {
      throw new Error(`清单太大（超过 ${Math.round(MAX_MANIFEST_BYTES / 1024 / 1024)}MB）`);
    }

    let parsed: Manifest;
    try {
      parsed = JSON.parse(text) as Manifest;
    } catch {
      throw new Error('清单不是合法 JSON');
    }

    if (!Array.isArray(parsed.items)) {
      throw new Error('清单缺少 items 数组');
    }

    const items: LibraryItem[] = [];
    const seen = new Set<string>();
    for (const raw of parsed.items as ManifestItem[]) {
      const item = parseManifestItem(raw ?? {}, this.id, this.manifestUrl);
      if (!item || seen.has(item.itemId)) continue;
      seen.add(item.itemId);
      items.push(item);
    }

    const name = asText(parsed.name) ?? this.labelOverride ?? new URL(this.manifestUrl).host;
    log.debug(`曲库源 ${this.id} 清单已加载`, { items: items.length, name });
    return { at: Date.now(), name, items };
  }

  async search(query: LibraryQuery): Promise<LibraryItem[]> {
    // query.signal 故意不接进清单拉取：清单是「一次拉取、多个请求共享」的，
    // 让某个客户端的断连去 abort 共享请求会连累其他人。
    // 清单拉取自己带超时（searchTimeoutMs），足够兜住源站卡死。
    const entry = await this.manifest();
    const keyword = query.q.trim().toLowerCase();
    const matched: LibraryItem[] = [];

    for (const item of entry.items) {
      if (query.kind && item.kind !== query.kind) continue;
      if (keyword) {
        const haystack = `${item.title} ${item.artist ?? ''}`.toLowerCase();
        if (!haystack.includes(keyword)) continue;
      }
      matched.push(item);
      if (matched.length >= query.limit) break;
    }
    return matched;
  }

  async resolve(itemId: string): Promise<LibraryItem | undefined> {
    const entry = await this.manifest();
    return entry.items.find((item) => item.itemId === itemId);
  }

  /** 测试用：丢掉缓存 */
  clearCache(): void {
    this.cache = null;
  }
}
