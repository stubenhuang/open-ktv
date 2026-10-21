//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Messages } from '../../types.ts';

/**
 * 分区文案：components
 *
 * 命名规范：`components.<语义>`，语义用 snake_case，保持稳定、可读、不随文案改动而改。
 * 详见 CONTRIBUTING.md 的「Internationalisation (i18n)」一节。
 *
 * 这个分区放**跨页面复用的组件**自己的文案（手机演唱菜单、确认框、toast、骨架屏…）。
 * 只在一个页面里出现的文案放那个页面的分区，不要放这里。
 */
const components: Messages = {
  /* ---------------------------- 手机演唱入口菜单 ---------------------------- */
  'components.phone.title': 'Sing on phone',
  'components.phone.aria': 'Sing on phone: scan the QR code',
  'components.phone.loading': 'Reading the LAN address…',
  'components.phone.noEntry': 'There is no mobile entry available right now.',
  'components.phone.readFailed': 'Could not read the network information',
  'components.phone.qrAlt': 'Scan to sing on your phone',
  'components.phone.hint': 'Join the same WiFi and scan to open the mobile singing page.',
  'components.phone.tokenHint':
    'Access protection is on. The QR code already carries the token, so scanning just works — no typing needed.',
  'components.phone.micBlocked': 'Over an http entry the phone browser disables the microphone.',
  'components.phone.certHint':
    'The first visit warns about an untrusted certificate: choose “Advanced → Continue” (on iPhone: “Show details → visit website”).',
  'components.phone.downloadCert': 'Download certificate',
  'components.phone.headphones':
    'Wear headphones: speaker output leaks into the microphone and ends up in the mix.',

  /* -------------------------------- 确认框 -------------------------------- */
  'components.confirm.title': 'Please confirm',
  'components.confirm.ok': 'Confirm',
  'components.confirm.cancel': 'Cancel',

  /* -------------------------------- 轻提示 -------------------------------- */
  'components.toast.close': 'Dismiss notification',

  /* -------------------------------- 令牌闸门 -------------------------------- */
  'components.token.title': 'Access token required',
  'components.token.hint': 'This service is protected. Enter the token to continue.',
  'components.token.placeholder': 'Access token',
  'components.token.submit': 'Enter',
  'components.token.failed': 'That token is not right. Please try again.',

  /* ------------------------------ 实时试听卡片 ------------------------------ */
  'components.preview.title': 'Live preview',
  'components.preview.hint':
    'Dry vocals and accompaniment are mixed in the browser in real time: dragging a slider or changing a millisecond value takes effect immediately without interrupting playback. This is only a preview — tap “Mix” and the server renders a brand-new MP3.',
  'components.preview.play': '▶ Preview',
  'components.preview.pause': '⏸ Pause',
  'components.preview.liveBadge': 'Changes apply instantly',
  'components.preview.failed':
    'Preview failed: {reason} (you can still listen to the rendered MP3 in your library, or tap “Preview” to try again)',
  /** 浏览器拦截等极端情况：抛到控制台排障（log.error 用的也是目录文案） */
  'components.preview.playFailed': 'Playback failed',

  /* -------------------------------- 跟唱歌词 -------------------------------- */
  'components.lyrics.seekHint': 'Tap a line to jump to that moment',
  'components.lyrics.seekLocked': 'Cannot seek while recording',

  /* --------------------------------- 播放器 --------------------------------- */
  'components.player.seek': 'Playback position',

  /* --------------------------------- 升降调 --------------------------------- */
  'components.pitch.aria': 'Accompaniment pitch shift (semitones)',
  'components.pitch.unsupported':
    'This ffmpeg build has no rubberband, so pitch shift is unavailable (everything else still works). Build with --enable-librubberband to enable it.',
  'components.pitch.generating':
    'Rendering the pitch-shifted accompaniment (a few seconds)… Playback and the preview still sound in the original key until it is ready, then they swap over automatically.',
  'components.pitch.failed': 'Pitch shift failed: {reason}',
  'components.pitch.ready':
    'The accompaniment has been rendered in {pitch}: singing, the live preview and the final MP3 all use this version.',
  'components.pitch.originalHint':
    'Playing in the original key. If it is too high to sing, drag right — the whole accompaniment shifts and the length stays the same.',
  'components.pitch.saveFailed': 'Could not save the pitch shift',

  /* -------------------------------- 混音面板 -------------------------------- */
  'components.mix.title': 'Adjust effects',
  'components.mix.hint':
    'Every change goes straight into the “Live preview” above; tap “Mix” to render a new MP3 from the dry vocals, then head back to your library.',
  'components.mix.groupEffects': 'Sound',
  'components.mix.effectsHint': '{count} presets · space and wetness continuously adjustable',
  'components.mix.presetCurrent': 'Current: {preset}',
  'components.mix.presetManual': 'Adjusted manually',
  'components.mix.presetHint':
    'Tap once to write the EQ and reverb starting points into the sliders below, then keep tweaking by hand; the repair controls (compression / de-esser / noise reduction) are unaffected by presets and off by default.',
  'components.mix.reverbHint':
    '“Space” moves continuously from dry to canyon — the 8 ticks under the slider are the old preset names; “Wetness” controls the reverb amount independently, and 0% is dry. Both axes can be fine-tuned; presets are only a starting point.',
  'components.mix.reverbNote':
    '“Space” moves continuously between dry / room / plate / hall / stage / cathedral / arena / canyon, while “Wetness” controls the reverb amount independently (0% = dry); presets are only a starting point — keep tweaking and the preview updates instantly.',
  'components.mix.reverbAxes': 'Space small → large · wetness independent',
  'components.mix.repairNote':
    'The de-esser is approximate in the preview; enable noise reduction only when the recording has obvious background noise, and note that it **only applies to the rendered result**.',
  'components.mix.apply': 'Mix',
  'components.mix.applying': 'Mixing…',

  /* ------------------------------ 编辑伴奏弹窗 ------------------------------ */
  'components.trackEdit.title': 'Edit accompaniment',
  'components.trackEdit.subtitle': 'Rename the track, paste lyrics, fine-tune lyric timing.',
  'components.trackEdit.lyricsLabel': 'Lyrics (LRC)',
  'components.trackEdit.lyricsExisting': 'Lyrics exist — your changes will overwrite them',
  'components.trackEdit.lyricsNone': 'No lyrics yet',
  'components.trackEdit.lyricsLoading': 'Loading lyrics…',
  'components.trackEdit.lyricsPlaceholder': 'Every line needs a timestamp, e.g.:\n[00:12.00]First line\n[00:16.50]Second line',
  'components.trackEdit.pickLrc': 'Choose an .lrc file',
  'components.trackEdit.autoLyrics': 'Fetch lyrics automatically',
  'components.trackEdit.clearLyrics': 'Clear lyrics',
  'components.trackEdit.autoLyricsHint': 'Automatic fetch: matches an LRC from Kugou by title and artist.',
  'components.trackEdit.lyricsOffset': 'Lyric timing',
  'components.trackEdit.lyricsOffsetHint':
    'Positive values show lyrics later; if the lyrics run ahead of the accompaniment, drag right.',
  'components.trackEdit.saved': 'Saved',
  'components.trackEdit.lyricsSaved': 'Lyrics saved',
  'components.trackEdit.lyricsAutoSaved': 'Lyrics fetched',
  'components.trackEdit.loadLyricsFailed': 'Could not load the lyrics',
  'components.trackEdit.saveFailed': 'Could not save',
  'components.trackEdit.uploadLyricsFailed': 'Could not upload the lyrics',
  'components.trackEdit.autoLyricsFailed': 'Could not fetch lyrics automatically',

  /* ------------------------------ 上传伴奏弹窗 ------------------------------ */
  'components.upload.title': 'Upload accompaniment',
  'components.upload.subtitle':
    'Pick an audio file, and add lyrics too if you want to sing along. Up to 1GB per file.',
  'components.upload.audioLabel': 'Audio file (required)',
  'components.upload.audioCount': '{count} selected',
  'components.upload.audioMultiHint': 'You can pick several at once',
  'components.upload.audioEmpty': 'Click here to choose audio files, or drop them onto the library upload area',
  'components.upload.lyricsLabel': 'Lyrics file (optional)',
  'components.upload.lyricsHint': '.lrc / .txt',
  'components.upload.lyricsEmpty': 'Click here to choose a lyrics file',
  'components.upload.lyricsDisabledMulti':
    'Lyrics cannot be attached when uploading several audio files at once — add them later in the editor',
  'components.upload.lyricsDropped':
    'Lyrics cannot be attached when uploading several audio files at once, so the selected lyrics were removed; you can add them later in the editor.',
  'components.upload.audioRejected': 'Only audio files are supported — ignored {names} (extract the audio from a video first)',
  'components.upload.lyricsSingle': 'Pick exactly one .lrc / .txt lyrics file',
  'components.upload.lyricsNotePrefix': 'Every lyric line needs a timestamp (e.g. ',
  'components.upload.lyricsExample': '[00:12.00]First line',
  'components.upload.lyricsNoteSuffix':
    '); without lyrics there is no sing-along subtitle while singing — you can add them later with “Edit” in the library.',
  'components.upload.lyricsWithFirst': 'The lyrics will be stored together with the first audio file.',
  'components.upload.start': 'Start upload',
  /** 上传请求失败的兜底（ApiError 自带本地化文案时不会用到） */
  'components.upload.failed': 'Upload failed',

  /* ------------------------------ 跨分区共用 ------------------------------ */
  /* 服务端给了错误对象却没带 reason（pitchError / track.error / work.error）时的兜底 */
  'components.unknown_reason': 'Unknown reason',
};

export default components;
