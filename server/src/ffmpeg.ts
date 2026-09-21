import { spawn } from 'node:child_process';
import { FFMPEG_BIN } from './config.ts';
import { createLogger } from './logger.ts';

const log = createLogger('ffmpeg');

export interface RunFfmpegOptions {
  args: string[];
  timeoutMs: number;
  /** 用于把 out_time 换算成 0–1 的进度；为空则不报进度 */
  totalDurationSec?: number | null;
  onProgress?: (ratio: number) => void;
  label?: string;
}

const STDERR_TAIL_BYTES = 4096;

/**
 * 跑一次 ffmpeg，带超时、错误尾部和进度回调。
 * 注意：这里不经过 shell，args 直接传给进程，避免路径注入。
 */
export function runFfmpeg(options: RunFfmpegOptions): Promise<void> {
  const { args, timeoutMs, totalDurationSec, onProgress, label = 'ffmpeg' } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    log.debug(`启动 ${label}`, { bin: FFMPEG_BIN, timeoutSec: Math.round(timeoutMs / 1000) });

    let stderrTail = '';
    let stdoutBuffer = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (!onProgress || !totalDurationSec || totalDurationSec <= 0) return;
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const [key, rawValue] = line.split('=');
        if (key !== 'out_time_us' && key !== 'out_time_ms') continue;
        const micros = Number(rawValue);
        if (!Number.isFinite(micros) || micros < 0) continue;
        const ratio = micros / 1_000_000 / totalDurationSec;
        onProgress(Math.max(0, Math.min(1, ratio)));
      }
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        finish(
          new Error(
            `找不到 ffmpeg（${FFMPEG_BIN}）。请先安装并把 ffmpeg / ffprobe 放进 PATH，` +
              `或用 FFMPEG_BIN 环境变量指定绝对路径。`,
          ),
        );
        return;
      }
      finish(new Error(`${label} 启动失败：${error.message}`));
    });

    child.on('close', (code) => {
      if (timedOut) {
        log.warn(`${label} 超时（${Math.round(timeoutMs / 1000)}s），已中止`);
        finish(new Error(`${label} 超时（${Math.round(timeoutMs / 1000)}s）已中止`));
        return;
      }
      if (code === 0) {
        onProgress?.(1);
        finish();
        return;
      }
      log.debug(`${label} 退出码 ${code}`, { stderrTail: stderrTail.trim().slice(-500) });
      finish(new Error(`${label} 失败（退出码 ${code}）：${stderrTail.trim().slice(-1500)}`));
    });
  });
}
