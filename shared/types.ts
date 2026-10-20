/**
 * 前后端共享的类型与常量。
 *
 * 注意：web 端只能用 `import type` 引入本文件的类型（这样会被完全擦除），
 * 运行时常量（MIX_LIMITS / DEFAULT_MIX_PARAMS 等）走普通 import。
 */

export type TrackKind = 'audio' | 'video';

/** processing = 正在转码代理；ready = 可演唱；failed = 探测或转码失败 */
export type TrackStatus = 'processing' | 'ready' | 'failed';

/**
 * 伴奏从哪来：
 *  · upload  = 用户手动拖上来的文件（服务端在 data/originals 里存了一份副本）
 *  · library = 从曲库源点歌下载的（同样落在 data/originals，只是入口不同）
 * 两者入库后行为完全一致 —— 区别只在 UI 与去重口径。
 */
export type TrackSource = 'upload' | 'library';

/** none = 原文件浏览器可播；video = 转出了 mp4 代理；audio = 转出了 mp3 代理 */
export type ProxyKind = 'none' | 'video' | 'audio';

export type WorkStatus = 'mixing' | 'ready' | 'failed';

/**
 * 混响档位（8 档）；数组本身就是唯一来源，前后端都从这里取顺序
 * （服务端另用它做白名单，前端预览用同一顺序排刻度）。
 *
 * 顺序即「空间由小到大」：原声 → 小房间 → 金属板 → 大厅 → 演唱会 → 教堂 → 体育场 → 峡谷。
 * 混响参数不再是「选哪一档」，而是空间轴上的连续位置 + 独立湿度（见 REVERB_ANCHORS），
 * 这 8 个名字退化为刻度标签 / 读数提示 / 预设词汇，DSP 只认数值。
 */
export const REVERB_KINDS = [
  'dry',
  'room',
  'plate',
  'hall',
  'stage',
  'cathedral',
  'arena',
  'canyon',
] as const;

export type ReverbKind = (typeof REVERB_KINDS)[number];

/**
 * 混响空间轴上的一个锚点。
 *
 * 8 个锚点把 0–1 的空间轴均分（位置 = i/7），每个锚点携带一整组 IR 规格：
 *  · 尾巴秒数 / 前延迟 ms / 衰减指数（程序生成的指数衰减噪声 IR，试听与服务端
 *    共用同一份生成公式，见 shared/mix.ts 的 generateReverbIr）；
 *  · 满湿度（wet）—— 该空间档在湿度 100% 时的湿声发送量。
 *
 * 历史上这张表还带 aecho 四元组（in/out/delay/decay）给服务端拼
 * `aecho=in:out:delay:decay`。那套参数基于对 ffmpeg aecho 语义的误读
 * （in_gain 缩放的是干声、回声 = out_gain×decay 且只有一个单回声），
 * 湿度因此控制不了成品混响量，成品与试听必然对不上。现已全部改为卷积混响，
 * 锚点只剩 IR 规格。
 *
 * 锚点处的数值是**契约**：老作品/老请求里的 `reverb: 'hall'` 映射到
 * (3/7, 湿度 1)，插值在锚点原样返回值，试听 IR 规格与档位表精确对应。
 */
export interface ReverbAnchor {
  kind: ReverbKind;
  /** 在 0–1 空间轴上的位置；由下标程序化生成（i/7），不手写 */
  position: number;
  /* ---- 实时试听 / 服务端成品共用的 IR 规格 ---- */
  /** 尾巴秒数 */
  tailSec: number;
  /** 前延迟 ms */
  preDelayMs: number;
  /** 衰减指数：包络 = (1 - t)^irDecay */
  irDecay: number;
  /** 该空间档的满湿度（发送量，0..1） */
  wet: number;
}

/** 8 个锚点（顺序 = REVERB_KINDS）。dry 的 IR 湿度 0：空间 0 或湿度 0 都直接不挂滤镜 */
export const REVERB_ANCHORS: ReverbAnchor[] = (
  [
    // 原声：湿度 0（旁通），其余数值仅为占位
    { kind: 'dry', tailSec: 0.35, preDelayMs: 10, irDecay: 2.6, wet: 0 },
    { kind: 'room', tailSec: 0.35, preDelayMs: 10, irDecay: 2.6, wet: 0.35 },
    { kind: 'plate', tailSec: 0.5, preDelayMs: 8, irDecay: 2.8, wet: 0.32 },
    { kind: 'hall', tailSec: 1.3, preDelayMs: 25, irDecay: 2.0, wet: 0.45 },
    { kind: 'stage', tailSec: 2.6, preDelayMs: 45, irDecay: 1.6, wet: 0.55 },
    { kind: 'cathedral', tailSec: 3.8, preDelayMs: 60, irDecay: 1.4, wet: 0.6 },
    { kind: 'arena', tailSec: 5, preDelayMs: 80, irDecay: 1.2, wet: 0.62 },
    { kind: 'canyon', tailSec: 6.5, preDelayMs: 110, irDecay: 1, wet: 0.65 },
  ] as Omit<ReverbAnchor, 'position'>[]
).map((anchor, index, all) => ({ ...anchor, position: index / (all.length - 1) }));

