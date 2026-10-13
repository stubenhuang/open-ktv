import { HOST, PORT } from './config.ts';
import { createApp } from './app.ts';
import { initDb, recoverInterruptedJobs } from './db.ts';
import { createLogger } from './logger.ts';
import { cleanTmpDir } from './paths.ts';
import { startLanHttpsMirror, stopLanHttpsMirror, isLoopbackHost } from './lanHttps.ts';

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
  if (isLoopbackHost()) {
    log.info('只绑了本机回环，手机连不进来；要手机演唱就把 HOST 留空（默认 0.0.0.0）');
  }
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    log.error(`端口 ${PORT} 已被占用。换一个端口：PORT=8888 npm run dev`);
  } else {
    log.error('服务启动失败', { error });
  }
  process.exit(1);
});

/**
 * 手机端 HTTPS 镜像（生产模式、绑了非回环地址时才起）。
 *
 * 放在 listen 之后：镜像失败绝不该拖垮主服务 —— 手机不能录音而已，
 * 桌面该干嘛干嘛。地址与二维码由 /api/network 现查现给。
 */
void startLanHttpsMirror(app).then((state) => {
  if (state.running) {
    log.info(`手机演唱入口：https://<局域网IP>:${state.port}/m（扫码或手输，首次需信任自签名证书）`);
  }
});

function shutdown(signal: string): void {
  log.info(`收到 ${signal}，正在关闭服务…`);
  // 镜像先收：它和主服务是同一个 app，先关少的那个
  void stopLanHttpsMirror().finally(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
