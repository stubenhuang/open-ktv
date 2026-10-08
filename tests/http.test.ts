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

/** 造一个 1 秒的 mp4（h264 + aac）—— 视频伴奏，上传应被拒 */
async function makeMp4(): Promise<Buffer> {
  const file = path.join(dataDir, 'fixture.mp4');
  await helpers.ffmpegOk([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x120:rate=10:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=1',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    '-shortest',
    file,
  ]);
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
    const body = (await response.json()) as {
      ok: boolean;
      queue: { active: null };
    };
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

  it('上传视频被拒：伴奏库只收音频（靠 ffprobe 判定，不看扩展名）', async () => {
    const form = new FormData();
    form.append('file', new Blob([await makeMp4()], { type: 'video/mp4' }), 'mv.mp4');
    const response = await fetch(`${baseUrl}/api/tracks`, { method: 'POST', body: form });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /音频/);

    // 混进库里一条都不行
    const list = (await (await fetch(`${baseUrl}/api/tracks`)).json()) as { kind: string }[];
    assert.equal(list.some((item) => item.kind === 'video'), false);
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

  it('歌词：贴 LRC 文本入库并规范化，详情带正文、列表只带 hasLyrics', async () => {
    const messy = ['[00:30]丙', '[by:某人]', '[00:10.5]甲'].join('\n');
    const response = await fetch(`${baseUrl}/api/tracks/${trackId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lyrics: messy }),
    });
    assert.equal(response.status, 200);

    const body = (await response.json()) as { lyrics: string; hasLyrics: boolean };
    assert.equal(body.lyrics, ['[00:10.50]甲', '[00:30.00]丙'].join('\n'), '服务端存的是规范化后的文本');
    assert.equal(body.hasLyrics, true);

    // 详情带歌词正文
    const detail = (await (await fetch(`${baseUrl}/api/tracks/${trackId}`)).json()) as {
      lyrics: string;
      hasLyrics: boolean;
      lyricsOffsetMs: number;
    };
    assert.equal(detail.lyrics, body.lyrics);
    assert.equal(detail.hasLyrics, true);

    // 列表不带歌词正文，只给布尔值 —— 几百首的库不该每次轮询都传全部歌词
    const list = (await (await fetch(`${baseUrl}/api/tracks`)).json()) as Record<string, unknown>[];
    const item = list.find((entry) => entry.id === trackId)!;
    assert.equal(item.hasLyrics, true);
    assert.equal('lyrics' in item, false);
  });

  it('歌词：纯文本没有时间戳 → 400，不被静默降级', async () => {
    const response = await fetch(`${baseUrl}/api/tracks/${trackId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lyrics: '这是一段没有时间戳的歌词\n第二行' }),
    });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /\[mm:ss\]/);
  });

  it('歌词：lyricsOffsetMs 被钳制到 ±30000 并取整', async () => {
    const over = (await (
      await fetch(`${baseUrl}/api/tracks/${trackId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lyricsOffsetMs: 999_999 }),
      })
    ).json()) as { lyricsOffsetMs: number };
    assert.equal(over.lyricsOffsetMs, 30_000);

    const under = (await (
      await fetch(`${baseUrl}/api/tracks/${trackId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lyricsOffsetMs: -999_999.6 }),
      })
    ).json()) as { lyricsOffsetMs: number };
    assert.equal(under.lyricsOffsetMs, -30_000);

    const rounded = (await (
      await fetch(`${baseUrl}/api/tracks/${trackId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lyricsOffsetMs: -120.6 }),
      })
    ).json()) as { lyricsOffsetMs: number };
    assert.equal(rounded.lyricsOffsetMs, -121);
  });

  it('歌词：空串清除歌词，但不动微调', async () => {
    const before = (await (await fetch(`${baseUrl}/api/tracks/${trackId}`)).json()) as {
      lyricsOffsetMs: number;
    };
    const response = await fetch(`${baseUrl}/api/tracks/${trackId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lyrics: '' }),
    });
    assert.equal(response.status, 200);

    const body = (await response.json()) as { lyrics: null; hasLyrics: boolean; lyricsOffsetMs: number };
    assert.equal(body.lyrics, null);
    assert.equal(body.hasLyrics, false);
    assert.equal(body.lyricsOffsetMs, before.lyricsOffsetMs, '清歌词不该顺带重置微调');
  });

  it('歌词：上传 .lrc 文件，非法内容 / 错误扩展名 / 不存在的伴奏都被拒', async () => {
    const upload = async (content: string, fileName: string, id = trackId) => {
      const form = new FormData();
      form.append('lyrics', new Blob([content], { type: 'text/plain' }), fileName);
      return fetch(`${baseUrl}/api/tracks/${id}/lyrics`, { method: 'POST', body: form });
    };

    const ok = await upload('[ti:晴天]\n[00:01.00]第一句\n[00:05.00]第二句', '晴天.lrc');
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { lyrics: string };
    assert.equal(body.lyrics, ['[ti:晴天]', '[00:01.00]第一句', '[00:05.00]第二句'].join('\n'));

    const badContent = await upload('没有时间戳的歌词', 'bad.lrc');
    assert.equal(badContent.status, 400);

    const badExtension = await upload('[00:01.00]甲', '歌词.docx');
    assert.equal(badExtension.status, 400);
    assert.match(((await badExtension.json()) as { error: string }).error, /\.lrc/);

    const missingTrack = await upload('[00:01.00]甲', 'x.lrc', '不存在的id');
    assert.equal(missingTrack.status, 404);
  });

  it('歌词：缺文件字段 → 400', async () => {
    const form = new FormData();
    form.append('notlyrics', 'x');
    const response = await fetch(`${baseUrl}/api/tracks/${trackId}/lyrics`, {
      method: 'POST',
      body: form,
    });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /表单字段名应为 lyrics/);
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

  it('删除伴奏不再被作品拦截：作品保留，脱钩后不能再合成', async () => {
    // 直接造「伴奏 + 作品」：这里要验的是删除语义，不必真走一遍录音上传
    const db = await import('../server/src/db.ts');
    const { DEFAULT_MIX_PARAMS } = await import('../shared/types.ts');
    const trackId = 'http-delete-with-works';
    db.insertTrack({
      id: trackId,
      title: 'HTTP删除测试伴奏',
      artist: null,
      kind: 'audio',
      originalName: 'x.mp3',
      originalPath: path.join(dataDir, 'x.mp3'),
      playablePath: path.join(dataDir, 'x.mp3'),
      proxyKind: 'none',
      mime: 'audio/mpeg',
      size: 1024,
      duration: 3,
      status: 'ready',
      error: null,
    });
    db.insertWork({
      id: 'http-delete-work',
      trackId,
      title: 'HTTP删除测试作品',
      vocalPath: path.join(dataDir, 'vocal.wav'),
      vocalDuration: 3,
      autoOffsetMs: 100,
      mixParams: DEFAULT_MIX_PARAMS,
      status: 'ready',
    });

    const removed = await fetch(`${baseUrl}/api/tracks/${trackId}`, { method: 'DELETE' });
    assert.equal(removed.status, 200, '有作品也照删，不再 409');
    assert.deepEqual(await removed.json(), { ok: true, keptWorks: 1 });

    assert.equal((await fetch(`${baseUrl}/api/tracks/${trackId}`)).status, 404, '伴奏没了');

    // 作品记录和接口都还在，只是脱钩了
    const detail = (await (await fetch(`${baseUrl}/api/works/http-delete-work`)).json()) as {
      trackId: string | null;
      trackTitle: string | null;
    };
    assert.equal(detail.trackId, null, '外键 SET NULL 把作品脱钩');
    assert.equal(detail.trackTitle, null, '列表/详情都该反映「伴奏已删除」');

    const list = (await (await fetch(`${baseUrl}/api/works`)).json()) as {
      id: string;
      trackTitle: string | null;
    }[];
    assert.ok(list.some((item) => item.id === 'http-delete-work'), '作品库列表仍包含它');

    // 没有伴奏就不能再合成：任务应立即失败并说明原因
    const remix = await fetch(`${baseUrl}/api/works/http-delete-work/mix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(remix.status, 202);

    const deadline = Date.now() + 5000;
    let failedError: string | null = null;
    while (Date.now() < deadline) {
      const work = (await (await fetch(`${baseUrl}/api/works/http-delete-work`)).json()) as {
        status: string;
        error: string | null;
      };
      if (work.status === 'failed') {
        failedError = work.error;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(failedError ?? '', /伴奏已删除/, '没伴奏时合成应直接失败并说明原因');

    // 收尾：作品本身仍可删
    const workRemoved = await fetch(`${baseUrl}/api/works/http-delete-work`, { method: 'DELETE' });
    assert.equal(workRemoved.status, 200);
  });

  it('删除伴奏后查不到了', async () => {
    const response = await fetch(`${baseUrl}/api/tracks/${trackId}`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, keptWorks: 0 });

    const gone = await fetch(`${baseUrl}/api/tracks/${trackId}`);
    assert.equal(gone.status, 404);
  });
});
