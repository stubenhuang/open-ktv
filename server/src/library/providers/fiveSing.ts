/**
 * 5sing 伴奏源（内置 provider）。
 *
 * 对接 5sing 官方 Web 自己在用的几个端点，全部实测可用：
 *  - 关键词搜索：`{searchBase}/home/json?keyword=&sort=1&page=&filter=3&type=0`
 *    （filter=3 = 只出伴奏；每页 10 条；songName 带 `<em class="keyword">` 高亮）
 *  - 空关键词浏览：`{webBase}/bz/rmsong/more_1.shtml` 的「热门伴奏」表格（每页 50 首）
 *  - 元数据：`{apiBase}/song/newget?songid=&songtype=bz`
 *  - 下载地址：`{apiBase}/song/getSongUrl?songid=&songtype=bz`
 *    （sq/hq/lq 三档 + 各自的 backup CDN；URL 带时间戳会过期）
 *
 * 两个和 httpIndex 明显不同、值得留意的点：
 *
 * 1. **search 拿不到下载地址**。search 接口只给元数据，下载地址要点歌时向
 *    getSongUrl 现取（URL 带过期时间戳，缓存下来再用迟早 403）。所以 search
 *    返回的 item.url 是空串，真正的地址只在 resolve 之后存在。点歌路由是
 *    resolve → 下载，这条链路上 url 一定已经填好。
 * 2. **下载地址每次 resolve 现取**。同一首歌唱两次会请求两次 getSongUrl ——
 *    这是故意的：宁可多一次请求，也不要给用户一个过期的链接。
 */

import {
  LIBRARY_CACHE_TTL_MS,
  LIBRARY_SEARCH_TIMEOUT_MS,
  FIVESING_SEARCH_BASE,
  FIVESING_API_BASE,
  FIVESING_WEB_BASE,
} from '../../config.ts';
import { createLogger } from '../../logger.ts';
import type { LibraryItem, LibraryProvider, LibraryQuery } from '../types.ts';

const log = createLogger('library');

/** 每页条数（5sing 接口不认 pageSize，固定 10） */
const PAGE_SIZE = 10;
/** resolve 用的元数据缓存上限； FIFO 淘汰，防长尾查询把内存吃满 */
const METADATA_CACHE_MAX = 1000;
/** 5sing 伴奏区 type=3（typeName='伴奏'）；其他 type 一概不要 */
const SONG_TYPE_BZ = 3;

export interface FiveSingProviderOptions {
  id?: string;
  label?: string;
  searchBaseUrl?: string;
  apiBaseUrl?: string;
  webBaseUrl?: string;
  /** 空关键词时浏览的热门伴奏页路径 */
  hotPath?: string;
  /** 元数据缓存时长（下载地址不缓存，每次 resolve 现取） */
  metadataTtlMs?: number;
  timeoutMs?: number;
  /** 一次搜索最多翻几页 */
  maxPages?: number;
}

interface FiveSingMeta {
  title: string;
  artist: string | null;
  sizeBytes: number | null;
  /** 写入缓存的时刻，超期后 resolve 会重新拉 newget */
  at: number;
}

interface SearchItem {
  songId?: unknown;
  songName?: unknown;
  singer?: unknown;
  nickName?: unknown;
  originSinger?: unknown;
  songSize?: unknown;
  type?: unknown;
  typeName?: unknown;
}

interface SearchResponse {
  list?: unknown;
  pageInfo?: unknown;
}

interface NewGetResponse {
  success?: unknown;
  code?: unknown;
  message?: unknown;
  data?: {
    SN?: unknown;
    SS?: unknown;
    user?: { NN?: unknown } | null;
  } | null;
}

