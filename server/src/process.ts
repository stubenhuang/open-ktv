import { spawn } from 'node:child_process';

/**
 * 跑一次外部二进制（目前只有 ffmpeg），只负责「调度」这一层：
 * 超时杀掉、stderr 尾部留证、把退出码原样交给调用方。
 *
 * 刻意不在这一层拼业务错误文案 —— ffmpeg 的「转码失败」「混音失败」
 * 和响度测量的「听不到音频轨」是不同的事，由各自的调用方决定怎么报。
 */

export interface ProcessResult {
  /** 进程退出码；被信号杀掉时为 null */
  code: number | null;
  /** 是否因超时被 SIGKILL */
  timedOut: boolean;
  /** stderr 尾部（最多 stderrTailBytes 字节） */
  stderr: string;
}

export interface RunProcessOptions {
  bin: string;
  args: string[];
  timeoutMs: number;
  /** 任务名，仅用于「启动失败」文案 */
  label: string;
  /** 二进制找不到（ENOENT）时抛出的文案，各调用方保留自己的提示 */
  missingBinMessage: string;
  /** 逐块接收 stdout（-progress 解析用）；不传则不接 stdout */
  onStdout?: (chunk: string) => void;
  /** stderr 尾部保留多少字节，默认 4KB */
  stderrTailBytes?: number;
}

const DEFAULT_STDERR_TAIL_BYTES = 4096;

export function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  const { bin, args, timeoutMs, label, missingBinMessage, onStdout } = options;
  const stderrTailBytes = options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', onStdout ? 'pipe' : 'ignore', 'pipe'],
    });

    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();

    const finish = (error?: Error, value?: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };

    // stdio 里 stderr 固定是 pipe，这里拿到的必然不是 null
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-stderrTailBytes);
    });

    if (onStdout) {
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', onStdout);
    }

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        finish(new Error(missingBinMessage));
        return;
      }
      finish(new Error(`${label} 启动失败：${error.message}`));
    });

    // 超时被杀同样走 close，调用方看 timedOut 决定怎么报
    child.on('close', (code) => {
      finish(undefined, { code, timedOut, stderr });
    });
  });
}
