import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FFPROBE_BIN } from './config.ts';
import { classifyProbe, type Classification, type FfprobeResult } from './classify.ts';
import { createLogger } from './logger.ts';

const log = createLogger('probe');

const execFileAsync = promisify(execFile);

export type { Classification, FfprobeResult };

const PROBE_TIMEOUT_MS = 60_000;

/**
 * 用 ffprobe 读文件的流信息。文件损坏、格式不支持、ffprobe 缺失都会抛错，
 * 调用方负责把错误变成面向前端的中文提示。
 */
export async function probeFile(filePath: string): Promise<FfprobeResult> {
  log.debug('探测文件', { filePath });
  try {
    const { stdout } = await execFileAsync(
      FFPROBE_BIN,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        // 允许探测 mkv 等容器时读取时长
        '-analyzeduration',
        '100M',
        '-probesize',
        '100M',
        filePath,
      ],
      { maxBuffer: 16 * 1024 * 1024, timeout: PROBE_TIMEOUT_MS },
    );
    return JSON.parse(stdout) as FfprobeResult;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (err.code === 'ENOENT') {
      throw new Error(
        `找不到 ffprobe（${FFPROBE_BIN}）。请先安装 ffmpeg（内含 ffprobe）并放进 PATH。`,
      );
    }
    if (err.killed) throw new Error('探测文件超时，文件可能损坏或过大');
    const detail = (err.stderr ?? '').trim().split('\n').slice(-3).join(' / ');
    throw new Error(`无法解析这个文件：${detail || err.message}`);
  }
}

export interface ProbeAndClassify extends Classification {
  raw: FfprobeResult;
}

export async function probeAndClassify(
  filePath: string,
  options: { extension?: string } = {},
): Promise<ProbeAndClassify> {
  const raw = await probeFile(filePath);
  return { ...classifyProbe(raw, options), raw };
}
