import { HOST, PORT } from './config.ts';
import { createApp } from './app.ts';
import { initDb, recoverInterruptedJobs } from './db.ts';
import { createLogger } from './logger.ts';
import { cleanTmpDir } from './paths.ts';

const log = createLogger('boot');

initDb();
cleanTmpDir();
const recovered = recoverInterruptedJobs();
if (recovered.tracks > 0 || recovered.works > 0) {
  log.info(`已把中断的任务标记为失败：伴奏 ${recovered.tracks} 个、作品 ${recovered.works} 个`);
}

const app = createApp();

const server = app.listen(PORT, HOST, () => {
  log.info(`Open KTV 服务已就绪：http://${HOST}:${PORT}`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    log.error(`端口 ${PORT} 已被占用。换一个端口：PORT=8888 npm run dev`);
  } else {
    log.error('服务启动失败', { error });
  }
  process.exit(1);
});

function shutdown(signal: string): void {
  log.info(`收到 ${signal}，正在关闭服务…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
