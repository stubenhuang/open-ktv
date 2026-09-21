/**
 * 前后端共享的类型与常量。
 *
 * 注意：web 端只能用 `import type` 引入本文件的类型（这样会被完全擦除），
 * 运行时常量（MIX_LIMITS / DEFAULT_MIX_PARAMS 等）走普通 import。
 */

export type TrackKind = 'audio' | 'video';

/** processing = 正在转码代理；ready = 可演唱；failed = 探测或转码失败 */
export type TrackStatus = 'processing' | 'ready' | 'failed';

/** none = 原文件浏览器可播；video = 转出了 mp4 代理；audio = 转出了 mp3 代理 */
export type ProxyKind = 'none' | 'video' | 'audio';

export type WorkStatus = 'mixing' | 'ready' | 'failed';

export type ReverbKind = 'dry' | 'room' | 'hall' | 'stage';

/**
 * 最近一次成功混音时实测的两轨归一化增益（dB）。
 * 前端实时预览用它复算电平，才能和成品 MP3 的绝对音量对齐。
 */
export interface WorkLevels {
  vocalGainDb: number;
  accompGainDb: number;
}

/** 实时预览引擎的输入参数（偏移已合成、增益已复算） */
export interface PreviewParams {
  vocalGain: number;
  accompGain: number;
  reverb: ReverbKind;
  /** 合成后的总对齐偏移（autoOffsetMs + userOffsetMs，已钳制），ms */
  offsetMs: number;
  /** 服务端实测归一化增益；null = 老作品，按 0dB 基准 */
  levels: WorkLevels | null;
}

export interface MixParams {
  /** 人声音量 0–2 */
  vocalGain: number;
  /** 伴奏音量 0–2 */
  accompGain: number;
  reverb: ReverbKind;
  /** 人声对齐微调 -1000–1000 ms */
  userOffsetMs: number;
}

export interface Track {
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
}

/** 列表接口返回的伴奏，附带转码进度（0–1，仅 processing 时有值） */
export interface TrackListItem extends Track {
  progress: number | null;
}

export interface Work {
  id: string;
  trackId: string;
  title: string;
  /** 秒 */
  vocalDuration: number;
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
} as const;

export const DEFAULT_MIX_PARAMS: MixParams = {
  vocalGain: 1,
  accompGain: 1,
  reverb: 'room',
  userOffsetMs: 0,
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