interface SongUrlResponse {
  code?: unknown;
  message?: unknown;
  data?: {
    squrl?: unknown;
    squrl_backup?: unknown;
    hqurl?: unknown;
    hqurl_backup?: unknown;
    lqurl?: unknown;
    lqurl_backup?: unknown;
  } | null;
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

/** 剥离搜索结果里的 `<em class="keyword">` 高亮标签与 HTML 实体 */
export function stripHighlight(raw: string): string {
  return raw
    .replace(/<\/?em[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** 下载地址只信 http(s)：响应是外部数据，别把 file:// 之类引进来 */
function httpUrlOrNull(value: unknown): string | null {
  const text = asText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** 判断一条搜索结果是不是伴奏（type=3 或 typeName='伴奏'，双保险） */
function isAccompaniment(item: SearchItem): boolean {
  if (item.type === SONG_TYPE_BZ) return true;
  return asText(item.typeName) === '伴奏';
}

export class FiveSingProvider implements LibraryProvider {
  readonly id: string;

  private readonly labelOverride: string | undefined;
  private readonly searchBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly webBaseUrl: string;
  private readonly hotPath: string;
  private readonly metadataTtlMs: number;
  private readonly timeoutMs: number;
  private readonly maxPages: number;

  /** itemId → 元数据；search 时写入，resolve 时命中可少一次 newget 请求 */
  private readonly metadata = new Map<string, FiveSingMeta>();

  constructor(options: FiveSingProviderOptions = {}) {
    this.id = options.id ?? '5sing';
    this.labelOverride = options.label;
    this.searchBaseUrl = options.searchBaseUrl ?? FIVESING_SEARCH_BASE;
    this.apiBaseUrl = options.apiBaseUrl ?? FIVESING_API_BASE;
    this.webBaseUrl = options.webBaseUrl ?? FIVESING_WEB_BASE;
    this.hotPath = options.hotPath ?? '/bz/rmsong/more_1.shtml';
    this.metadataTtlMs = options.metadataTtlMs ?? LIBRARY_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? LIBRARY_SEARCH_TIMEOUT_MS;
    this.maxPages = options.maxPages ?? 6;
  }

  get label(): string {
    return this.labelOverride ?? '5sing 伴奏';
  }

  /* --------------------------------- 搜索 --------------------------------- */

  async search(query: LibraryQuery): Promise<LibraryItem[]> {
    // 5sing 伴奏区只有音频，没有 MV
    if (query.kind === 'video') return [];

    const keyword = query.q.trim();
    if (!keyword) return this.searchHot(query);

    const items: LibraryItem[] = [];
    const seen = new Set<string>();
    const startedAt = Date.now();

    for (let page = 1; page <= this.maxPages; page += 1) {
      // 已经攒够 / 明显到尾页 / 总耗时超预算 → 不再翻页。
      // 不把整个搜索吊死在第 5、6 页上：5sing 一页 ~130ms，但抽风时不是。
      if (items.length >= query.limit) break;
      if (page > 1 && Date.now() - startedAt > this.timeoutMs) break;

      let list: SearchItem[];
      try {
        list = await this.fetchSearchPage(keyword, page);
      } catch (error) {
        // 第一页就失败 = 这个源现在不可用，抛给 registry 降级；
        // 后面的页失败只是少几条结果，已有的照常用。
        if (page === 1) throw error;
        log.warn(`曲库源 ${this.id} 第 ${page} 页拉取失败，只用前 ${items.length} 条`, { error });
        break;
      }

      for (const raw of list) {
        const item = this.toItem(raw);
        if (!item || seen.has(item.itemId)) continue;
        seen.add(item.itemId);
        this.rememberSearchItem(item);
        items.push(item);
        if (items.length >= query.limit) break;
      }

      // 不足一页说明已经是最后一页
      if (list.length < PAGE_SIZE) break;
    }

    return items;
  }

  /** 空关键词：热门伴奏表格页（服务端渲染的 HTML，不需要任何登录态） */
  private async searchHot(query: LibraryQuery): Promise<LibraryItem[]> {
    const response = await fetch(`${this.webBaseUrl}${this.hotPath}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: 'text/html' },
    });
    if (!response.ok) {
      throw new Error(`热门伴奏页拉取失败（HTTP ${response.status}）`);
    }

    const html = await response.text();
    const rows = [...html.matchAll(/<a href="[^"]*\/bz\/(\d+)\.html"[^>]*>([^<]+)<\/a>/g)];
    const items: LibraryItem[] = [];
    const seen = new Set<string>();
    const titleById = new Map<string, string>();

    for (const [, rawId, rawName] of rows) {
      const songId = asText(rawId);
      const title = stripHighlight(rawName ?? '');
      if (!songId || !title) continue;
      if (!titleById.has(songId)) titleById.set(songId, title);
    }

    for (const [songId, title] of titleById) {
      if (seen.has(songId)) continue;
      seen.add(songId);
      const item: LibraryItem = {
        providerId: this.id,
        itemId: songId,
        title,
        artist: null,
        durationSec: null,
        kind: 'audio',
        // 下载地址 resolve 时现取；热门表格页里没有可靠的歌手列顺序
        url: '',
        lrcUrl: null,
        sizeBytes: null,
      };
      this.rememberSearchItem(item);
      items.push(item);
      if (items.length >= query.limit) break;
    }

    return items;
  }

  private async fetchSearchPage(keyword: string, page: number): Promise<SearchItem[]> {
    const url =
      `${this.searchBaseUrl}/home/json?keyword=${encodeURIComponent(keyword)}` +
      `&sort=1&page=${page}&filter=${SONG_TYPE_BZ}&type=0`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`5sing 搜索失败（HTTP ${response.status}）`);
    }

    const text = await response.text();
    if (!text.trim()) return [];
    let parsed: SearchResponse;
    try {
      parsed = JSON.parse(text) as SearchResponse;
    } catch {
      throw new Error('5sing 搜索返回的不是合法 JSON');
    }
    return Array.isArray(parsed.list) ? (parsed.list as SearchItem[]) : [];
  }

  /** 一条搜索结果 → LibraryItem；不是伴奏或缺关键字段就丢掉 */
  private toItem(raw: SearchItem): LibraryItem | null {
    if (!raw || typeof raw !== 'object') return null;
    if (!isAccompaniment(raw)) return null;

    const songId = asText(String(raw.songId ?? ''));
    const title = raw.songName === undefined ? null : stripHighlight(String(raw.songName));
    if (!songId || !title) return null;

    const artist = asText(raw.singer) ?? asText(raw.nickName) ?? asText(raw.originSinger);
    const sizeBytes = asNumber(raw.songSize);

    return {
      providerId: this.id,
      itemId: songId,
      title,
      artist,
      durationSec: null,
      kind: 'audio',
      url: '',
      lrcUrl: null,
      sizeBytes: sizeBytes && sizeBytes > 0 ? sizeBytes : null,
    };
  }

  /* -------------------------------- resolve -------------------------------- */

  async resolve(itemId: string): Promise<LibraryItem | undefined> {
    // itemId 就是 5sing 的 songId：非纯数字的一律不认识
    if (!/^\d+$/.test(itemId)) return undefined;

    const meta = await this.resolveMeta(itemId);
    const { url, backupUrl } = await this.resolveUrl(itemId);
    if (!url) return undefined;

    return {
      providerId: this.id,
      itemId,
      title: meta?.title ?? `5sing_${itemId}`,
      artist: meta?.artist ?? null,
      durationSec: null,
      kind: 'audio',
      url,
      backupUrl,
      lrcUrl: null,
      sizeBytes: meta?.sizeBytes ?? null,
    };
  }

  /** 元数据：先缓存后 newget。缓存超期或没有才请求网络。 */
  private async resolveMeta(itemId: string): Promise<FiveSingMeta | null> {
    const cached = this.metadata.get(itemId);
    if (cached && Date.now() - cached.at < this.metadataTtlMs) return cached;

    try {
      const response = await fetch(
        `${this.apiBaseUrl}/song/newget?songid=${itemId}&songtype=bz`,
        { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: 'application/json' } },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const parsed = (await response.json()) as NewGetResponse;
      const data = parsed.data;
      if (!parsed.success || !data) throw new Error(asText(parsed.message) ?? 'empty');

      const title = asText(String(data.SN ?? ''));
      const meta: FiveSingMeta | null = title
        ? {
            title,
            artist: asText(data.user?.NN) ?? null,
            sizeBytes: asNumber(data.SS),
            at: Date.now(),
          }
        : null;

      if (meta) this.rememberMeta(itemId, meta);
      return meta;
    } catch (error) {
      // 拿不到元数据不致命：resolveUrl 才是点歌的必要条件，
      // 歌名兜底成 5sing_<id>（缓存里通常还有 search 时留下的标题）。
      log.warn(`曲库源 ${this.id} 元数据拉取失败（songId=${itemId}）`, { error });
      return null;
    }
  }

  private rememberMeta(itemId: string, meta: FiveSingMeta): void {
    // 先删再设：Map 保持插入顺序，这样淘汰的就是最老的那条
    this.metadata.delete(itemId);
    this.metadata.set(itemId, meta);
    while (this.metadata.size > METADATA_CACHE_MAX) {
      const oldest = this.metadata.keys().next();
      if (oldest.done) break;
      this.metadata.delete(oldest.value);
    }
  }

  /** 下载地址：sq → hq → lq 第一个非空，backup 取同档的备用 CDN */
  private async resolveUrl(
    itemId: string,
  ): Promise<{ url: string | null; backupUrl: string | null }> {
    const response = await fetch(
      `${this.apiBaseUrl}/song/getSongUrl?songid=${itemId}&songtype=bz`,
      { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: 'application/json' } },
    );
    if (!response.ok) {
      throw new Error(`5sing 下载地址获取失败（HTTP ${response.status}）`);
    }

    const parsed = (await response.json()) as SongUrlResponse;
    if (parsed.code !== 1000 || !parsed.data) {
      throw new Error(`5sing 返回：${asText(parsed.message) ?? `code ${String(parsed.code)}`}`);
    }

    const tiers: [string | null, string | null][] = [
      [httpUrlOrNull(parsed.data.squrl), httpUrlOrNull(parsed.data.squrl_backup)],
      [httpUrlOrNull(parsed.data.hqurl), httpUrlOrNull(parsed.data.hqurl_backup)],
      [httpUrlOrNull(parsed.data.lqurl), httpUrlOrNull(parsed.data.lqurl_backup)],
    ];

    for (const [primary, backup] of tiers) {
      if (primary) return { url: primary, backupUrl: backup };
    }
    return { url: null, backupUrl: null };
  }

  /** search 命中的条目顺手进元数据缓存，resolve 时可少一次 newget 请求 */
  rememberSearchItem(item: LibraryItem): void {
    if (!item.title) return;
    this.rememberMeta(item.itemId, {
      title: item.title,
      artist: item.artist,
      sizeBytes: item.sizeBytes,
      at: Date.now(),
    });
  }

  /** 测试用：丢掉元数据缓存 */
  clearMetadataCache(): void {
    this.metadata.clear();
  }
}
