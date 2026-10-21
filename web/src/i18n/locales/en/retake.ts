//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Messages } from '../../types.ts';

/**
 * 分区文案：retake
 *
 * 命名规范：`retake.<语义>`，语义用 snake_case，保持稳定、可读、不随文案改动而改。
 * 详见 CONTRIBUTING.md 的「Internationalisation (i18n)」一节。
 *
 * 只放分段重录页（/works/:workId/retake）的文案。手机端没有重录入口，
 * 重录相关的服务端错误码在 `errors` 分区（error.work_retake_*）。
 */
const retake: Messages = {
  /* --------------------------------- 页面骨架 --------------------------------- */
  'retake.title': 'Segment retake',
  'retake.loading': 'Loading the work…',
  'retake.load_failed': 'Could not load the work',
  'retake.back_to_work': 'Back to the work',
  'retake.subtitle': '{title} · vocal {duration}',
  'retake.subtitle_with_artist': '{title} · vocal {duration} · {artist}',

  /* --------------------------------- 前置拦截 --------------------------------- */
  'retake.unsupported_browser':
    'This browser lacks the Web Audio features recording needs (AudioWorklet / getUserMedia). Open it in desktop Chrome or Edge.',
  'retake.track_deleted':
    'The backing track behind this work has been deleted. A segment retake needs the track file (it is re-mixed afterwards), so retaking is no longer possible — the MP3 that was already rendered can still be played or downloaded from the library.',
  'retake.track_processing': 'This backing track is still transcoding. You can retake once it is ready.',
  'retake.track_failed': 'This backing track failed to process: {reason}',
  'retake.mixing_warning': 'This work is being mixed right now. Wait a few seconds before retaking (so the two mixes do not overwrite each other).',
  'retake.beyond_track':
    'The end of the selected segment is past the end of the backing track ({end} s / {duration}), so there is nothing to follow there. Move the end earlier.',
  'retake.retry_permission': 'Retry permission',

  /* --------------------------------- 录音阶段 --------------------------------- */
  'retake.audio_only': 'Audio backing track (no video)',
  'retake.recording': 'Retaking',
  'retake.splicing': 'Splicing…',
  'retake.start': 'Start retake',
  'retake.finish': 'Finish retake',
  'retake.cancel': 'Cancel retake',
  'retake.start_failed': 'Could not start the retake',
  'retake.failed': 'Retake failed',
  'retake.offset_not_measured':
    'The playback offset of this take was not measured accurately, so the alignment would drift. Move the start time a little later and record again.',
  'retake.recording_too_short_for_range':
    'Recording stopped before the end of the segment ({duration} in total, so it does not cover the whole range). Record again, or move the end earlier.',
  'retake.segment_too_short': 'The spliced retake segment is too short. Please record it again.',
  'retake.mic_connect_failed': 'Could not connect the microphone: {reason}',

  /* -------------------------------- 采集告警 -------------------------------- */
  'retake.capture.dropped_frames':
    '{percent} of the audio blocks were not captured this time, so the vocal may stutter. This is usually the audio device, its driver, or system load — close other heavy programs or try another microphone port.',
  'retake.capture.forced_processing':
    'The driver of this microphone forces echo cancellation and noise suppression on, and the browser cannot switch them off. They treat singing as noise, so the take may sound muffled or stuttery. If the device supports it, turn off options like “ambient noise reduction” in the system sound settings.',

  /* -------------------------------- 起录提示语 -------------------------------- */
  'retake.hint.pitch_processing': 'The backing track is being rendered in the new key. You can retake once that is done…',
  'retake.hint.pitch_failed':
    'Pitch shifting failed ({reason}), so the retake will use the original key. Retry it if you want the new key, or drag the control back to “original”.',
  'retake.hint.mic_permission': 'Waiting for microphone permission…',
  'retake.hint.no_mic': 'No external microphone is available. Plug one in and it will show up here.',
  'retake.hint.ready':
    'Ready: put on headphones and press “Start retake”. The backing track starts at {start} ({lead_in} s before the segment) and stops on its own at the end of the segment.',
  'retake.hint.preparing_audio': 'Preparing the audio…',
  'retake.hint.connecting_mic': 'Connecting the microphone…',

  /* -------------------------------- 重录说明卡 -------------------------------- */
  'retake.notes.title': '📋 How retaking works',
  'retake.notes.replace_only': 'Only the vocal between [{start}, {end}) is replaced; everything else is kept as is.',
  'retake.notes.lead_in':
    'The backing track starts {lead_in} s before the segment so you can find the beat, and recording stops at the end of the segment. The first 0.15 s of silence is kept for automatic alignment — just sing.',
  'retake.notes.crossfade': 'Each splice gets a 20 ms crossfade, so there is no click, and the total vocal length stays the same.',
  'retake.notes.backup': 'A backup of the vocal is kept before the retake, and the work page can undo it (one level only).',
  'retake.notes.remix': 'The work is re-mixed automatically once splicing is done — go back to the work page and wait for “Ready”.',

  /* -------------------------------- 选区面板 -------------------------------- */
  'retake.range.title': '✂️ Which segment',
  'retake.range.start': 'Start (vocal timeline)',
  'retake.range.end': 'End (vocal timeline)',
  'retake.range.from': 'From (s)',
  'retake.range.to': 'To (s)',
  'retake.range.segment_duration': 'Segment length {duration}',
  'retake.preview.start': 'Preview this segment',
  'retake.preview.stop': 'Stop preview',
  'retake.preview.note_mix': 'The preview plays the current mix.',
  'retake.preview.note_vocal': 'This work is not mixed yet, so the preview plays the dry vocal.',

  /* -------------------------------- 歌词行选段 -------------------------------- */
  'retake.lyrics.title': 'Pick by lyric line',
  'retake.lyrics.hint': '“From” = start replacing at this line, “To” = stop after this line',
  'retake.lyrics.from': 'From',
  'retake.lyrics.to': 'To',

  /* -------------------------------- 麦克风面板 -------------------------------- */
  'retake.mic.title': '🎙 Microphone',
  'retake.mic.device': 'Input device',
  'retake.mic.not_granted': 'not granted',
  'retake.mic.no_external': '(no external input available)',
  'retake.mic.awaiting_permission': '(waiting for microphone permission)',
  'retake.mic.all_shown': 'All input devices are listed (including the built-in microphone).',
  'retake.mic.external_only': 'External only',
  'retake.mic.no_external_found':
    'No external microphone was detected, so these are hidden: {devices}. Plug in a USB or 3.5 mm microphone and it will show up here.',
  'retake.mic.show_all': 'Show all devices',
  'retake.mic.external_only_note': 'Only external inputs are listed (hidden: {devices}).',
  'retake.mic.level': 'Input level',
  'retake.mic.try_speaking': 'Try speaking into the microphone',
  'retake.mic.not_connected': 'not connected',
};

export default retake;
