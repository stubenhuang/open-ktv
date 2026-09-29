import { AUDIO, FFMPEG_BIN } from './config.ts';
import { createLogger } from './logger.ts';
import { runProcess } from './process.ts';

const log = createLogger('ffmpeg');

/**
 * 输出 mp3 的统一参数：混音成品和音频代理都是 192k 立体声 48k，
 * 所以两边共用同一份，别各写一遍。
 */
export const MP3_OUTPUT_ARGS = [
  '-c:a',
  'libmp3lame',
  '-b:a',
  AUDIO.mp3Bitrate,
  '-ar',
  String(AUDIO.sampleRate),
  '-ac',
  String(AUDIO.channels),
  '-id3v2_version',
  '3',
];

/** 让 ffmpeg 把 -progress 写到 stdout 的固定尾巴（runFfmpeg 靠它报进度） */
export const PROGRESS_OUTPUT_ARGS = ['-progress', 'pipe:1', '-nostats'];

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
 *
 * 子进程调度（超时杀掉、ENOENT、stderr 尾部）在 process.ts，与响度测量共用。
 */
export async function runFfmpeg(options: RunFfmpegOptions): Promise<void> {
  const { args, timeoutMs, totalDurationSec, onProgress, label = 'ffmpeg' } = options;

  log.debug(`启动 ${label}`, { bin: FFMPEG_BIN, timeoutSec: Math.round(timeoutMs / 1000) });

  const trackProgress =
    onProgress && totalDurationSec && totalDurationSec > 0
      ? progressParser(totalDurationSec, onProgress)
      : undefined;

  const result = await runProcess({
    bin: FFMPEG_BIN,
    args,
    timeoutMs,
    label,
    missingBinMessage:
      `找不到 ffmpeg（${FFMPEG_BIN}）。请先安装并把 ffmpeg / ffprobe 放进 PATH，` +
      `或用 FFMPEG_BIN 环境变量指定绝对路径。`,
    stderrTailBytes: STDERR_TAIL_BYTES,
    onStdout: trackProgress,
  });

  if (result.timedOut) {
    log.warn(`${label} 超时（${Math.round(timeoutMs / 1000)}s），已中止`);
    throw new Error(`${label} 超时（${Math.round(timeoutMs / 1000)}s）已中止`);
  }
  if (result.code === 0) {
    onProgress?.(1);
    return;
  }

  log.debug(`${label} 退出码 ${result.code}`, { stderrTail: result.stderr.trim().slice(-500) });
  throw new Error(`${label} 失败（退出码 ${result.code}）：${result.stderr.trim().slice(-1500)}`);
}

/** -progress 的 out_time_* 行 → 0–1；残留半行留在 buffer 里等下一块 */
function progressParser(totalDurationSec: number, onProgress: (ratio: number) => void) {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const [key, rawValue] = line.split('=');
      if (key !== 'out_time_us' && key !== 'out_time_ms') continue;
      const micros = Number(rawValue);
      if (!Number.isFinite(micros) || micros < 0) continue;
      onProgress(Math.max(0, Math.min(1, micros / 1_000_000 / totalDurationSec)));
    }
  };
}
