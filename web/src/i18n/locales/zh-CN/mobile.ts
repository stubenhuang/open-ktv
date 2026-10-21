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
    '服务只绑了本机回环（HOST=127.0.0.1），手机连不进来。把 HOST 留空（默认 0.0.0.0）重启即可。',
  'mobile.reason.no_lan_address': '没找到局域网网卡：确认这台机器连了 WiFi / 网线，然后刷新。',
  'mobile.reason.https_mirror_down':
    'HTTPS 镜像没起来（多半是没装 openssl，或端口被占用）。手机端需要 HTTPS 才能用麦克风，详见日志。',
  'mobile.reason.http_entry':
    'http 入口：手机浏览器会禁用麦克风。设 LAN_HTTPS=1（默认就是开）并装好 openssl 后重启可恢复。',

  /* --------------------------------- 外壳与导航 --------------------------------- */
  'mobile.tabbar.aria': '手机端主导航',
  'mobile.tab.tracks': '伴奏',
  'mobile.tab.discover': '点歌',
  'mobile.tab.works': '作品',
  'mobile.back': '‹ 返回',
  'mobile.loading': '正在加载…',

  /* -------------------------------- 通用加载失败 -------------------------------- */
  'mobile.load_tracks_failed': '加载伴奏失败',
  'mobile.load_work_failed': '加载作品失败',
  'mobile.load_works_failed': '加载作品失败',
  'mobile.loading_track': '正在加载伴奏…',
  'mobile.loading_work': '正在加载作品…',
  'mobile.refresh_failed': '刷新状态失败',

  /* --------------------------------- 首页：选歌 --------------------------------- */
  'mobile.home.title': '🎤 选首歌开唱',
  'mobile.home.connected': '已连接 {host}',
  'mobile.home.search_placeholder': '搜歌名 / 歌手',
  'mobile.home.loading': '正在加载伴奏…',
  'mobile.home.empty_library': '曲库还是空的。',
  'mobile.home.empty_library_hint': '去电脑端上传伴奏，或在「点歌」里搜一首直接入库。',
  'mobile.home.go_discover': '去点歌台',
  'mobile.home.go_works': '看作品',
  'mobile.home.no_match': '没有匹配「{query}」的伴奏。',
  'mobile.home.pending_note': '另有 {count} 首正在转码或处理失败，手机上先不列。',
  'mobile.home.pending_note.one': '另有 {count} 首正在转码或处理失败，手机上先不列。',
  'mobile.home.pending_note.other': '另有 {count} 首正在转码或处理失败，手机上先不列。',
  'mobile.home.foot_note': '唱完的作品会进「我的作品」，电脑端可以调效果、下载 MP3。',

  /* -------------------------------- 点歌台 -------------------------------- */
  'mobile.discover.title': '🔍 点歌台',
  'mobile.discover.subtitle': '搜歌名或歌手，点「点歌」自动下载进伴奏库。',
  'mobile.discover.subtitle_full': '搜歌名或歌手，点「点歌」自动下载进伴奏库；有歌词会一起带上。',
  'mobile.discover.no_sources':
    '还没有配置任何曲库源。内置 5sing 伴奏源默认是开的（被 FIVESING_ENABLED=0 关掉了？），也可以用 LIBRARY_SOURCES 配上自己的源。伴奏照样能手动上传，不受影响。',
  'mobile.discover.load_sources_failed': '读取曲库源失败',
  'mobile.discover.search_failed': '搜索失败',
  'mobile.discover.search_placeholder': '歌名 / 歌手',
  'mobile.discover.searching': '搜索中…',
  'mobile.discover.searching_list': '正在搜索…',
  'mobile.discover.no_results': '没搜到「{query}」相关的伴奏。',
  'mobile.discover.empty_library': '曲库里还没有伴奏。',
  'mobile.discover.download': '点歌',
  'mobile.discover.download_failed': '点歌失败',
  'mobile.discover.download_failed_short': '下载失败',
  'mobile.discover.downloading': '下载中',
  'mobile.discover.go_sing': '去演唱',
  'mobile.discover.source_ok': '{label} {count}',
  'mobile.discover.source_unavailable': '{label} 不可用',
  'mobile.kind.audio': '音频',
  'mobile.kind.video': '视频',
  'mobile.track.has_lyrics': ' · 有歌词',
  'mobile.track.with_lyrics': ' · 带歌词',

  /* -------------------------------- 作品库 -------------------------------- */
  'mobile.works.title': '🎤 我的作品',
  'mobile.works.count_note': '共 {count} 首 · 唱完的作品在这里调效果、下载',
  'mobile.works.count_note.one': '共 {count} 首 · 唱完的作品在这里调效果、下载',
  'mobile.works.count_note.other': '共 {count} 首 · 唱完的作品在这里调效果、下载',
  'mobile.works.search_placeholder': '搜作品名 / 伴奏 / 歌手',
  'mobile.works.sort_label': '排序',
  'mobile.works.sort_recent': '最近演唱',
  'mobile.works.sort_oldest': '最早演唱',
  'mobile.works.sort_title': '按歌名',
  'mobile.works.sort_duration': '按时长',
  'mobile.works.loading': '正在加载作品…',
  'mobile.works.empty': '还没有作品。去伴奏库选一首开唱吧。',
  'mobile.works.no_match': '没有匹配的作品。',
  'mobile.works.track_deleted': '伴奏已删除',
  'mobile.works.cover_fallback': '♪',
  'mobile.status.mixing': '合成中',

  /* ------------------------------ 作品详情 / 结果 ------------------------------ */
  'mobile.mixing_mp3': '正在合成 MP3…',
  'mobile.mixing_hint': '几秒就好。可以先去选下一首，合成完了回来再听。',
  'mobile.mix_failed': '合成失败：{reason}',
  'mobile.retrying': '正在重试…',
  'mobile.retry_mix': '重试合成',
  'mobile.retry_mix_failed': '重试合成失败',
  'mobile.adjust_effects': '调整效果',
  'mobile.rename': '改名',
  'mobile.renamed': '已改名',
  'mobile.rename_failed': '重命名失败',
  'mobile.delete_work_title': '删除作品',
  'mobile.delete_work_message': '确定删除作品「{title}」吗？录音干声和成品 MP3 都会一起删掉。',
  'mobile.deleted': '已删除',
  'mobile.delete_failed': '删除失败',
  'mobile.sing_another': '再唱一首',
  'mobile.back_home': '返回首页',
  'mobile.track_deleted_note': '这个作品的伴奏已被删除：成品 MP3 还能播放，但不能重新合成。',

  /* ------------------------------ 效果调整（编辑页） ------------------------------ */
  'mobile.mix': '合成',
  'mobile.mixing': '合成中…',
  'mobile.mixing_tag': ' · 合成中…',
  'mobile.mix_submitted': '已提交合成，几秒后刷新就是新版',
  'mobile.mix_failed_short': '合成失败',
  'mobile.track_deleted_cannot_edit':
    '这个作品用的伴奏已经被删除了。已生成的 MP3 还能播放 / 下载，但实时试听和重新合成都需要伴奏文件，所以不能调整效果。',
  'mobile.preview': '试听',
  'mobile.preview_progress': '试听进度',
  'mobile.preview_failed': '试听失败：{reason}',
  'mobile.preview_notes':
    '干声和伴奏在手机里实时混音：拖滑块、改毫秒都会立刻生效，不打断播放。这只是预览 —— 点「合成」服务端才真正出新版 MP3。',

  /* --------------------------------- 演唱页 --------------------------------- */
  'mobile.audio_only_no_lyrics': '音频伴奏（无歌词）',
  'mobile.video_track': ' · 视频伴奏',
  'mobile.playback_progress': '播放进度',
  'mobile.recording': '录音中',
  'mobile.start_singing': '开始演唱',
  'mobile.start_sing_failed': '开始演唱失败',
  'mobile.finish_recording': '完成录制',
  'mobile.cancel_recording': '取消录制',
  'mobile.recording_too_short': '录音太短了，至少唱满 {seconds} 秒再结束。',
  'mobile.stop_failed': '结束录音失败：{reason}',
  'mobile.backgrounded': '录音中离开了这个页面，系统可能已经停止采集。建议重唱这一遍。',
  'mobile.uploading_mixing': '正在上传干声并合成…',
  'mobile.headphones_hint':
    '🎧 建议戴耳机：手机外放伴奏会被麦克风收进去，混音里就是一串伴奏声。只录你的干声，伴奏不进录音文件；起唱前会自动留 0.15 秒静音用来对齐，不用手动调。',
  'mobile.pitch_failed':
    '⚠️ 移调没成功（{reason}），将按原调演唱。想用新调就在上面的「升降调」里重试，或拖回「原调」。',
  'mobile.track_processing': '这个伴奏还在转码中（{percent}），转好之后才能唱。',
  'mobile.track_failed': '这个伴奏处理失败了：{reason}',
  'mobile.insecure_context':
    '这个页面不是「安全上下文」（http + 局域网 IP），浏览器把麦克风禁用了。请用桌面端二维码里的 https 地址重新打开；看到证书警告时点「高级 → 继续访问」。',
  'mobile.unsupported_browser':
    '这个浏览器缺少录音所需的能力（AudioWorklet / getUserMedia），请换新版 Chrome 或 Safari。',
  'mobile.retry_permission': '重试授权',
  'mobile.capture.dropped_frames':
    '这次录音有 {percent} 的时间片没采到，声音可能断断续续。换个麦克风接口、或关掉别的占资源的程序再试。',
  'mobile.capture.short_capture':
    '只采集到 {captured} 秒音频，但录音持续了约 {expected} 秒。多半是系统把后台音频收了，锁屏/切应用会这样。',
  'mobile.mic_connect_failed': '接入麦克风失败：{reason}',

  /* -------------------------------- 麦克风面板 -------------------------------- */
  'mobile.mic.device': '输入设备',
  'mobile.mic.not_granted': '未授权',
  'mobile.mic.no_external': '（没有可用的外置输入）',
  'mobile.mic.awaiting_permission': '（等待麦克风授权）',
  'mobile.mic.all_shown': '已显示全部输入设备（含机身麦克风）。',
  'mobile.mic.external_only': '只看外置',
  'mobile.mic.no_external_found':
    '没检测到外置麦克风，已隐藏：{devices}。插上 USB / Type-C / 3.5mm 麦克风或耳机麦后会出现在这里。',
  'mobile.mic.show_all': '显示全部设备',
  'mobile.mic.external_only_note': '只列外置输入（已隐藏：{devices}）。',
  'mobile.mic.level': '输入电平',
  'mobile.mic.try_speaking': '对着麦克风说话试试',
  'mobile.mic.not_connected': '未接入',
};

export default mobile;
