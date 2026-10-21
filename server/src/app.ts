//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { LIBRARY_SOURCES, KUGOU_LYRICS_ENABLED, WEB_DIST_DIR, DATA_DIR } from './config.ts';
import { createDefaultRegistry, type LibraryRegistry } from './library/registry.ts';
import { createKugouLyrics } from './library/lyrics/kugou.ts';
import type { LyricsLookup } from './library/lyrics/types.ts';
import { queueState } from './jobs.ts';
import { detectFfmpegCapabilities } from './ffmpegCapabilities.ts';
import { freeBytes } from './disk.ts';
import { createTokenGate } from './auth.ts';
import { createLogger, type LogLevel } from './logger.ts';
import { fail, readHttpError } from './httpError.ts';
import { createLibraryRouter } from './routes/library.ts';
import { createNetworkRouter } from './routes/network.ts';
import { createTracksRouter } from './routes/tracks.ts';
import mediaRouter from './routes/media.ts';
import worksRouter from './routes/works.ts';

const httpLog = createLogger('http');

export interface CreateAppOptions {
  /**
   * 曲库源注册表。生产从 LIBRARY_SOURCES + 内置 5sing 构建；测试注入指向本地
   * 清单源的实例，从而完全不依赖外网。
   */
  library?: LibraryRegistry;
  /**
   * 歌词源。生产默认酷狗（KUGOU_LYRICS_ENABLED=0 时为 null）；
   * 测试注入假实现，同样不碰外网。
   */
  lyrics?: LyricsLookup | null;
}

/**
 * 组装 Express 应用（不监听端口、不碰数据库）。
 *
 * index.ts 负责 initDb / 启动 / 信号收尾；测试直接把 createApp() 挂到临时端口上，
 * 配 DATA_DIR 指向临时目录即可整条 API 链路跑起来。
 */
export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  const library = options.library ?? createDefaultRegistry(LIBRARY_SOURCES);
  const lyrics = options.lyrics ?? (KUGOU_LYRICS_ENABLED ? createKugouLyrics() : null);

  // 请求日志：谁、什么路径、什么状态码、花了多久。
  // 轮询类接口（健康检查、媒体流）和非 api 请求降到 debug，否则前端一刷就是一片。
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const costMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const line = `${req.method} ${req.originalUrl} ${res.statusCode} ${costMs.toFixed(0)}ms`;
      const level: LogLevel =
        res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      const noisy =
        !req.path.startsWith('/api') ||
        req.path.startsWith('/api/media') ||
        req.path === '/api/health';
      if (noisy) httpLog.debug(line);
      else if (level === 'info') httpLog.info(line);
      else if (level === 'warn') httpLog.warn(line);
      else httpLog.error(line);
    });
    next();
  });

  // 访问令牌闸门（ACCESS_TOKEN 没配时完全透明）。放在所有 /api 路由之前，
  // 静态前端壳和 SPA 兜底不设限 —— 页面谁都能看，数据接口才需要令牌。
  app.use('/api', createTokenGate());

  // 健康检查：队列状态 + 数据盘余量。openktv.sh status 打的就是它，
  // 磁盘快满时在这里一眼能看见（上传前的预检也是同一份数据）。
  app.get('/api/health', async (_req, res) => {
    let free: number | null = null;
    try {
      free = await freeBytes(DATA_DIR);
    } catch {
      // 量不到就只报队列，别让健康检查本身失败
    }
    // capabilities：ffmpeg 能力（rubberband）。缺它时前端把升降调禁掉并说明原因，
    // 而不是等用户选了调、点了保存才失败。现探一次（带缓存）：没跑过启动探测时
    // （例如测试里直接 createApp）也能给出真实答案
    const capabilities = await detectFfmpegCapabilities();
    res.json({
      ok: true,
      queue: queueState(),
      disk: { freeBytes: free },
      capabilities,
    });
  });

  app.use('/api/tracks', createTracksRouter({ lyrics }));
  app.use('/api/works', worksRouter);
  app.use('/api/library', createLibraryRouter(library, { lyrics }));
  app.use('/api/media', mediaRouter);
  // 手机端入口：局域网地址探测 + 二维码 + 自签名证书下载
  app.use('/api/network', createNetworkRouter());

  app.use('/api', (_req, res) => {
    fail(res, 404, 'endpoint_not_found');
  });

  // 生产模式：直接托管 vite build 出来的前端；没有 dist 时同一个兜底路由给出提示
  const hasBuiltWeb = fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'));
  const serveAppShell: RequestHandler = hasBuiltWeb
    ? // SPA 兜底：非 /api 的 GET 一律交给前端路由
      (_req, res) => {
        res.sendFile(path.join(WEB_DIST_DIR, 'index.html'));
      }
    : (_req, res) => {
        res
          .status(503)
          .type('text/plain; charset=utf-8')
          .send(
            '前端还没构建。开发时请用 npm run dev（Vite 在 5173）；生产请先 npm run build。\n' +
              'The front end has not been built. Use `npm run dev` for development, ' +
              'or run `npm run build` before starting in production mode.',
          );
      };

  if (hasBuiltWeb) {
    app.use(express.static(WEB_DIST_DIR, { index: false }));
    httpLog.debug('检测到 web/dist，静态托管已开启');
  } else {
    httpLog.warn('未检测到 web/dist，页面请求会返回 503（开发模式请访问 Vite）');
  }
  app.get(/^\/(?!api\/).*/, serveAppShell);

  // 统一错误出口：JSON 解析失败、multer 之外漏出的异常都在这里收口
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    httpLog.error('请求处理出错', { error });
    if (res.headersSent) {
      res.end();
      return;
    }
    const { status, code, params } = readHttpError(error, 'internal_error', 500);
    fail(res, status, code, params);
  });

  return app;
}
