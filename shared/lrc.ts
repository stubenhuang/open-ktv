/**
 * LRC 歌词解析与时间轴定位（纯函数，无 IO、无浏览器/Node 依赖）。
 *
 * 前后端共用同一份实现：服务端只用 parseLrc/normalizeLrc 做入库校验与规范化，
 * 客户端用 parseLrc + findActiveLineIndex 做跟唱滚动。两边一旦分叉，
 * 「服务端说合法、前端显示不出来」这种问题就会冒出来。
 *
 * 时间戳支持的写法（LRC 在野外的写法很杂，这里都认）：
 *   [mm:ss]        [00:12]
 *   [mm:ss.xx]     [00:12.34]     小数 2 位按「厘秒」解释
 *   [mm:ss.xxx]    [00:12.345]    小数 3 位按「毫秒」解释
 *   [mm:ss:xx]     [00:12:34]     用冒号当小数分隔符（部分老工具的输出）
 *   [m:ss.xx]      [0:12.34]      分钟不补零
 * 一行可以挂多个时间戳（副歌复用）：
 *   [00:12.00][01:20.00]同一句歌词
 *
 * 小数位数与单位的对应关系（不足 3 位按位数补足）：
 *   1 位 → 每位 100ms（"5" = 500ms）
 *   2 位 → 每位 10ms（"50" = 500ms）
 *   3 位 → 每位 1ms（"500" = 500ms）
 */

/** 一行歌词 */
export interface LrcLine {
  /** 行起始时间（毫秒，相对伴奏时间轴 0 点） */
  timeMs: number;
  /**
   * 该行文本。允许空串 —— LRC 常用「带时间戳的空行」当清屏/间奏标记，
   * 丢掉它会让间奏期间一直挂着上一句歌词。
   */
  text: string;
}

export interface LrcDocument {
  /** 已按时间升序、同刻去重 */
  lines: LrcLine[];
  /**
   * `[offset:]` 标签的原值（毫秒）。
   * 按 LRC 惯例：**正值表示歌词应更早显示**（抵消「歌词比音频慢」的情况）。
   * 与用户手调的 userOffsetMs（正值 = 歌词更晚）方向相反，见 lrcDisplayTimeMs。
   */
  offsetMs: number;
  title: string | null;
  artist: string | null;
  album: string | null;
}

/** 空文档：没有歌词时的统一返回，避免调用方到处判 null */
export const EMPTY_LRC: LrcDocument = {
  lines: [],
  offsetMs: 0,
  title: null,
  artist: null,
  album: null,
};

/**
 * 时间戳正则的源码。
 * 每次用都新建 RegExp —— 全局正则带 lastIndex 状态，
 * 复用同一个实例会在 matchAll / replace 交替时踩到脏状态。
 */
const TIME_TAG_SOURCE = String.raw`\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]`;

/** 整行就是单个元数据标签：[ti:歌名] / [offset:+500] */
const META_LINE = /^\s*\[([a-zA-Z]+):([^\]]*)\]\s*$/;

function timeTag(): RegExp {
  return new RegExp(TIME_TAG_SOURCE, 'g');
}

/** 分:秒[.小数] → 毫秒；秒数 ≥ 60 或解析不出数字时返回 null（那不是时间戳） */
function parseTimestamp(minutesText: string, secondsText: string, fractionText?: string): number | null {
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  if (seconds >= 60) return null;

  let fractionMs = 0;
  if (fractionText !== undefined && fractionText !== '') {
    const digits = Math.min(fractionText.length, 3);
    const value = Number(fractionText.slice(0, 3));
    if (!Number.isFinite(value)) return null;
    fractionMs = value * Math.pow(10, 3 - digits);
  }

  return Math.round(minutes * 60_000 + seconds * 1000 + fractionMs);
}

