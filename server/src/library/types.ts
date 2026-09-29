/**
 * 曲库 provider 抽象。
 *
 * 为什么要有这一层：网上**没有**免费公开的「伴奏搜索」API。现实中可用的源
 * （自建 HTTP 清单、商业在线 KTV 曲库、某个具体站点的抓取）在鉴权方式、
 * 协议格式、稳定性上差别极大，而且随时可能失效。
 *
 * 把差异全部关进 provider，搜索聚合 / 下载 / 入库 / 去重这些公共逻辑就
 * 只写一遍 —— 以后要接 ZEGO 之类的正式曲库，或者给某个站点写适配器，
 * 都是新增一个 provider 文件，不用动架构。
 */

import type {
  LibraryItemDto,
  LibraryItemKind,
  LibrarySearchResult,
  LibrarySourceStatus,
} from '../../../shared/types.ts';

/** 下发给前端的契约类型统一放在 shared/types.ts，前后端共用一份 */
export type { LibraryItemDto, LibraryItemKind, LibrarySearchResult, LibrarySourceStatus };

/** 曲库里的一个条目（服务端内部形态，带下载地址） */
export interface LibraryItem {
  providerId: string;
  /** provider 内唯一。与 providerId 合成 library_ref 做去重 */
  itemId: string;
  title: string;
  artist: string | null;
  durationSec: number | null;
  kind: LibraryItemKind;
  /** 源站给的下载地址（已绝对化）。只在服务端流转，不下发给浏览器 */
  url: string;
  /** 可选的 LRC 歌词地址（已绝对化）；有就随伴奏一起入库 */
  lrcUrl: string | null;
  sizeBytes: number | null;
}

export interface LibraryQuery {
  /** 关键词；空串 = 列出全部（受 limit 限制） */
  q: string;
  kind: LibraryItemKind | null;
  limit: number;
  signal: AbortSignal;
}

/** 每个源的搜索状态由 shared 定义（前端要渲染它）；这里只是转发 */
export interface LibraryProvider {
  id: string;
  label: string;
  /**
   * 搜索。
   * 抛错 = 这个源当前不可用 —— registry 会把它降级成一条状态提示，
   * 不影响其他源的结果。
   */
  search(query: LibraryQuery): Promise<LibraryItem[]>;
  /**
   * 按 itemId 取回条目（含下载地址）；找不到返回 undefined。
   *
   * 不收 AbortSignal：实现通常是查一份已缓存的清单（纯内存），
   * 不适合让某个客户端的断连影响共享缓存。
   */
  resolve(itemId: string): Promise<LibraryItem | undefined>;
}

/** 把 item 转成可下发前端的形态 */
export function toLibraryItemDto(item: LibraryItem): LibraryItemDto {
  return {
    providerId: item.providerId,
    itemId: item.itemId,
    title: item.title,
    artist: item.artist,
    durationSec: item.durationSec,
    kind: item.kind,
    sizeBytes: item.sizeBytes,
    hasLyrics: Boolean(item.lrcUrl),
  };
}

/** 曲库去重键：与 tracks.library_ref 同构 */
export function libraryRef(providerId: string, itemId: string): string {
  return `${providerId}:${itemId}`;
}
