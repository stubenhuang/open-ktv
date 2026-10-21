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
  'retake.title': '分段重录',
  'retake.loading': '正在加载作品…',
  'retake.load_failed': '加载作品失败',
  'retake.back_to_work': '返回作品',
  'retake.subtitle': '{title} · 干声 {duration}',
  'retake.subtitle_with_artist': '{title} · 干声 {duration} · {artist}',

  /* --------------------------------- 前置拦截 --------------------------------- */
  'retake.unsupported_browser':
    '这个浏览器缺少录音所需的 Web Audio 能力（AudioWorklet / getUserMedia）。请用桌面版 Chrome 或 Edge 打开。',
  'retake.track_deleted':
    '这个作品用的伴奏已经被删除了。分段重录需要伴奏文件（重录完要重新混音），所以不能再重录；已生成的 MP3 还能在作品库里播放 / 下载。',
  'retake.track_processing': '这个伴奏还在转码中，转好之后才能重录。',
  'retake.track_failed': '这个伴奏处理失败了：{reason}',
  'retake.mixing_warning': '作品正在合成中，稍等几秒再重录（避免两次合成互相覆盖）。',
  'retake.beyond_track':
    '所选片段的结束位置超出了伴奏长度（{end} 秒 / {duration}），那段没有伴奏可跟。把结束时间往前提一点。',
  'retake.retry_permission': '重试授权',

  /* --------------------------------- 录音阶段 --------------------------------- */
  'retake.audio_only': '音频伴奏（无画面）',
  'retake.recording': '重录中',
  'retake.splicing': '正在拼接…',
  'retake.start': '开始重录',
  'retake.finish': '完成重录',
  'retake.cancel': '取消重录',
  'retake.start_failed': '开始重录失败',
  'retake.failed': '重录失败',
  'retake.offset_not_measured': '这次重录的起播没测准，对齐会错位。请把开始时间往后挪一点再录一遍。',
  'retake.recording_too_short_for_range':
    '这次录音在片段结束前就停了（共 {duration}，没能覆盖整段）。重新录一遍，或把结束时间往前提。',
  'retake.segment_too_short': '裁出来的重录片段太短，请重新录制。',
  'retake.mic_connect_failed': '接入麦克风失败：{reason}',

  /* -------------------------------- 采集告警 -------------------------------- */
  'retake.capture.dropped_frames':
    '这次录音有 {percent} 的时间片没采到，声音可能会断断续续。多半是音频设备/驱动或系统负载的问题，可以关掉别的占资源的程序、换一个麦克风接口再试。',
  'retake.capture.forced_processing':
    '这个麦克风的驱动强制开启了「回声消除/降噪」，浏览器关不掉。它们会把歌声当成噪声处理，录出来可能发闷或断断续续。如果设备支持，去系统声音设置里把「环境降噪」之类的选项关掉。',

  /* -------------------------------- 起录提示语 -------------------------------- */
  'retake.hint.pitch_processing': '伴奏正在按新调生成，生成好才能重录…',
  'retake.hint.pitch_failed': '移调没成功（{reason}），将按原调重录。想用新调就重试，或拖回「原调」。',
  'retake.hint.mic_permission': '等待麦克风授权…',
  'retake.hint.no_mic': '没有可用的外置麦克风，插上麦克风后这里会自动出现。',
  'retake.hint.ready':
    '准备好了：戴好耳机点「开始重录」。伴奏会从 {start} 响起（片段开始前 {lead_in} 秒），唱到片段结束自动停。',
  'retake.hint.preparing_audio': '正在准备音频…',
  'retake.hint.connecting_mic': '正在接入麦克风…',

  /* -------------------------------- 重录说明卡 -------------------------------- */
  'retake.notes.title': '📋 重录说明',
  'retake.notes.replace_only': '只替换 [{start}, {end}) 之间的干声，其余原样保留。',
  'retake.notes.lead_in':
    '伴奏从片段开始前 {lead_in} 秒响起（给你找拍），到片段结束自动停录；起录时也会先留 0.15 秒静音，用来自动对齐，唱进去就行。',
  'retake.notes.crossfade': '拼接边界有 20ms 交叉淡化，不会咔哒；干声总时长不变。',
  'retake.notes.backup': '重录前的干声会留一份备份，作品页可以「撤销重录」（只回退一级）。',
  'retake.notes.remix': '拼接完成后自动重新混音，回作品页等「已就绪」即可。',

  /* -------------------------------- 选区面板 -------------------------------- */
  'retake.range.title': '✂️ 重录哪一段',
  'retake.range.start': '开始（干声时间）',
  'retake.range.end': '结束（干声时间）',
  'retake.range.from': '起（秒）',
  'retake.range.to': '止（秒）',
  'retake.range.segment_duration': '片段时长 {duration}',
  'retake.preview.start': '试听这一段',
  'retake.preview.stop': '停止试听',
  'retake.preview.note_mix': '试听播放的是当前成品（混音后）。',
  'retake.preview.note_vocal': '作品还没合成好，试听播放的是干声。',

  /* -------------------------------- 歌词行选段 -------------------------------- */
  'retake.lyrics.title': '按歌词行选',
  'retake.lyrics.hint': '「起」= 从这句开始替换，「止」= 到这句唱完',
  'retake.lyrics.from': '起',
  'retake.lyrics.to': '止',

  /* -------------------------------- 麦克风面板 -------------------------------- */
  'retake.mic.title': '🎙 麦克风',
  'retake.mic.device': '输入设备',
  'retake.mic.not_granted': '未授权',
  'retake.mic.no_external': '（没有可用的外置输入）',
  'retake.mic.awaiting_permission': '（等待麦克风授权）',
  'retake.mic.all_shown': '已显示全部输入设备（含内置麦克风）。',
  'retake.mic.external_only': '只看外置',
  'retake.mic.no_external_found':
    '没检测到外置麦克风，已隐藏：{devices}。插上 USB / 3.5mm 麦克风后会自动出现在这里。',
  'retake.mic.show_all': '显示全部设备',
  'retake.mic.external_only_note': '只列外置输入（已隐藏：{devices}）。',
  'retake.mic.level': '输入电平',
  'retake.mic.try_speaking': '对着麦克风说话试试',
  'retake.mic.not_connected': '未接入',
};

export default retake;