function parseOffsetTag(value: string): number | null {
  const parsed = Number(value.replace(/^\+/, ''));
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

/**
 * 解析 LRC 文本。
 *
 * 宽容但不瞎猜：认不出的行（纯文本、非法标签）直接跳过，
 * 秒数 ≥ 60 的伪时间戳也不当时间戳。返回的 lines 一定按时间升序。
 */
export function parseLrc(text: string): LrcDocument {
  if (!text) return { ...EMPTY_LRC, lines: [] };

  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const collected: LrcLine[] = [];
  let offsetMs = 0;
  let title: string | null = null;
  let artist: string | null = null;
  let album: string | null = null;

  for (const rawLine of normalized.split('\n')) {
    const meta = rawLine.match(META_LINE);
    if (meta) {
      const key = meta[1]!.toLowerCase();
      const value = meta[2]!.trim();
      if (key === 'offset') {
        const parsed = parseOffsetTag(value);
        if (parsed !== null) offsetMs = parsed;
      } else if (key === 'ti') {
        title = value || null;
      } else if (key === 'ar') {
        artist = value || null;
      } else if (key === 'al') {
        album = value || null;
      }
      // [by:] [ve:] [length:] 之类不影响播放，忽略
      continue;
    }

    const stamps = [...rawLine.matchAll(timeTag())];
    if (stamps.length === 0) continue;

    // 去掉所有时间戳后剩下的就是歌词正文
    const lineText = rawLine.replace(timeTag(), '').trim();
    for (const stamp of stamps) {
      const timeMs = parseTimestamp(stamp[1]!, stamp[2]!, stamp[3]);
      if (timeMs === null) continue;
      collected.push({ timeMs, text: lineText });
    }
  }

  collected.sort((a, b) => a.timeMs - b.timeMs);

  // 同一时刻的多行（多见于重复的副歌时间戳被写重）：保留后出现的那条
  const lines: LrcLine[] = [];
  for (const line of collected) {
    const last = lines[lines.length - 1];
    if (last && last.timeMs === line.timeMs) {
      lines[lines.length - 1] = line;
    } else {
      lines.push(line);
    }
  }

  return { lines, offsetMs, title, artist, album };
}

/** 毫秒 → `[mm:ss.xx]` 里的 `mm:ss.xx` */
export function formatLrcTimestamp(ms: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const centiseconds = Math.floor((total % 1000) / 10);
  return [
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':') + `.${String(centiseconds).padStart(2, '0')}`;
}

/**
 * 规范化成一份稳定的 LRC 文本用于落库。
 *
 * 目的不是「美化」，而是让库里存的形态唯一：剥掉无法识别的行与标签、
 * 时间戳统一成 `[mm:ss.xx]`、按时间排序、同刻去重。
 * 这样「同一份歌词贴两次」得到完全相同的字符串，diff 与去重才靠得住。
 */
export function normalizeLrc(text: string): string {
  const doc = parseLrc(text);
  const parts: string[] = [];
  if (doc.title) parts.push(`[ti:${doc.title}]`);
  if (doc.artist) parts.push(`[ar:${doc.artist}]`);
  if (doc.album) parts.push(`[al:${doc.album}]`);
  if (doc.offsetMs !== 0) parts.push(`[offset:${doc.offsetMs}]`);
  for (const line of doc.lines) {
    parts.push(`[${formatLrcTimestamp(line.timeMs)}]${line.text}`);
  }
  return parts.join('\n');
}

/** 歌词里至少有一行带时间戳才算可用（纯文本歌词不参与跟唱与定位） */
export function hasLrcTimeline(text: string | null | undefined): boolean {
  if (!text) return false;
  return parseLrc(text).lines.length > 0;
}

/**
 * 二分查找当前应高亮的行下标。
 *
 * 返回最后一条 timeMs ≤ timeMs 的行；时间早于第一行时返回 −1
 * （还没进第一句，应该没有高亮行）。
 */
export function findActiveLineIndex(lines: readonly LrcLine[], timeMs: number): number {
  if (lines.length === 0) return -1;
  const target = Number.isFinite(timeMs) ? timeMs : 0;

  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid]!.timeMs <= target) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * 某行歌词在**伴奏时间轴**上应该被高亮的时刻（毫秒）。
 *
 *     显示时刻 = 行时间 − [offset:] 标签 + 用户微调
 *
 * `[offset:]` 正值 = 歌词更早显示，`userOffsetMs` 正值 = 歌词更晚显示 ——
 * 方向相反是 LRC 惯例与我们的滑块语义各自决定的，这里显式写死并测试。
 */
export function lrcDisplayTimeMs(
  lineTimeMs: number,
  lrcOffsetMs: number,
  userOffsetMs: number,
): number {
  const line = Number.isFinite(lineTimeMs) ? lineTimeMs : 0;
  const tag = Number.isFinite(lrcOffsetMs) ? lrcOffsetMs : 0;
  const user = Number.isFinite(userOffsetMs) ? userOffsetMs : 0;
  return line - tag + user;
}

