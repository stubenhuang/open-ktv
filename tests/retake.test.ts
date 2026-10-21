//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createIsolatedDataDir, removeIsolatedDataDir } from './isolated.ts';

/**
 * 分段重录的整条 API 链路：选段上传 → 服务端拼接 → 自动重新混音 → 撤销。
 *
 * 和 http.test.ts 一样起真服务、跑真 ffmpeg。音频内容用可分辨的正弦：
 * 原干声 440Hz、重录片段 880Hz，拼完用「过零次数」验中段真的换成了素材、
 * 头尾原样 —— 这比只验时长更能抓住「拼错位置」这类回归。
 */
let dataDir = '';
let server: http.Server;
let baseUrl = '';
let helpers: typeof import('./helpers.ts');
let db: typeof import('../server/src/db.ts');

const TRACK_ID = 'retake-track';
const WORK_ID = 'retake-work';

before(async () => {
  dataDir = await createIsolatedDataDir('retake');
  helpers = await import('./helpers.ts');
  const { createApp } = await import('../server/src/app.ts');
  db = await import('../server/src/db.ts');

  db.initDb();

  // 伴奏：1 秒 440Hz mp3（免转码，不会拉起转码任务）
  const accompaniment = path.join(dataDir, 'accomp.mp3');
  await helpers.ffmpegOk(
    helpers.sineArgs(accompaniment, 4, 440, ['-c:a', 'libmp3lame', '-b:a', '192k']),
  );
  db.insertTrack({
    id: TRACK_ID,
    title: '重录测试伴奏',
    artist: null,
    kind: 'audio',
    originalName: 'accomp.mp3',
    originalPath: accompaniment,
    playablePath: accompaniment,
    proxyKind: 'none',
    mime: 'audio/mpeg',
    size: 1024,
    duration: 4,
    status: 'ready',
    error: null,
  });

  // 干声：4 秒 440Hz WAV（48k 单声道，和真实录音同规格）
  const vocal = path.join(dataDir, 'vocal.wav');
  await helpers.ffmpegOk(helpers.sineArgs(vocal, 4, 440, ['-c:a', 'pcm_s16le']));
  db.insertWork({
    id: WORK_ID,
    trackId: TRACK_ID,
    title: '重录测试作品',
    vocalPath: vocal,
    vocalDuration: 4,
    autoOffsetMs: 150,
    mixParams: {
      vocalGain: 1,
      accompGain: 1,
      reverbSpace: 0,
      reverbWet: 0,
      userOffsetMs: 0,
      vocalPreset: 'natural',
      eqLowDb: 0,
      eqMidDb: 0,
      eqHighDb: 0,
      compression: 0,
      deEss: 0,
      noiseReduction: false,
    },
    status: 'ready',
  });

  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  if (dataDir) await removeIsolatedDataDir(dataDir);
});

