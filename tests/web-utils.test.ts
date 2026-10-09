import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_MIX_PARAMS, type WorkListItem } from '../shared/types.ts';
import {
  LYRIC_FULLSCREEN_LINE_HEIGHT,
  LYRIC_FULLSCREEN_VIEW_LINES,
  coverGradient,
  coverHue,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatRelativeTime,
  formatTimer,
  isAudioFile,
  isBuiltinMic,
  isLyricsFileName,
  lyricLineSizeClass,
  lyricTrackOffsetY,
  selectVisibleWorks,
} from '../web/src/utils.ts';

describe('formatDuration（秒 → mm:ss）', () => {
  it('正常时长', () => {
    assert.equal(formatDuration(9), '00:09');
    assert.equal(formatDuration(65), '01:05');
    assert.equal(formatDuration(599), '09:59');
    assert.equal(formatDuration(215.4), '03:35', '四舍五入到秒');
  });

  it('0 秒按「没有时长」处理', () => {
    // 实现里 0 是 falsy，和 null 一样给占位符
    assert.equal(formatDuration(0), '--:--');
  });

  it('超过一小时给 h:mm:ss', () => {
    assert.equal(formatDuration(3600), '1:00:00');
    assert.equal(formatDuration(3725), '1:02:05');
  });

  it('脏数据给占位符', () => {
    assert.equal(formatDuration(null), '--:--');
    assert.equal(formatDuration(undefined), '--:--');
    assert.equal(formatDuration(Number.NaN), '--:--');
    assert.equal(formatDuration(-5), '--:--');
  });
});

describe('formatTimer（毫秒 → mm:ss.mmm）', () => {
  it('毫秒精度', () => {
    assert.equal(formatTimer(0), '00:00.000');
    assert.equal(formatTimer(1), '00:00.001');
    assert.equal(formatTimer(999), '00:00.999');
    assert.equal(formatTimer(1000), '00:01.000');
    assert.equal(formatTimer(65_000), '01:05.000');
    assert.equal(formatTimer(3_600_000), '60:00.000', '计时器不显示小时，只累加分钟');
  });

  it('负数按 0 算', () => {
    assert.equal(formatTimer(-100), '00:00.000');
  });
});

describe('formatBytes', () => {
  it('各单位', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
    assert.equal(formatBytes(2.5 * 1024 ** 3), '2.5 GB');
  });

  it('脏数据', () => {
    assert.equal(formatBytes(Number.NaN), '0 B');
    assert.equal(formatBytes(-1), '0 B');
  });

  it('超过 GB 不再放大单位', () => {
    assert.equal(formatBytes(1024 ** 4), '1024.0 GB');
  });
});

describe('formatDateTime', () => {
  it('按本地时区格式化并补零', () => {
    const timestamp = new Date(2025, 0, 2, 3, 4, 5).getTime();
    const date = new Date(timestamp);
    const pad = (value: number) => String(value).padStart(2, '0');
    const want = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    assert.equal(formatDateTime(timestamp), want);
  });

  it('月份/日期/小时/分钟都补零', () => {
    const text = formatDateTime(new Date(2025, 8, 9, 7, 5).getTime());
    assert.match(text, /^2025-09-09 07:05$/);
  });
});

describe('歌词滚动布局', () => {
  it('当前行落在可视区正中间', () => {
    // 5 行可视区、行高 34：容器高 170，中线 85
    // 第 0 行：轨道上移到 68，该行中心 = 68 + 17 = 85 ✓
    assert.equal(lyricTrackOffsetY(0), 68);
    // 第 2 行：68 − 68 = 0，该行中心 = 0 + 2*34 + 17 = 85 ✓
    assert.equal(lyricTrackOffsetY(2), 0);
    assert.equal(lyricTrackOffsetY(3), -34);
  });

  it('还没进第一句（−1）按第 0 行定位，不把轨道推到屏幕外', () => {
    assert.equal(lyricTrackOffsetY(-1), lyricTrackOffsetY(0));
  });

  it('行数越多，轨道越往上移（单调递减）', () => {
    const values = [0, 1, 2, 3, 4].map((index) => lyricTrackOffsetY(index));
    for (let i = 1; i < values.length; i += 1) {
      assert.ok(values[i]! < values[i - 1]!, `第 ${i} 行应比第 ${i - 1} 行更高`);
    }
  });

  it('行高与可视行数可覆盖，脏输入回落默认', () => {
    assert.equal(lyricTrackOffsetY(0, 40, 3), 40);
    assert.equal(lyricTrackOffsetY(1, 40, 3), 0);
    assert.equal(lyricTrackOffsetY(Number.NaN), lyricTrackOffsetY(0));
    assert.equal(lyricTrackOffsetY(0, 0, 0), 0);
  });
});

