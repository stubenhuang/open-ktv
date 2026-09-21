import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { WEB_DIST_DIR } from './config.ts';
import { queueState } from './jobs.ts';
import { createLogger, type LogLevel } from './logger.ts';
import mediaRouter from './routes/media.ts';
import tracksRouter from './routes/tracks.ts';
import worksRouter from './routes/works.ts';

const httpLog = createLogger('http');

/**
 * 组装 Express 应用（不监听端口、不碰数据库）。
 *
 * index.ts 负责 initDb / 启动 / 信号收尾；测试直接把 createApp() 挂到临时端口上，
 * 配 DATA_DIR 指向临时目录即可整条 API 链路跑起来。
 */
export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

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

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, queue: queueState() });
  });

  app.use('/api/tracks', tracksRouter);
  app.use('/api/works', worksRouter);
  app.use('/api/media', mediaRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });

  // 生产模式：直接托管 vite build 出来的前端
  const hasBuiltWeb = fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'));
  if (hasBuiltWeb) {
    app.use(express.static(WEB_DIST_DIR, { index: false }));
    // SPA 兜底：非 /api 的 GET 一律交给前端路由
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(WEB_DIST_DIR, 'index.html'));
    });
    httpLog.debug('检测到 web/dist，静态托管已开启');
  } else {
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res
        .status(503)
        .type('text/plain; charset=utf-8')
        .send('前端还没构建。开发时请用 npm run dev（Vite 在 5173）；生产请先 npm run build。');
    });
    httpLog.warn('未检测到 web/dist，页面请求会返回 503（开发模式请访问 Vite）');
  }

  // 统一错误出口：JSON 解析失败、multer 之外漏出的异常都在这里收口
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : '服务内部错误';
    httpLog.error('请求处理出错', { error });
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = (error as { status?: number; statusCode?: number }).status
      ?? (error as { statusCode?: number }).statusCode
      ?? 500;
    res.status(status).json({ error: message });
  });

  return app;
}
