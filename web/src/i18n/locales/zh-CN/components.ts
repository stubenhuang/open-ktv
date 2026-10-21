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
  'components.phone.title': '手机演唱',
  'components.phone.aria': '手机演唱：扫码用手机唱歌',
  'components.phone.loading': '正在读取局域网地址…',
  'components.phone.noEntry': '现在没有可用的手机入口。',
  'components.phone.readFailed': '读取网络信息失败',
  'components.phone.qrAlt': '扫码用手机演唱',
  'components.phone.hint': '手机连同一个 WiFi，扫码即开移动端演唱页。',
  'components.phone.tokenHint': '服务开启了访问保护，二维码地址里已带上令牌，手机扫码即用、无需手输。',
  'components.phone.micBlocked': 'http 入口下手机浏览器会禁用麦克风。',
  'components.phone.certHint':
    '首次打开提示「证书不受信任」：点「高级 → 继续访问」（iPhone：显示详细信息 → 访问网站）。',
  'components.phone.downloadCert': '下载证书',
  'components.phone.headphones': '建议戴耳机唱：外放伴奏会被麦克风收进去。',

  /* -------------------------------- 确认框 -------------------------------- */
  'components.confirm.title': '请确认',
  'components.confirm.ok': '确定',
  'components.confirm.cancel': '取消',

  /* -------------------------------- 轻提示 -------------------------------- */
  'components.toast.close': '关闭提示',

  /* -------------------------------- 令牌闸门 -------------------------------- */
  'components.token.title': '需要访问令牌',
  'components.token.hint': '这个服务开了访问保护。请输入令牌后继续。',
  'components.token.placeholder': '访问令牌',
  'components.token.submit': '进入',
  'components.token.failed': '令牌不对，请重新输入。',

  /* ------------------------------ 实时试听卡片 ------------------------------ */
  'components.preview.title': '实时试听',
  'components.preview.hint':
    '干声 + 伴奏在浏览器里实时混音：拖滑块、改毫秒都会立刻生效，不打断播放。这只是预览 —— 点「合成」服务端才真正出新版 MP3。',
  'components.preview.play': '▶ 试听',
  'components.preview.pause': '⏸ 暂停',
  'components.preview.liveBadge': '改动立即生效',
  'components.preview.failed': '预览失败：{reason}（可以回作品库听已生成的 MP3，或再点一次「试听」重试）',
  /** 浏览器拦截等极端情况：抛到控制台排障（log.error 用的也是目录文案） */
  'components.preview.playFailed': '播放失败',

  /* -------------------------------- 跟唱歌词 -------------------------------- */
  'components.lyrics.seekHint': '点这一行跳到对应位置',
  'components.lyrics.seekLocked': '录音中不能跳转',

  /* --------------------------------- 播放器 --------------------------------- */
  'components.player.seek': '播放进度',

  /* --------------------------------- 升降调 --------------------------------- */
  'components.pitch.aria': '伴奏升降调（半音）',
  'components.pitch.unsupported':
    '当前 ffmpeg 不带 rubberband，升降调不可用（其余功能不受影响）。换一个带 --enable-librubberband 的构建即可启用。',
  'components.pitch.generating': '正在生成新调的伴奏（几秒）…这期间播放和试听听到的还是原调，生成好会自动换过来。',
  'components.pitch.failed': '移调失败：{reason}',
  'components.pitch.ready': '已按「{pitch}」生成伴奏：演唱、实时试听、成品 MP3 用的都是这一份。',
  'components.pitch.originalHint': '按原调播放。唱不上去就往右拖，伴奏会整体移调，时长不变。',
  'components.pitch.saveFailed': '升降调保存失败',

  /* -------------------------------- 混音面板 -------------------------------- */
  'components.mix.title': '效果调整',
  'components.mix.hint': '每项改动都会实时送进上面的「实时试听」；点「合成」用干声重新出一版 MP3，然后返回作品库。',
  'components.mix.groupEffects': '音效',
  'components.mix.effectsHint': '{count} 种预设 · 空间/湿度连续可调',
  'components.mix.presetCurrent': '当前：{preset}',
  'components.mix.presetManual': '已手动调整',
  'components.mix.presetHint':
    '点一下把均衡和混响的起点写进下面的滑块，之后还能继续手调；修音（压缩/去齿音/降噪）不受预设影响，默认关闭。',
  'components.mix.reverbHint':
    '「空间」在原声 → 峡谷之间连续过渡，滑块下方的 8 个刻度就是原来的档位名；「湿度」独立控制混响量，0% 就是干声。两个轴都可以微调，预设只是起点。',
  'components.mix.reverbNote':
    '「空间」在原声 / 小房间 / 金属板 / 大厅 / 演唱会 / 教堂 / 体育场 / 峡谷之间连续过渡，「湿度」独立控制混响量（0% = 干声）；预设只是起点，之后可继续微调，试听立即生效。',
  'components.mix.reverbAxes': '空间由小到大 · 湿度独立',
  'components.mix.repairNote': '去齿音在试听里是近似效果；降噪只该在录音有明显底噪时开，且**只在合成后的成品里生效**。',
  'components.mix.apply': '合成',
  'components.mix.applying': '合成中…',

  /* ------------------------------ 编辑伴奏弹窗 ------------------------------ */
  'components.trackEdit.title': '编辑伴奏',
  'components.trackEdit.subtitle': '改歌名歌手、贴歌词、微调歌词时间。',
  'components.trackEdit.lyricsLabel': '歌词（LRC）',
  'components.trackEdit.lyricsExisting': '已有歌词，改动会覆盖',
  'components.trackEdit.lyricsNone': '还没有歌词',
  'components.trackEdit.lyricsLoading': '正在加载歌词…',
  'components.trackEdit.lyricsPlaceholder': '每行都要带时间戳，例如：\n[00:12.00]第一句\n[00:16.50]第二句',
  'components.trackEdit.pickLrc': '选择 .lrc 文件',
  'components.trackEdit.autoLyrics': '自动获取歌词',
  'components.trackEdit.clearLyrics': '清空歌词',
  'components.trackEdit.autoLyricsHint': '自动获取：按歌名/歌手从酷狗匹配 LRC。',
  'components.trackEdit.lyricsOffset': '歌词对轴',
  'components.trackEdit.lyricsOffsetHint': '正值 = 歌词更晚出现；歌词跑在伴奏前面就往右拖。',
  'components.trackEdit.saved': '已保存',
  'components.trackEdit.lyricsSaved': '歌词已入库',
  'components.trackEdit.lyricsAutoSaved': '已自动获取歌词',
  'components.trackEdit.loadLyricsFailed': '加载歌词失败',
  'components.trackEdit.saveFailed': '保存失败',
  'components.trackEdit.uploadLyricsFailed': '上传歌词失败',
  'components.trackEdit.autoLyricsFailed': '自动获取歌词失败',

  /* ------------------------------ 上传伴奏弹窗 ------------------------------ */
  'components.upload.title': '上传伴奏',
  'components.upload.subtitle': '选一个音频文件，想一起跟唱的话再带上歌词。单个文件最大 1GB。',
  'components.upload.audioLabel': '音频文件（必填）',
  'components.upload.audioCount': '已选 {count} 个',
  'components.upload.audioMultiHint': '可一次选多个',
  'components.upload.audioEmpty': '点这里选择音频文件，或把文件拖到伴奏库上传区',
  'components.upload.lyricsLabel': '歌词文件（可选）',
  'components.upload.lyricsHint': '.lrc / .txt',
  'components.upload.lyricsEmpty': '点这里选择歌词文件',
  'components.upload.lyricsDisabledMulti': '一次传多个音频时不能同时指定歌词，可上传后在编辑里补',
  'components.upload.lyricsDropped': '一次传多个音频时不能同时指定歌词，已撤掉选中的歌词；可上传后在编辑里补。',
  'components.upload.audioRejected': '只支持音频文件，已忽略 {names}（视频伴奏请先提取音频）',
  'components.upload.lyricsSingle': '歌词只能选一个 .lrc / .txt 文件',
  'components.upload.lyricsNotePrefix': '歌词每行都要带时间戳（例如 ',
  'components.upload.lyricsExample': '[00:12.00]第一句',
  'components.upload.lyricsNoteSuffix': '）；不上传歌词的话，演唱时就没有跟唱字幕，之后也可以在伴奏库里点「编辑」补。',
  'components.upload.lyricsWithFirst': '歌词会跟着第一个音频一起入库。',
  'components.upload.start': '开始上传',
  /** 上传请求失败的兜底（ApiError 自带本地化文案时不会用到） */
  'components.upload.failed': '上传失败',

  /* -------------------------------- 跨分区共用 -------------------------------- */
  /* 服务端给了错误对象却没带 reason（pitchError / track.error / work.error）时的兜底 */
  'components.unknown_reason': '未知原因',
};

export default components;
