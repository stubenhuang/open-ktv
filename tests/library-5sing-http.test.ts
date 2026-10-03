import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createIsolatedDataDir, removeIsolatedDataDir, sleep } from './isolated.ts';

/**
 * 内置 5sing 源 + 酷狗歌词的整条链路：
 *   搜索 → 点歌 → 下载（主 CDN 404 → backup 重试）→ 歌词匹配 → 入库 → 去重
 *   上传（没歌词）→ 自动补歌词
 *
 * 全程只跟两个临时起的本地 HTTP 服务器（5sing 桩 / 酷狗歌词桩）打交道，
 * 不碰外网。env 必须在动态 import 之前设好 —— config.ts 是加载时求值的。
 */

let dataDir = '';
let fiveSingOrigin = '';
let kugouOrigin = '';
let fiveSingStub: http.Server;
let kugouStub: http.Server;
let server: http.Server;
let baseUrl = '';
let helpers: typeof import('./helpers.ts');

/** 真 mp3（测试开始时用 ffmpeg 生成） */
let mp3: Buffer;

/** 酷狗桩开关：false = 歌词源全挂 */
let kugouAlive = true;

const LRC = '[ti:晴天]\n[ar:周杰伦]\n[al:叶惠美]\n[00:00.00]晴天 - 周杰伦\n[00:29.26]故事的小黄花\n[00:32.71]从出生那年就飘着';

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function buildFiveSingStub(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // 关键词搜索：一页 3 条伴奏
    if (url.pathname === '/home/json') {
      const keyword = url.searchParams.get('keyword') ?? '';
      if (!keyword) {
        // 空关键词走热门页，这里的 JSON 分支不该被用到
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      json(res, {
        list: [
          {
            songId: 1001,
            songName: `<em class="keyword">晴天</em> - 原版伴奏`,
            singer: '官方伴奏铺',
            nickName: '官方伴奏铺',
            songSize: mp3.byteLength,
            ext: 'mp3',
            type: 3,
            typeName: '伴奏',
          },
          {
            songId: 1002,
            songName: '晴天 - 周杰伦',
            singer: 'someone',
            nickName: 'someone',
            songSize: 0,
            ext: 'mp3',
            type: 3,
            typeName: '伴奏',
          },
        ],
        pageInfo: { cur: 1, totalCount: 2, totalPages: 1 },
      });
      return;
    }

    // 热门伴奏页（空关键词浏览）
    if (url.pathname === '/bz/rmsong/more_1.shtml') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        `<table class="ct_list"><tr><td><div class="aleft">` +
          `<a href="http://5sing.kugou.com/bz/9001.html" target="_blank" title="热门伴奏甲">热门伴奏甲</a>` +
          `</div></td></tr></table>`,
      );
      return;
    }

    // 元数据：999999999 当作「已删除的歌」
    if (url.pathname === '/song/newget') {
      const songId = url.searchParams.get('songid') ?? '';
      if (songId === '999999999') {
        json(res, { success: false, code: 28, message: '歌曲不存在或状态不正常', data: [] });
        return;
      }
      json(res, {
        success: true,
        code: 0,
        data: { ID: songId, SN: '晴天', SS: mp3.byteLength, user: { NN: '官方伴奏铺' } },
      });
      return;
    }

    // 下载地址：1001 的主 CDN 指向一个 404 路径（用来验证 backup 重试）
    if (url.pathname === '/song/getSongUrl') {
      const songId = url.searchParams.get('songid') ?? '';
      if (songId === '999999999') {
        json(res, { code: 28, message: '歌曲不存在', data: [] });
        return;
      }
      json(res, {
        code: 1000,
        data: {
          squrl: `${fiveSingOrigin}/cdn-missing/sq.mp3`,
          squrl_backup: `${fiveSingOrigin}/cdn/sq.mp3`,
          hqurl: '',
          hqurl_backup: '',
          lqurl: '',
          lqurl_backup: '',
        },
      });
      return;
    }

    // 真文件
    if (url.pathname === '/cdn/sq.mp3') {
      res.statusCode = 200;
      res.setHeader('content-type', 'audio/mpeg');
      res.end(mp3);
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });
}

function buildKugouStub(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (!kugouAlive) {
      res.statusCode = 502;
      res.end('bad gateway');
      return;
    }

    if (url.pathname === '/api/v3/search/song') {
      json(res, {
        status: 1,
        data: {
          info: [{ hash: 'hash-sunny', songname: '晴天', singername: '周杰伦', duration: 269 }],
        },
      });
      return;
    }

    if (url.pathname === '/search') {
      json(res, {
        status: 200,
        candidates: [
          { id: '42', accesskey: 'key42', song: '晴天', singer: '周杰伦', duration: 269792 },
        ],
      });
      return;
    }

    if (url.pathname === '/download') {
      json(res, { status: 200, fmt: 'lrc', content: b64(LRC) });
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });
}

