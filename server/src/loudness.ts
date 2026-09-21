import { spawn } from 'node:child_process';
import { FFMPEG_BIN } from './config.ts';
import { createLogger } from './logger.ts';

const log = createLogger('loudness');

export interface LoudnessMeasurement {
  /** 整轨积分响度（LUFS）。静音文件为 -Infinity */
  inputI: number;
  /** 真峰值（dBTP）。测不到为 -Infinity */
  inputTp: number;
}

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
 */
export function measureLoudness(
  filePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<LoudnessMeasurement> {
  const timeoutMs = opts.timeoutMs ?? MEASURE_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    log.debug('测量响度', { filePath });
    const child = spawn(
      FFMPEG_BIN,
      [
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
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      log.warn('响度测量超时，已中止', { filePath });
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();

    const finish = (error?: Error, value?: LoudnessMeasurement) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        finish(
          new Error(
            `找不到 ffmpeg（${FFMPEG_BIN}）。请先安装并把 ffmpeg / ffprobe 放进 PATH。`,
          ),
        );
        return;
      }
      finish(new Error(`响度测量启动失败：${error.message}`));
    });

    child.on('close', (code) => {
      if (timedOut) {
        finish(new Error('响度测量超时，伴奏文件可能过长或已损坏'));
        return;
      }

      const match = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/);
      if (!match) {
        // 没拿到 JSON：文件里可能根本没有音频轨
        if (code === 0) {
          finish(undefined, { inputI: -Infinity, inputTp: -Infinity });
          return;
        }
        finish(new Error(`响度测量失败（退出码 ${code}）：${stderr.trim().slice(-800)}`));
        return;
      }

      let parsed: Record<string, string>;
      try {
        parsed = JSON.parse(match[0]) as Record<string, string>;
      } catch {
        finish(new Error('无法解析 ffmpeg 的响度输出'));
        return;
      }

      finish(undefined, {
        inputI: parseNumber(parsed.input_i),
        inputTp: parseNumber(parsed.input_tp),
      });
      log.debug('响度测量完成', {
        filePath,
        inputI: parseNumber(parsed.input_i),
        inputTp: parseNumber(parsed.input_tp),
      });
    });
  });
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

/**
 * dB → 线性增益。
 * 定义搬到 shared/mix.ts（前端实时预览要复算同一套增益），这里转手出去保持既有 import 不破。
 */
export { dbToLinear } from '../../shared/mix.ts';