/**
 * 最近一次成功混音时实测的两轨归一化增益（dB）。
 * 前端实时预览用它复算电平，才能和成品 MP3 的绝对音量对齐。
 */
export interface WorkLevels {
  vocalGainDb: number;
  accompGainDb: number;
}

/**
 * 实时预览引擎的输入参数（偏移已合成、增益已复算）。
 *
 * 刻意不含 vocalPreset：预设只是往下面这些数值字段里写默认值的 UI 便利，
 * DSP 只认数值。少一个可以「两边推导出不同结果」的输入。
 */
export interface PreviewParams {
  vocalGain: number;
  accompGain: number;
  /** 混响空间 0–1：REVERB_ANCHORS 八个档位之间的连续位置（0 = 原声） */
  reverbSpace: number;
  /** 混响湿度 0–1：0 = 旁通（干声），1 = 当前空间档的满湿度 */
  reverbWet: number;
  /** 合成后的总对齐偏移（userOffsetMs − autoOffsetMs，已钳制），ms；可正可负 */
  offsetMs: number;
  /** 服务端实测归一化增益；null = 老作品，按 0dB 基准 */
  levels: WorkLevels | null;

  eqLowDb: number;
  eqMidDb: number;
  eqHighDb: number;
  compression: number;
  deEss: number;
  /** 预览没有 FFT 降噪的对应节点，只会影响服务端成品 */
  noiseReduction: boolean;
}

/**
 * 人声预设（10 种）。
 *
 * 它**不是**一个不透明 DSP 参数：预设只是「一组具名参数默认值」
 * （见 shared/mix.ts 的 VOCAL_PRESET_SPECS），点一下就把数值写进
 * eqLowDb / reverbSpace 等**音效**字段。这样实时试听与服务端天然同构，
 * 用户也能在预设基础上继续手调。
 *
 * **预设只管音效（均衡 + 混响）**：修音三项（compression / deEss /
 * noiseReduction）与预设完全解耦，默认关闭 —— 点预设不会打开它们，
 * 手调的修音值跨预设切换原样保留，拖修音也不影响预设高亮。
 */
export const VOCAL_PRESETS = [
  'natural',
  'warm',
  'bright',
  'sweet',
  'magnetic',
  'ethereal',
  'soft',
  'powerful',
  'retro',
  'live',
] as const;

export type VocalPreset = (typeof VOCAL_PRESETS)[number];

export const VOCAL_PRESET_LABELS: Record<VocalPreset, string> = {
  natural: '自然',
  warm: '温暖',
  bright: '明亮',
  sweet: '甜美',
  magnetic: '磁性',
  ethereal: '空灵',
  soft: '轻柔',
  powerful: '有力',
  retro: '复古',
  live: '现场',
};

export interface MixParams {
  /** 人声音量 0–2 */
  vocalGain: number;
  /** 伴奏音量 0–2 */
  accompGain: number;
  /**
   * 混响空间 0–1：REVERB_ANCHORS 八个档位之间的连续位置。
   * 老作品里这一项是 `reverb: 'hall'` 这样的档位名，读取时映射到锚点位置（i/7），
   * 因此老作品重新合成的出声与改动前逐字节一致（tests/db.test.ts 守着）。
   */
  reverbSpace: number;
  /** 混响湿度 0–1：0 = 旁通（干声），1 = 当前空间档的满湿度；预设写入的起点即 1 或略低 */
  reverbWet: number;
  /** 人声对齐微调 -1000–1000 ms：正值=人声更晚（抢拍时用），负值=人声更早（拖拍时用） */
  userOffsetMs: number;

  /* ------------------------------- 音效 ------------------------------- */

