import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  cleanSongTitle,
  normalizeForMatch,
  pickBestCandidate,
  scoreLyricCandidate,
} from '../server/src/library/lyrics/songTitle.ts';
import { createKugouLyrics } from '../server/src/library/lyrics/kugou.ts';

/**
 * 歌词源测试：清洗/打分是纯函数；酷狗三步流打本地 stub。
 * 全部不碰外网。
 */

let server: http.Server;
let origin = '';
const hits = new Map<string, number>();
let routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void> = {};

/** 搜歌接口返回的 hash 序列（按顺序被 provider 依次尝试） */
let songHashes: string[] = ['hash-a', 'hash-b', 'hash-c'];
/** 每个 hash 对应的歌词候选；缺省视为没有候选 */
let candidatesByHash: Record<string, unknown[]> = {};
/** id+accesskey → base64 歌词内容；缺省视为下载失败 */
let lrcByKey: Record<string, string> = {};

function hit(pathname: string): void {
  hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
}

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

const LRC_GAOBAIQIQIU =
  '[ti:告白气球]\n[ar:周杰伦]\n[00:00.00]周杰伦 - 告白气球\n[00:23.59]塞纳河畔 左岸的咖啡\n[00:26.16]我手一杯 品尝你的美';

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    hit(url.pathname);

    // 自定义路由优先：测试要能模拟 500 / 空结果之类的异常分支
    const custom = routes[url.pathname];
    if (custom) {
      custom(req, res);
      return;
    }

    if (url.pathname === '/api/v3/search/song') {
      json(res, {
        status: 1,
        data: {
          info: songHashes.map((hash, index) => ({
            hash,
            songname: `歌${index}`,
            singername: '周杰伦',
            duration: 215,
            filename: '周杰伦 - 告白气球',
          })),
        },
      });
      return;
    }

    if (url.pathname === '/search') {
      const hash = url.searchParams.get('hash') ?? '';
      json(res, { status: 200, candidates: candidatesByHash[hash] ?? [] });
      return;
    }

    if (url.pathname === '/download') {
      const id = url.searchParams.get('id') ?? '';
      const key = `${id}|${url.searchParams.get('accesskey') ?? ''}`;
      const content = lrcByKey[key];
      if (!content) {
        json(res, { status: 403, info: 'Bad Accesskey', content: '' });
        return;
      }
      json(res, { status: 200, fmt: 'lrc', content });
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
});

/** 默认装一套「第一个 hash 就命中」的数据 */
function installDefaultFlow(): void {
  songHashes = ['hash-a', 'hash-b', 'hash-c'];
  candidatesByHash = {
    'hash-a': [{ id: '1', accesskey: 'k1', song: '告白气球', singer: '周杰伦', duration: 215000 }],
  };
  lrcByKey = { '1|k1': b64(LRC_GAOBAIQIQIU) };
}

function makeLyrics() {
  return createKugouLyrics({
    songSearchBaseUrl: origin,
    lyricsBaseUrl: origin,
    timeoutMs: 3_000,
  });
}

/* ------------------------------ 歌名清洗与打分 ------------------------------ */

describe('cleanSongTitle', () => {
  it('去掉伴奏/版本噪声与调性标记', () => {
    assert.equal(cleanSongTitle('周杰伦 - 告白气球 - 原版伴奏'), '周杰伦 告白气球');
    assert.equal(cleanSongTitle('祝福祖国【bE】伴奏 合唱版'), '祝福祖国');
    assert.equal(cleanSongTitle('偏偏喜欢你　消音伴奏'), '偏偏喜欢你');
    assert.equal(cleanSongTitle('晴天（C Low 伴奏）'), '晴天');
    assert.equal(cleanSongTitle('一路向北 (官方伴奏)'), '一路向北');
    assert.equal(cleanSongTitle('告白气球(Own)消音'), '告白气球');
  });

  it('没有噪声的原样返回；洗完为空时退回原文', () => {
    assert.equal(cleanSongTitle('晴天'), '晴天');
    assert.equal(cleanSongTitle('  稻香  '), '稻香');
    assert.equal(cleanSongTitle('伴奏'), '伴奏');
  });
});

describe('scoreLyricCandidate / pickBestCandidate', () => {
  const input = {
    rawTitle: '周杰伦 - 告白气球 - 原版伴奏',
    cleanTitle: '周杰伦 告白气球',
    artist: 'MacMine',
    durationSec: null,
  };

  it('标题命中 + 歌手出现在原始标题 → 高分入选', () => {
    const score = scoreLyricCandidate(input, { song: '告白气球', singer: '周杰伦' });
    assert.ok(score >= 2, `score=${score}`);
    assert.ok(
      pickBestCandidate(input, [
        { song: '告白气球', singer: '周杰伦' },
        { song: '完全无关的另一首歌', singer: '某人' },
      ])?.singer === '周杰伦',
    );
  });

  it('标题不沾边 → 0 分，绝不出现在结果里', () => {
    assert.equal(scoreLyricCandidate(input, { song: '夜曲', singer: '周杰伦' }), 0);
    assert.equal(
      pickBestCandidate(input, [{ song: '夜曲', singer: '周杰伦' }]),
      null,
      '没有达标的候选就返回 null（宁缺毋滥）',
    );
  });

  it('时长对得上加分，差太远扣分', () => {
    const base = { song: '告白气球', singer: '周杰伦' };
    const withDuration = { ...input, durationSec: 215 };
    assert.ok(
      scoreLyricCandidate(withDuration, { ...base, durationMs: 215800 }) >
        scoreLyricCandidate(input, base),
      '时长接近应该加分',
    );
    assert.ok(
      scoreLyricCandidate(withDuration, { ...base, durationMs: 300000 }) <
        scoreLyricCandidate(input, base),
      '时长差太远应该扣分',
    );
  });

  it('normalizeForMatch 只留中英文与数字', () => {
    assert.equal(normalizeForMatch('告白气球 (Live)'), '告白气球live');
    assert.equal(normalizeForMatch('So La Si Si'), 'solasisi');
  });
});

