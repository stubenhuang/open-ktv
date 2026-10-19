import fs from 'node:fs';
import path from 'node:path';
import { RETAKE_LIMITS } from '../../shared/types.ts';
import { encodeWavBytes } from '../../shared/wav.ts';
import { AUDIO, JOB_TIMEOUT_MS } from './config.ts';
import type { WorkRecord } from './db.ts';
import { ensureFreeSpace } from './disk.ts';
import { runFfmpeg } from './ffmpeg.ts';
import { createLogger } from './logger.ts';
import { TMP_DIR } from './paths.ts';

const log = createLogger('vocal-splice');

/**
 * 分段重录的拼接（服务端）。
 *
 * 为什么在服务端拼、而不是让浏览器拼好再上传整条干声：
 * 干声最长 15 分钟（约 86MB），每重录一段就重传一整条太浪费；而片段本身
 * 只有几秒到几十秒。服务端拿原干声 + 片段拼，浏览器只上传小文件。
 *
 * 拼接统一在 48k 单声道上做（混音链路本来就是这个规格，ffmpeg 解码时
 * 顺便重采样，浏览器录到 44.1k 也无所谓）。
 */
const SPLICE_RATE = AUDIO.sampleRate;

/**
 * 「重录前的上一版干声」路径：紧跟干声文件，删作品 / 备份时都能找到。
 *
 * 撤销只回退一级 —— 再重录一次，这份备份就被更新成更新前的那一版。
 */
export function backupVocalPath(vocalPath: string): string {
  return `${vocalPath}.prev`;
}

/**
 * 把一段新素材拼进干声（纯函数，无 IO —— 单测直接钉行为）。
 *
 * 输出长度恒等于 old.length：干声总时长不变，作品的 vocalDuration 不用改，
 * 干声后面的一切（对齐偏移、伴奏时间轴）原样成立。布局：
 *
 *     旧[0, start) 原样
 *     头部交叉淡化 [start, start+fade)      旧淡出 / 新淡入
 *     新素材中段 [start+fade, end-fade)
 *     尾部交叉淡化 [end-fade, end)           新淡出 / 旧淡入
 *     旧[end, 末) 原样
 *
 * 两端必须淡化：波形硬切在采样点留下台阶，耳机里就是一声咔哒。
 * 新素材不足 lenSamples 补静音、超出则截断 —— 一律以目标长度为准，
 * 不然「干声时长分毫不动」就不成立。
 *
 * @param startSample 干声轴替换起点（采样点）
 * @param lenSamples 替换长度（采样点）；新素材按它裁 / 补
 * @param fadeSamples 单边淡化长度（采样点）；自动钳到 len/2 以内
 */
export function spliceIntoVocal(
  old: Float32Array,
  seg: Float32Array,
  startSample: number,
  lenSamples: number,
  fadeSamples: number,
): Float32Array {
  const total = old.length;
  const start = Math.max(0, Math.min(total, Math.round(startSample)));
  const len = Math.max(0, Math.min(total - start, Math.round(lenSamples)));
  const fade = Math.max(0, Math.min(Math.round(fadeSamples), Math.floor(len / 2)));

  // 拷一份再改：尾部「原样保留」就是这份拷贝
  const out = old.slice();

  // 新素材按目标长度裁 / 补静音
  const placed = new Float32Array(len);
  placed.set(seg.subarray(0, Math.min(seg.length, len)));

  if (fade === 0) {
    // 片段太短，淡不过来就直接落（长度下限已经把这种情况挡在门外，这里是兜底）
    if (len > 0) out.set(placed, start);
    return out;
  }

  // 权重取 (i+1)/(fade+1)：两端都避开 0 和 1，端点不会出现「一份素材被完全压没」
  // 的量化静音，听感上是等幅度的直线交叉淡化。
  const weight = (i: number) => (i + 1) / (fade + 1);

  // 头部：旧淡出、新淡入
  for (let i = 0; i < fade; i += 1) {
    const w = weight(i);
    out[start + i] = old[start + i]! * (1 - w) + placed[i]! * w;
  }
  // 中段：纯新素材
  if (len - 2 * fade > 0) {
    out.set(placed.subarray(fade, len - fade), start + fade);
  }
  // 尾部：新淡出、旧淡入
  for (let i = 0; i < fade; i += 1) {
    const w = weight(i);
    const idx = start + len - fade + i;
    out[idx] = placed[len - fade + i]! * (1 - w) + old[idx]! * w;
  }
  return out;
}

/* ---------------------------------- 解码 ---------------------------------- */

