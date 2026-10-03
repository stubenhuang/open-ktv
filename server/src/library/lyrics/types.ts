/**
 * 歌词源抽象。
 *
 * 为什么单独一层：网上没有稳定免费的「LRC 歌词」API，各站（酷狗、网易云、
 * 将来的木兰词…）在鉴权、协议、匹配方式上差别极大。把差异关进 LyricsLookup，
 * 「点歌时补齐歌词」「给已有伴奏补歌词」这些公共逻辑就只写一遍。
 *
 * 关键约定：**best-effort**。找不到、源站挂掉、匹配分不够 —— 一律返回 null，
 * 调用方照常入库/照常返回，绝不让歌词挡住伴奏。歌词是锦上添花。
 */

export interface LyricsQuery {
  /** 伴奏歌名（允许脏，比如「周杰伦 - 告白气球 - 原版伴奏」） */
  title: string;
  /** 歌手；5sing 伴奏的 artist 是上传者，可能和原唱无关，只作辅助信号 */
  artist: string | null;
  /** 伴奏真实时长（秒）。有时长就能用来挑对版本；没有就只按名字/歌手挑 */
  durationSec?: number | null;
}

export interface LyricsLookup {
  /** 找带时间轴的 LRC（已 normalize）。找不到或任何失败都解析成 null */
  find(query: LyricsQuery, options?: { signal?: AbortSignal }): Promise<string | null>;
}
