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
  'audio.micUnsupported': 'This browser doesn\'t support microphone capture. Please switch to Chrome or Edge.',
  'audio.micPermissionDenied': 'Microphone access was denied. Click the icon to the left of the address bar, set microphone permission to "Allow", and try again.',
  'audio.micNoneFound': 'No microphone was detected. Plug in a headset and try again.',
  'audio.micOpenFailed': 'Couldn\'t open the microphone: {reason}',
  'audio.micListFailed': 'Failed to read the microphone device list',
  /** Placeholder name until enumerateDevices reports a label (permission not granted yet) */
  'audio.micFallbackName': 'Microphone {index}',

  /* ------------------------------- 录音引擎 ------------------------------- */
  'audio.workletLoadFailed': 'Failed to load the recording module: {reason}',
  'audio.accompPlayBlocked': 'The browser blocked playback of the accompaniment: {reason}',
  'audio.accompPlayBlockedRetry': 'The browser blocked playback of the accompaniment: {reason}. Tap "Start singing" once more.',
  'audio.micNotConnected': 'No microphone is connected yet',
  'audio.notRecording': 'Not currently recording',

  /* ------------------------------- 实时试听 ------------------------------- */
  'audio.preview.vocal': 'vocal track',
  'audio.preview.accomp': 'accompaniment track',
  'audio.preview.loadFailed': 'Failed to load the {label} (HTTP {status})',
  'audio.preview.decodeFailed': 'Failed to decode the {label}: {reason}',

  /* ------------------------------ 人声预设词汇 ------------------------------ */
  /** 与 shared/types.ts 的 VOCAL_PRESETS 一一对应；桌面/手机混音面板与作品卡共用 */
  'audio.preset.natural': 'Natural',
  'audio.preset.warm': 'Warm',
  'audio.preset.bright': 'Bright',
  'audio.preset.sweet': 'Sweet',
  'audio.preset.magnetic': 'Magnetic',
  'audio.preset.ethereal': 'Ethereal',
  'audio.preset.soft': 'Soft',
  'audio.preset.powerful': 'Powerful',
  'audio.preset.retro': 'Retro',
  'audio.preset.live': 'Live',
  'audio.preset.title': 'Vocal presets',

  /* -------------------------------- 混响词汇 -------------------------------- */
  /** 与 shared/types.ts 的 REVERB_KINDS 一一对应：空间轴上的 8 个档位名（刻度/读数） */
  'audio.reverb.kind.dry': 'Dry',
  'audio.reverb.kind.room': 'Room',
  'audio.reverb.kind.plate': 'Plate',
  'audio.reverb.kind.hall': 'Hall',
  'audio.reverb.kind.stage': 'Stage',
  'audio.reverb.kind.cathedral': 'Cathedral',
  'audio.reverb.kind.arena': 'Arena',
  'audio.reverb.kind.canyon': 'Canyon',
  /** 作品卡上的混响摘要：{space} 是档位名、{wet} 是湿度百分比 */
  'audio.reverb.summary': '{space} {wet}%',
  'audio.reverb.title': 'Vocal reverb',
  'audio.reverb.space': 'Space',
  'audio.reverb.wet': 'Wetness',
  'audio.reverb.dry': 'Dry',

  /* -------------------------------- 均衡词汇 -------------------------------- */
  'audio.eq.title': 'Equalizer',
  'audio.eq.low': 'Low shelf',
  'audio.eq.mid': 'Mid',
  'audio.eq.high': 'High shelf',
  'audio.eq.bands': 'Low 200Hz · Mid 1.2kHz · High 4kHz',

  /* -------------------------------- 音量词汇 -------------------------------- */
  'audio.gain.title': 'Levels',
  'audio.gain.vocal': 'Vocal level',
  'audio.gain.accomp': 'Accompaniment level',
  /** 手机端排版紧，标签用短名（桌面用上面的全名） */
  'audio.gain.vocalShort': 'Vocal',
  'audio.gain.accompShort': 'Accompaniment',
  'audio.gain.muted': 'Muted',

  /* -------------------------------- 修音词汇 -------------------------------- */
  'audio.repair.title': 'Vocal repair',
  'audio.repair.compression': 'Compression',
  'audio.repair.deEss': 'De-esser',
  'audio.repair.noiseReduction': 'Noise reduction',
  'audio.repair.summary': 'Compression · de-esser · noise reduction · unaffected by presets',
  /** 去齿音滑到 0 时的读数 */
  'audio.repair.off': 'Off',
  'audio.repair.compressionHint': 'Pulls loud and quiet passages together so quiet lines are not buried by the accompaniment.',
  'audio.repair.deEssHint': 'Tames harsh “s” and “t” high frequencies. The preview approximates it; the rendered file gets the real processing.',
  'audio.repair.noiseReductionHint':
    'Enable only when the recording has obvious background noise. It does not apply in the live preview — only in the rendered result.',

  /* ------------------------------ 人声对齐词汇 ------------------------------ */
  'audio.offset.title': 'Vocal alignment',
  'audio.offset.range': '±1000ms',
  'audio.offset.hint': 'Positive = vocals later (rushing); negative = earlier (dragging). The silence at the start of the take is already accounted for.',

  /* ------------------------------ 升降调词汇 ------------------------------ */
  'audio.pitch.title': 'Pitch shift',
  /** 0 半音时的读数 / 「回到原调」按钮 */
  'audio.pitch.original': 'Original key',
  /** 非 0 半音时的读数，{semitones} 已带符号（见 i18n/labels.ts 的 pitchLabel） */
  'audio.pitch.shifted': '{semitones} semitones',

  /* --------------------------------- 单位 --------------------------------- */
  'audio.unit.decibel': 'dB',
};

export default audio;
