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
  'discover.title': 'Discover',
  'discover.subtitle':
    'Search by title or artist, then hit “Request” — the song downloads into your library automatically, lyrics included.',

  /* --------------------------------- 失败 --------------------------------- */
  'discover.sources.failed': 'Could not read the library sources',
  'discover.search.failed': 'Search failed',
  'discover.request.failed': 'Request failed',
  'discover.download.failed': 'Download failed',

  /* ------------------------------ 一个源都没配 ------------------------------ */
  'discover.noSources.title': 'No library sources configured',
  'discover.noSources.description':
    'Once a source is configured you can search and request songs here. Uploading tracks by hand keeps working either way.',
  'discover.noSources.howTo': 'How to configure library sources',
  'discover.noSources.builtin': 'The built-in 5sing source can be turned on with',
  'discover.noSources.builtinAfter': ' (on by default). You can also add your own sources with the',
  'discover.noSources.custom':
    'environment variable. A source only needs to host a static JSON file — no server-side logic — so a NAS, object storage, or a plain LAN HTTP server all work.',
  'discover.noSources.sample':
    'FIVESING_ENABLED=1 ./openktv.sh start\n# or with your own manifest:\nLIBRARY_SOURCES="my-library=https://nas.local/ktv/index.json" ./openktv.sh start',
  'discover.noSources.format':
    'Manifest format: {"version":1,"name":"我的伴奏库","items":[{"id":"qingtian","title":"晴天","artist":"周杰伦","kind":"audio","url":"qingtian.mp3","lrc":"qingtian.lrc"}]}',
  'discover.noSources.formatHint': 'Restart the service once it is in place.',

  /* --------------------------------- 搜索 --------------------------------- */
  'discover.search.placeholder': 'Type a title or artist, then hit Search',
  'discover.search.clear': 'Clear search',

  /* -------------------------------- 分类筛选 -------------------------------- */
  'discover.filter.audio': 'Audio',
  'discover.filter.video': 'Video',

  /* -------------------------------- 逐源状态 -------------------------------- */
  'discover.source.ok': '{label} ({count})',
  'discover.source.unavailable': '{label}: unavailable',

  /* --------------------------------- 空状态 --------------------------------- */
  'discover.empty.title': 'The library has no tracks yet',
  'discover.empty.description': 'Try another keyword, or upload a track to your library yourself.',
  'discover.empty.noMatch.title': 'Nothing found for “{query}”',
  'discover.empty.goLibrary': 'Upload in the library',

  /* --------------------------------- 列表行 --------------------------------- */
  'discover.kind.video': 'Video track',
  'discover.kind.audio': 'Audio track',
  'discover.hasLyrics': 'Lyrics',
  'discover.imported': 'In library',
  'discover.goSing': 'Sing now',
  'discover.download.button': 'Request',
  'discover.download.retry': 'Retry request',
  'discover.download.queued': 'Queued…',
  'discover.download.running': 'Downloading…',
};

export default discover;
