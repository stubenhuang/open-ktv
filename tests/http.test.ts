import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createIsolatedDataDir, removeIsolatedDataDir } from './isolated.ts';

/**
 * 整条 API 链路：createApp() 挂到临时端口，DATA_DIR 指向临时目录。
 * 先设环境变量再动态 import —— 静态 import 会在设 DATA_DIR 前就把 config.ts 求值掉。
 */
let dataDir = '';
let server: http.Server;
let baseUrl = '';
let helpers: typeof import('./helpers.ts');
let trackId = '';

before(async () => {
  dataDir = await createIsolatedDataDir('http');
  helpers = await import('./helpers.ts');
  const { createApp } = await import('../server/src/app.ts');
  const db = await import('../server/src/db.ts');
  const { cleanTmpDir } = await import('../server/src/paths.ts');

  db.initDb();
  cleanTmpDir();

  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  // fetch 默认keep-alive，不主动断连的话 server.close() 会一直等
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  if (dataDir) await removeIsolatedDataDir(dataDir);
});

/** 造一个浏览器能直接播的小 mp3（免转码，不会拉起 ffmpeg 任务） */
async function makeMp3(): Promise<Buffer> {
  const file = path.join(dataDir, 'fixture.mp3');
  await helpers.ffmpegOk(helpers.sineArgs(file, 1, 440, ['-c:a', 'libmp3lame', '-b:a', '192k']));
  return fs.readFileSync(file);
}

async function uploadTrack(mp3: Buffer, fileName = '周杰伦 - 晴天.mp3'): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([mp3], { type: 'audio/mpeg' }), fileName);
  return fetch(`${baseUrl}/api/tracks`, { method: 'POST', body: form });
}

describe('HTTP API（真实 Express + 临时数据目录）', () => {
  it('健康检查', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; queue: { active: null } };
    assert.equal(body.ok, true);
    assert.deepEqual(body.queue, { active: null, waiting: 0 });
  });

  it('未知接口 404 JSON', async () => {
    const response = await fetch(`${baseUrl}/api/nope`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: '接口不存在' });
  });

  it('上传接口没带文件 → 400', async () => {
    const form = new FormData();
    form.append('notfile', 'x');
    const response = await fetch(`${baseUrl}/api/tracks`, { method: 'POST', body: form });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /表单字段名应为 file/);
  });

  it('上传伴奏：探测、入库、直接可用（mp3 免转码）', async () => {
    const response = await uploadTrack(await makeMp3());
    assert.equal(response.status, 201);

    const track = (await response.json()) as {
      id: string;
      title: string;
      artist: string;
      kind: string;
      status: string;
      proxyKind: string;
      progress: null;
      duration: number;
    };
    trackId = track.id;
    assert.equal(track.title, '晴天', '从「歌手 - 歌名」解析出歌名');
    assert.equal(track.artist, '周杰伦');
    assert.equal(track.kind, 'audio');
    assert.equal(track.status, 'ready');
    assert.equal(track.proxyKind, 'none');
    assert.equal(track.progress, null);
    assert.ok(track.duration > 0.5, `时长应探测到，实际 ${track.duration}`);
  });

  it('列表和详情能读到刚上传的伴奏', async () => {
    const list = (await (await fetch(`${baseUrl}/api/tracks`)).json()) as { id: string }[];
    assert.ok(list.some((item) => item.id === trackId));

    const detail = await fetch(`${baseUrl}/api/tracks/${trackId}`);
    assert.equal(detail.status, 200);

    const missing = await fetch(`${baseUrl}/api/tracks/不存在的id`);
    assert.equal(missing.status, 404);
  });

  it('改名：空标题 / 超长标题被拒，正常改名成功', async () => {
    const empty = await fetch(`${baseUrl}/api/tracks/${trackId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '  ' }),
    });
    assert.equal(empty.status, 400);
    assert.match(((await empty.json()) as { error: string }).error, /歌名不能为空/);

    const tooLong = await fetch(`${baseUrl}/api/tracks/${trackId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(121) }),
    });
    assert.equal(tooLong.status, 400);

    const ok = await fetch(`${baseUrl}/api/tracks/${trackId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '新歌名', artist: '' }),
    });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { title: string; artist: null };
    assert.equal(body.title, '新歌名');
    assert.equal(body.artist, null, '空字符串清空歌手');
  });

  it('伴奏媒体可流式播放（audio/mpeg）', async () => {
    const response = await fetch(`${baseUrl}/api/media/track/${trackId}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /audio\/mpeg/);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length > 0);
  });

  it('作品相关接口对不存在的 id 一律 404', async () => {
    for (const path of ['/api/works/nope', '/api/works/nope/audio', '/api/works/nope/vocal']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 404, path);
    }
  });

  it('坏 JSON 走统一错误出口 → 400', async () => {
    const response = await fetch(`${baseUrl}/api/works/nope/mix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '这不是 JSON',
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.equal(typeof body.error, 'string');
  });

  it('删除伴奏后查不到了', async () => {
    const response = await fetch(`${baseUrl}/api/tracks/${trackId}`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const gone = await fetch(`${baseUrl}/api/tracks/${trackId}`);
    assert.equal(gone.status, 404);
  });
});