describe('全屏歌词的行高与字号档', () => {
  it('全屏行高更大，当前行同样落在可视区正中间', () => {
    // 5 行可视区、行高 72：容器高 360，中线 180
    assert.equal(LYRIC_FULLSCREEN_LINE_HEIGHT, 72);
    assert.equal(LYRIC_FULLSCREEN_VIEW_LINES, 5);
    // 第 0 行：轨道上移到 144，该行中心 = 144 + 36 = 180 ✓
    assert.equal(lyricTrackOffsetY(0, LYRIC_FULLSCREEN_LINE_HEIGHT, LYRIC_FULLSCREEN_VIEW_LINES), 144);
    // 第 2 行：144 − 144 = 0，该行中心 = 0 + 2*72 + 36 = 180 ✓
    assert.equal(lyricTrackOffsetY(2, LYRIC_FULLSCREEN_LINE_HEIGHT, LYRIC_FULLSCREEN_VIEW_LINES), 0);
  });

  it('长句逐级缩字号，短句不减', () => {
    assert.equal(lyricLineSizeClass('短句'), '');
    assert.equal(lyricLineSizeClass('一二三四五六七八九十壹贰叁'), 'lyric-fs-sm');
    assert.equal(
      lyricLineSizeClass('一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾'),
      'lyric-fs-xs',
    );
  });

  it('emoji 按一个字符算，不会把代理对拆成两个', () => {
    // 「🎤🎤🎤🎤🎤🎤🎤🎤🎤🎤🎤🎤🎤」= 13 个码位 → 只缩一号
    assert.equal(lyricLineSizeClass('🎤'.repeat(13)), 'lyric-fs-sm');
    assert.equal(lyricLineSizeClass('🎤'.repeat(19)), 'lyric-fs-xs');
  });

  it('空串不缩号', () => {
    assert.equal(lyricLineSizeClass(''), '');
  });
});

describe('作品卡封条配色（coverHue / coverGradient）', () => {
  it('确定性：同一个标题每次算出来的色相一样', () => {
    // 封条要「用户认得出我那首」，同一首歌不能每次刷新都换色
    assert.equal(coverHue('寂寞的季节'), coverHue('寂寞的季节'));
    assert.equal(coverGradient('离歌'), coverGradient('离歌'));
  });

  it('色相落在 0～359', () => {
    for (const title of ['晴天', 'A', '', '🎤'.repeat(20), '很长的歌名'.repeat(10)]) {
      const hue = coverHue(title);
      assert.ok(Number.isInteger(hue), `${title} 的色相应是整数`);
      assert.ok(hue >= 0 && hue <= 359, `${title} 的色相越界：${hue}`);
    }
  });

  it('不同标题尽量错开（一整组真实歌名的碰撞率要低）', () => {
    const titles = ['寂寞的季节', '不凡', '慢慢', '爱错', '转眼', '离歌', '如烟', '晴天', '夜曲'];
    const hues = new Set(titles.map(coverHue));
    // 不追求零碰撞（360 个色相装不下整个曲库），但九首里至少七首不同色
    assert.ok(hues.size >= 7, `九首歌只分出了 ${hues.size} 种色相`);
  });

  it('渐变是合法的 CSS linear-gradient，两个色标落在色相环上', () => {
    assert.match(coverGradient('寂寞的季节'), /^linear-gradient\(135deg, hsl\(\d+ 68% 46%\), hsl\(\d+ 72% 36%\)\)$/);
  });
});

