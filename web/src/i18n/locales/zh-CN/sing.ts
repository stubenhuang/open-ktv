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
  'sing.loadFailed': '加载伴奏失败',
  'sing.loadingTrack': '正在加载伴奏…',
  'sing.backToLibrary': '返回伴奏库',
  'sing.unsupported':
    '这个浏览器缺少录音所需的 Web Audio 能力（AudioWorklet / getUserMedia）。请用桌面版 Chrome 或 Edge 打开。',
  'sing.unknownReason': '未知原因',
  'sing.track.processing': '这个伴奏还在转码中（{percent}），转好之后才能演唱。',
  'sing.track.failed': '这个伴奏处理失败了：{reason}',
  'sing.trackKind.video': '视频伴奏',
  'sing.trackKind.audio': '音频伴奏',
  /* 音频伴奏的「舞台」：慢转的唱片 + 歌名，比一枚大 emoji 有生命力 */
  'sing.stage.audioOnly': '音频伴奏（无画面）',

  /* -------------------------------- 耳机警告 -------------------------------- */
  'sing.headphones.warning': '请戴上耳机再唱。',
  'sing.headphones.why': '为什么？',
  'sing.headphones.reason':
    '为了保证音质，我们特意关掉了浏览器的「降噪 / 回声消除」—— 那套处理是给语音通话做的，会把歌声当成噪声削掉（实测能削掉 18dB，听感就是断断续续）。代价是不再自动防啸叫：外放时麦克风会把伴奏收回去，轻则串音重则啸叫。另外蓝牙耳机延迟通常 150ms 以上，耳返会明显拖拍，建议用有线耳机。',

  /* -------------------------------- 录音流程 -------------------------------- */
  'sing.start': '开始演唱',
  'sing.startFailed': '开始演唱失败',
  'sing.stopFailed': '结束录音失败：{reason}',
  'sing.recording.active': '录音中',
  'sing.recording.finish': '完成录制',
  'sing.recording.cancel': '取消录制',
  'sing.recording.mixing': '正在合成…',
  'sing.recording.tooShort': '录音太短了，至少唱满 {seconds} 秒再结束。',
  'sing.lyricsOffsetSaveFailed': '歌词微调保存失败：{reason}',
  'sing.micConnectFailed': '接入麦克风失败：{reason}',

  /* ------------------------- 采集质量提醒（不阻断流程） ------------------------- */
  'sing.capture.dropped':
    '这次录音有 {percent} 的时间片没采到，声音可能会断断续续。多半是音频设备/驱动或系统负载的问题，可以关掉别的占资源的程序、换一个麦克风接口再试。',
  'sing.capture.echoCancellation':
    '这个麦克风的驱动强制开启了「回声消除/降噪」，浏览器关不掉。它们会把歌声当成噪声处理，录出来可能发闷或断断续续。如果设备支持，去系统声音设置里把「环境降噪」之类的选项关掉。',
  'sing.capture.shortfall':
    '只采集到 {captured} 秒音频，但录音持续了约 {expected} 秒（音频上下文状态：{state}）。多半是音频设备/驱动中途出错了，请检查耳机和麦克风后重试。',

  /* AudioContext 的机读状态（engine.context.state）→ 说成人话 */
  'sing.audioContext.running': '运行中',
  'sing.audioContext.suspended': '已挂起',
  'sing.audioContext.closed': '已关闭',

  /* --------------------------- 开始按钮旁的状态提示 --------------------------- */
  'sing.hint.pitchProcessing': '正在生成新调的伴奏，生成好才能开始演唱…',
  'sing.hint.pitchFailed': '移调没成功（{reason}），将按原调演唱。想用新调就重试，或拖回「原调」。',
  'sing.hint.micPermission': '等待麦克风授权…',
  'sing.hint.noExternalMic': '没有可用的外置麦克风，插上麦克风后这里会自动出现。',
  'sing.hint.ready': '准备好了：戴好耳机，点「{action}」。',
  'sing.hint.micConnecting': '正在接入麦克风…',
  'sing.hint.audioPreparing': '正在准备音频…',

  /* -------------------------------- 录音说明 -------------------------------- */
  'sing.notes.title': '录音说明',
  'sing.notes.dryOnly': '只录你的干声，伴奏不进录音文件。',
  'sing.notes.autoMix': '唱完自动把干声和伴奏合成一版 MP3。',
  'sing.notes.effects': '想换效果，去作品库点「调整效果」：实时试听即时生效，点「合成」出新版 MP3。',
  'sing.notes.alignment': '开始时会先录 0.15 秒静音再放伴奏，用来自动对齐人声，不用手动调。',

  /* -------------------------------- 麦克风卡 -------------------------------- */
  'sing.mic.title': '麦克风',
  'sing.mic.device': '输入设备',
  'sing.mic.unauthorized': '未授权',
  'sing.mic.noExternalInput': '（没有可用的外置输入）',
  'sing.mic.waitingPermission': '（等待麦克风授权）',
  'sing.mic.showingAll': '已显示全部输入设备（含内置麦克风）。',
  'sing.mic.externalOnly': '只看外置',
  'sing.mic.showAll': '显示全部设备',
  'sing.mic.noExternalDetected':
    '没检测到外置麦克风，已隐藏：{devices}。插上 USB / 3.5mm 麦克风后会自动出现在这里。',
  'sing.mic.externalOnlyHint': '只列外置输入（已隐藏：{devices}）。',
  'sing.mic.level': '输入电平',
  'sing.mic.speakToTest': '对着麦克风说话试试',
  'sing.mic.notConnected': '未接入',
  'sing.mic.retryAuth': '重试授权',

  /* ------------------------------ 耳机监听卡 ------------------------------ */
  'sing.monitor.title': '耳机监听',
  'sing.monitor.accompVolume': '伴奏音量',
  'sing.monitor.accompHint': '耳机里听到的伴奏大小。',
  'sing.monitor.micMonitor': '人声耳返',
  'sing.monitor.hearMyself': '在耳机里听到自己的声音',

  /* ---------------------------- 升降调卡 / 歌词卡 ---------------------------- */
  'sing.pitch.title': '升降调',
  'sing.lyrics.title': '歌词',
  'sing.lyrics.offset': '歌词对轴',
  'sing.lyrics.offsetHint': '歌词跟伴奏差半拍时拖这个；正值 = 歌词更晚，自动保存。',
  'sing.lyrics.offsetReset': '归零',
};

export default sing;