  /**
   * 最后点过的预设（UI 高亮用）。
   * **不参与 DSP** —— 真正生效的是下面那些数值字段。这样就不存在
   * 「预设与滑块谁说了算」的歧义，也不会前后端推导出不同的结果。
   * 预设只写「音效」字段（均衡 + 混响）；修音三项与预设解耦，默认关闭。
   */
  vocalPreset: VocalPreset;
  /** 均衡：低/中/高，−12..+12 dB */
  eqLowDb: number;
  eqMidDb: number;
  eqHighDb: number;
  /** 压缩量 0..1（0 = 不压缩） */
  compression: number;
  /** 去齿音强度 0..1（0 = 关） */
  deEss: number;
  /** 人声降噪开关（FFT 降噪，只该在录音有明显底噪时开） */
  noiseReduction: boolean;
}

/**
 * 升降调（移调）的状态。
 *
 *  · ready      当前调的伴奏可用（原调，或移调伴奏已经生成好）
 *  · processing 正在生成移调伴奏（这期间播放/演唱听到的还是原调）
 *  · failed     移调失败（原因见 TrackSummary.pitchError）
 *
 * 之所以单独一个状态而不是复用 tracks.status：移调是「在可用伴奏之上再派生
 * 一份文件」，原伴奏始终能播 —— 混在一起会让演唱页把「正在移调」说成
 * 「这个伴奏坏了」，而真相只是新调还没出来。
 */
export type PitchStatus = 'ready' | 'processing' | 'failed';

/** 伴奏的公共字段（不含歌词正文）—— 列表、详情、单条都从这里派生 */
export interface TrackSummary {
  id: string;
  title: string;
  artist: string | null;
  kind: TrackKind;
  originalName: string;
  mime: string | null;
  size: number;
  /** 秒 */
  duration: number | null;
  status: TrackStatus;
  proxyKind: ProxyKind;
  error: string | null;
  createdAt: number;
  /** 歌词全局微调（ms）：正值 = 歌词更晚显示（与 [offset:] 标签方向相反，见 shared/lrc.ts） */
  lyricsOffsetMs: number;
  /**
   * 有没有歌词。列表接口只下发这个布尔值，不下发歌词正文 ——
   * 一个几百首的库每次轮询都带上全部 LRC 是几十倍的浪费。
   */
  hasLyrics: boolean;
  source: TrackSource;
  /**
   * 升降调（半音，−12…+12）；0 = 原调。
   *
   * 移的是**伴奏**：设成非 0 时服务端会生成一份移调伴奏，演唱时耳机里听到的、
   * 实时试听里放的、成品 MP3 里混的，全是那一份 —— 歌手照着新调唱，人声不用动。
   * 人声（干声）永远不做移调：它是「你真实的声音」，移了反而不自然。
   */
  pitchSemitones: number;
  /** 移调伴奏的状态（见 PitchStatus） */
  pitchStatus: PitchStatus;
  /** 移调失败的原因；null = 没失败 */
  pitchError: string | null;
}

/** 单个伴奏详情：在列表字段之上带歌词正文（演唱页跟唱要它） */
export interface Track extends TrackSummary {
  /**
   * 规范化后的 LRC 歌词文本；null = 这个伴奏没有歌词。
   * 只存原始 LRC，解析交给 shared/lrc.ts 在两端各自执行 ——
   * 库里存一份「解析结果」迟早会和解析器版本对不上。
   */
  lyrics: string | null;
}

/** 列表接口返回的伴奏，附带转码进度（0–1，仅 processing 时有值） */
export interface TrackListItem extends TrackSummary {
  progress: number | null;
  /**
   * 这个伴奏下有几个作品。
   * 只给列表：删除伴奏时作品会保留（不能再混音），卡片上要把这个数量说清楚。
   */
  workCount: number;
}

/**
 * 单条伴奏接口的返回：既要歌词正文（演唱页），也要转码进度（等转码时显示百分比）。
 */
export interface TrackDetail extends Track {
  progress: number | null;
}