/**
 * 把**伴奏时间**换算到**歌词时间轴**上的位置，供 findActiveLineIndex 使用。
 *
 * 它是 lrcDisplayTimeMs 的逆运算：要选出满足
 * `lrcDisplayTimeMs(line) ≤ 伴奏时间` 的那一行，等价于在歌词时间轴上
 * 查找 `伴奏时间 + offset标签 − 用户微调`。
 * 两个函数共用同一套符号，改动其中一个必须同步另一个（有单测互相锁定）。
 */
export function lyricClockMs(
  audioTimeMs: number,
  lrcOffsetMs: number,
  userOffsetMs: number,
): number {
  const audio = Number.isFinite(audioTimeMs) ? audioTimeMs : 0;
  const tag = Number.isFinite(lrcOffsetMs) ? lrcOffsetMs : 0;
  const user = Number.isFinite(userOffsetMs) ? userOffsetMs : 0;
  return audio + tag - user;
}

/**
 * 最后一句歌词的兜底时长（ms）。
 * LRC 的末行没有「下一行」可借时长，只能拿媒体时长；两者都拿不到时按这么久算唱完。
 */
export const LAST_LINE_FALLBACK_MS = 4000;

/**
 * 第 index 行在**伴奏时间轴**上的起止时刻（ms），供逐字填充用。
 *
 *     startMs = lrcDisplayTimeMs(本行)
 *     endMs   = lrcDisplayTimeMs(下一行)   // 末行没有下一行，借 fallbackEndMs
 *
 * 必须走 lrcDisplayTimeMs 而不是自己再算一遍 `line − tag + user` ——
 * 高亮、seek、这里三方共用同一套符号，分叉就会出现「字亮完了行还没高亮」。
 *
 * fallbackEndMs 传媒体时长（`mediaEl.duration × 1000`，0/NaN = 不知道）；
 * 拿不到或比本行还早时按 LAST_LINE_FALLBACK_MS 兜底。
 */
export function lyricLineWindowMs(
  lines: readonly LrcLine[],
  index: number,
  lrcOffsetMs: number,
  userOffsetMs: number,
  fallbackEndMs: number,
): { startMs: number; endMs: number } {
  const line = lines[index];
  const startMs = line ? lrcDisplayTimeMs(line.timeMs, lrcOffsetMs, userOffsetMs) : 0;
  const next = lines[index + 1];
  const fallback =
    Number.isFinite(fallbackEndMs) && fallbackEndMs > startMs
      ? fallbackEndMs
      : startMs + LAST_LINE_FALLBACK_MS;
  const endMs = next ? lrcDisplayTimeMs(next.timeMs, lrcOffsetMs, userOffsetMs) : fallback;
  return { startMs, endMs };
}

/**
 * 某行歌词的行内进度（0–1）：唱到这句的百分之多少。
 *
 * clockMs 是**伴奏时间轴**上的时刻（和 startMs/endMs 同一套空间，
 * 调用方传 `mediaEl.currentTime × 1000`）。
 * 窗口长度 ≤ 0（同一刻的多行）时「行一旦开始就当唱完」——
 * 否则会除出 Infinity/NaN，字会全灭或全亮；起点本身是脏数据时返回 0（不亮）。
 */
export function lyricLineProgress(clockMs: number, startMs: number, endMs: number): number {
  const clock = Number.isFinite(clockMs) ? clockMs : 0;
  if (!Number.isFinite(startMs)) return 0;
  const start = startMs;
  const end = Number.isFinite(endMs) ? endMs : start;
  const span = end - start;
  if (span <= 0) return clock >= start ? 1 : 0;
  if (clock <= start) return 0;
  if (clock >= end) return 1;
  return (clock - start) / span;
}

/**
 * 进度 → 点亮字数（0–charCount，向下取整）：逐字翻亮，同一帧内不出现半亮半灭的中间态。
 * charCount ≤ 0（间奏空行）或进度脏数据时返回 0，绝不给 NaN。
 */
export function lyricCharLitCount(progress: number, charCount: number): number {
  if (!Number.isFinite(charCount) || charCount <= 0) return 0;
  const value = Number.isFinite(progress) ? progress : 0;
  return Math.max(0, Math.min(charCount, Math.floor(value * charCount)));
}
