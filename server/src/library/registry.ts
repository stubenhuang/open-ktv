/**
 * 曲库源注册表：把配置解析成 provider 列表，并负责「多源并发搜索 + 聚合」。
 *
 * 关键行为：**单个源失败不影响其他源**。用 Promise.all 会很脆 ——
 * 一个源超时就让整个搜索报错。所以每个源各自 try/catch，失败降级成
 * 一条 sources 状态，前端可以逐源提示「某某源当前不可用」。
 */

import { LIBRARY_SEARCH_TIMEOUT_MS } from '../config.ts';
import { createLogger } from '../logger.ts';
import { HttpIndexProvider } from './providers/httpIndex.ts';
import {
  libraryRef,
  toLibraryItemDto,
  type LibraryItem,
  type LibraryItemDto,
  type LibraryItemKind,
  type LibraryProvider,
  type LibrarySearchResult,
  type LibrarySourceStatus,
} from './types.ts';

const log = createLogger('library');

/**
 * 解析一条源配置：`名字=清单URL` 或裸 URL。
 *
 * 不能简单地按第一个 `=` 切 —— URL 的查询串里也可能有 `=`。
 * 只有「`=` 左边不含 `/` 和 `:`」且「右边是个 http(s) URL」时才认定它是名字。
 */
export function parseSourceSpec(spec: string): { name?: string; url: string } {
  const trimmed = spec.trim();
  const eq = trimmed.indexOf('=');
  if (eq > 0) {
    const maybeName = trimmed.slice(0, eq).trim();
    const rest = trimmed.slice(eq + 1).trim();
    if (maybeName && !/[/:]/.test(maybeName) && /^https?:\/\//i.test(rest)) {
      return { name: maybeName, url: rest };
    }
  }
  return { url: trimmed };
}

export class LibraryRegistry {
  private readonly providerList: LibraryProvider[];

  constructor(providers: LibraryProvider[]) {
    this.providerList = providers;
  }

  get providers(): readonly LibraryProvider[] {
    return this.providerList;
  }

  get isEmpty(): boolean {
    return this.providerList.length === 0;
  }

  find(providerId: string): LibraryProvider | undefined {
    return this.providerList.find((provider) => provider.id === providerId);
  }

  /**
   * 并发搜所有源并聚合。
   *
   * 结果按「轮流取」交错排列而不是把第一个源排在最前 —— 配了多个源时，
   * 首个源不该把 limit 全占满。命中上限即停，多余的不再取。
   */
  async searchAll(input: {
    q: string;
    kind: LibraryItemKind | null;
    limit: number;
  }): Promise<LibrarySearchResult> {
    const perSource = await Promise.all(
      this.providerList.map(async (provider) => {
        try {
          const items = await provider.search({
            q: input.q,
            kind: input.kind,
            limit: input.limit,
            signal: AbortSignal.timeout(LIBRARY_SEARCH_TIMEOUT_MS),
          });
          return { provider, items, error: null as string | null };
        } catch (error) {
          const message = error instanceof Error ? error.message : '未知错误';
          log.warn(`曲库源 ${provider.id} 搜索失败`, { error });
          return { provider, items: [] as LibraryItem[], error: message };
        }
      }),
    );

    const sources: LibrarySourceStatus[] = perSource.map((result) => ({
      id: result.provider.id,
      label: result.provider.label,
      ok: result.error === null,
      count: result.items.length,
      error: result.error,
    }));

    const seen = new Set<string>();
    const items: LibraryItemDto[] = [];

    // 交错：第 1 轮取每个源的第 1 条，第 2 轮取第 2 条……
    const maxPerSource = Math.max(0, ...perSource.map((result) => result.items.length));
    for (let index = 0; index < maxPerSource && items.length < input.limit; index += 1) {
      for (const result of perSource) {
        if (items.length >= input.limit) break;
        const item = result.items[index];
        if (!item) continue;
        const ref = libraryRef(item.providerId, item.itemId);
        if (seen.has(ref)) continue;
        seen.add(ref);
        items.push(toLibraryItemDto(item));
      }
    }

    return { items, sources };
  }
}

/**
 * 从配置构建注册表。
 *
 * 配置有问题的项只记 warn 并跳过 —— 一个写错的源不该让服务起不来，
 * 其余源照常可用。
 */
export function createRegistry(specs: readonly string[]): LibraryRegistry {
  const providers: LibraryProvider[] = [];
  const seenManifest = new Set<string>();

  for (const spec of specs) {
    const { name, url } = parseSourceSpec(spec);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      log.warn(`曲库源地址无效，已忽略：${spec}`);
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      log.warn(`曲库源只支持 http/https，已忽略：${spec}`);
      continue;
    }
    if (seenManifest.has(parsed.toString())) {
      log.warn(`曲库源重复，已忽略：${spec}`);
      continue;
    }
    seenManifest.add(parsed.toString());

    // provider id 直接用清单地址：它是这个源的稳定身份。
    // 不能用「配置里的第几项」当 id —— 用户调整顺序会让已点过的歌被当成新条目重复入库。
    providers.push(
      new HttpIndexProvider({
        id: `http-index:${parsed.toString()}`,
        manifestUrl: parsed.toString(),
        label: name,
      }),
    );
  }

  if (providers.length > 0) {
    log.info(`曲库源已加载 ${providers.length} 个`, { ids: providers.map((p) => p.id) });
  }

  return new LibraryRegistry(providers);
}
