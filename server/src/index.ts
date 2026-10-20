import { HOST, PORT, SHUTDOWN_JOB_GRACE_MS } from './config.ts';
import { createApp } from './app.ts';
import { closeDb, initDb, recoverInterruptedJobs } from './db.ts';
import { killRunningChildren } from './process.ts';
import { whenQueueIdle } from './jobs.ts';
import { detectFfmpegCapabilities } from './ffmpegCapabilities.ts';
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
if (recovered.pitches > 0) {
  log.info(`已作废中断的移调伴奏 ${recovered.pitches} 个（播放回落到原调，重新设置升降调即可再生成）`);
}

// 升降调要用的 rubberband 是 ffmpeg 的编译期开关：先探一次，缺了就一路降级
// （接口禁掉控件、说明原因），别等用户选了调才炸
await detectFfmpegCapabilities();

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 优雅关闭只能进一次：Ctrl+C 按两次时第二次直接无视（强杀由脚本层负责） */
let shuttingDown = false;

/**
 * 优雅关闭。
 *
 * 顺序有讲究，每一步都在解决一个具体的「退出后留烂摊子」问题：
 *
 *  1. `server.close()` —— 不再接受新连接。但它**不会**断开已建立的
 *     keep-alive 连接，浏览器开着的页面会让它一直不返回；
 *  2. 2 秒后 `closeAllConnections()` —— 到点强制断开，保证退出流程走得动；
 *  3. 等队列空（上限 SHUTDOWN_JOB_GRACE_MS）—— 给正在跑的那一次
 *     混音/转码一个落盘机会。任务中途被杀，作品会停在 failed，
 *     而干声和伴奏都还在，用户重点「合成」就能恢复；
 *  4. `killRunningChildren()` —— 还没跑完的 ffmpeg 显式收掉。
 *     父进程 exit 不会带走子进程，它们会被过继给 init 继续写
 *     `data/tmp` 里的半成品（库里的任务却已标 failed，从此没人认领）；
 *  5. 关 HTTPS 镜像、关库（WAL 合并回主库）。
 *
 * 整体再包一层总超时：关闭流程任何一步卡住都必须在有限时间内退出，
 * 绝不能把「停止服务」本身变成需要被强杀的操作。
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`收到 ${signal}，正在关闭服务…`);

  // ① 停止接受新连接；② 到点强制断开 keep-alive，别让 close 永远悬着
  server.close();
  setTimeout(() => server.closeAllConnections(), 2000).unref();

  // 总超时兜底：③④⑤ 任何一步卡住，到点也必须退出 —— 「停止服务」
  // 本身不该变成需要被强杀的操作。各步骤自身也都有界（等待任务有
  // 上限、kill 子进程最多 1s、关库是同步的），这里只是最后一道保险。
  const hardDeadlineMs = SHUTDOWN_JOB_GRACE_MS + 5000;
  let hardExit = false;
  const hardTimer = setTimeout(() => {
    hardExit = true;
    log.warn('关闭流程超过总超时，强制退出');
    process.exit(0);
  }, hardDeadlineMs);
  hardTimer.unref();

  try {
    // ③ 等在跑的任务（混音/转码），超时就放弃 —— 用户重试即可
    const drained = await Promise.race([
      whenQueueIdle().then(() => true),
      sleep(SHUTDOWN_JOB_GRACE_MS).then(() => false),
    ]);
    if (!drained) {
      log.warn(`等待任务结束超时（${SHUTDOWN_JOB_GRACE_MS}ms），将继续关闭`);
    }

    // ④ 收掉还在跑的 ffmpeg，别留孤儿进程写 tmp
    await killRunningChildren();

    // ⑤ 镜像与数据库
    await stopLanHttpsMirror();
    closeDb();
  } catch (error) {
    log.error('关闭过程中出错', { error });
  }

  if (!hardExit) {
    clearTimeout(hardTimer);
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