describe('isAudioFile（伴奏库只收音频）', () => {
  it('音频 MIME 直接放行', () => {
    assert.equal(isAudioFile({ name: '晴天.mp3', type: 'audio/mpeg' }), true);
    assert.equal(isAudioFile({ name: 'whatever.xyz', type: 'audio/mp4' }), true);
  });

  it('MIME 为空时靠扩展名兜底（NAS / Linux 上很常见）', () => {
    assert.equal(isAudioFile({ name: '晴天.MP3', type: '' }), true, '扩展名大小写不敏感');
    assert.equal(isAudioFile({ name: 'live.flac', type: '' }), true);
    assert.equal(isAudioFile({ name: 'a.m4a', type: '' }), true);
    assert.equal(isAudioFile({ name: 'a.ape', type: '' }), true);
    assert.equal(isAudioFile({ name: 'no-extension', type: '' }), false);
  });

  it('视频格式一律拒绝（伴奏库不再支持视频）', () => {
    assert.equal(isAudioFile({ name: 'mv.mp4', type: 'video/mp4' }), false);
    assert.equal(isAudioFile({ name: 'mv.mkv', type: '' }), false);
    assert.equal(isAudioFile({ name: 'mv.avi', type: 'video/x-msvideo' }), false);
    assert.equal(isAudioFile({ name: 'mv.flv', type: '' }), false);
    assert.equal(isAudioFile({ name: 'mv.webm', type: 'video/webm' }), false);
    assert.equal(isAudioFile({ name: 'mv.mov', type: 'video/quicktime' }), false);
  });

  it('歌词文件不是伴奏', () => {
    assert.equal(isAudioFile({ name: '晴天.lrc', type: 'text/plain' }), false);
    assert.equal(isAudioFile({ name: '晴天.txt', type: '' }), false);
  });
});

describe('isLyricsFileName', () => {
  it('只认 .lrc / .txt，大小写不敏感', () => {
    assert.equal(isLyricsFileName('晴天.lrc'), true);
    assert.equal(isLyricsFileName('晴天.LRC'), true);
    assert.equal(isLyricsFileName('晴天.txt'), true);
    assert.equal(isLyricsFileName('晴天.docx'), false);
    assert.equal(isLyricsFileName('晴天.mp3'), false);
    assert.equal(isLyricsFileName('没有扩展名'), false);
  });
});

describe('isBuiltinMic（演唱只用外置输入）', () => {
  it('Apple 机身内置麦克风的几种叫法都认得出来', () => {
    // 本机实测：macOS 中文系统 + Chrome 的 label 就是「系统设备名 (传输类型)」
    assert.equal(isBuiltinMic('abc123', 'MacBook Pro麦克风 (Built-in)'), true);
    assert.equal(isBuiltinMic('abc123', 'MacBook Pro Microphone (Built-in)'), true);
    assert.equal(isBuiltinMic('abc123', 'MacBook Air的麦克风（内置）'), true);
    assert.equal(isBuiltinMic('abc123', 'iMac Microphone (Built-in)'), true);
    // 老机型 / 英文系统
    assert.equal(isBuiltinMic('abc123', '内置麦克风'), true);
    assert.equal(isBuiltinMic('abc123', 'Internal Microphone (Built-in)'), true);
    assert.equal(isBuiltinMic('abc123', 'Built-in Audio Input'), true);
  });

  it('外置设备不会被误杀', () => {
    assert.equal(isBuiltinMic('usb-1', 'Blue Yeti (USB)'), false);
    assert.equal(isBuiltinMic('usb-2', 'AirPods Pro (Bluetooth)'), false);
    assert.equal(isBuiltinMic('usb-3', 'MixPre-3 II (Thunderbolt)'), false);
    assert.equal(isBuiltinMic('usb-4', 'USB Audio Device'), false);
    // 声卡上的「麦克风」二字不该触发内置判定
    assert.equal(isBuiltinMic('usb-5', 'Scarlett Solo 麦克风输入 (USB)'), false);
  });

  it('3.5mm 口的外接麦：名字写着「外置」，传输类型却是 Built-in（真实踩过的坑）', () => {
    // macOS 把这个口的 Transport 也报成 Built-in，Chrome 的 label 就成了
    // 「外置麦克风 (Built-in)」——只看 (Built-in) 后缀会把用户真正的麦克风藏掉
    assert.equal(isBuiltinMic('jack-1', '外置麦克风 (Built-in)'), false);
    assert.equal(isBuiltinMic('jack-1', '外置麦克风'), false);
    assert.equal(isBuiltinMic('jack-1', '外接麦克风 (Built-in)'), false);
    assert.equal(isBuiltinMic('jack-1', 'External Microphone (Built-in)'), false);
  });

  it('Chrome 的「系统默认设备」别名算内置', () => {
    // 它指向哪个物理设备无从判断，而默认就是内置那个
    assert.equal(isBuiltinMic('default', 'Default - 麦克风'), true);
    assert.equal(isBuiltinMic('default', '任何名字'), true);
  });

  it('label 为空（还没授权）不算内置，宁可多列也不清空列表', () => {
    assert.equal(isBuiltinMic('some-id', ''), false);
    assert.equal(isBuiltinMic('some-id', undefined as unknown as string), false);
  });
});

