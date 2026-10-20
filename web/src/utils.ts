import type { WorkListItem } from '../../shared/types.js';

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
 *
 * **手机端同理**（手机演唱页也要求外置输入）：iPhone / Android 机身麦的 label
 * 一般带机型或「手机/iPhone/默认」字样，裸叫「麦克风」的也是机身那个；
 * 耳机麦（有线/蓝牙/USB-C）走上面的外置清单优先命中。判断同样是猜的，
 * 所以 UI 一律保留「显示全部设备」的逃生开关。
 */
export function isBuiltinMic(deviceId: string, label: string): boolean {
  if (deviceId === 'default') return true;
  const name = label ?? '';
  // 名字里明说是外接/外置的一律当外置（耳机麦也在这一档：先于内置规则判定）
  if (/外置|外接|external|usb|bluetooth|蓝牙|无线|wireless|airpods|thunderbolt|耳机|headset|headphone|有线|wired|type-?c|lightning/i.test(name)) {
    return false;
  }
  if (/built[\s_-]?in|内置|内建|internal/i.test(name)) return true;
  // 手机机身麦克风的几种叫法（iPhone / Android / 听筒 / 系统默认）
  if (/iphone|ipad|android|手机|电话|听筒|免提|hands-?free|默认|default/i.test(name)) return true;
  // 有些系统上机身麦就叫光秃秃一个「麦克风」—— 不带任何外接标记的 generic 名
  if (/^(麦克风|话筒|microphone|phone microphone)$/i.test(name.trim())) return true;
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
 * 手机端歌词的行高 / 可视行数。
 *
 * 桌面全屏是 72px 行高 × 5 行 = 360px，那是给 54px 大字留的；手机舞台还要同时
 * 放传输条、麦克风行和大录音键，可用高度通常只有 300px 上下，360px 会被舞台的
 * overflow:hidden 切掉上下两行。56px × 5 = 280px 在 375×667 的小屏上也放得下。
 */
export const LYRIC_MOBILE_LINE_HEIGHT = 56;

/** 矮屏（视口高 < 700px，iPhone SE 一类）下的手机歌词行高：5 行 240px 也放得下 */
export const LYRIC_MOBILE_LINE_HEIGHT_SHORT = 48;

/** 手机端歌词可视行数（同样取奇数，当前行才能居中） */
export const LYRIC_MOBILE_VIEW_LINES = 5;

/**
 * 手机端逐行缩字号的下限。
 *
 * 手机歌词保持 nowrap（换行会破坏「一行一行滚」的偏移数学），长句只能缩字号。
 * 0.34 是拿真实歌词长度反推的：当前行基础字号 30px，缩到下限约 10px，
 * 390px 宽的屏能塞下约 30 个汉字 —— 覆盖几乎所有歌词句长；再长的句子属于
 * 极端情况，靠上下 mask 淡出兜底，不为了它把正常句子一起拖小。
 */
export const LYRIC_FIT_FLOOR = 0.34;

/**
 * 由实测宽度算一行的缩字号系数（纯函数，单测见 tests/web-utils.test.ts）。
 *
 * @param naturalWidth 该行在 100% 字号下的实测宽度（scrollWidth）
 * @param availableWidth 容器可用宽度（clientWidth）
 * @returns 0.45～1 的系数；放得下就是 1
 */
export function lyricFitFactor(naturalWidth: number, availableWidth: number): number {
  if (!Number.isFinite(naturalWidth) || !Number.isFinite(availableWidth) || availableWidth <= 0) {
    return 1;
  }
  if (naturalWidth <= availableWidth) return 1;
  return Math.max(LYRIC_FIT_FLOOR, availableWidth / naturalWidth);
}

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

/* ------------------------------ 作品卡封条配色 ------------------------------ */

/**
 * 标题 → 确定性色相（0～359）。
 *
 * 作品卡顶部那条渐变封条用它取色：同一首歌每次进来颜色一样（用户认得出
 * 「我那首粉色的」），不同标题错开（一屏八张卡不撞色）。FNV 式滚动哈希，
 * 纯函数、无依赖 —— 单测见 tests/web-utils.test.ts。
 */
export function coverHue(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // Math.imul：32 位整数乘法，避免 JS 浮点把哈希冲淡
    hash = Math.imul(hash, 16777619);
  }
  // >>> 0 转无符号；% 360 落回色相环
  return (hash >>> 0) % 360;
}

/**
 * 作品卡封条渐变：主色相 + 旁边 35° 的邻近色，比单色更有层次。
 *
 * 色相被压进 0～84 这一段（朱 → 橙 → 金 → 山吹）：主题换成「和風暖色」之后，
 * 封条是页面里唯一还留着全色相的地方，一出现蓝绿封条就破功。
 * 输出格式与饱和度都不变 —— 调用方和单测零改动。
 */
