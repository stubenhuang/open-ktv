/**
 * 酷狗歌词源（默认歌词实现）。
 *
 * 三步流（全部实测可用，2026-10）：
 *  1. 搜歌：GET {songSearchBase}/api/v3/search/song?format=json&keyword=&page=1&pagesize=N
 *     → data.info[]：hash / songname / singername / duration(秒)
 *  2. 歌词候选：GET {lyricsBase}/search?ver=1&man=yes&client=pc&keyword=&duration=&hash=
 *     → candidates[]：id / accesskey / song / singer / score / duration(毫秒)
 *  3. 下载：GET {lyricsBase}/download?ver=1&client=pc&id=&accesskey=&fmt=lrc&charset=utf8
 *     → {status, content: base64(LRC)}；accesskey 失效时 status=403
 *
 * 为什么按「hash → 候选」而不是「keyword 直接搜歌词」：keyword 模式返回的
 * song/singer 字段是空的（实测都等于 keyword 本身），没法用来挑版本；先搜歌
 * 能拿到准确的 hash，候选里还带 score 与 duration，是挑对原唱版本的关键。
 *
 * 版本匹配策略（错歌词比没歌词更糟）：
 *  - 歌名清洗后搜一轮；没有达标候选就带歌手/原始词再搜一轮；
 *  - 每个 hash 的候选过 scoreLyricCandidate，第一个出现达标候选的 hash 就定下来；
 *  - 所有尝试都失败 → 返回 null（调用方照常入库，只是没歌词）。
 */

import {
  KUGOU_LYRICS_TIMEOUT_MS,
  KUGOU_SONG_SEARCH_BASE,
  KUGOU_LYRICS_BASE,
} from '../../config.ts';
import { hasLrcTimeline, normalizeLrc } from '../../../../shared/lrc.ts';
import { createLogger } from '../../logger.ts';
import {
  cleanSongTitle,
  pickBestCandidate,
  scoreLyricCandidate,
} from './songTitle.ts';
import type { LyricsLookup, LyricsQuery } from './types.ts';

const log = createLogger('library');

/** 一次搜歌取几个候选 hash（按搜索排序取前几个依次试） */
const HASH_CANDIDATES = 3;
/** 每轮搜歌取几首 */
const SONG_PAGE_SIZE = 8;

export interface KugouLyricsOptions {
  songSearchBaseUrl?: string;
  lyricsBaseUrl?: string;
  timeoutMs?: number;
}

interface SongInfo {
  hash?: unknown;
  songname?: unknown;
  singername?: unknown;
  duration?: unknown;
}

interface SongSearchResponse {
  data?: { info?: unknown } | null;
}

interface LyricCandidate {
  id: string;
  accesskey: string;
  song: string | null;
  singer: string | null;
  durationMs: number | null;
}

interface LyricSearchResponse {
  status?: unknown;
  candidates?: unknown;
}

interface LyricDownloadResponse {
  status?: unknown;
  content?: unknown;
  info?: unknown;
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

/** base64 → utf8 文本；内容不是 base64（极少数站点返回明文）时退回原文 */
function decodeLyricContent(content: string): string {
  try {
    return Buffer.from(content, 'base64').toString('utf8');
  } catch {
    return content;
  }
}

export function createKugouLyrics(options: KugouLyricsOptions = {}): LyricsLookup {
  const songSearchBaseUrl = options.songSearchBaseUrl ?? KUGOU_SONG_SEARCH_BASE;
  const lyricsBaseUrl = options.lyricsBaseUrl ?? KUGOU_LYRICS_BASE;
  const timeoutMs = options.timeoutMs ?? KUGOU_LYRICS_TIMEOUT_MS;

  async function searchSongs(keyword: string): Promise<SongInfo[]> {
    const url =
      `${songSearchBaseUrl}/api/v3/search/song?format=json` +
      `&keyword=${encodeURIComponent(keyword)}&page=1&pagesize=${SONG_PAGE_SIZE}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`酷狗搜歌失败（HTTP ${response.status}）`);

    const parsed = (await response.json()) as SongSearchResponse;
    const info = parsed.data?.info;
    return Array.isArray(info) ? (info as SongInfo[]) : [];
  }

  async function searchCandidates(hash: string): Promise<LyricCandidate[]> {
    const url =
      `${lyricsBaseUrl}/search?ver=1&man=yes&client=pc` +
      `&keyword=&duration=&hash=${encodeURIComponent(hash)}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`酷狗歌词查询失败（HTTP ${response.status}）`);

    const parsed = (await response.json()) as LyricSearchResponse;
    const list = parsed.candidates;
    if (!Array.isArray(list)) return [];

    const candidates: LyricCandidate[] = [];
    for (const raw of list as Record<string, unknown>[]) {
      const id = asText(raw?.id);
      const accesskey = asText(raw?.accesskey);
      if (!id || !accesskey) continue;
      candidates.push({
        id,
        accesskey,
        song: asText(raw?.song),
        singer: asText(raw?.singer),
        // 候选时长单位是毫秒
        durationMs: asNumber(raw?.duration),
      });
    }
    return candidates;
  }