describe('formatRelativeTime（时间戳 → 友好相对时间）', () => {
  // 全部用本地时间构造：函数按本地时区的自然日比较，测试也必须同口径
  const noon = new Date(2025, 0, 2, 12, 0, 0).getTime();
  const at = (y: number, m: number, d: number, h: number, min: number) =>
    new Date(y, m, d, h, min).getTime();

  it('一分钟内都是「刚刚」', () => {
    assert.equal(formatRelativeTime(noon - 30_000, noon), '刚刚');
    assert.equal(formatRelativeTime(noon - 59_999, noon), '刚刚');
    assert.equal(formatRelativeTime(noon, noon), '刚刚');
  });

  it('一小时内说「N 分钟前」', () => {
    assert.equal(formatRelativeTime(noon - 60_000, noon), '1 分钟前');
    assert.equal(formatRelativeTime(noon - 5 * 60_000, noon), '5 分钟前');
    assert.equal(formatRelativeTime(noon - 59 * 60_000, noon), '59 分钟前');
  });

  it('当天说「今天 HH:mm」', () => {
    assert.equal(formatRelativeTime(at(2025, 0, 2, 8, 5), noon), '今天 08:05');
    // 恰好一小时整也落进日历口径，而不是「60 分钟前」
    assert.equal(formatRelativeTime(noon - 3_600_000, noon), '今天 11:00');
  });

  it('前一天说「昨天 HH:mm」', () => {
    assert.equal(formatRelativeTime(at(2025, 0, 1, 21, 12), noon), '昨天 21:12');
  });

  it('同一年（且不是今/昨天）说「MM-DD」', () => {
    // 换一个居中的 now：1 月 2 日的「同一年过去日期」只可能是昨天，测不到 MM-DD
    const summer = new Date(2025, 5, 15, 12, 0, 0).getTime();
    assert.equal(formatRelativeTime(at(2025, 2, 9, 7, 5), summer), '03-09');
    assert.equal(formatRelativeTime(at(2025, 4, 31, 23, 59), summer), '05-31');
    assert.equal(formatRelativeTime(at(2025, 0, 1, 0, 0), summer), '01-01');
  });

  it('跨年给完整日期', () => {
    assert.equal(formatRelativeTime(at(2024, 11, 31, 23, 59), noon), '2024-12-31');
    assert.equal(formatRelativeTime(at(2023, 5, 1, 0, 0), noon), '2023-06-01');
  });

  it('未来的时间戳（时钟偏斜）按「刚刚」，不渲染负数', () => {
    assert.equal(formatRelativeTime(noon + 5_000, noon), '刚刚');
    assert.equal(formatRelativeTime(new Date(2025, 5, 1).getTime(), noon), '刚刚');
  });

  it('脏数据给占位符', () => {
    assert.equal(formatRelativeTime(0, noon), '--');
    assert.equal(formatRelativeTime(Number.NaN, noon), '--');
    assert.equal(formatRelativeTime(new Date('nope').getTime(), noon), '--');
  });
});

/* ------------------------------ 作品列表筛选 ------------------------------ */

function makeWork(overrides: Partial<WorkListItem> = {}): WorkListItem {
  return {
    id: 'w1',
    trackId: 't1',
    title: '晴天（我的演唱 06-01 12:00）',
    vocalDuration: 180,
    autoOffsetMs: 150,
    mixParams: { ...DEFAULT_MIX_PARAMS },
    levels: null,
    status: 'ready',
    error: null,
    createdAt: 2000,
    updatedAt: 3000,
    trackTitle: '晴天',
    trackKind: 'audio',
    trackArtist: '周杰伦',
    sizeBytes: 4_000_000,
    ...overrides,
  };
}

const NO_FILTER = { query: '', status: 'all', sortBy: 'recent' } as const;