before(async () => {
  dataDir = await createIsolatedDataDir('library-5sing-http');

  // 1) 两个桩服务器先起来（env 要在任何 import 到 config.ts 的模块之前设好 ——
  //    helpers.ts 传递依赖 ffmpeg/probe，都会把 config.ts 拉起来求值）
  fiveSingStub = buildFiveSingStub();
  kugouStub = buildKugouStub();
  await new Promise<void>((resolve) => fiveSingStub.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => kugouStub.listen(0, '127.0.0.1', resolve));
  fiveSingOrigin = `http://127.0.0.1:${(fiveSingStub.address() as AddressInfo).port}`;
  kugouOrigin = `http://127.0.0.1:${(kugouStub.address() as AddressInfo).port}`;

  process.env.FIVESING_SEARCH_BASE = fiveSingOrigin;
  process.env.FIVESING_API_BASE = fiveSingOrigin;
  process.env.FIVESING_WEB_BASE = fiveSingOrigin;
  process.env.KUGOU_SONG_SEARCH_BASE = kugouOrigin;
  process.env.KUGOU_LYRICS_BASE = kugouOrigin;

  // 2) 真 mp3 当「5sing CDN」上的伴奏
  helpers = await import('./helpers.ts');
  const fixture = path.join(dataDir, 'source-fixture.mp3');
  await helpers.ffmpegOk(helpers.sineArgs(fixture, 1, 440, ['-c:a', 'libmp3lame', '-b:a', '192k']));
  mp3 = fs.readFileSync(fixture);

  // 3) 起被测应用（默认装配：内置 5sing + 酷狗歌词，地址都指向桩）
  const { createApp } = await import('../server/src/app.ts');
  const db = await import('../server/src/db.ts');
  const { cleanTmpDir } = await import('../server/src/paths.ts');

  db.initDb();
  cleanTmpDir();

  // 不注入任何依赖：走生产默认装配（内置 5sing + 酷狗歌词，地址指向桩）
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  for (const stub of [fiveSingStub, kugouStub]) {
    await new Promise<void>((resolve) => {
      stub.close(() => resolve());
      stub.closeAllConnections();
    });
  }
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

async function postJson(pathname: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

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

async function listSources(): Promise<{ id: string; label: string }[]> {
  const body = (await (await fetch(`${baseUrl}/api/library/sources`)).json()) as {
    sources: { id: string; label: string }[];
  };
  return body.sources;
}

async function download(
  providerId: string,
  itemId: string,
): Promise<{ status: number; body: { taskId?: string; alreadyImported?: boolean; track?: { id: string } } }> {
  const response = await postJson('/api/library/download', { providerId, itemId });
  return { status: response.status, body: (await response.json()) as never };
}

async function getTrack(id: string) {
  return (await (await fetch(`${baseUrl}/api/tracks/${id}`)).json()) as {
    title: string;
    artist: string | null;
    source: string;
    status: string;
    hasLyrics: boolean;
    lyrics: string | null;
    duration: number | null;
  };
}

describe('内置 5sing 源 + 酷狗歌词（生产默认装配，全链路）', () => {
  it('sources 里出现内置 5sing 源', async () => {
    const sources = await listSources();
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.id, '5sing');
    assert.match(sources[0]!.label, /5sing/);
  });

  it('搜索：命中关键词，不下发源站下载地址', async () => {
    const body = (await (
      await fetch(`${baseUrl}/api/library/search?q=${encodeURIComponent('晴天')}`)
    ).json()) as {
      items: Record<string, unknown>[];
      sources: { ok: boolean; count: number }[];
    };

    assert.equal(body.sources[0]!.ok, true);
    assert.equal(body.sources[0]!.count, 2);
    assert.equal(body.items.length, 2);
    assert.equal(body.items[0]!.title, '晴天 - 原版伴奏', '高亮标签要剥掉');
    for (const item of body.items) {
      assert.equal('url' in item, false, '下载地址不该下发给浏览器');
      assert.equal('lrcUrl' in item, false);
    }
  });

  it('搜索：空关键词列出热门伴奏', async () => {
    const body = (await (
      await fetch(`${baseUrl}/api/library/search?q=`)
    ).json()) as { items: { itemId: string; title: string }[] };
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0]!.itemId, '9001');
    assert.equal(body.items[0]!.title, '热门伴奏甲');
  });

  it('点歌：主 CDN 404 → backup 重试成功 → 歌词自动匹配入库', async () => {
    const sources = await listSources();
    const accepted = await download(sources[0]!.id, '1001');
    assert.equal(accepted.status, 202);
    const started = accepted.body as { taskId: string; title: string };
    assert.equal(started.title, '晴天 - 原版伴奏');

    const task = await waitForTask(started.taskId);
    assert.ok(task.trackId);

    const track = await getTrack(task.trackId!);
    assert.equal(track.title, '晴天 - 原版伴奏');
    assert.equal(track.source, 'library');
    assert.equal(track.status, 'ready');
    assert.equal(track.hasLyrics, true, '酷狗桩应该给出歌词');
    assert.match(track.lyrics!, /\[ti:晴天\]/);
    assert.match(track.lyrics!, /\[00:29\.26\]故事的小黄花/);

    // 原文件确实落盘了
    const originals = await fs.promises.readdir(path.join(dataDir, 'originals'));
    assert.ok(originals.some((name) => name.startsWith(task.trackId!)), '原始文件应落在 originals/');
  });

  it('点歌：酷狗挂掉时照常入库，只是没歌词', async () => {
    kugouAlive = false;
    try {
      const sources = await listSources();
      const accepted = await download(sources[0]!.id, '1002');
      assert.equal(accepted.status, 202);
      const started = accepted.body as { taskId: string };
      const task = await waitForTask(started.taskId);

      const track = await getTrack(task.trackId!);
      assert.equal(track.status, 'ready', '歌词源挂了不该挡住伴奏入库');
      assert.equal(track.hasLyrics, false);
    } finally {
      kugouAlive = true;
    }
  });

  it('点歌：同一个条目重复点只入库一次', async () => {
    const sources = await listSources();
    const again = await download(sources[0]!.id, '1001');
    assert.equal(again.status, 200);
    const body = again.body as unknown as { alreadyImported: boolean; track: { source: string } };
    assert.equal(body.alreadyImported, true);
    assert.equal(body.track.source, 'library');

    const list = (await (await fetch(`${baseUrl}/api/tracks`)).json()) as {
      title: string;
      source: string;
    }[];
    const sunny = list.filter((track) => track.title === '晴天 - 原版伴奏' && track.source === 'library');
    assert.equal(sunny.length, 1, `实际 ${sunny.length} 条`);
  });

  it('点歌：5sing 报「歌曲不存在」时任务失败且错误可读', async () => {
    const sources = await listSources();
    const response = await postJson('/api/library/download', {
      providerId: sources[0]!.id,
      itemId: '999999999',
    });
    // resolve 阶段 getSongUrl 就报错 → 502（任务还没排上）
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /5sing/);
  });

  it('点歌：非数字 itemId → 404', async () => {
    const sources = await listSources();
    const accepted = await download(sources[0]!.id, '不是数字');
    assert.equal(accepted.status, 404);
  });

  it('已知伴奏补歌词：上传（没歌词）→ 自动获取 → 有歌词', async () => {
    const form = new FormData();
    // 命名约定是「歌手 - 歌名」：uploads 走文件名解析
    form.append('file', new Blob([mp3], { type: 'audio/mpeg' }), '周杰伦 - 稻香.mp3');
    const upload = await fetch(`${baseUrl}/api/tracks`, { method: 'POST', body: form });
    assert.equal(upload.status, 201);
    const created = (await upload.json()) as { id: string; title: string; artist: string | null };

    assert.equal(created.title, '稻香');
    assert.equal(created.artist, '周杰伦');

    const before = await getTrack(created.id);
    assert.equal(before.hasLyrics, false);

    // 桩的候选只有「晴天」，稻香匹配不上 → 404 语义
    const miss = await postJson(`/api/tracks/${created.id}/lyrics/auto`, {});
    assert.equal(miss.status, 404);
    const missBody = (await miss.json()) as { error?: string };
    assert.match(missBody.error ?? '', /没找到/);

    // 把歌名改成桩能命中的「晴天」，再自动获取
    await fetch(`${baseUrl}/api/tracks/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '晴天' }),
    });

    const hit = await postJson(`/api/tracks/${created.id}/lyrics/auto`, {});
    assert.equal(hit.status, 200);
    const updated = (await hit.json()) as { hasLyrics: boolean; lyrics: string | null };
    assert.equal(updated.hasLyrics, true);
    assert.match(updated.lyrics!, /\[00:32\.71\]从出生那年就飘着/);

    // 落库确实生效
    const after = await getTrack(created.id);
    assert.equal(after.hasLyrics, true);
  });
});
