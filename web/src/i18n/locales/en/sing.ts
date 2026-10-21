//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Messages } from '../../types.ts';

/**
 * 分区文案：sing
 *
 * 命名规范：`sing.<语义>`，语义用 snake_case，保持稳定、可读、不随文案改动而改。
 * 详见 CONTRIBUTING.md 的「Internationalisation (i18n)」一节。
 */
const sing: Messages = {
  /* ------------------------------ 加载与伴奏状态 ------------------------------ */
  'sing.loadFailed': 'Failed to load the backing track',
  'sing.loadingTrack': 'Loading track…',
  'sing.backToLibrary': 'Back to library',
  'sing.unsupported':
    'This browser is missing the Web Audio capabilities that recording needs (AudioWorklet / getUserMedia). Open it in desktop Chrome or Edge.',
  'sing.unknownReason': 'unknown reason',
  'sing.track.processing': 'This track is still transcoding ({percent}) — singing opens up once it is ready.',
  'sing.track.failed': 'This track failed to process: {reason}',
  'sing.trackKind.video': 'Video',
  'sing.trackKind.audio': 'Audio',
  /* 音频伴奏的「舞台」：慢转的唱片 + 歌名，比一枚大 emoji 有生命力 */
  'sing.stage.audioOnly': 'Audio only (no video)',

  /* -------------------------------- 耳机警告 -------------------------------- */
  'sing.headphones.warning': 'Put on headphones before you sing.',
  'sing.headphones.why': 'Why?',
  'sing.headphones.reason':
    'To keep the sound quality, we deliberately switch off the browser noise reduction / echo cancellation — that processing is built for voice calls and treats singing as noise (it can shave off 18 dB, which sounds like constant dropouts). The trade-off is no automatic feedback protection: on speakers, the microphone picks the backing track back up, causing bleed at best and howling at worst. Bluetooth headphones also usually add 150 ms or more of latency, which makes monitoring lag noticeably — wired headphones are recommended.',

  /* -------------------------------- 录音流程 -------------------------------- */
  'sing.start': 'Start singing',
  'sing.startFailed': 'Failed to start singing',
  'sing.stopFailed': 'Failed to stop recording: {reason}',
  'sing.recording.active': 'Recording',
  'sing.recording.finish': 'Finish take',
  'sing.recording.cancel': 'Cancel take',
  'sing.recording.mixing': 'Mixing…',
  'sing.recording.tooShort': 'That take was too short — sing for at least {seconds} seconds before stopping.',
  'sing.lyricsOffsetSaveFailed': 'Failed to save the lyrics offset: {reason}',
  'sing.micConnectFailed': 'Failed to connect the microphone: {reason}',

  /* ------------------------- 采集质量提醒（不阻断流程） ------------------------- */
  'sing.capture.dropped':
    '{percent} of the audio buffers in this take came back empty, so the recording may sound choppy. This is usually an audio device or driver issue, or system load — close other resource-heavy programs, or try a different microphone port.',
  'sing.capture.echoCancellation':
    'The driver for this microphone forces echo cancellation / noise suppression on, and the browser cannot switch it off. They treat your voice as noise, so the recording may sound muffled or choppy. If the device supports it, turn off options like "ambient noise reduction" in the system sound settings.',
  'sing.capture.shortfall':
    'Only {captured} seconds of audio were captured, but the take lasted about {expected} seconds (audio context state: {state}). The audio device or driver most likely failed part-way through — check the headphones and microphone, then try again.',

  /* AudioContext 的机读状态（engine.context.state）→ 说成人话 */
  'sing.audioContext.running': 'running',
  'sing.audioContext.suspended': 'suspended',
  'sing.audioContext.closed': 'closed',

  /* --------------------------- 开始按钮旁的状态提示 --------------------------- */
  'sing.hint.pitchProcessing': 'Generating the pitch-shifted track — singing opens up once it is ready…',
  'sing.hint.pitchFailed': 'Pitch shift failed ({reason}), so this take will be sung to the original key. Retry for the new key, or drag the slider back to "Original".',
  'sing.hint.micPermission': 'Waiting for microphone permission…',
  'sing.hint.noExternalMic': 'No external microphone is available — plug one in and it will show up here.',
  'sing.hint.ready': 'Ready: put on headphones, then tap "{action}".',
  'sing.hint.micConnecting': 'Connecting microphone…',
  'sing.hint.audioPreparing': 'Preparing audio…',

  /* -------------------------------- 录音说明 -------------------------------- */
  'sing.notes.title': 'Recording notes',
  'sing.notes.dryOnly': 'Only the dry vocal is recorded; the backing track never enters the file.',
  'sing.notes.autoMix': 'When the take ends, the dry vocal is mixed with the backing track into an MP3 automatically.',
  'sing.notes.effects': 'Want a different sound? Open the work in the library and tap "Adjust effects": previews apply instantly, and "Mix" renders a new MP3.',
  'sing.notes.alignment': 'Recording starts with 0.15 seconds of silence before the track plays, which is used to align the vocal automatically — no manual adjustment needed.',

  /* -------------------------------- 麦克风卡 -------------------------------- */
  'sing.mic.title': 'Microphone',
  'sing.mic.device': 'Input device',
  'sing.mic.unauthorized': 'Not authorized',
  'sing.mic.noExternalInput': '(No external input available)',
  'sing.mic.waitingPermission': '(Waiting for microphone permission)',
  'sing.mic.showingAll': 'Showing all input devices (including the built-in microphone).',
  'sing.mic.externalOnly': 'External only',
  'sing.mic.showAll': 'Show all devices',
  'sing.mic.noExternalDetected':
    'No external microphone detected. Hidden: {devices}. Plug in a USB or 3.5 mm microphone and it will show up here.',
  'sing.mic.externalOnlyHint': 'Listing external inputs only (hidden: {devices}).',
  'sing.mic.level': 'Input level',
  'sing.mic.speakToTest': 'Try speaking into the microphone',
  'sing.mic.notConnected': 'Not connected',
  'sing.mic.retryAuth': 'Retry authorization',

  /* ------------------------------ 耳机监听卡 ------------------------------ */
  'sing.monitor.title': 'Headphone monitoring',
  'sing.monitor.accompVolume': 'Backing track volume',
  'sing.monitor.accompHint': 'How loud the backing track is in the headphones.',
  'sing.monitor.micMonitor': 'Vocal monitoring',
  'sing.monitor.hearMyself': 'Hear my own voice in the headphones',

  /* ---------------------------- 升降调卡 / 歌词卡 ---------------------------- */
  'sing.pitch.title': 'Pitch shift',
  'sing.lyrics.title': 'Lyrics',
  'sing.lyrics.offset': 'Lyrics timing',
  'sing.lyrics.offsetHint': 'Drag this when the lyrics are half a beat off the track; positive values delay the lyrics. Saves automatically.',
  'sing.lyrics.offsetReset': 'Reset',
};

export default sing;