describe('selectVisibleWorks（作品库筛选 / 排序）', () => {
  const works: WorkListItem[] = [
    makeWork({ id: 'a', title: '阿木（我的演唱 06-01 12:00）', createdAt: 1000, vocalDuration: 200 }),
    makeWork({
      id: 'b',
      title: '波光（我的演唱 06-02 12:00）',
      trackTitle: '波光',
      trackArtist: 'Jay Chou',
      createdAt: 3000,
      vocalDuration: 100,
      status: 'mixing',
    }),
    makeWork({
      id: 'c',
      title: '失败品（我的演唱 06-03 12:00）',
      trackTitle: null,
      trackArtist: null,
      createdAt: 2000,
      status: 'failed',
      error: '磁盘写满',
    }),
  ];

  it('无过滤时原样返回（recent = 后端返回顺序）', () => {
    assert.deepEqual(
      selectVisibleWorks(works, NO_FILTER).map((w) => w.id),
      ['a', 'b', 'c'],
    );
  });

  it('关键字匹配作品名 / 伴奏名 / 歌手，大小写不敏感', () => {
    assert.deepEqual(
      selectVisibleWorks(works, { ...NO_FILTER, query: '阿木' }).map((w) => w.id),
      ['a'],
    );
    assert.deepEqual(
      selectVisibleWorks(works, { ...NO_FILTER, query: '波光' }).map((w) => w.id),
      ['b'],
    );
    // 歌手是英文：小写输入也要能命中
    assert.deepEqual(
      selectVisibleWorks(works, { ...NO_FILTER, query: 'jay' }).map((w) => w.id),
      ['b'],
    );
    assert.deepEqual(
      selectVisibleWorks(works, { ...NO_FILTER, query: '周杰' }).map((w) => w.id),
      ['a'],
    );
  });

  it('伴奏已删的作品（trackTitle/artist 为 null）不被搜索搞炸', () => {
    assert.deepEqual(
      selectVisibleWorks(works, { ...NO_FILTER, query: '失败' }).map((w) => w.id),
      ['c'],
    );
    // 谁都匹配不上的词：空结果而不是抛异常
    assert.deepEqual(selectVisibleWorks(works, { ...NO_FILTER, query: '梁静茹' }).map((w) => w.id), []);
  });

  it('首尾空白不算数（搜" "应返回全部）', () => {
    assert.equal(selectVisibleWorks(works, { ...NO_FILTER, query: '   ' }).length, 3);
  });

  it('状态过滤只看 status', () => {
    assert.deepEqual(
      selectVisibleWorks(works, { ...NO_FILTER, status: 'ready' }).map((w) => w.id),
      ['a'],
    );
    assert.deepEqual(
      selectVisibleWorks(works, { ...NO_FILTER, status: 'mixing' }).map((w) => w.id),
      ['b'],
    );
    assert.deepEqual(
      selectVisibleWorks(works, { ...NO_FILTER, status: 'failed' }).map((w) => w.id),
      ['c'],
    );
  });

  it('关键字 + 状态组合（与的关系）', () => {
    // 「波光」存在但正在合成：按 ready 过滤后就搜不到
    assert.deepEqual(
      selectVisibleWorks(works, { ...NO_FILTER, query: '波光', status: 'ready' }).map((w) => w.id),
      [],
    );
    assert.deepEqual(
      selectVisibleWorks(works, { ...NO_FILTER, query: '波光', status: 'mixing' }).map((w) => w.id),
      ['b'],
    );
  });

  it('排序：oldest 按 createdAt 升序，duration 按时长降序', () => {
    assert.deepEqual(
      selectVisibleWorks(works, { ...NO_FILTER, sortBy: 'oldest' }).map((w) => w.id),
      ['a', 'c', 'b'],
    );
    // 时长：a=200s > c=180s > b=100s
    assert.deepEqual(
      selectVisibleWorks(works, { ...NO_FILTER, sortBy: 'duration' }).map((w) => w.id),
      ['a', 'c', 'b'],
    );
  });

  it('排序按歌名（localeCompare zh 口径）且不改原数组', () => {
    const snapshot = works.map((w) => w.id);
    const sorted = selectVisibleWorks(works, { ...NO_FILTER, sortBy: 'title' }).map((w) => w.id);
    // 拼音序：阿(ā) < 波(bō) < 失(shī)。依赖 full-icu（Node 官方发行版默认带上；
    // 伴奏库的「按歌名」排序同样跑在 localeCompare zh 上，两边口径一致）
    assert.deepEqual(sorted, ['a', 'b', 'c']);
    // 纯函数：输入数组不被排序原地打乱
    assert.deepEqual(
      works.map((w) => w.id),
      snapshot,
    );
  });
});
