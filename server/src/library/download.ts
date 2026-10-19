/**
 * 从曲库源把文件拉回本地。
 *
 * 清单地址由用户配置，但清单**内容**是外部数据 —— 里面的 url 可能指向内网
 * （SSRF），也可能是这个项目根本处理不了的东西。这里的约束是：
 * 只允许 http(s)、有硬性大小上限、有超时、超限立刻中断而不是先下完再判断。
 *
 * LIBRARY_BLOCK_PRIVATE_NET=1 时，每一次 fetch 的每一跳（含重定向目标）
 * 都要过私网校验 —— fetch 的 redirect:'follow' 不会告诉我们最终跳到哪，
 * 所以那条路改成手动跟随，自己盯着 location。
 */

import fs from 'node:fs';
import { createLogger } from '../logger.ts';
import { LIBRARY_BLOCK_PRIVATE_NET } from '../config.ts';
import { assertPublicHttpUrl } from './urlGuard.ts';

const log = createLogger('library');

/** 手动跟随重定向的上限：够用，也够防「无限跳圈」 */
const MAX_REDIRECTS = 5;

export interface DownloadToFileOptions {
  url: string;
  destPath: string;
  maxBytes: number;
  timeoutMs: number;
  /** 0–1；用于任务进度（留了 1% 给入库/转码，进度条不会先满再卡住） */
  onProgress: (ratio: number) => void;
}

function describeLimit(maxBytes: number): string {
  return `${Math.round(maxBytes / 1024 / 1024)}MB`;
}

/**
 * 带「私网校验 + 手动重定向」的 fetch。
 *
 * 开关关着时走原生 redirect:'follow' —— 与启用校验前的行为逐字节一致。
 */
async function fetchUrl(url: string, timeoutMs: number): Promise<Response> {
  if (!LIBRARY_BLOCK_PRIVATE_NET) {
    return fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  }

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHttpUrl(current);
    const response = await fetch(current, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    const location = response.headers.get('location');
    const isRedirect = response.status >= 300 && response.status < 400 && location;
    if (!isRedirect) return response;

    // 相对地址按当前地址绝对化；type=... 的情况（305）不用管，早没人用了
    current = new URL(location, current).toString();
  }
  throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次，已放弃`);
}

/**
 * 流式下载到文件，返回写入的字节数。
 * 任何失败都抛错，并且**不留半个文件**（调用方负责清 tmp）。
 */
export async function downloadToFile(options: DownloadToFileOptions): Promise<number> {
  const { url, destPath, maxBytes, timeoutMs, onProgress } = options;

  let response: Response;
  try {
    response = await fetchUrl(url, timeoutMs);
  } catch (error) {
    throw new Error(`下载失败：${error instanceof Error ? error.message : '网络错误'}`);
  }
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
  if (!response.body) throw new Error('下载失败：响应没有内容');

  // 声明的大小先在下载前挡一道，避免白下几百 MB 再拒绝
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`文件超过 ${describeLimit(maxBytes)} 上限，已拒绝下载`);
  }

  const handle = await fs.promises.open(destPath, 'w');
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      received += value.byteLength;
      // 源站没给 content-length 时也得能拦住超大文件
      if (received > maxBytes) {
        throw new Error(`文件超过 ${describeLimit(maxBytes)} 上限，已中断下载`);
      }
      await handle.write(value);
      onProgress(declared > 0 ? Math.min(0.99, received / declared) : 0.5);
    }
  } finally {
    await handle.close();
  }

  if (received === 0) throw new Error('下载到的文件是空的');

  onProgress(1);
  log.debug('曲库文件下载完成', { bytes: received });
  return received;
}

/**
 * 拉一段文本（歌词用）。
 * 失败返回 null —— 歌词是锦上添花，不该因为它拉不到就让伴奏入库失败。
 */
export async function fetchText(url: string, maxBytes: number, timeoutMs: number): Promise<string | null> {
  try {
    const response = await fetchUrl(url, timeoutMs);
    if (!response.ok) {
      log.warn('歌词下载失败，将不带歌词入库', { status: response.status });
      return null;
    }
    const text = await response.text();
    if (text.length > maxBytes) {
      log.warn('歌词文件过大，已忽略', { chars: text.length });
      return null;
    }
    return text;
  } catch (error) {
    log.warn('歌词下载失败，将不带歌词入库', { error });
    return null;
  }
}
