import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { HttpIndexProvider } from '../server/src/library/providers/httpIndex.ts';
import { LibraryRegistry, createRegistry, parseSourceSpec } from '../server/src/library/registry.ts';
import type { LibraryItem } from '../server/src/library/types.ts';

/**
 * 全部用一个临时起的本地 HTTP 服务器当「源站」——
 * 不依赖外网，也不依赖任何第三方站点的可用性。
 */

let server: http.Server;
let origin = '';
/** 每个路径被请求了几次，用来验证缓存 */
const hits = new Map<string, number>();
/** 改成 true 就让清单接口返回 500，用来验证降级 */
let manifestBroken = false;
/** 清单之外的自定义路由（测试里按需覆盖） */
let routes: Record<string, (res: http.ServerResponse) => void> = {};

function hit(pathname: string): void {
  hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
}

before(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    hit(pathname);

    const custom = routes[pathname];
    if (custom) {
      custom(res);
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

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

const GOOD_MANIFEST = {
  version: 1,
  name: '测试曲库',
  items: [
    { id: 'qingtian', title: '晴天', artist: '周杰伦', durationSec: 269, kind: 'audio', url: 'qingtian.mp3', lrc: 'qingtian.lrc' },
    { id: 'yequ', title: '夜曲', artist: '周杰伦', durationSec: 227, kind: 'audio', url: '/audio/yequ.mp3' },
    { id: 'mv1', title: '稻香 MV', artist: '周杰伦', kind: 'video', url: 'https://cdn.example.com/daoxiang.mp4' },
    // 没有 id：用 url 兜底
    { title: '没有id的歌', artist: '某人', url: 'noid.mp3' },
    // 缺 title / url：应被丢掉
    { id: 'broken1', url: 'x.mp3' },
    { id: 'broken2', title: '缺地址' },
    // file:// 协议：应被丢掉
    { id: 'broken3', title: '本地路径', url: 'file:///etc/passwd' },
  ],
};

async function makeProvider(overrides: Partial<{ cacheTtlMs: number; searchTimeoutMs: number }> = {}) {
  routes['/index.json'] = (res) => {
    if (manifestBroken) {
      json(res, { error: 'boom' }, 500);
      return;
    }
    json(res, GOOD_MANIFEST);
  };
  return new HttpIndexProvider({
    id: 'test-source',
    manifestUrl: `${origin}/index.json`,
    label: '测试源',
    ...overrides,
  });
}

function q(text: string, extra: { kind?: 'audio' | 'video' | null; limit?: number } = {}) {
  return {
    q: text,
    kind: extra.kind ?? null,
    limit: extra.limit ?? 50,
    signal: AbortSignal.timeout(5_000),
  };
}

describe('parseSourceSpec', () => {
  it('名字=URL 的写法', () => {
    assert.deepEqual(parseSourceSpec('我的库=https://a.example/index.json'), {
      name: '我的库',
      url: 'https://a.example/index.json',
    });
  });

  it('裸 URL 没有名字', () => {
    assert.deepEqual(parseSourceSpec('https://a.example/index.json'), {
      url: 'https://a.example/index.json',
    });
  });

  it('URL 查询串里的 = 不会被当成名字分隔符', () => {
    const spec = 'https://a.example/index.json?token=abc&x=1';
    assert.deepEqual(parseSourceSpec(spec), { url: spec });
  });

  it('名字里带 / 或 : 时按裸 URL 处理', () => {
    assert.deepEqual(parseSourceSpec('http://a/b=https://c/d'), {
      url: 'http://a/b=https://c/d',
    });
  });
});

describe('HttpIndexProvider：清单解析', () => {
  it('相对地址按清单地址绝对化，id 缺失用 url 兜底，坏条目被丢掉', async () => {
    const provider = await makeProvider();
    const items = await provider.search(q(''));

    const byId = new Map(items.map((item) => [item.itemId, item]));

    const qingtian = byId.get('qingtian')!;
    assert.equal(qingtian.url, `${origin}/qingtian.mp3`, '相对地址要绝对化');
    assert.equal(qingtian.lrcUrl, `${origin}/qingtian.lrc`);
    assert.equal(qingtian.kind, 'audio');
    assert.equal(qingtian.durationSec, 269);

    // 以 / 开头的相对地址
    assert.equal(byId.get('yequ')!.url, `${origin}/audio/yequ.mp3`);

    // 绝对 URL 原样保留
    assert.equal(byId.get('mv1')!.url, 'https://cdn.example.com/daoxiang.mp4');
    assert.equal(byId.get('mv1')!.kind, 'video');

    // 没有 id → 用 url 当 id
    assert.ok(byId.has(`${origin}/noid.mp3`), '没有 id 的条目应回落到 url 作为 id');

    // 缺关键字段 / 非 http(s) 的条目被丢掉
    assert.equal(items.length, 4, `实际 ${items.length} 条`);
    assert.equal(byId.has('broken1'), false);
    assert.equal(byId.has('broken2'), false);
    assert.equal(byId.has('broken3'), false, 'file:// 不该被接受');
  });

  it('没有 lrc 的条目 lrcUrl 为 null', async () => {
    const provider = await makeProvider();
    const items = await provider.search(q('夜曲'));
    assert.equal(items[0]!.lrcUrl, null);
  });
});

describe('HttpIndexProvider：搜索', () => {
  it('空关键词返回全部，受 limit 限制', async () => {
    const provider = await makeProvider();
    assert.equal((await provider.search(q(''))).length, 4);
    assert.equal((await provider.search(q('', { limit: 2 }))).length, 2);
  });

  it('按歌名与歌手匹配，大小写不敏感', async () => {
    const provider = await makeProvider();
    assert.equal((await provider.search(q('晴天'))).length, 1);
    assert.equal((await provider.search(q('周杰伦'))).length, 3);
    assert.equal((await provider.search(q('周杰伦', { kind: 'video' }))).length, 1);
    assert.equal((await provider.search(q('不存在的歌'))).length, 0);
  });

  it('kind 过滤生效', async () => {
    const provider = await makeProvider();
    const audio = await provider.search(q('', { kind: 'audio' }));
    assert.equal(audio.length, 3);
    assert.ok(audio.every((item) => item.kind === 'audio'));
  });

  it('resolve 能按 itemId 取回下载地址', async () => {
    const provider = await makeProvider();
    const item = await provider.resolve('qingtian');
    assert.equal(item?.url, `${origin}/qingtian.mp3`);
    assert.equal(await provider.resolve('没这个'), undefined);
  });
});

describe('HttpIndexProvider：缓存与降级', () => {
  it('TTL 内只拉一次清单', async () => {
    hits.clear();
    const provider = await makeProvider();
    await provider.search(q(''));
    await provider.search(q('晴天'));
    await provider.search(q('夜曲'));
    assert.equal(hits.get('/index.json'), 1, 'TTL 内搜三次只该拉一次清单');
  });

  it('TTL 为 0 时每次重新拉', async () => {
    hits.clear();
    const provider = await makeProvider({ cacheTtlMs: 0 });
    await provider.search(q(''));
    await provider.search(q(''));
    assert.equal(hits.get('/index.json'), 2);
  });

  it('并发搜索只触发一次清单请求（单飞）', async () => {
    hits.clear();
    const provider = await makeProvider();
    await Promise.all([provider.search(q('')), provider.search(q('')), provider.search(q(''))]);
    assert.equal(hits.get('/index.json'), 1);
  });

  it('源站失败时回退到过期缓存，而不是让曲库变空', async () => {
    hits.clear();
    manifestBroken = false;
    const provider = await makeProvider({ cacheTtlMs: 0 });
    assert.equal((await provider.search(q(''))).length, 4);

    // 源站挂了：TTL=0 会去重拉，失败后应回退到上一次的缓存
    manifestBroken = true;
    const fallback = await provider.search(q(''));
    assert.equal(fallback.length, 4, '应沿用过期缓存');
    manifestBroken = false;
  });

  it('没有缓存且源站失败 → 抛错（由 registry 降级成源状态）', async () => {
    manifestBroken = true;
    const provider = await makeProvider({ cacheTtlMs: 0 });
    await assert.rejects(() => provider.search(q('')), /HTTP 500|清单拉取失败/);
    manifestBroken = false;
  });

  it('清单不是合法 JSON / 缺 items → 抛错', async () => {
    routes['/bad-json.json'] = (res) => {
      res.setHeader('content-type', 'application/json');
      res.end('这不是 JSON');
    };
    const badJson = new HttpIndexProvider({
      id: 'bad',
      manifestUrl: `${origin}/bad-json.json`,
      cacheTtlMs: 0,
    });
    await assert.rejects(() => badJson.search(q('')), /合法 JSON/);

    routes['/no-items.json'] = (res) => json(res, { version: 1 });
    const noItems = new HttpIndexProvider({
      id: 'noitems',
      manifestUrl: `${origin}/no-items.json`,
      cacheTtlMs: 0,
    });
    await assert.rejects(() => noItems.search(q('')), /items/);
  });
});

describe('LibraryRegistry：多源聚合', () => {
  function fakeProvider(id: string, items: LibraryItem[]) {
    return {
      id,
      label: id,
      async search() {
        return items;
      },
      async resolve(itemId: string) {
        return items.find((item) => item.itemId === itemId);
      },
    };
  }

  function item(providerId: string, itemId: string): LibraryItem {
    return {
      providerId,
      itemId,
      title: itemId,
      artist: null,
      durationSec: null,
      kind: 'audio',
      url: `https://example.com/${itemId}.mp3`,
      lrcUrl: null,
      sizeBytes: null,
    };
  }

  it('多个源的结果交错排列，不让第一个源占满 limit', async () => {
    const a = fakeProvider('a', [item('a', 'a1'), item('a', 'a2'), item('a', 'a3')]);
    const b = fakeProvider('b', [item('b', 'b1'), item('b', 'b2')]);
    const registry = new LibraryRegistry([a, b]);

    const result = await registry.searchAll({ q: '', kind: null, limit: 4 });
    assert.deepEqual(
      result.items.map((entry) => entry.itemId),
      ['a1', 'b1', 'a2', 'b2'],
    );
  });

  it('单个源抛错不影响其他源，并反映在 sources 状态里', async () => {
    const good = fakeProvider('good', [item('good', 'g1')]);
    const bad = {
      id: 'bad',
      label: 'bad',
      async search() {
        throw new Error('源站炸了');
      },
      async resolve() {
        return undefined;
      },
    };
    const registry = new LibraryRegistry([good, bad]);

    const result = await registry.searchAll({ q: '', kind: null, limit: 10 });
    assert.deepEqual(result.items.map((entry) => entry.itemId), ['g1']);

    const goodStatus = result.sources.find((source) => source.id === 'good')!;
    const badStatus = result.sources.find((source) => source.id === 'bad')!;
    assert.equal(goodStatus.ok, true);
    assert.equal(badStatus.ok, false);
    assert.match(badStatus.error!, /源站炸了/);
  });

  it('同一个条目在多个源里只出现一次', async () => {
    const a = fakeProvider('a', [item('a', 'same')]);
    const b = fakeProvider('b', [item('b', 'same')]);
    const registry = new LibraryRegistry([a, b]);

    const result = await registry.searchAll({ q: '', kind: null, limit: 10 });
    // itemId 相同但 providerId 不同 → 去重键不同，两条都该保留
    assert.equal(result.items.length, 2);

    // 同源内的重复 id 由 provider 自己保证唯一，registry 再做一道兜底
    const dup = fakeProvider('c', [item('c', 'x'), item('c', 'x')]);
    const registry2 = new LibraryRegistry([dup]);
    assert.equal((await registry2.searchAll({ q: '', kind: null, limit: 10 })).items.length, 1);
  });

  it('没有配置任何源时返回空结果而不是报错', async () => {
    const registry = createRegistry([]);
    assert.equal(registry.isEmpty, true);
    const result = await registry.searchAll({ q: '晴天', kind: null, limit: 10 });
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.sources, []);
    assert.equal(registry.find('随便'), undefined);
  });
});

describe('createRegistry：配置解析', () => {
  it('非法 / 重复 / 非 http 的源被跳过，其余照常加载', () => {
    const registry = createRegistry([
      '名字=https://a.example/index.json',
      'https://a.example/index.json', // 与上面同一个清单 → 重复
      'https://b.example/index.json?token=abc&x=1',
      'ftp://c.example/index.json', // 协议不支持
      '不是一个地址',
    ]);

    assert.equal(registry.providers.length, 2, `实际 ${registry.providers.length}`);
    assert.equal(registry.providers[0]!.label, '名字');
    assert.deepEqual(registry.find(registry.providers[1]!.id)?.id, registry.providers[1]!.id);
  });

  it('provider id 用清单地址而不是配置顺序，保证点歌去重键稳定', () => {
    const first = createRegistry(['https://a.example/index.json']);
    const reordered = createRegistry(['https://b.example/index.json', 'https://a.example/index.json']);
    const idFromFirst = first.providers[0]!.id;
    assert.ok(
      reordered.providers.some((provider) => provider.id === idFromFirst),
      '调整配置顺序不该改变已有源的 id',
    );
  });

  it('label 在清单加载前回落到主机名', () => {
    const registry = createRegistry(['https://a.example/index.json']);
    assert.equal(registry.providers[0]!.label, 'a.example');
  });
});
