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

/** 混响档位；数组本身就是唯一来源，前后端都从这里取顺序（服务端另用它做白名单） */
export const REVERB_KINDS = ['dry', 'room', 'hall', 'stage'] as const;

export type ReverbKind = (typeof REVERB_KINDS)[number];

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
  reverb: ReverbKind;
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
 * 音效预设。
 *
 * 它**不是**一个不透明 DSP 参数：预设只是「一组具名参数默认值」
 * （见 shared/mix.ts 的 VOCAL_PRESET_SPECS），点一下就把数值写进
 * eqLowDb / compression / reverb 等字段。这样实时试听与服务端天然同构，
 * 用户也能在预设基础上继续手调。
 */
export const VOCAL_PRESETS = ['natural', 'warm', 'bright', 'magnetic', 'ethereal', 'powerful'] as const;

export type VocalPreset = (typeof VOCAL_PRESETS)[number];

export const VOCAL_PRESET_LABELS: Record<VocalPreset, string> = {
  natural: '自然',
  warm: '温暖',
  bright: '明亮',
  magnetic: '磁性',
  ethereal: '空灵',
  powerful: '有力',
};

export interface MixParams {
  /** 人声音量 0–2 */
  vocalGain: number;
  /** 伴奏音量 0–2 */
  accompGain: number;
  reverb: ReverbKind;
  /** 人声对齐微调 -1000–1000 ms：正值=人声更晚（抢拍时用），负值=人声更早（拖拍时用） */
  userOffsetMs: number;

  /* ------------------------------- 音效 ------------------------------- */

  /**
   * 最后点过的预设（UI 高亮用）。
   * **不参与 DSP** —— 真正生效的是下面那些数值字段。这样就不存在
   * 「预设与滑块谁说了算」的歧义，也不会前后端推导出不同的结果。
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
}

/**
 * 单条伴奏接口的返回：既要歌词正文（演唱页），也要转码进度（等转码时显示百分比）。
 */
export interface TrackDetail extends Track {
  progress: number | null;
}

export interface Work {
  id: string;
  trackId: string;
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
  status: WorkStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkListItem extends Work {
  trackTitle: string | null;
  trackKind: TrackKind | null;
}

export const MIX_LIMITS = {
  gain: { min: 0, max: 2, step: 0.05 },
  userOffsetMs: { min: -1000, max: 1000, step: 10 },
  /** 均衡三段：−12..+12 dB */
  eqDb: { min: -12, max: 12, step: 0.5 },
  /** 「量」类参数（压缩量 / 去齿音强度）：0..1 */
  amount: { min: 0, max: 1, step: 0.05 },
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
  reverb: 'room',
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
  dry: '原声（无混响）',
  room: '小房间',
  hall: '大厅',
  stage: '演唱会',
};

/** 用户录音的绝对上限（毫秒），前端与后端共用 */
export const MAX_RECORD_MS = 15 * 60 * 1000;
/** 低于该时长的录音拒绝出片 */
export const MIN_RECORD_MS = 1000;

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