/** 解码成 48k 单声道 float（与服务端拼接同一规格） */
async function decodeMono(filePath: string): Promise<Float32Array> {
  const raw = path.join(dataDir, 'decode.raw');
  await helpers.ffmpegOk(['-i', filePath, '-f', 's16le', '-ac', '1', '-ar', '48000', raw]);
  const buffer = fs.readFileSync(raw);
  const out = new Float32Array(Math.floor(buffer.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = buffer.readInt16LE(i * 2) / 32768;
  fs.rmSync(raw, { force: true });
  return out;
}

/** 数一段区间的过零次数：440Hz 与 880Hz 的稳定判别器 */
function zeroCrossings(samples: Float32Array, fromSec: number, toSec: number): number {
  const from = Math.max(0, Math.round(fromSec * 48000));
  const to = Math.min(samples.length, Math.round(toSec * 48000));
  let count = 0;
  for (let i = from + 1; i < to; i += 1) {
    if (samples[i - 1]! <= 0 !== samples[i]! <= 0) count += 1;
  }
  return count;
}

/** 造一段指定时长/频率的 WAV 当「重录片段」 */
async function makeSegment(seconds: number, frequency: number): Promise<Buffer> {
  const file = path.join(dataDir, `segment-${frequency}-${seconds}.wav`);
  await helpers.ffmpegOk(helpers.sineArgs(file, seconds, frequency, ['-c:a', 'pcm_s16le']));
  return fs.readFileSync(file);
}

async function postRetake(
  workId: string,
  segment: Buffer,
  startSec: number,
  endSec: number,
): Promise<Response> {
  const form = new FormData();
  form.append('segment', new Blob([segment]), 'segment.wav');
  form.append('startSec', String(startSec));
  form.append('endSec', String(endSec));
  return fetch(`${baseUrl}/api/works/${workId}/retake`, { method: 'POST', body: form });
}

/** 轮询等作品到某个状态；超时返回最后看到的状态 */
async function waitForStatus(workId: string, status: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const work = (await (await fetch(`${baseUrl}/api/works/${workId}`)).json()) as {
      status: string;
    };
    last = work.status;
    if (work.status === status) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}

describe('分段重录（/api/works/:id/retake）', () => {
  it('拼接：中段换成新素材、头尾原样、干声时长不变', async () => {
    // 干声 4s 440Hz；替换 [1s, 2s) 为 1s 880Hz
    const response = await postRetake(WORK_ID, await makeSegment(1, 880), 1, 2);
    assert.equal(response.status, 202, await response.text());

    const spliced = await decodeMono(db.getWork(WORK_ID)!.vocalPath);
    // 时长分毫不变（4s）
    assert.ok(Math.abs(spliced.length / 48000 - 4) < 0.01, `时长应仍为 4s，实际 ${spliced.length / 48000}`);

    // 中段（1.3s–1.7s）是 880Hz：0.4s 内约 0.4×1760 = 704 次过零
    const mid = zeroCrossings(spliced, 1.3, 1.7);
    assert.ok(mid > 600, `中段应是 880Hz（过零 ${mid}）`);
    // 头尾仍是 440Hz：0.6s 窗口约 528 次、0.4s 窗口约 352 次（每周两次过零）
    const head = zeroCrossings(spliced, 0.2, 0.8);
    const tail = zeroCrossings(spliced, 2.3, 2.7);
    assert.ok(head > 470 && head < 590, `头部应仍是 440Hz（过零 ${head}）`);
    assert.ok(tail > 310 && tail < 400, `尾部应仍是 440Hz（过零 ${tail}）`);

    // 备份存在，作品详情据此显示「撤销重录」
    const detail = (await (await fetch(`${baseUrl}/api/works/${WORK_ID}`)).json()) as {
      hasPrevVocal: boolean;
      status: string;
      vocalDuration: number;
    };
    assert.equal(detail.hasPrevVocal, true);
    assert.equal(detail.vocalDuration, 4);
    assert.equal(detail.status, 'mixing', '拼接后应自动重新混音');
  });

  it('重录后自动混出新的成品（等 ready）', async () => {
    const status = await waitForStatus(WORK_ID, 'ready');
    assert.equal(status, 'ready');

    const audio = await fetch(`${baseUrl}/api/works/${WORK_ID}/audio`);
    assert.equal(audio.status, 200);
    const bytes = Buffer.from(await audio.arrayBuffer());
    assert.ok(bytes.length > 0);
    assert.match(bytes.subarray(0, 3).toString('latin1'), /ID3|.../);
  });

  it('撤销重录：换回旧干声（中段回到 440Hz）并重新混音', async () => {
    const response = await fetch(`${baseUrl}/api/works/${WORK_ID}/retake-undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 202, await response.text());

    const restored = await decodeMono(db.getWork(WORK_ID)!.vocalPath);
    const mid = zeroCrossings(restored, 1.3, 1.7);
    assert.ok(mid > 310 && mid < 400, `撤销后中段应回到 440Hz（过零 ${mid}）`);

    // 备份被消费掉：再撤销就是 409
    const again = await fetch(`${baseUrl}/api/works/${WORK_ID}/retake-undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(again.status, 409);

    const detail = (await (await fetch(`${baseUrl}/api/works/${WORK_ID}`)).json()) as {
      hasPrevVocal: boolean;
    };
    assert.equal(detail.hasPrevVocal, false);
  });

  it('等撤销后的重新混音跑完（不影响下面的用例）', async () => {
    assert.equal(await waitForStatus(WORK_ID, 'ready'), 'ready');
  });

  it('区间非法（起≥止 / 太短 / 非数字）→ 400', async () => {
    const segment = await makeSegment(1, 880);
    const same = await postRetake(WORK_ID, segment, 2, 2);
    assert.equal(same.status, 400);
    assert.match(((await same.json()) as { error: string }).error, /结束时间/);

    const tiny = await postRetake(WORK_ID, segment, 1, 1.1);
    assert.equal(tiny.status, 400);
    assert.match(((await tiny.json()) as { error: string }).error, /太短/);

    const form = new FormData();
    form.append('segment', new Blob([segment]), 'segment.wav');
    form.append('startSec', 'abc');
    form.append('endSec', '2');
    const nan = await fetch(`${baseUrl}/api/works/${WORK_ID}/retake`, { method: 'POST', body: form });
    assert.equal(nan.status, 400);
  });

  it('作品不存在 → 404；伴奏已删除 → 409', async () => {
    const segment = await makeSegment(1, 880);
    const missing = await postRetake('nope', segment, 1, 2);
    assert.equal(missing.status, 404);

    // 造一个「伴奏已删」的作品：重录要跟着混音，没有伴奏直接拒。
    // 走「建了再删伴奏」而不是直接插 track_id=null —— NewWork 的类型就是 string，
    // 脱钩靠外键 SET NULL 才是真实路径
    db.insertTrack({
      id: 'retake-doomed-track',
      title: '待删伴奏',
      artist: null,
      kind: 'audio',
      originalName: 'x.mp3',
      originalPath: path.join(dataDir, 'x.mp3'),
      playablePath: path.join(dataDir, 'x.mp3'),
      proxyKind: 'none',
      mime: 'audio/mpeg',
      size: 1024,
      duration: 4,
      status: 'ready',
      error: null,
    });
    db.insertWork({
      id: 'retake-no-track',
      trackId: 'retake-doomed-track',
      title: '无伴奏作品',
      vocalPath: path.join(dataDir, 'vocal.wav'),
      vocalDuration: 4,
      autoOffsetMs: 150,
      mixParams: {
        vocalGain: 1,
        accompGain: 1,
        reverbSpace: 0,
        reverbWet: 0,
        userOffsetMs: 0,
        vocalPreset: 'natural',
        eqLowDb: 0,
        eqMidDb: 0,
        eqHighDb: 0,
        compression: 0,
        deEss: 0,
        noiseReduction: false,
      },
      status: 'ready',
    });
    const removedTrack = await fetch(`${baseUrl}/api/tracks/retake-doomed-track`, {
      method: 'DELETE',
    });
    assert.equal(removedTrack.status, 200);

    const noTrack = await postRetake('retake-no-track', segment, 1, 2);
    assert.equal(noTrack.status, 409);
    assert.match(((await noTrack.json()) as { error: string }).error, /伴奏已删除/);
  });

  it('片段文件与所选区间差得太远 → 400', async () => {
    // 目标 3 秒，只上传 0.2 秒
    const response = await postRetake(WORK_ID, await makeSegment(0.2, 880), 1, 4);
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /差得太远/);
  });

  it('删除作品连备份一起清掉', async () => {
    // 先重录一次造出备份
    const retake = await postRetake(WORK_ID, await makeSegment(1, 880), 1, 2);
    assert.equal(retake.status, 202);
    // 等这轮混音跑完再删：删除时正好在混音会让任务报错（老逻辑同样如此），
    // 这个用例要验的是文件清理，不想被那条噪音盖住
    assert.equal(await waitForStatus(WORK_ID, 'ready'), 'ready');

    const vocalPath = db.getWork(WORK_ID)!.vocalPath;
    assert.ok(fs.existsSync(`${vocalPath}.prev`), '应有备份');

    const removed = await fetch(`${baseUrl}/api/works/${WORK_ID}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    // 删除路由里的 rm 是 fire-and-forget，轮询一会儿再断言
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && fs.existsSync(`${vocalPath}.prev`)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(!fs.existsSync(`${vocalPath}.prev`), '备份应被删掉');
    assert.ok(!fs.existsSync(vocalPath), '干声应被删掉');
  });
});
