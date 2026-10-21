//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录 */
export const ROOT_DIR = path.resolve(here, '..', '..');

/**
 * 数据目录。默认在项目内，可用 DATA_DIR 整体搬走
 * （测试也靠它把库指到临时目录，不碰真实数据）。
 */
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT_DIR, 'data');
export const WEB_DIST_DIR = path.join(ROOT_DIR, 'web', 'dist');

export const PORT = Number(process.env.PORT ?? 8787);
/**
 * 监听地址。默认绑所有网卡 —— 手机要能通过局域网 WiFi 连进来（见 README「手机演唱」）。
 * 只想本机用就 `HOST=127.0.0.1`，绑回环时手机端入口会一并关掉。
 */
export const HOST = process.env.HOST ?? '0.0.0.0';

/**
 * 手机端 HTTPS 镜像端口（默认 PORT+1）。
 *
 * 为什么需要它：手机浏览器只在「安全上下文」里开放麦克风，而规范只把
 * https / 127.0.0.0/8 / localhost 算作潜在可信 origin —— `http://192.168.x.x`
 * 不是（见 W3C Secure Contexts §3.1）。所以局域网入口必须走 HTTPS。
 * 桌面仍用 http://127.0.0.1:8787，看不到证书警告；镜像与主服务是同一个
 * Express 实例、同一份数据，只是多一条 TLS 通道给手机用。
 */
export const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? PORT + 1);
/** 手机 HTTPS 镜像开关；0 = 不签证书、不起镜像（手机只能浏览播放，不能录音） */
export const LAN_HTTPS = (process.env.LAN_HTTPS ?? '1') !== '0';

/** 开发模式下 Vite 的端口（与 vite.config.ts 读同一个环境变量） */
export const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);
/** dev.mjs 给子进程打标记：开发模式不起 HTTPS 镜像（手机入口走 Vite 自己的 TLS） */
export const DEV_MODE = process.env.KTV_DEV === '1';
/**
 * 开发模式让 Vite 也开 TLS（自签名证书与镜像共用 data/certs）。
 *
 * 默认开：手机浏览器只在安全上下文里开放麦克风，开发时扫码即用，
 * 不用记着多敲一个环境变量。代价是桌面开发地址变成
 * https://127.0.0.1:5173，首次会有一次自签名证书警告（点一次「继续访问」就好）。
 * 想完全回到 http：VITE_HTTPS=0。
 */
export const VITE_HTTPS = (process.env.VITE_HTTPS ?? '1') !== '0';

/** 手机端页面路径（二维码指向它；Express 的 SPA 兜底已经覆盖） */
export const MOBILE_PATH = '/m';

/** 自签名证书存放位置（跟着 DATA_DIR 走，备份 data/ 时一起带走） */
export const CERT_DIR = path.join(DATA_DIR, 'certs');

/** 输出音频统一规格 */
export const AUDIO = {
  sampleRate: 48_000,
  channels: 2,
  mp3Bitrate: '192k',
} as const;

/** 代理转码参数（音频代理的 mp3 规格走 AUDIO，见 ffmpeg.ts 的 MP3_OUTPUT_ARGS） */
export const TRANSCODE = {
  videoPreset: 'veryfast',
  videoCrf: 23,
  maxVideoWidth: 1920,
  videoAudioBitrate: '192k',
} as const;

export const JOB_TIMEOUT_MS = {
  transcode: 30 * 60 * 1000,
  mix: 5 * 60 * 1000,
  /**
   * 人声预处理（降噪、压缩、去齿音）单独限时。
   * 不并进 mix 的预算里：预处理与混音是两次独立的 ffmpeg 调用，
   * 混用一个总额会让「预处理慢」和「混音慢」无法区分。
   */
  preProcess: 5 * 60 * 1000,
} as const;

/**
 * 优雅关闭时等待在跑任务的上限（ms）。
 *
 * 服务收到 SIGTERM 后，正在跑的那一次混音/转码还有这个机会落盘；
 * 超时就放弃（任务标 failed，用户重试即可，干声和伴奏都还在）。
 *
 * 默认 8s 是照着 openktv.sh 的 10s 强杀宽限留的余量 —— 服务端先退出，
 * 脚本的 `kill -KILL` 就不会真的落到我们头上。
 */
export const SHUTDOWN_JOB_GRACE_MS = Number(process.env.SHUTDOWN_JOB_GRACE_MS ?? 8000);

/* --------------------------------- 曲库源 --------------------------------- */

/**
 * 曲库源列表，逗号分隔。每一项是 `名字=清单URL` 或直接一个清单URL：
 *
 *   LIBRARY_SOURCES="我的库=https://nas.local/ktv/index.json,https://cdn.example.com/index.json"
 *
 * 名字可以省略（省略时用清单里的 name，再不行用主机名）。
 * 不配置就是空的 —— 点歌台会显示配置指引，其余功能完全不受影响。
 */