/**
 * 把音频文件解码成 48k 单声道 s16le 裸 PCM，落临时文件。
 *
 * 为什么不接 stdout：runFfmpeg 的进度回调按行解析 stdout，二进制 PCM 会把
 * 它冲垮；而 runProcess 也没有「收集 stdout」的选项。落临时文件最省事，
 * 反正 TMP_DIR 启动时会清（mixJob 的中间产物也是这个套路）。
 */
async function decodeToMonoRaw(sourcePath: string, destPath: string, label: string): Promise<void> {
  await runFfmpeg({
    args: [
      '-v',
      'error',
      '-i',
      sourcePath,
      '-f',
      's16le',
      '-ac',
      '1',
      '-ar',
      String(SPLICE_RATE),
      '-y',
      destPath,
    ],
    timeoutMs: JOB_TIMEOUT_MS.preProcess,
    label,
  });
}

/** 读 s16le 裸 PCM 成 Float32（−32768..32767 → ±1，与 encodeWavBytes 的缩放互逆） */
function readRawMono(filePath: string): Float32Array {
  const buffer = fs.readFileSync(filePath);
  const samples = Math.floor(buffer.length / 2);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    out[i] = buffer.readInt16LE(i * 2) / 32768;
  }
  return out;
}

/* -------------------------------- 主流程 -------------------------------- */

export interface RetakeSpliceResult {
  vocalPath: string;
  backupPath: string;
  /** 拼接后干声时长（秒）；与拼接前一致 */
  durationSec: number;
}

/**
 * 用一段新录音替换干声里的 [startSec, endSec)（干声时间轴，秒）。
 *
 * 顺序很讲究：先备份再替换。撤销重录靠 `<vocalPath>.prev` 这一份，
 * 万一写新 WAV 失败，原干声一个字都没动。
 */
export async function spliceRetakeIntoVocal(input: {
  work: WorkRecord;
  segmentPath: string;
  startSec: number;
  endSec: number;
}): Promise<RetakeSpliceResult> {
  const { work, segmentPath, startSec, endSec } = input;
  const oldRawPath = path.join(TMP_DIR, `splice-old-${work.id}.raw`);
  const segRawPath = path.join(TMP_DIR, `splice-seg-${work.id}.raw`);
  const stagedPath = path.join(TMP_DIR, `splice-new-${work.id}.wav`);
  const intermediates = [oldRawPath, segRawPath, stagedPath];

  try {
    await decodeToMonoRaw(work.vocalPath, oldRawPath, '干声解码');
    await decodeToMonoRaw(segmentPath, segRawPath, '重录片段解码');

    const old = readRawMono(oldRawPath);
    const seg = readRawMono(segRawPath);
    if (old.length === 0) throw new Error('原干声解码出来是空的，文件可能已损坏');

    const spliced = spliceIntoVocal(
      old,
      seg,
      Math.round(startSec * SPLICE_RATE),
      Math.round((endSec - startSec) * SPLICE_RATE),
      Math.round(RETAKE_LIMITS.fadeSec * SPLICE_RATE),
    );

    // 空间预检：新干声 + 备份一份旧的，按两倍 WAV 估
    await ensureFreeSpace(spliced.length * 2 * 2 + 8 * 1024 * 1024, '这次重录拼接');

    await fs.promises.writeFile(
      stagedPath,
      Buffer.from(encodeWavBytes(spliced, SPLICE_RATE)),
    );

    // 备份当前干声 → 新 WAV 原子换入。rename 前原文件一直完好。
    const backupPath = backupVocalPath(work.vocalPath);
    await fs.promises.copyFile(work.vocalPath, backupPath);
    await fs.promises.rename(stagedPath, work.vocalPath);

    log.info('干声已拼接重录', {
      workId: work.id,
      startSec: Number(startSec.toFixed(3)),
      endSec: Number(endSec.toFixed(3)),
      segmentSec: Number((endSec - startSec).toFixed(3)),
      durationSec: Number((spliced.length / SPLICE_RATE).toFixed(3)),
    });
    return { vocalPath: work.vocalPath, backupPath, durationSec: spliced.length / SPLICE_RATE };
  } finally {
    await Promise.all(intermediates.map((file) => fs.promises.rm(file, { force: true })));
  }
}

/**
 * 撤销上一步重录：把备份干声换回来（备份被消费掉，只回退一级）。
 *
 * 同步 IO：整个服务的事件循环上这就是一次 rename，路由层可以直接用。
 */
export function undoRetake(work: WorkRecord): void {
  const backupPath = backupVocalPath(work.vocalPath);
  if (!fs.existsSync(backupPath)) {
    throw new Error('没有可撤销的重录备份');
  }
  fs.renameSync(backupPath, work.vocalPath);
  log.info('已撤销上一步重录', { workId: work.id, vocalPath: work.vocalPath });
}
