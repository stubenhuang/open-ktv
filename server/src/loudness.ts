import { FFMPEG_BIN } from './config.ts';
import { createLogger } from './logger.ts';
import { runProcess } from './process.ts';

const log = createLogger('loudness');

export interface LoudnessMeasurement {
  /** 整轨积分响度（LUFS）。静音文件为 -Infinity */
  inputI: number;
  /** 真峰值（dBTP）。测不到为 -Infinity */
  inputTp: number;
}

/** loudnorm 的 JSON 输出夹在 stderr 里，尾巴留大一点免得被别的日志挤掉 */
const STDERR_TAIL_BYTES = 64 * 1024;
const MEASURE_TIMEOUT_MS = 3 * 60 * 1000;

function parseNumber(raw: string): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : -Infinity;
}

/**
 * 用 ffmpeg 的 loudnorm 打印模式量一遍响度。
 *
 * 为什么不用单遍 loudnorm 直接归一化：动态模式会引入内部前瞻缓冲，
 * 会给「人声与伴奏对齐」带来不可控的偏移。这里改成「先量、再乘一个静态增益」，
 * 零延迟且结果可预测。
 *
 * 子进程调度（超时杀掉、ENOENT、stderr 尾部）在 process.ts，与 runFfmpeg 共用。
 */
export async function measureLoudness(
  filePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<LoudnessMeasurement> {
  const timeoutMs = opts.timeoutMs ?? MEASURE_TIMEOUT_MS;
  log.debug('测量响度', { filePath });

  const result = await runProcess({
    bin: FFMPEG_BIN,
    args: [
      '-hide_banner',
      '-nostdin',
      '-i',
      filePath,
      // 只看音频，别浪费时间解视频
      '-vn',
      '-af',
      'loudnorm=I=-18:TP=-1.5:LRA=11:print_format=json',
      '-f',
      'null',
      '-',
    ],
    timeoutMs,
    label: '响度测量',
    missingBinMessage: `找不到 ffmpeg（${FFMPEG_BIN}）。请先安装并把 ffmpeg / ffprobe 放进 PATH。`,
    stderrTailBytes: STDERR_TAIL_BYTES,
  });

  if (result.timedOut) {
    log.warn('响度测量超时，已中止', { filePath });
    throw new Error('响度测量超时，伴奏文件可能过长或已损坏');
  }

  const match = result.stderr.match(/\{[^{}]*"input_i"[^{}]*\}/);
  if (!match) {
    // 没拿到 JSON：文件里可能根本没有音频轨
    if (result.code === 0) return { inputI: -Infinity, inputTp: -Infinity };
    throw new Error(`响度测量失败（退出码 ${result.code}）：${result.stderr.trim().slice(-800)}`);
  }

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, string>;
  } catch {
    throw new Error('无法解析 ffmpeg 的响度输出');
  }

  const measurement: LoudnessMeasurement = {
    inputI: parseNumber(parsed.input_i),
    inputTp: parseNumber(parsed.input_tp),
  };
  log.debug('响度测量完成', { filePath, ...measurement });
  return measurement;
}

/**
 * 算出把这段音频推到目标响度需要的静态增益（dB）。
 * 同时受真峰值上限约束 —— 响度不够但峰值已经贴顶时，宁可少推一点，交给末端限幅器收尾。
 */
export function normalizeGainDb(
  measurement: LoudnessMeasurement,
  targetI: number,
  maxTruePeakDb = -1,
): number {
  if (!Number.isFinite(measurement.inputI)) return 0;

  const byLoudness = targetI - measurement.inputI;
  const byPeak = Number.isFinite(measurement.inputTp)
    ? maxTruePeakDb - measurement.inputTp
    : Number.POSITIVE_INFINITY;

  return Math.max(-30, Math.min(30, Math.min(byLoudness, byPeak)));
}