export const LIBRARY_SOURCES: string[] = (process.env.LIBRARY_SOURCES ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

/** 清单缓存时长：搜索是本地过滤，不需要每次敲字都打源站 */
export const LIBRARY_CACHE_TTL_MS = Number(process.env.LIBRARY_CACHE_TTL_MS ?? 10 * 60 * 1000);
/** 单次搜索里每个源的超时；超时即视为该源不可用，不影响其他源 */
export const LIBRARY_SEARCH_TIMEOUT_MS = Number(process.env.LIBRARY_SEARCH_TIMEOUT_MS ?? 5_000);
/** 单个伴奏的下载超时；大 MV 可能几百 MB，给得宽一些 */
export const LIBRARY_DOWNLOAD_TIMEOUT_MS = Number(
  process.env.LIBRARY_DOWNLOAD_TIMEOUT_MS ?? 15 * 60 * 1000,
);

/* ------------------------------ 内置 5sing 曲库 ------------------------------ */

/**
 * 内置的 5sing 伴奏源，默认开启。
 *
 * huodong.5sing.kugou.com 只是「5sing音乐活动」页（任何路径都返回同一个 SPA），
 * 没有伴奏接口；真正在用的一直是下面这组 5sing 官方端点。三个 BASE 都可覆盖 ——
 * 哪天活动页或别的镜像提供了同构 API，改环境变量即可，代码不用动。
 */
export const FIVESING_ENABLED = (process.env.FIVESING_ENABLED ?? '1') !== '0';

/** 关键词搜索（filter=3 只出伴奏）与空关键词浏览用的热门伴奏页 */
export const FIVESING_SEARCH_BASE = process.env.FIVESING_SEARCH_BASE ?? 'http://search.5sing.kugou.com';
export const FIVESING_WEB_BASE = process.env.FIVESING_WEB_BASE ?? 'http://5sing.kugou.com';
/** 歌曲元数据（newget）与下载地址（getSongUrl） */
export const FIVESING_API_BASE = process.env.FIVESING_API_BASE ?? 'http://mobileapi.5sing.kugou.com';

/* --------------------------------- 歌词源 --------------------------------- */

/**
 * 酷狗歌词，默认开启。三步流：搜歌拿 hash → 查歌词候选 → 下载 LRC。
 * 选它的理由：与 5sing 同属酷狗、国内直连、候选带评分与时长（挑版本用）。
 *
 * 歌词是附赠功能：任何一步失败都只导致「这首没歌词」，绝不影响伴奏入库。
 */
export const KUGOU_LYRICS_ENABLED = (process.env.KUGOU_LYRICS_ENABLED ?? '1') !== '0';
/** 搜歌接口（该域名只有 http）；歌词查询/下载走 https */
export const KUGOU_SONG_SEARCH_BASE = process.env.KUGOU_SONG_SEARCH_BASE ?? 'http://mobilecdn.kugou.com';
export const KUGOU_LYRICS_BASE = process.env.KUGOU_LYRICS_BASE ?? 'https://lyrics.kugou.com';
/** 歌词三步的总预算；给得比搜索宽一点，但别让点歌任务卡在歌词上 */
export const KUGOU_LYRICS_TIMEOUT_MS = Number(process.env.KUGOU_LYRICS_TIMEOUT_MS ?? 8_000);

export const FFMPEG_BIN = process.env.FFMPEG_BIN ?? 'ffmpeg';
export const FFPROBE_BIN = process.env.FFPROBE_BIN ?? 'ffprobe';

/* ---------------------------------- 访问令牌 --------------------------------- */

/**
 * 可选的局域网访问令牌（默认空 = 不设防，与以前完全一致）。
 *
 * 背景：默认绑 0.0.0.0，同一 WiFi 下谁都能打开页面、调接口 —— 包括
 * DELETE /api/tracks/:id 这种 destructive 操作。家里随便唱无所谓，
 * 宿舍/办公室环境下这就是个真实风险。
 *
 * 设了之后的规则（见 server/src/auth.ts）：
 *  · **回环地址永远放行** —— 桌面本机使用零感知，不用记令牌；
 *  · 非回环（手机 / 局域网其他设备）必须带令牌：header `x-access-token`
 *    或 query `?token=`（`<audio>`/`<video>` 的 src 带不了 header）；
 *  · 二维码地址由服务端自动追加 `?token=`，手机扫码即用，无感。
 */
export const ACCESS_TOKEN = (process.env.ACCESS_TOKEN ?? '').trim();

/* ------------------------------ 曲库私网地址开关 ------------------------------ */

/**
 * 是否拦截曲库源里的私网地址（默认 0 = 不拦）。
 *
 * 清单内容是外部数据，条目 url 理论上可以指向内网服务（SSRF 面）。
 * 但 README 明确宣传「NAS / 对象存储 / 局域网 HTTP 都能当源用」——
 * 那些恰恰是私网地址，默认拦截会直接把宣传出去的功能打死。
 * 所以只做开关：觉得自己配的源不可信、或机器放在不可信网络里，
 * 设 1 打开；此时清单地址、条目 url、下载重定向的每一跳都会过校验
 * （见 server/src/library/urlGuard.ts）。
 */
export const LIBRARY_BLOCK_PRIVATE_NET = (process.env.LIBRARY_BLOCK_PRIVATE_NET ?? '0') !== '0';
