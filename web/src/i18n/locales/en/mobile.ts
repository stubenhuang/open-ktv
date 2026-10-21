//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Messages } from '../../types.ts';

/**
 * 分区文案：mobile
 *
 * 命名规范：`mobile.<语义>`，语义用 snake_case，保持稳定、可读、不随文案改动而改。
 * 详见 CONTRIBUTING.md 的「Internationalisation (i18n)」一节。
 *
 * 只放手机端页面（/m）的文案。手机端也复用的桌面组件文案在 `components` 分区。
 */
const mobile: Messages = {
  /*
   * 手机入口不可用 / 降级的原因。服务端只给机器可读码
   * （shared/types.ts 的 NetworkReasonCode），句子在这里按语言拼。
   */
  'mobile.reason.loopback_only':
    'The service is bound to the loopback address only (HOST=127.0.0.1), so phones cannot reach it. Leave HOST empty (the default 0.0.0.0) and restart.',
  'mobile.reason.no_lan_address':
    'No LAN interface was found. Make sure this machine is on WiFi or Ethernet, then refresh.',
  'mobile.reason.https_mirror_down':
    'The HTTPS mirror did not start (most likely openssl is missing, or the port is taken). Phones need HTTPS for the microphone — see the log.',
  'mobile.reason.http_entry':
    'http entry: the phone browser disables the microphone. Set LAN_HTTPS=1 (on by default) with openssl installed and restart to restore it.',

  /* --------------------------------- 外壳与导航 --------------------------------- */
  'mobile.tabbar.aria': 'Main navigation',
  'mobile.tab.tracks': 'Tracks',
  'mobile.tab.discover': 'Discover',
  'mobile.tab.works': 'Works',
  'mobile.back': '‹ Back',
  'mobile.loading': 'Loading…',

  /* -------------------------------- 通用加载失败 -------------------------------- */
  'mobile.load_tracks_failed': 'Could not load the backing tracks',
  'mobile.load_work_failed': 'Could not load the work',
  'mobile.load_works_failed': 'Could not load the works',
  'mobile.loading_track': 'Loading the backing track…',
  'mobile.loading_work': 'Loading the work…',
  'mobile.refresh_failed': 'Could not refresh the status',

  /* --------------------------------- 首页：选歌 --------------------------------- */
  'mobile.home.title': '🎤 Pick a song',
  'mobile.home.connected': 'Connected to {host}',
  'mobile.home.search_placeholder': 'Song title / artist',
  'mobile.home.loading': 'Loading the backing tracks…',
  'mobile.home.empty_library': 'The library is still empty.',
  'mobile.home.empty_library_hint':
    'Upload a backing track on the desktop, or search one directly in “Discover”.',
  'mobile.home.go_discover': 'Go to Discover',
  'mobile.home.go_works': 'See works',
  'mobile.home.no_match': 'No backing track matches “{query}”.',
  'mobile.home.pending_note': '{count} more are still transcoding or failed, so they are not listed here.',
  'mobile.home.pending_note.one': '{count} more track is still transcoding or failed, so it is not listed here.',
  'mobile.home.pending_note.other': '{count} more are still transcoding or failed, so they are not listed here.',
  'mobile.home.foot_note':
    'Finished works end up in “My works”, where the desktop can tune the effects and download the MP3.',

  /* -------------------------------- 点歌台 -------------------------------- */
  'mobile.discover.title': '🔍 Discover',
  'mobile.discover.subtitle': 'Search by song title or artist and tap “Get” to download it into the library.',
  'mobile.discover.subtitle_full':
    'Search by song title or artist and tap “Get” to download it into the library; lyrics come along when there are any.',
  'mobile.discover.no_sources':
    'No library source is configured yet. The built-in 5sing source is on by default (was it switched off with FIVESING_ENABLED=0?), or point LIBRARY_SOURCES at your own. Uploading backing tracks by hand still works.',
  'mobile.discover.load_sources_failed': 'Could not read the library sources',
  'mobile.discover.search_failed': 'Search failed',
  'mobile.discover.search_placeholder': 'Song title / artist',
  'mobile.discover.searching': 'Searching…',
  'mobile.discover.searching_list': 'Searching…',
  'mobile.discover.no_results': 'Nothing found for “{query}”.',
  'mobile.discover.empty_library': 'The library has no backing tracks yet.',
  'mobile.discover.download': 'Get',
  'mobile.discover.download_failed': 'Could not request the track',
  'mobile.discover.download_failed_short': 'Download failed',
  'mobile.discover.downloading': 'Downloading',
  'mobile.discover.go_sing': 'Sing',
  'mobile.discover.source_ok': '{label} {count}',
  'mobile.discover.source_unavailable': '{label} unavailable',
  'mobile.kind.audio': 'Audio',
  'mobile.kind.video': 'Video',
  'mobile.track.has_lyrics': ' · has lyrics',
  'mobile.track.with_lyrics': ' · with lyrics',

  /* -------------------------------- 作品库 -------------------------------- */
  'mobile.works.title': '🎤 My works',
  'mobile.works.count_note': '{count} songs · tune the effects and download here',
  'mobile.works.count_note.one': '{count} song · tune the effects and download here',
  'mobile.works.count_note.other': '{count} songs · tune the effects and download here',
  'mobile.works.search_placeholder': 'Work / backing track / artist',
  'mobile.works.sort_label': 'Sort',
  'mobile.works.sort_recent': 'Most recent',
  'mobile.works.sort_oldest': 'Oldest first',
  'mobile.works.sort_title': 'By song title',
  'mobile.works.sort_duration': 'By length',
  'mobile.works.loading': 'Loading the works…',
  'mobile.works.empty': 'No works yet. Pick a track from the library and start singing.',
  'mobile.works.no_match': 'No matching works.',
  'mobile.works.track_deleted': 'Backing track deleted',
  'mobile.works.cover_fallback': '♪',
  'mobile.status.mixing': 'Mixing',

  /* ------------------------------ 作品详情 / 结果 ------------------------------ */
  'mobile.mixing_mp3': 'Mixing the MP3…',
  'mobile.mixing_hint': 'Just a few seconds. Pick the next song and come back to listen.',
  'mobile.mix_failed': 'Mixing failed: {reason}',
  'mobile.retrying': 'Retrying…',
  'mobile.retry_mix': 'Retry mixing',
  'mobile.retry_mix_failed': 'Could not retry the mix',
  'mobile.adjust_effects': 'Adjust effects',
  'mobile.rename': 'Rename',
  'mobile.renamed': 'Renamed',
  'mobile.rename_failed': 'Could not rename',
  'mobile.delete_work_title': 'Delete work',
  'mobile.delete_work_message':
    'Delete the work “{title}”? The dry vocal and the MP3 are deleted with it.',
  'mobile.deleted': 'Deleted',
  'mobile.delete_failed': 'Could not delete',
  'mobile.sing_another': 'Sing another',
  'mobile.back_home': 'Back to home',
  'mobile.track_deleted_note':
    'The backing track behind this work was deleted: the MP3 can still be played, but it cannot be mixed again.',

  /* ------------------------------ 效果调整（编辑页） ------------------------------ */
  'mobile.mix': 'Mix',
  'mobile.mixing': 'Mixing…',
  'mobile.mixing_tag': ' · mixing…',
  'mobile.mix_submitted': 'Mixing submitted — refresh in a few seconds for the new version',
  'mobile.mix_failed_short': 'Mixing failed',
  'mobile.track_deleted_cannot_edit':
    'The backing track behind this work was deleted. The rendered MP3 can still be played or downloaded, but live preview and re-mixing both need the track file, so the effects cannot be adjusted.',
  'mobile.preview': 'Preview',
  'mobile.preview_progress': 'Preview position',
  'mobile.preview_failed': 'Preview failed: {reason}',
  'mobile.preview_notes':
    'The vocal and the backing track are mixed in the phone in real time: dragging the slider or changing milliseconds takes effect immediately without stopping playback. This is only a preview — tap “Mix” for the server to render a new MP3.',

  /* --------------------------------- 演唱页 --------------------------------- */
  'mobile.audio_only_no_lyrics': 'Audio backing track (no lyrics)',
  'mobile.video_track': ' · video',
  'mobile.playback_progress': 'Playback position',
  'mobile.recording': 'Recording',
  'mobile.start_singing': 'Start singing',
  'mobile.start_sing_failed': 'Could not start singing',
  'mobile.finish_recording': 'Finish recording',
  'mobile.cancel_recording': 'Cancel recording',
  'mobile.recording_too_short': 'The recording is too short — sing for at least {seconds} s before finishing.',
  'mobile.stop_failed': 'Could not finish the recording: {reason}',
  'mobile.backgrounded':
    'This page was left while recording, so the system may already have stopped capturing. Sing this take again.',
  'mobile.uploading_mixing': 'Uploading the dry vocal and mixing…',
  'mobile.headphones_hint':
    '🎧 Wear headphones: the phone speaker feeds the backing track back into the microphone and the mix ends up full of it. Only your vocal is recorded — the backing track never enters the file. The first 0.15 s of silence is kept for alignment, so there is nothing to adjust by hand.',
  'mobile.pitch_failed':
    '⚠️ Pitch shifting failed ({reason}), so this take uses the original key. Retry it under “Pitch” above, or drag the control back to “original”.',
  'mobile.track_processing': 'This backing track is still transcoding ({percent}). You can sing once it is ready.',
  'mobile.track_failed': 'This backing track failed to process: {reason}',
  'mobile.insecure_context':
    'This page is not a secure context (http + LAN IP), so the browser disabled the microphone. Reopen the https address from the desktop QR code, and choose “Advanced → Continue” at the certificate warning.',
  'mobile.unsupported_browser':
    'This browser lacks what recording needs (AudioWorklet / getUserMedia). Try a recent Chrome or Safari.',
  'mobile.retry_permission': 'Retry permission',
  'mobile.capture.dropped_frames':
    '{percent} of the audio blocks were not captured this time, so the vocal may stutter. Try another microphone port, or close other heavy programs and try again.',
  'mobile.capture.short_capture':
    'Only {captured} s of audio was captured, but the recording ran for about {expected} s. The system usually reclaimed background audio this way — locking the screen or switching apps does it.',
  'mobile.mic_connect_failed': 'Could not connect the microphone: {reason}',

  /* -------------------------------- 麦克风面板 -------------------------------- */
  'mobile.mic.device': 'Input device',
  'mobile.mic.not_granted': 'not granted',
  'mobile.mic.no_external': '(no external input available)',
  'mobile.mic.awaiting_permission': '(waiting for microphone permission)',
  'mobile.mic.all_shown': 'All input devices are listed (including the built-in microphone).',
  'mobile.mic.external_only': 'External only',
  'mobile.mic.no_external_found':
    'No external microphone was detected, so these are hidden: {devices}. Plug in a USB, Type-C or 3.5 mm microphone, or a headset mic, and it will show up here.',
  'mobile.mic.show_all': 'Show all devices',
  'mobile.mic.external_only_note': 'Only external inputs are listed (hidden: {devices}).',
  'mobile.mic.level': 'Input level',
  'mobile.mic.try_speaking': 'Try speaking into the microphone',
  'mobile.mic.not_connected': 'not connected',
};

export default mobile;
