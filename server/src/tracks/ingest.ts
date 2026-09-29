/**
 * 伴奏入库链路。
 *
 * 这个文件存在的唯一理由：**手动上传**与**曲库点歌下载**必须走出完全一样的
 * 结果。两边的差异只在「文件从哪来」，之后的探测、清名、解析歌名、落库、
 * 按需转码都不该有第二份实现 —— 否则点歌来的伴奏迟早在某个细节上和
 * 上传的不一致（漏了代理转码、错了扩展名、忘了歌词），而且极难发现。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TrackKind, TrackSource } from '../../../shared/types.ts';
import { findAudioStream } from '../classify.ts';
import { getTrack, insertTrack, updateTrack, type TrackRecord } from '../db.ts';
import { transcodeKey } from '../dto.ts';
import { enqueue } from '../jobs.ts';
import { createLogger } from '../logger.ts';
import { decodeOriginalName, parseNameParts, safeExtension } from '../naming.ts';
import { ORIGINALS_DIR } from '../paths.ts';
import { probeAndClassify } from '../probe.ts';
import { proxyPathFor, transcodeToProxy, type ProxyTarget } from '../transcode.ts';

const log = createLogger('track');

/** 可以带回 HTTP 状态码的入库错误；调用方按 status 回响应 */
export class IngestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'IngestError';
    this.status = status;
  }
}

/**
 * 排一次代理转码。
 *
 * 抽出来是因为「上传后自动转」和「失败后重试」两条路都要用它，
 * 而且任务内部重新读库 —— 保证用的是最新状态。
 */
export function startTranscode(
  trackId: string,
  sourcePath: string,
  durationSec: number | null,
  target: ProxyTarget,
): void {
  const outputPath = proxyPathFor(trackId, target);

  enqueue(
    transcodeKey(trackId),
    async (report) => {
      await fs.promises.rm(outputPath, { force: true });
      await transcodeToProxy({ sourcePath, outputPath, target, durationSec, onProgress: report });
      updateTrack(trackId, {
        status: 'ready',
        error: null,
        playablePath: outputPath,
        proxyKind: target,
      });
    },
    (error) => {
      updateTrack(trackId, { status: 'failed', error: error.message });
      void fs.promises.rm(outputPath, { force: true });
    },
  );
}

export interface IngestInput {
  /** 已经在 tmp 目录里的待入库文件；成功后会被移进 ORIGINALS_DIR */
  tmpPath: string;
  /** 原始文件名：用来解析歌名/歌手、决定保留哪个扩展名 */
  originalName: string;
  /** 表单/清单里显式给的歌名与歌手；为空则回落到文件名解析 */
  title?: string | null;
  artist?: string | null;
  mime?: string | null;
  size: number;
  /** 默认 'upload'；点歌下载传 'library' */
  source?: TrackSource;
  /** 曲库来源键 `providerId:itemId`；唯一索引据此去重 */
  libraryRef?: string | null;
  /** 随伴奏一起拿到的 LRC 歌词（曲库源可选提供） */
  lyrics?: string | null;
}

export interface IngestResult {
  track: TrackRecord;
  /** 最终落在库里的歌名/歌手（可能是从文件名解析出来的） */
  title: string;
  artist: string | null;
  kind: TrackKind;
  durationSec: number | null;
  /** 需要转码时给出目标，null = 浏览器可直接播 */
  proxyTarget: ProxyTarget | null;
  /** 探测给出的可读理由，直接进日志 */
  reason: string;
}

/**
 * 把一个临时文件收进伴奏库。
 *
 * 无论成败，tmp 里的文件都不会留在原处：成功被 rename 走，
 * 失败由调用方（或这里的 finally）清掉。抛出的都是 IngestError。
 */
export async function ingestFile(input: IngestInput): Promise<IngestResult> {
  const originalName = decodeOriginalName(input.originalName);
  const extension = path.extname(originalName).toLowerCase();

  let probed: Awaited<ReturnType<typeof probeAndClassify>>;
  try {
    probed = await probeAndClassify(input.tmpPath, { extension });
  } catch (error) {
    // 探测失败（文件损坏 / ffprobe 缺失）一律按「这个文件不能用」回报
    throw new IngestError(error instanceof Error ? error.message : '无法解析这个文件');
  }

  if (!findAudioStream(probed.raw)) {
    throw new IngestError('这个文件里没有音频轨，无法作为伴奏使用');
  }

  const { title: parsedTitle, artist: parsedArtist } = parseNameParts(originalName);
  const title = (input.title ?? '').trim() || parsedTitle;
  const artist = (input.artist ?? '').trim() || parsedArtist;

  const id = randomUUID();
  // 保留原始扩展名：Content-Type 判定与后续探测都靠它
  const safeExt = safeExtension(originalName, probed.kind === 'video' ? '.mp4' : '.mp3');
  const originalPath = path.join(ORIGINALS_DIR, `${id}${safeExt}`);
  await fs.promises.rename(input.tmpPath, originalPath);

  const proxyTarget: ProxyTarget = probed.kind === 'video' ? 'video' : 'audio';
  const needsProxy = !probed.playable;

  insertTrack({
    id,
    title,
    artist,
    kind: probed.kind,
    originalName,
    originalPath,
    playablePath: needsProxy ? proxyPathFor(id, proxyTarget) : originalPath,
    proxyKind: needsProxy ? proxyTarget : 'none',
    mime: input.mime ?? null,
    size: input.size,
    duration: probed.durationSec,
    status: needsProxy ? 'processing' : 'ready',
    error: null,
    source: input.source ?? 'upload',
    libraryRef: input.libraryRef ?? null,
    lyrics: input.lyrics ?? null,
  });

  if (needsProxy) {
    startTranscode(id, originalPath, probed.durationSec, proxyTarget);
  }

  const track = getTrack(id);
  if (!track) throw new IngestError('入库后读不到记录', 500);

  log.info(`${title}（${probed.kind}）→ ${needsProxy ? `转码 ${proxyTarget}` : '直接可用'}：${probed.reason}`, {
    id,
    artist: artist ?? undefined,
    durationSec: probed.durationSec ?? undefined,
    size: input.size,
    source: input.source ?? 'upload',
  });

  return {
    track,
    title,
    artist,
    kind: probed.kind,
    durationSec: probed.durationSec,
    proxyTarget: needsProxy ? proxyTarget : null,
    reason: probed.reason,
  };
}

/**
 * 清掉一个没能入库的临时文件。
 * 清理失败只记日志 —— 不能因为删不掉一个 tmp 文件就把整次入库判成失败。
 */
export async function discardTmp(tmpPath: string | undefined): Promise<void> {
  if (!tmpPath) return;
  try {
    await fs.promises.rm(tmpPath, { force: true });
  } catch (error) {
    log.warn('清理临时文件失败', { path: tmpPath, error });
  }
}