/* -------------------------------- 酷狗三步流 -------------------------------- */

describe('createKugouLyrics：三步流', () => {
  it('搜歌 → 候选 → 下载，返回归一化后的 LRC', async () => {
    installDefaultFlow();
    const lyrics = makeLyrics();
    const found = await lyrics.find({ title: '周杰伦 - 告白气球 - 原版伴奏', artist: 'MacMine' });

    assert.ok(found, '应该拿到歌词');
    assert.match(found, /\[ti:告白气球\]/);
    assert.match(found, /\[ar:周杰伦\]/);
    assert.match(found, /\[00:23\.59\]塞纳河畔 左岸的咖啡/);
    // 时间戳被规范化（毫秒→厘秒）
    assert.doesNotMatch(found, /\[00:23\.590\]/);
  });

  it('第一个 hash 没有候选时依次试下一个', async () => {
    installDefaultFlow();
    candidatesByHash = {
      'hash-b': [{ id: '2', accesskey: 'k2', song: '告白气球', singer: '周杰伦', duration: 215000 }],
    };
    lrcByKey = { '2|k2': b64(LRC_GAOBAIQIQIU) };

    const found = await makeLyrics().find({ title: '告白气球', artist: '周杰伦' });
    assert.ok(found);
    assert.match(found, /告白气球/);
  });

  it('下载返回 403（accesskey 失效）→ 当作没歌词，不抛错', async () => {
    installDefaultFlow();
    lrcByKey = {}; // 全部 Key 无效
    const found = await makeLyrics().find({ title: '告白气球', artist: '周杰伦' });
    assert.equal(found, null);
  });

  it('歌词是纯文本（无时间轴）→ 不入库', async () => {
    installDefaultFlow();
    lrcByKey = { '1|k1': b64('塞纳河畔 左岸的咖啡\n我手一杯 品尝你的美') };
    const found = await makeLyrics().find({ title: '告白气球', artist: '周杰伦' });
    assert.equal(found, null);
  });

  it('所有候选都不沾边 → null', async () => {
    installDefaultFlow();
    candidatesByHash = {
      'hash-a': [{ id: '9', accesskey: 'k9', song: '完全无关', singer: '某人' }],
    };
    const found = await makeLyrics().find({ title: '告白气球', artist: '周杰伦' });
    assert.equal(found, null);
  });

  it('源站 500 → null（不往调用方抛）', async () => {
    installDefaultFlow();
    routes['/api/v3/search/song'] = (_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    };
    const found = await makeLyrics().find({ title: '告白气球', artist: '周杰伦' });
    assert.equal(found, null);
  });

  it('空歌名直接 null，不发请求', async () => {
    installDefaultFlow();
    hits.clear();
    const found = await makeLyrics().find({ title: '   ', artist: null });
    assert.equal(found, null);
    assert.equal(hits.get('/api/v3/search/song'), undefined);
  });

  it('第一轮搜不到会按拆出的单段再搜（歌名/歌手单独搜）', async () => {
    installDefaultFlow();
    // 前两轮的关键词都搜不到可用候选，第三轮（拆出的单段）才命中
    const seenKeywords: string[] = [];
    routes['/api/v3/search/song'] = (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      seenKeywords.push(url.searchParams.get('keyword') ?? '');
      if (seenKeywords.length <= 2) {
        json(res, { status: 1, data: { info: [{ hash: 'hash-a', songname: 'x', singername: 'y', duration: 1 }] } });
        return;
      }
      json(res, {
        status: 1,
        data: {
          info: [{ hash: 'hash-b', songname: '告白气球', singername: '周杰伦', duration: 215 }],
        },
      });
    };
    candidatesByHash = {
      'hash-a': [],
      'hash-b': [{ id: '3', accesskey: 'k3', song: '告白气球', singer: '周杰伦', duration: 215000 }],
    };
    lrcByKey = { '3|k3': b64(LRC_GAOBAIQIQIU) };

    const found = await makeLyrics().find({ title: '周杰伦 - 告白气球 - 原版伴奏', artist: null });
    assert.ok(found, '后续轮次应该命中');
    assert.ok(seenKeywords.length >= 2, `应该发起多轮搜歌：${JSON.stringify(seenKeywords)}`);
    const laterQueries = seenKeywords.slice(1);
    assert.ok(
      laterQueries.some((keyword) => keyword === '周杰伦' || keyword === '告白气球'),
      `后续轮次应是拆出的单段：${JSON.stringify(seenKeywords)}`,
    );
  });
});
