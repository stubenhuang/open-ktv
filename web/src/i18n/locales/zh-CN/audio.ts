//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Messages } from '../../types.ts';

/**
 * 分区文案：audio
 *
 * 命名规范：`audio.<语义>`，语义用 snake_case，保持稳定、可读、不随文案改动而改。
 * 详见 CONTRIBUTING.md 的「Internationalisation (i18n)」一节。
 */
const audio: Messages = {
  /* ------------------------------ 麦克风与设备 ------------------------------ */
  'audio.micUnsupported': '这个浏览器不支持麦克风采集，请换 Chrome 或 Edge',
  'audio.micPermissionDenied': '麦克风权限被拒绝了。请点地址栏左侧的图标把麦克风权限改成「允许」，然后重试。',
  'audio.micNoneFound': '没有检测到任何麦克风设备，请插上耳麦后重试。',
  'audio.micOpenFailed': '打开麦克风失败：{reason}',
  'audio.micListFailed': '读取麦克风设备失败',
  /** enumerateDevices 还没给出 label 时（权限未授 / 匿名设备）的兜底名字 */
  'audio.micFallbackName': '麦克风 {index}',

  /* ------------------------------- 录音引擎 ------------------------------- */
  'audio.workletLoadFailed': '录音模块加载失败：{reason}',
  'audio.accompPlayBlocked': '伴奏播放被浏览器拦住了：{reason}',
  'audio.accompPlayBlockedRetry': '伴奏播放被浏览器拦住了：{reason}。请再点一次「开始演唱」。',
  'audio.micNotConnected': '还没有可用的麦克风',
  'audio.notRecording': '当前没有在录音',

  /* ------------------------------- 实时试听 ------------------------------- */
  'audio.preview.vocal': '干声',
  'audio.preview.accomp': '伴奏',
  'audio.preview.loadFailed': '{label}加载失败（HTTP {status}）',
  'audio.preview.decodeFailed': '{label}解码失败：{reason}',

  /* ------------------------------ 人声预设词汇 ------------------------------ */
  /** 与 shared/types.ts 的 VOCAL_PRESETS 一一对应；桌面/手机混音面板与作品卡共用 */
  'audio.preset.natural': '自然',
  'audio.preset.warm': '温暖',
  'audio.preset.bright': '明亮',
  'audio.preset.sweet': '甜美',
  'audio.preset.magnetic': '磁性',
  'audio.preset.ethereal': '空灵',
  'audio.preset.soft': '轻柔',
  'audio.preset.powerful': '有力',
  'audio.preset.retro': '复古',
  'audio.preset.live': '现场',
  'audio.preset.title': '人声预设',

  /* -------------------------------- 混响词汇 -------------------------------- */
  /** 与 shared/types.ts 的 REVERB_KINDS 一一对应：空间轴上的 8 个档位名（刻度/读数） */
  'audio.reverb.kind.dry': '原声',
  'audio.reverb.kind.room': '小房间',
  'audio.reverb.kind.plate': '金属板',
  'audio.reverb.kind.hall': '大厅',
  'audio.reverb.kind.stage': '演唱会',
  'audio.reverb.kind.cathedral': '教堂',
  'audio.reverb.kind.arena': '体育场',
  'audio.reverb.kind.canyon': '峡谷',
  /** 作品卡上的混响摘要：{{space}} 是档位名、{{wet}} 是湿度百分比 */
  'audio.reverb.summary': '{space} {wet}%',
  'audio.reverb.title': '人声混响',
  'audio.reverb.space': '空间',
  'audio.reverb.wet': '湿度',
  'audio.reverb.dry': '干声',

  /* -------------------------------- 均衡词汇 -------------------------------- */
  'audio.eq.title': '均衡',
  'audio.eq.low': '低音',
  'audio.eq.mid': '中音',
  'audio.eq.high': '高音',
  'audio.eq.bands': '低 200Hz · 中 1.2kHz · 高 4kHz',

  /* -------------------------------- 音量词汇 -------------------------------- */
  'audio.gain.title': '音量',
  'audio.gain.vocal': '人声音量',
  'audio.gain.accomp': '伴奏音量',
  /** 手机端排版紧，标签用短名（桌面用上面的全名） */
  'audio.gain.vocalShort': '人声',
  'audio.gain.accompShort': '伴奏',
  'audio.gain.muted': '静音',

  /* -------------------------------- 修音词汇 -------------------------------- */
  'audio.repair.title': '修音',
  'audio.repair.compression': '压缩',
  'audio.repair.deEss': '去齿音',
  'audio.repair.noiseReduction': '降噪',
  'audio.repair.summary': '压缩 · 去齿音 · 降噪 · 不受预设影响',
  /** 去齿音滑到 0 时的读数 */
  'audio.repair.off': '关闭',
  'audio.repair.compressionHint': '把大小声拉近，小声的句子不会被伴奏盖住。',
  'audio.repair.deEssHint': '压掉「嘶 / 次」这类刺耳的高频。试听里是近似效果，成品里才是真正的处理。',
  'audio.repair.noiseReductionHint': '只该在录音有明显底噪时开。实时试听里不生效，只在「合成」后的成品里生效。',

  /* ------------------------------ 人声对齐词汇 ------------------------------ */
  'audio.offset.title': '人声对齐',
  'audio.offset.range': '±1000ms',
  'audio.offset.hint': '正值 = 人声更晚（抢拍），负值 = 更早（拖拍）。起录时那段静音已自动扣除。',

  /* ------------------------------ 升降调词汇 ------------------------------ */
  'audio.pitch.title': '升降调',
  /** 0 半音时的读数 / 「回到原调」按钮 */
  'audio.pitch.original': '原调',
  /** 非 0 半音时的读数，{semitones} 已带符号（见 i18n/labels.ts 的 pitchLabel） */
  'audio.pitch.shifted': '{semitones} 半音',

  /* --------------------------------- 单位 --------------------------------- */
  'audio.unit.decibel': 'dB',
};

export default audio;
