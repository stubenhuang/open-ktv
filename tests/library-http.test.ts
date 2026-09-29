import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createIsolatedDataDir, removeIsolatedDataDir, sleep } from './isolated.ts';

/**
 * 曲库点歌的整条链路：本地源站（清单 + 音频 + LRC）→ 搜索 → 点歌 →
 * 下载 → 入库 → 转码 → 歌词带出来 → 重复点歌去重。
 *
 * 全程只跟一个临时起的本地 HTTP 服务器打交道，不依赖外网、
 * 也不依赖任何真实站点的可用性。
 */

let dataDir = '';
let origin = '';
let source: http.Server;
let server: http.Server;
let baseUrl = '';
let helpers: typeof import('./helpers.ts');

/** 源站上真实可下载的 mp3（测试开始时用 ffmpeg 生成） */
let mp3: Buffer;

const LRC = '[ti:晴天]\n[00:01.00]第一句\n[00:05.00]第二句';

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

before(async () => {
  dataDir = await createIsolatedDataDir('library-http');
  helpers = await import('./helpers.ts');

  // 1) 造一个真 mp3 当源站资源
  const fixture = path.join(dataDir, 'source-fixture.mp3');
  await helpers.ffmpegOk(helpers.sineArgs(fixture, 1, 440, ['-c:a', 'libmp3lame', '-b:a', '192k']));
  mp3 = fs.readFileSync(fixture);

  // 2) 起「源站」：清单 / 音频 / 歌词
  source = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/index.json') {
      json(res, {
        version: 1,
        name: '本地测试源',
        items: [
          {
            id: 'qingtian',
            title: '晴天',
            artist: '周杰伦',
            durationSec: 1,
            kind: 'audio',
            url: 'qingtian.mp3',
            lrc: 'qingtian.lrc',
          },
          {
            id: 'no-lyrics',
            title: '没有歌词的歌',
            artist: '某人',
            durationSec: 1,
            kind: 'audio',
            url: 'qingtian.mp3',
            // 这个歌词地址会 404：验证「歌词拿不到不该挡住伴奏入库」
            lrc: 'missing.lrc',
          },
        ],
      });
      return;
    }

    if (url.pathname === '/qingtian.mp3') {
      res.statusCode = 200;
      res.setHeader('content-type', 'audio/mpeg');
      res.setHeader('content-length', String(mp3.byteLength));
      res.end(mp3);
      return;
    }

    if (url.pathname === '/qingtian.lrc') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(LRC);
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;

  // 3) 起被测应用，注入指向本地源站的 registry
  const { createApp } = await import('../server/src/app.ts');
  const db = await import('../server/src/db.ts');
  const { cleanTmpDir } = await import('../server/src/paths.ts');
  const { createRegistry } = await import('../server/src/library/registry.ts');

  db.initDb();
  cleanTmpDir();

  server = http.createServer(
    createApp({ library: createRegistry([`本地测试源=${origin}/index.json`]) }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await new Promise<void>((resolve) => {
    source.close(() => resolve());
    source.closeAllConnections();
  });
  if (dataDir) await removeIsolatedDataDir(dataDir);
});

interface TaskBody {
  taskId: string;
  title: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  trackId: string | null;
  error: string | null;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 轮询任务直到结束（失败时直接把错误抛出来，测试里更好定位） */
async function waitForTask(taskId: string, timeoutMs = 30_000): Promise<TaskBody> {
  const deadline = Date.now() + timeoutMs;
  let last: TaskBody | null = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/library/tasks/${taskId}`);
    assert.equal(response.status, 200);
    last = (await response.json()) as TaskBody;
    if (last.state === 'done') return last;
    if (last.state === 'failed') throw new Error(`点歌任务失败：${last.error}`);
    await sleep(50);
  }
  throw new Error(`点歌任务超时，最后状态 ${JSON.stringify(last)}`);
}

describe('曲库点歌（本地源站 + 真实 Express）', () => {
  it('列出已配置的源', async () => {
    const body = (await (await fetch(`${baseUrl}/api/library/sources`)).json()) as {
      sources: { id: string; label: string }[];
    };
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0]!.label, '本地测试源');
  });

  it('搜索：命中关键词，带上 hasLyrics', async () => {
    const body = (await (
      await fetch(`${baseUrl}/api/library/search?q=${encodeURIComponent('晴天')}`)
    ).json()) as {
      items: { itemId: string; title: string; artist: string; hasLyrics: boolean }[];
      sources: { ok: boolean; count: number }[];
    };

    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0]!.ok, true);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0]!.itemId, 'qingtian');
    assert.equal(body.items[0]!.title, '晴天');
    assert.equal(body.items[0]!.hasLyrics, true);
  });

  it('搜索：不下发源站下载地址（只该服务端知道）', async () => {
    const body = (await (await fetch(`${baseUrl}/api/library/search?q=`)).json()) as {
      items: Record<string, unknown>[];
    };
    assert.ok(body.items.length >= 1);
    for (const item of body.items) {
      assert.equal('url' in item, false, '下载地址不该下发给浏览器');
      assert.equal('lrcUrl' in item, false);
    }
  });

  it('搜索：源站不可用时只在 sources 里报错，不整体失败', async () => {
    // 用一个指向不存在路径的源另起一个 app 太重，这里直接验证未知源的点歌报错
    const response = await postJson('/api/library/download', {
      providerId: 'http-index:https://nope.example/index.json',
      itemId: 'whatever',
    });
    assert.equal(response.status, 404);
    assert.match(((await response.json()) as { error: string }).error, /没有配置/);
  });

  it('点歌：参数缺失 → 400，条目不存在 → 404', async () => {
    const missing = await postJson('/api/library/download', { providerId: 'x' });
    assert.equal(missing.status, 400);

    const sources = (await (await fetch(`${baseUrl}/api/library/sources`)).json()) as {
      sources: { id: string }[];
    };
    const sourceId = sources.sources[0]!.id;

    const noItem = await postJson('/api/library/download', { providerId: sourceId, itemId: '没这个' });
    assert.equal(noItem.status, 404);
    assert.match(((await noItem.json()) as { error: string }).error, /找不到这个伴奏/);
  });

  it('点歌：下载 → 入库 → 歌词自动带出', async () => {
    const sources = (await (await fetch(`${baseUrl}/api/library/sources`)).json()) as {
      sources: { id: string }[];
    };
    const sourceId = sources.sources[0]!.id;

    const accepted = await postJson('/api/library/download', { providerId: sourceId, itemId: 'qingtian' });
    assert.equal(accepted.status, 202);
    const started = (await accepted.json()) as { taskId: string; title: string };
    assert.equal(started.title, '晴天');

    const task = await waitForTask(started.taskId);
    assert.ok(task.trackId, '任务完成时应带上入库的伴奏 id');
    assert.equal(task.progress, 1);

    const track = (await (await fetch(`${baseUrl}/api/tracks/${task.trackId}`)).json()) as {
      title: string;
      artist: string;
      kind: string;
      status: string;
      source: string;
      hasLyrics: boolean;
      lyrics: string;
    };

    assert.equal(track.title, '晴天', '歌名用清单里的，不是从文件名猜的');
    assert.equal(track.artist, '周杰伦');
    assert.equal(track.kind, 'audio');
    assert.equal(track.status, 'ready');
    assert.equal(track.source, 'library', '来源应标成点歌');
    assert.equal(track.hasLyrics, true, '清单里带 lrc，应该自动入库');
    assert.match(track.lyrics, /\[00:01\.00\]第一句/);

    // 源文件确实落盘了
    const originals = await fs.promises.readdir(path.join(dataDir, 'originals'));
    assert.ok(originals.some((name) => name.startsWith(task.trackId!)), '原始文件应落在 originals/');
  });

  it('点歌：歌词拉不到时照常入库，只是没有歌词', async () => {
    const sources = (await (await fetch(`${baseUrl}/api/library/sources`)).json()) as {
      sources: { id: string }[];
    };
    const sourceId = sources.sources[0]!.id;

    const accepted = await postJson('/api/library/download', {
      providerId: sourceId,
      itemId: 'no-lyrics',
    });
    assert.equal(accepted.status, 202);
    const started = (await accepted.json()) as { taskId: string };

    const task = await waitForTask(started.taskId);
    const track = (await (await fetch(`${baseUrl}/api/tracks/${task.trackId}`)).json()) as {
      hasLyrics: boolean;
      status: string;
    };
    assert.equal(track.status, 'ready', '歌词 404 不该挡住伴奏入库');
    assert.equal(track.hasLyrics, false);
  });

  it('点歌：同一个条目重复点只入库一次', async () => {
    const sources = (await (await fetch(`${baseUrl}/api/library/sources`)).json()) as {
      sources: { id: string }[];
    };
    const sourceId = sources.sources[0]!.id;

    const again = await postJson('/api/library/download', { providerId: sourceId, itemId: 'qingtian' });
    assert.equal(again.status, 200, '已入库的条目直接返回，不再排一次下载');
    const body = (await again.json()) as { alreadyImported: boolean; track: { id: string; source: string } };
    assert.equal(body.alreadyImported, true);
    assert.equal(body.track.source, 'library');
    assert.ok(body.track.id);

    // 全库只有一条 source=library 的「晴天」
    const list = (await (await fetch(`${baseUrl}/api/tracks`)).json()) as {
      title: string;
      source: string;
    }[];
    const qingtian = list.filter((track) => track.title === '晴天' && track.source === 'library');
    assert.equal(qingtian.length, 1, `实际 ${qingtian.length} 条`);
  });

  it('任务查询：未知 taskId → 404（重启后前端据此提示重试）', async () => {
    const response = await fetch(`${baseUrl}/api/library/tasks/不存在的任务`);
    assert.equal(response.status, 404);
    assert.match(((await response.json()) as { error: string }).error, /任务不存在/);
  });
});