  async function downloadLrc(candidate: LyricCandidate): Promise<string | null> {
    const url =
      `${lyricsBaseUrl}/download?ver=1&client=pc` +
      `&id=${encodeURIComponent(candidate.id)}` +
      `&accesskey=${encodeURIComponent(candidate.accesskey)}&fmt=lrc&charset=utf8`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`酷狗歌词下载失败（HTTP ${response.status}）`);

    const parsed = (await response.json()) as LyricDownloadResponse;
    if (parsed.status !== 200) {
      throw new Error(`酷狗歌词下载被拒：${asText(parsed.info) ?? String(parsed.status)}`);
    }
    const content = asText(parsed.content);
    if (!content) return null;
    return decodeLyricContent(content);
  }

  /**
   * 搜索词序列：先整条清洗结果（「周杰伦 告白气球」）；不达标再按分隔符拆出的
   * 单段各试一次（上传者有时把原唱写在前面，歌名单独搜反而更准）。
   * 去重后最多 3 个，命中即止。
   */
  function buildQueries(query: LyricsQuery): string[] {
    const clean = cleanSongTitle(query.title);
    const queries = [clean];

    const segments = clean
      .split(/[-–—_·|/\\\s]+/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length >= 2 && segment !== clean);

    for (const segment of segments) {
      if (queries.length >= 3) break;
      if (!queries.includes(segment)) queries.push(segment);
    }
    return queries;
  }

  async function find(query: LyricsQuery, _options?: { signal?: AbortSignal }): Promise<string | null> {
    const title = query.title.trim();
    if (!title) return null;

    const cleanTitle = cleanSongTitle(title);
    if (!cleanTitle) return null;

    const scoreInput = {
      rawTitle: title,
      cleanTitle,
      artist: query.artist ?? null,
      durationSec: query.durationSec ?? null,
    };

    try {
      for (const keyword of buildQueries(query)) {
        const songs = await searchSongs(keyword);

        for (const song of songs.slice(0, HASH_CANDIDATES)) {
          const hash = asText(song?.hash);
          if (!hash) continue;

          const candidates = await searchCandidates(hash);
          const best = pickBestCandidate(scoreInput, candidates);
          if (!best) continue;

          const raw = await downloadLrc(best);
          if (!raw) continue;

          const normalized = normalizeLrc(raw);
          // 纯文本歌词（无时间轴）跟唱用不了，按缺失处理
          if (!hasLrcTimeline(normalized)) continue;

          log.debug('酷狗歌词匹配成功', {
            song: best.song,
            singer: best.singer,
            score: scoreLyricCandidate(scoreInput, best),
            keyword,
          });
          return normalized;
        }
      }
      return null;
    } catch (error) {
      // 歌词是附赠功能：任何失败都只让这首没歌词，不往外抛
      log.warn('酷狗歌词匹配失败，这首将不带歌词', { title, error });
      return null;
    }
  }

  return { find };
}

/** 打分函数导出给测试用（实现内部也只走这一份） */
export { scoreLyricCandidate };
