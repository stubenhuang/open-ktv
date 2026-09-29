/**
 * 从 catch 到的任意值里取出可展示的文案。
 * 后端返回的 ApiError（继承 Error）会带上服务端的中文提示，直接透出即可。
 */
export function errorMessage(error: unknown, fallback = '未知错误'): string {
  if (error instanceof Error) return error.message || fallback;
  const text = String(error ?? '').trim();
  return text || fallback;
}

/** 秒 → mm:ss（超过一小时给 h:mm:ss） */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

/** 毫秒 → mm:ss.mmm，录音计时用 */
export function formatTimer(ms: number): string {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = Math.floor(total % 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* ------------------------------ 歌词滚动布局 ------------------------------ */

/**
 * 每行歌词的固定高度（px）。
 *
 * 滚动位置是靠「行下标 × 行高」算出来的，所以这个值必须和
 * styles.css 里 `.lyric-line` 的高度严格一致 —— 改一边就要改另一边。
 */
export const LYRIC_LINE_HEIGHT = 34;

/** 歌词可视区域显示的行数（奇数，当前行才能正好居中） */
export const LYRIC_VIEW_LINES = 5;

/**
 * 歌词轨道的 translateY（px）：让 activeIndex 那一行落在可视区正中间。
 *
 * activeIndex 为 −1（还没进第一句）时按第 0 行定位 —— 否则整条轨道会被
 * 推到可视区之外，开头几行全看不见。
 */
export function lyricTrackOffsetY(
  activeIndex: number,
  lineHeight: number = LYRIC_LINE_HEIGHT,
  visibleLines: number = LYRIC_VIEW_LINES,
): number {
  const index = Number.isFinite(activeIndex) && activeIndex > 0 ? Math.floor(activeIndex) : 0;
  const height = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : LYRIC_LINE_HEIGHT;
  const visible = Number.isFinite(visibleLines) && visibleLines >= 1 ? Math.floor(visibleLines) : 1;
  return ((visible - 1) / 2) * height - index * height;
}