export interface Work {
  id: string;
  /**
   * 伴奏 id；null = 伴奏已被删除。
   *
   * 删除伴奏不再拦截（作品与伴奏解耦）：作品记录和成品 MP3 都保留，
   * 只是不能再试听 / 重新合成。数据库靠 ON DELETE SET NULL 自动脱钩。
   */
  trackId: string | null;
  title: string;
  /** 秒 */
  vocalDuration: number;
  /**
   * 自动测得的「起录 → 伴奏真正起播」间隔（ms，恒为正数 G）。
   * 干声 WAV 的 t=0 是起录时刻，混音时人声要提前 G 才对得上伴奏时间轴，
   * 因此最终偏移 = mixParams.userOffsetMs − autoOffsetMs（可为负）。
   */
  autoOffsetMs: number;
  mixParams: MixParams;
  /** 最近一次成功混音的实测增益；实时预览对齐成品电平用，老作品为 null */
  levels: WorkLevels | null;
  /**
   * 混音时伴奏处在哪个调（半音，−12…+12）的快照；0 = 原调。
   *
   * 快照而不是去问伴奏的当前设置：用户随时可以改伴奏的升降调，而已经混好的
   * 成品里混的永远是「混音那一刻」的那一档。实时去问，老作品的徽章就会跟着
   * 伴奏乱变，说的和成品里放的不是一回事。每次（重新）合成前刷新一次，
   * 见 server/src/routes/works.ts 的 startMix。
   */
  pitchSemitones: number;
  status: WorkStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkListItem extends Work {
  trackTitle: string | null;
  trackKind: TrackKind | null;
  /**
   * 伴奏歌手；null = 伴奏已删除或本来就没有歌手信息。
   * 作品库列表要用它做「伴奏：歌名 · 歌手」的一行展示，搜索也按它匹配。
   */
  trackArtist: string | null;
  /**
   * 混音时伴奏处在哪个调（半音，−12…+12）；0 = 原调或伴奏已删除。
   * 作品库卡片据此显示「+3 半音」—— 移调过的作品听起来调不一样，
   * 列表里必须能看出来。取自作品自己的快照（Work.pitchSemitones），
   * 不是伴奏的当前设置：后者会随后者改动而变，徽章就不能信了。
   */
  trackPitchSemitones: number;
  /**
   * 成品 MP3 的文件大小（字节）；null = 还没合成成功或文件已丢失。
   * 列表接口顺带 fs.stat 出来（本地文件，失败只影响这一个字段）。
   */
  sizeBytes: number | null;
  /**
   * 有没有「重录前的上一版干声」可撤销（分段重录的备份）。
   * 只回退一级：再重录一次，备份就被更新成更新前的那一版。
   */
  hasPrevVocal: boolean;
}

/**
 * 升降调的限制：半音数 ±12（一个八度），步进 1。
 *
 * 服务端校验与前端控件都从这里取。±12 已是实用极限：再大的移调量，
 * 相位声码器的音质损失和「听起来像另一首歌」的程度都会超过收益。
 */
export const PITCH_LIMITS = {
  semitones: { min: -12, max: 12, step: 1 },
} as const;

export const MIX_LIMITS = {
  gain: { min: 0, max: 2, step: 0.05 },
  userOffsetMs: { min: -1000, max: 1000, step: 10 },
  /** 均衡三段：−12..+12 dB */
  eqDb: { min: -12, max: 12, step: 0.5 },
  /** 「量」类参数（压缩量 / 去齿音强度）：0..1 */
  amount: { min: 0, max: 1, step: 0.05 },
  /**
   * 混响：空间轴 0–1（8 档锚点均分）+ 湿度 0–1。
   * 步进 0.01 = 1%：拖动跟手，又不至于每像素都重建一次试听 IR。
   */
  reverb: {
    space: { min: 0, max: 1, step: 0.01 },
    wet: { min: 0, max: 1, step: 0.01 },
  },
} as const;

/** 歌词相关的共用限制：服务端校验与前端控件都从这里取 */
export const LRC_LIMITS = {
  /** 歌词全局微调范围（ms）：正值 = 歌词更晚显示 */
  offsetMs: { min: -30_000, max: 30_000, step: 100 },
  /** 单个 .lrc 文件上限；一首歌的 LRC 通常不到 20KB */
  maxBytes: 1024 * 1024,
  /** 歌词文本长度上限（UTF-16 码元），防止把整本书贴进来 */
  maxChars: 100_000,
} as const;

/**
 * 默认参数：新参数的默认值**全部是中性的**。
 * 老作品的 mix_params JSON 里没有这些键，parseMixParams 会回落到这里，
 * 因此老作品重新合成的出声与本次改动前逐字节一致（有测试守着）。
 */
export const DEFAULT_MIX_PARAMS: MixParams = {
  vocalGain: 1,
  accompGain: 1,
  // room 锚点 + 满湿度：与旧默认 reverb:'room' 同一声（零回归）
  reverbSpace: REVERB_ANCHORS[1]!.position,
  reverbWet: 1,
  userOffsetMs: 0,
  vocalPreset: 'natural',
  eqLowDb: 0,
  eqMidDb: 0,
  eqHighDb: 0,
  compression: 0,
  deEss: 0,
  noiseReduction: false,
};

export const REVERB_LABELS: Record<ReverbKind, string> = {
  dry: '原声',
  room: '小房间',
  plate: '金属板',
  hall: '大厅',
  stage: '演唱会',
  cathedral: '教堂',
  arena: '体育场',
  canyon: '峡谷',
};

/** 用户录音的绝对上限（毫秒），前端与后端共用 */
export const MAX_RECORD_MS = 15 * 60 * 1000;
/** 低于该时长的录音拒绝出片 */
export const MIN_RECORD_MS = 1000;

/* --------------------------------- 分段重录 --------------------------------- */

/**
 * 分段重录的共用限制：服务端校验与前端控件都从这里取。
 *
 * 一次重录只替换干声时间轴上的 [startSec, endSec) 一段；拼接在服务端做，
 * 两端边界用 fadeSec 的交叉淡化防咔哒声，输出干声总长不变（vocalDuration 不动）。
 */
export const RETAKE_LIMITS = {
  /** 重录时伴奏从「片段开始前这么多个秒」响起，给歌手找拍（lead-in） */
  leadInSec: 3,
  /** 片段时长下限（秒）：再短的片段，拼接对齐的收益还没边界噪声大 */
  minSegmentSec: 0.3,
  /** 拼接边界交叉淡化时长（秒）；头部「旧淡出/新淡入」、尾部「新淡出/旧淡入」 */
  fadeSec: 0.02,
  /** 伴奏过「片段结束」后这么久自动停录（秒）——之后唱得再好也不会被采用 */
  tailSec: 1,
} as const;

/** 上传单文件上限：1GB */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

/* --------------------------------- 曲库点歌 --------------------------------- */

export type LibraryItemKind = 'audio' | 'video';

/**
 * 下发给前端的曲库条目。
 *
 * 刻意**不含**源站的下载地址（url / lrcUrl）——下载由服务端发起，
 * 浏览器不需要也不该知道这些地址。
 */
export interface LibraryItemDto {
  providerId: string;
  itemId: string;
  title: string;
  artist: string | null;
  durationSec: number | null;
  kind: LibraryItemKind;
  sizeBytes: number | null;
  /** 源站提供了 LRC；点歌时会一并入库 */
  hasLyrics: boolean;
}

/** 每个曲库源的状态：某个源挂了不该让整个搜索报错 */
export interface LibrarySourceStatus {
  id: string;
  label: string;
  ok: boolean;
  count: number;
  error: string | null;
}

export interface LibrarySearchResult {
  items: LibraryItemDto[];
  sources: LibrarySourceStatus[];
}

export type LibraryTaskState = 'queued' | 'running' | 'done' | 'failed';

/** 点歌任务的下发形态（不含服务端内部的 jobKey） */
export interface LibraryTaskDto {
  taskId: string;
  title: string;
  state: LibraryTaskState;
  /** 0–1 */
  progress: number;
  /** 完成后指向入库的伴奏 id */
  trackId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/* --------------------------------- 手机演唱 --------------------------------- */

/**
 * 手机端入口信息（`GET /api/network`）。
 *
 * 桌面页用它渲染二维码：手机连同一个 WiFi，扫码即开移动端演唱页。
 * 所有字段都是「如实描述现状」—— 镜像没起来、入口降级成 http，
 * 都要让页面能说清楚为什么，而不是给一个点不开的二维码。
 */
export interface NetworkInfo {
  /** 这台机器的局域网 IPv4；空数组 = 没连网 */
  lanAddresses: string[];
  /** 手机端页面路径（'/m'） */
  mobilePath: string;
  /** 手机入口的协议与端口；null = 一个入口都拼不出来 */
  mobileOrigin: { scheme: 'http' | 'https'; port: number } | null;
  /** 二维码用的完整地址（取第一个网卡）；null = 同上 */
  mobileUrl: string | null;
  /** 全部网卡对应的完整地址（二维码用第一个，其余列出来供手输） */
  mobileUrls: string[];
  /** 入口是自签名 HTTPS：手机首次要手动信任证书 */
  selfSigned: boolean;
  /**
   * http 入口的坑：手机浏览器只在安全上下文里开放麦克风，
   * `http://<局域网IP>` 会被直接禁用（W3C Secure Contexts §3.1）。
   * true 时页面能浏览/播放，但录不了音。
   */
  micBlocked: boolean;
  /**
   * 服务端要求访问令牌（ACCESS_TOKEN 配了）。
   * true 时 mobileUrl / mobileUrls 已带 `?token=`，二维码扫码即用；
   * 桌面端页面据此在需要时提示输入令牌。
   */
  tokenRequired: boolean;
  /** 说明 / 告警；一切正常时为 null */
  reason: string | null;
}
