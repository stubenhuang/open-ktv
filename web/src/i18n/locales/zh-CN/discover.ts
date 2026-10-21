//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Messages } from '../../types.ts';

/**
 * 分区文案：discover
 *
 * 命名规范：`discover.<语义>`，语义用 snake_case，保持稳定、可读、不随文案改动而改。
 * 详见 CONTRIBUTING.md 的「Internationalisation (i18n)」一节。
 *
 * 只放点歌台页（web/src/pages/DiscoverPage.tsx）的文案。
 *
 * 配置示例里的 JSON 清单是**数据样例**，不是界面文案：各语言保持一致，
 * 只翻译它前后的说明文字。
 */
const discover: Messages = {
  /* --------------------------------- 页头 --------------------------------- */
  'discover.title': '点歌台',
  'discover.subtitle': '搜歌名或歌手，点「点歌」自动下载进伴奏库；有歌词会一起带上。',

  /* --------------------------------- 失败 --------------------------------- */
  'discover.sources.failed': '读取曲库源失败',
  'discover.search.failed': '搜索失败',
  'discover.request.failed': '点歌失败',
  'discover.download.failed': '下载失败',

  /* ------------------------------ 一个源都没配 ------------------------------ */
  'discover.noSources.title': '还没有配置任何曲库源',
  'discover.noSources.description': '配上曲库源之后就能在这里搜歌、点歌。伴奏照样能手动上传，不受影响。',
  'discover.noSources.howTo': '查看怎么配置曲库源',
  'discover.noSources.builtin': '内置的 5sing 伴奏源可以用',
  'discover.noSources.builtinAfter': '（默认就是开的）打开；也可以用',
  'discover.noSources.custom':
    '环境变量配上自己的源。源站只需要托管一份静态 JSON，不需要任何服务端逻辑，所以 NAS、对象存储、局域网 HTTP 都能直接用。',
  'discover.noSources.sample':
    'FIVESING_ENABLED=1 ./openktv.sh start\n# 或者用自己的清单：\nLIBRARY_SOURCES="我的伴奏库=https://nas.local/ktv/index.json" ./openktv.sh start',
  'discover.noSources.format':
    '清单格式：{"version":1,"name":"我的伴奏库","items":[{"id":"qingtian","title":"晴天","artist":"周杰伦","kind":"audio","url":"qingtian.mp3","lrc":"qingtian.lrc"}]}',
  'discover.noSources.formatHint': '配好之后重启服务即可。',

  /* --------------------------------- 搜索 --------------------------------- */
  'discover.search.placeholder': '输入歌名或歌手，点「搜索」',
  'discover.search.clear': '清空搜索词',

  /* -------------------------------- 分类筛选 -------------------------------- */
  'discover.filter.audio': '音频',
  'discover.filter.video': '视频',

  /* -------------------------------- 逐源状态 -------------------------------- */
  'discover.source.ok': '{label}（{count}）',
  'discover.source.unavailable': '{label}：不可用',

  /* --------------------------------- 空状态 --------------------------------- */
  'discover.empty.title': '曲库里还没有伴奏',
  'discover.empty.description': '换个关键词试试，或者去伴奏库自己上传一首。',
  'discover.empty.noMatch.title': '没搜到「{query}」相关的伴奏',
  'discover.empty.goLibrary': '去伴奏库上传',

  /* --------------------------------- 列表行 --------------------------------- */
  'discover.kind.video': '视频伴奏',
  'discover.kind.audio': '音频伴奏',
  'discover.hasLyrics': '带歌词',
  'discover.imported': '已入库',
  'discover.goSing': '去演唱',
  'discover.download.button': '点歌',
  'discover.download.retry': '重试点歌',
  'discover.download.queued': '排队中…',
  'discover.download.running': '下载中…',
};

export default discover;
