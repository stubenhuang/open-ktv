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

/* ------------------------------ 麦克风设备筛选 ------------------------------ */

/**
 * 判断一个音频输入设备是不是「机器自带的」（MacBook / iMac 的内置麦克风）。
 *
 * 为什么只能看 label：Web 平台没给设备类型字段，`MediaDeviceInfo` 只有 label /
 * deviceId / groupId。好在 macOS 上 Chrome 的 label 是「系统设备名 (传输类型)」，
 * 而 Apple 机身内置麦克风的名字一定带机型或「内置」字样：
 *
 *   内置：`MacBook Pro麦克风 (Built-in)`（本机实测）、`MacBook Pro Microphone (Built-in)`、
 *         `内置麦克风`、`Internal Microphone`
 *   外置：`外置麦克风 (Built-in)`（本机实测的 3.5mm 口外接麦）、`Blue Yeti (USB)`、
 *         `AirPods Pro (Bluetooth)`
 *
 * **「外置」这类明确标记优先于传输类型**：3.5mm 耳机口那个外接麦走的是机身 codec，
 * macOS 把它的 Transport 也报成 `Built-in`，只看后缀会把用户真正的麦克风藏掉。
 *
 * label 为空（还没授权时）不算内置 —— 宁可多列一个，也不要把设备列表清空。
 *
 * deviceId 为 `default` 时一律算内置：那是 Chrome 的「系统默认设备」别名，
 * 指向哪个物理设备无从判断，而它默认就是内置那个。
 */
export function isBuiltinMic(deviceId: string, label: string): boolean {
  if (deviceId === 'default') return true;
  const name = label ?? '';
  // 名字里明说是外接/外置的一律当外置
  if (/外置|外接|external|usb|bluetooth|蓝牙|无线|wireless|airpods|thunderbolt/i.test(name)) {
    return false;
  }
  if (/built[\s_-]?in|内置|内建|internal/i.test(name)) return true;
  return /macbook|imac/i.test(name);
}

/* ------------------------------ 伴奏上传的文件筛选 ------------------------------ */

/**
 * 伴奏库只收音频。这些扩展名是「type 为空时」的兜底判据 ——
 * 不少系统（尤其是 Linux / NAS 上的文件）给的 MIME 是空串，
 * 只认 audio/* 会把一堆合法的 flac、ape 误杀。
 */
const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.flac',
  '.m4a',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
  '.wma',
  '.ape',
  '.aiff',
  '.aif',
  '.caf',
  '.amr',
  '.ac3',
  '.dts',
  '.wv',
  '.tta',
]);

/** 取小写扩展名（含点）；没有扩展名返回空串 */
function fileExtension(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name ?? '');
  return match ? `.${match[1]!.toLowerCase()}` : '';
}

/**
 * 这个文件能不能当伴奏上传。
 *
 * MIME 和扩展名**任一**命中就算音频：视频文件（.mp4 / .mkv 等）两边都不沾，
 * 改名成 .mp3 也还有服务端 ffprobe 兜底（见 server/src/tracks/ingest.ts）。
 */
export function isAudioFile(file: { name: string; type: string }): boolean {
  if (file.type && file.type.startsWith('audio/')) return true;
  return AUDIO_EXTENSIONS.has(fileExtension(file.name));
}

/** 歌词文件只认 .lrc / .txt（与服务端 POST /api/tracks/:id/lyrics 同口径） */
export function isLyricsFileName(name: string): boolean {
  const extension = fileExtension(name);
  return extension === '.lrc' || extension === '.txt';
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

/* ------------------------------ 逐字填充（卡拉 OK） ------------------------------ */

/**
 * 全屏歌词的行高（px）。和 styles.css 里 .lyric-line 的内联高度同源，改一边要改另一边
 *
 * 72 是给 48px 的当前行留的：字大但行也高，唱到哪一行一眼能看到，
 * 上下相邻行也不会挤成一块。
 */
export const LYRIC_FULLSCREEN_LINE_HEIGHT = 72;

/** 全屏歌词可视区域显示的行数（奇数，当前行才能正好居中） */
export const LYRIC_FULLSCREEN_VIEW_LINES = 5;

/**
 * 全屏歌词的长句字号档。行是 nowrap 的，长句不缩号会被裁掉；
 * 阈值按字符数估（>12 缩一号，>18 再缩一号）。
 */
export function lyricLineSizeClass(text: string): 'lyric-fs-sm' | 'lyric-fs-xs' | '' {
  const length = [...text].length;
  if (length > 18) return 'lyric-fs-xs';
  if (length > 12) return 'lyric-fs-sm';
  return '';
}

