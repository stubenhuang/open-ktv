/**
 * 歌名清洗与歌词候选打分（纯函数，无 IO）。
 *
 * 存在的理由：5sing 的歌名是上传者自由发挥的字段，噪声极大 ——
 * 「周杰伦 - 告白气球 - 原版伴奏」「祝福祖国【bE】伴奏 合唱版」「偏偏喜欢你　消音伴奏」。
 * 拿这种字符串直接搜歌词源，要么搜不到，要么搜到错的版本（翻唱版时间轴对不上）。
 *
 * 两步走：
 *  1. `cleanSongTitle` 去掉伴奏/版本噪声，留下可搜索的歌名；
 *  2. `scoreLyricCandidate` 用「标题 + 歌手是否出现在原始标题 + 时长」给候选打分，
 *     低于阈值宁可不返回 —— 错歌词比没歌词更糟（跟唱全程错位）。
 */

/** 伴奏/版本噪声词：出现在歌名里对「找歌」没有任何帮助 */
const NOISE_WORDS = [
  '纯伴奏',
  '原版伴奏',
  '伴奏版',
  '伴奏',
  '消音伴奏',
  '消音',
  '和声伴奏',
  '无人声',
  '无人声版',
  '完整版',
  '合唱版',
  'KTV',
  'ktv',
  'Live',
  'live',
  'LIVE',
  'DJ',
  'dj',
  '舞曲',
  '剪辑',
  '试听',
  '高清',
  '无损',
];

/** 调性/版本标记：歌名里的方头/半角括号，如【bE】[原版](C Low)… */
const BRACKET_GROUP = /[【\[\(（]([^】\]）\)]*)[】\]）\)]/g;

/** 各种「歌手 - 歌名」分隔符 */
const SEPARATORS = /[-–—_·•|/\\]+|\s{2,}|　+/g;

/** 归一化：小写、只留中英文与数字。用于互相包含/相等的比较 */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^\p{Script=Han}\p{L}\p{N}]+/gu, '');
}

/** 括号内容是否该整组删掉：带噪声词，或是「调性/版本代码」这类短拉丁标记 */
function bracketGroupIsNoise(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  if (NOISE_WORDS.some((word) => trimmed.includes(word))) return true;
  // 【bE】、(Own)、(C Low)、(3D)：没有中文且很短，都是版本/调性标记
  return !/\p{Script=Han}/u.test(trimmed) && trimmed.length <= 6;
}

/**
 * 清洗歌名。例：
 *  - 「周杰伦 - 告白气球 - 原版伴奏」→「周杰伦 告白气球」
 *  -「祝福祖国【bE】伴奏 合唱版」→「祝福祖国」
 *  -「偏偏喜欢你　消音伴奏」→「偏偏喜欢你」
 *  -「一路向北 (官方伴奏)」→「一路向北」（括号里带「伴奏」→ 整组删）
 *  -「晴天」→「晴天」（没有噪声时原样返回，不乱切）
 */
export function cleanSongTitle(raw: string): string {
  let text = raw.replace(/<\/?em[^>]*>/gi, '').trim();

  // 1) 括号组：带噪声词或纯版本标记的整组删掉
  text = text.replace(BRACKET_GROUP, (match, content: string) =>
    bracketGroupIsNoise(content) ? ' ' : match,
  );

  // 2) 裸噪声词整词删除（中文没有词边界，直接删所有出现）
  for (const word of NOISE_WORDS) {
    text = text.split(word).join(' ');
  }

  // 3) 压掉分隔符与多余空白；首尾的残留分隔符也清掉
  text = text
    .replace(SEPARATORS, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 兜底：洗得太狠（比如整串都是噪声）就退回原始输入，让调用方至少有的搜
  return text || raw.trim();
}

/** 时长差距的奖惩（毫秒）：±3s 内加分，差太远扣分 */
const DURATION_CLOSE_MS = 3_000;
const DURATION_FAR_MS = 10_000;

export interface LyricCandidateLike {
  /** 歌词候选自带的歌名 */
  song: string | null;
  /** 歌词候选自带的歌手 */
  singer: string | null;
  /** 候选时长（毫秒） */
  durationMs?: number | null;
}

export interface ScoreInput {
  /** 原始（未清洗的）歌名——歌手信号要从里面挖 */
  rawTitle: string;
  /** 清洗后的搜索用歌名 */
  cleanTitle: string;
  /** 调用方给的歌手（5sing 伴奏场景下是上传者，不一定靠谱） */
  artist?: string | null;
  /** 伴奏真实时长（秒），没有就不参与打分 */
  durationSec?: number | null;
}

/** 达标线：标题必须互相包含或相等（2 分）才有资格入选 */
export const LYRIC_MATCH_MIN_SCORE = 2;

/**
 * 给一个歌词候选打分。
 *
 *  - 标题归一化后互相包含或相等：+2（必须，否则免谈）
 *  - 候选歌手出现在**原始**标题里：+1（「周杰伦 - 告白气球」→ 候选歌手周杰伦）
 *  - 候选歌手 == 调用方给的 artist：+1
 *  - 有时长时差距 ≤3s：+1；>10s：−1（版本不对的强信号）
 */
export function scoreLyricCandidate(input: ScoreInput, candidate: LyricCandidateLike): number {
  const candidateSong = normalizeForMatch(candidate.song ?? '');
  const cleanTitle = normalizeForMatch(input.cleanTitle);
  const rawTitle = normalizeForMatch(input.rawTitle);

  if (!candidateSong || !cleanTitle) return 0;
  const titleHit = candidateSong === cleanTitle
    || candidateSong.includes(cleanTitle)
    || cleanTitle.includes(candidateSong);
  if (!titleHit) return 0;

  let score = 2;

  const candidateSinger = normalizeForMatch(candidate.singer ?? '');
  if (candidateSinger) {
    if (rawTitle.includes(candidateSinger)) score += 1;
    const artist = normalizeForMatch(input.artist ?? '');
    if (artist && candidateSinger === artist) score += 1;
  }

  const knownMs =
    input.durationSec && Number.isFinite(input.durationSec)
      ? Math.round(input.durationSec * 1000)
      : null;
  const candidateMs = candidate.durationMs;
  if (knownMs !== null && candidateMs !== null && candidateMs !== undefined && Number.isFinite(candidateMs)) {
    const gap = Math.abs(knownMs - candidateMs);
    if (gap <= DURATION_CLOSE_MS) score += 1;
    else if (gap > DURATION_FAR_MS) score -= 1;
  }

  return score;
}

/** 从一组候选里挑最好的；没有达标的返回 null */
export function pickBestCandidate<T extends LyricCandidateLike>(
  input: ScoreInput,
  candidates: readonly T[],
): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = scoreLyricCandidate(input, candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= LYRIC_MATCH_MIN_SCORE ? best : null;
}