export function coverGradient(text: string): string {
  const warm = coverHue(text) % 50;
  return `linear-gradient(135deg, hsl(${warm} 68% 46%), hsl(${warm + 35} 72% 36%))`;
}

/* ------------------------------ 相对时间 ------------------------------ */

/** 一天之内的「短间隔」阈值：超过它就按日历口径说「今天 / 昨天」 */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** 60 秒：混音完成到用户回到列表页，常常就差这几秒 */
const JUST_NOW_MS = 60_000;

/**
 * 时间戳 → 友好的相对时间（本地时区，纯函数，`now` 可注入便于测试）。
 *
 * 为什么不用「N 天前」一路到底：作品列表里「今天 21:12」比「3 小时前」
 * 更好用 —— 用户记得自己是今晚唱的还是昨天下午唱的，绝对时刻直接告诉
 * 他，不用自己换算。规则：
 *
 *  - 未来或 1 分钟内（时钟偏斜 / 刚发生）→「刚刚」
 *  - 1 小时内                            →「N 分钟前」
 *  - 同一天（自然日）                    →「今天 HH:mm」
 *  - 前一天                              →「昨天 HH:mm」
 *  - 同一年                              →「MM-DD」
 *  - 更早                                →「YYYY-MM-DD」
 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '--';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '--';

  const reference = new Date(Number.isFinite(now) ? now : Date.now());
  const diff = reference.getTime() - date.getTime();
  if (diff < JUST_NOW_MS) return '刚刚';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} 分钟前`;

  const pad = (value: number) => String(value).padStart(2, '0');
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  if (sameDay(date, reference)) return `今天 ${clock}`;
  const yesterday = new Date(reference);
  yesterday.setDate(reference.getDate() - 1);
  if (sameDay(date, yesterday)) return `昨天 ${clock}`;
  if (date.getFullYear() === reference.getFullYear()) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/* ------------------------------ 作品列表筛选 ------------------------------ */

/** 状态过滤档位；'all' = 不过滤 */
export type WorkStatusFilter = 'all' | 'mixing' | 'ready' | 'failed';

/** 列表排序方式 */
export type WorksSortBy = 'recent' | 'oldest' | 'title' | 'duration';

export interface WorksQuery {
  /** 关键字：匹配作品名 / 伴奏名 / 歌手（大小写不敏感） */
  query: string;
  status: WorkStatusFilter;
  sortBy: WorksSortBy;
}

/**
 * 关键字 + 状态 + 排序后的可见作品（纯函数，单测见 tests/web-utils.test.ts）。
 *
 * 与伴奏库的筛选同构：作品就自己家几十首，全量已经在内存里，客户端过滤
 * 不值得为它打接口。歌名按拼音排（localeCompare 的 zh 排序），和
 * LibraryPage 一个口径。
 */
export function selectVisibleWorks(works: WorkListItem[], filter: WorksQuery): WorkListItem[] {
  const keyword = filter.query.trim().toLowerCase();
  const filtered = keyword
    ? works.filter((work) => {
        const title = work.title?.toLowerCase() ?? '';
        const trackTitle = work.trackTitle?.toLowerCase() ?? '';
        const trackArtist = work.trackArtist?.toLowerCase() ?? '';
        return (
          title.includes(keyword) || trackTitle.includes(keyword) || trackArtist.includes(keyword)
        );
      })
    : works;

  const byStatus =
    filter.status === 'all'
      ? filtered
      : filtered.filter((work) => work.status === filter.status);

  if (filter.sortBy === 'title') {
    return [...byStatus].sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  }
  if (filter.sortBy === 'duration') {
    return [...byStatus].sort((a, b) => (b.vocalDuration ?? 0) - (a.vocalDuration ?? 0));
  }
  if (filter.sortBy === 'oldest') {
    return [...byStatus].sort((a, b) => a.createdAt - b.createdAt);
  }
  // recent：后端已按 created_at DESC 返回，稳定排序保持原样即可
  return byStatus;
}

/* -------------------------------- 手机演唱入口 -------------------------------- */

/**
 * 把 /api/network 的返回展开成「每张网卡一个完整地址」。
 *
 * 纯函数：服务端已经判断好该用 http 还是 https、哪个端口，
 * 这里只负责把「地址 × 协议端口 × 路径」乘起来。二维码用第一个，
 * 其余列在卡片里供手输（一台机器可能同时接着 WiFi 和网线）。
 */
export function buildMobileUrls(info: {
  lanAddresses: string[];
  mobilePath: string;
  mobileOrigin: { scheme: 'http' | 'https'; port: number } | null;
}): string[] {
  if (!info.mobileOrigin) return [];
  const { scheme, port } = info.mobileOrigin;
  return info.lanAddresses.map((address) => `${scheme}://${address}:${port}${info.mobilePath}`);
}
