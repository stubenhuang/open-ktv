import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { FiveSingProvider, stripHighlight } from '../server/src/library/providers/fiveSing.ts';

/**
 * 5sing provider 的单测：全部打一个临时起的本地 HTTP 服务器，
 * 按 5sing 真实接口的响应结构造数据，不碰外网。
 */

let server: http.Server;
let origin = '';
/** 每个路径被请求了几次，用来验证缓存 */
const hits = new Map<string, number>();
/** 自定义路由（测试里按需覆盖） */
let routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void> = {};

function hit(pathname: string): void {
  hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
}

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    hit(url.pathname);

    const custom = routes[url.pathname];
    if (custom) {
      custom(req, res);
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

/** 造一页 5sing 搜索结果 */
function searchPage(items: unknown[], pageInfo = { cur: 1, totalCount: 100, totalPages: 10 }): unknown {
  return { list: items, type: 0, pageInfo };
}

function bzItem(
  songId: number,
  songName: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    songId,
    songName,
    singer: '傲艺',
    nickName: '傲艺',
    songSize: 8162871,
    ext: 'mp3',
    type: 3,
    typeName: '伴奏',
    songurl: `http://5sing.kugou.com/bz/${songId}.html`,
    downloadurl: `http://5sing.kugou.com/bz/down/${songId}`,
    typeEname: 'bz',
    ...extra,
  };
}

function q(text: string, extra: { kind?: 'audio' | 'video' | null; limit?: number } = {}) {
  return {
    q: text,
    kind: extra.kind ?? null,
    limit: extra.limit ?? 50,
    signal: AbortSignal.timeout(5_000),
  };
}

/** 装一个「两页搜索」的 stub：第 1 页 10 条，第 2 页 3 条 */
function installTwoPageSearch(): void {
  routes['/home/json'] = (req, res) => {
    const page = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('page'));
    if (page === 1) {
      const items = Array.from({ length: 10 }, (_, index) =>
        bzItem(1000 + index, `<em class="keyword">晴天</em> 第${index}版`),
      );
      json(res, searchPage(items, { cur: 1, totalCount: 13, totalPages: 2 }));
      return;
    }
    const items = [bzItem(2000, '晴天 第二页1'), bzItem(2001, '晴天 第二页2'), bzItem(2002, '晴天 第二页3')];
    json(res, searchPage(items, { cur: 2, totalCount: 13, totalPages: 2 }));
  };
}

function makeProvider(overrides: Partial<ConstructorParameters<typeof FiveSingProvider>[0]> = {}) {
  return new FiveSingProvider({
    searchBaseUrl: origin,
    apiBaseUrl: origin,
    webBaseUrl: origin,
    ...overrides,
  });
}

describe('stripHighlight', () => {
  it('剥掉 <em> 高亮标签与常见 HTML 实体', () => {
    assert.equal(stripHighlight('<em class="keyword">周杰伦</em> - 晴天'), '周杰伦 - 晴天');
    assert.equal(stripHighlight('A &amp; B'), 'A & B');
    assert.equal(stripHighlight('  空白  '), '空白');
  });
});

describe('FiveSingProvider：搜索解析', () => {
  it('剥离高亮标签、songSize=0 记成未知、非伴奏被过滤、artist 回落', async () => {
    routes['/home/json'] = (_req, res) => {
      json(
        res,
        searchPage([
          bzItem(2201577, '<em class="keyword">周杰伦</em>', { songSize: 0 }),
          bzItem(222, '另一首', { singer: '', nickName: '上传者小林' }),
          // 翻唱（type=2）不该出现
          { ...bzItem(333, '翻唱歌曲'), type: 2, typeName: '翻唱', typeEname: 'fc' },
          // 缺 songId 的丢掉
          { songName: '没有 id', type: 3, typeName: '伴奏' },
        ]),
      );
    };

    const provider = makeProvider();
    const items = await provider.search(q('周杰伦'));

    assert.equal(items.length, 2);
    const jay = items.find((item) => item.itemId === '2201577')!;
    assert.equal(jay.title, '周杰伦');
    assert.equal(jay.sizeBytes, null, 'songSize=0 是未知，不该当 0 字节');
    assert.equal(jay.kind, 'audio');
    assert.equal(jay.lrcUrl, null);
    assert.equal(jay.url, '', 'search 阶段拿不到下载地址');

    const other = items.find((item) => item.itemId === '222')!;
    assert.equal(other.artist, '上传者小林', 'singer 为空时回落到 nickName');
  });

  it('翻页：合并多页、尾页不足一页即停、受 limit 截断', async () => {
    hits.clear();
    installTwoPageSearch();
    const provider = makeProvider();

    const all = await provider.search(q('晴天'));
    assert.equal(all.length, 13, '两页都要合并进来');
    assert.deepEqual(
      all.map((item) => item.itemId),
      ['1000', '1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008', '1009', '2000', '2001', '2002'],
    );

    hits.clear();
    const limited = await provider.search(q('晴天', { limit: 12 }));
    assert.equal(limited.length, 12, '够数就不该再翻第 3 页');
  });

  it('kind=video 直接空结果（5sing 伴奏区没有 MV）', async () => {
    installTwoPageSearch();
    const provider = makeProvider();
    assert.deepEqual(await provider.search(q('晴天', { kind: 'video' })), []);
  });

  it('第一页就失败 → 抛错（registry 会降级成源状态）', async () => {
    routes['/home/json'] = (_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    };
    const provider = makeProvider();
    await assert.rejects(() => provider.search(q('晴天')), /HTTP 500/);
  });

  it('中间页失败 → 保留已有结果，不整体报错', async () => {
    routes['/home/json'] = (req, res) => {
      const page = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('page'));
      if (page === 1) {
        json(res, searchPage(Array.from({ length: 10 }, (_, i) => bzItem(100 + i, '歌'))));
        return;
      }
      res.statusCode = 500;
      res.end('boom');
    };
    const provider = makeProvider();
    const items = await provider.search(q('晴天'));
    assert.equal(items.length, 10);
  });

  it('空关键词 → 解析热门伴奏表格', async () => {
    routes['/bz/rmsong/more_1.shtml'] = (_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<table class="ct_list"><tr><td><div class="aleft">
        <a href="http://5sing.kugou.com/bz/3584436.html" target="_blank" title="刘一手新串烧降B中速Dj 试听">刘一手新串烧降B中速Dj 试听</a></div></td>
        <td><a href="http://search.5sing.kugou.com/?keyword=%E5%88%98%E4%B8%80%E6%89%8B" title="刘一手">刘一手</a></td></tr>
        <tr><td><div class="aleft">
        <a href="http://5sing.kugou.com/bz/3510042.html" target="_blank" title="高天上流云连奏降b唢呐伴奏李帅">高天上流云连奏降b唢呐伴奏李帅</a></div></td></tr>
        </table>`);
    };

    const provider = makeProvider();
    const items = await provider.search(q(''));
    assert.equal(items.length, 2);
    assert.equal(items[0]!.itemId, '3584436');
    assert.equal(items[0]!.title, '刘一手新串烧降B中速Dj 试听');
    assert.equal(items[0]!.url, '');
  });
});

describe('FiveSingProvider：resolve（下载地址现取）', () => {
  it('sq → hq → lq 回退，并带上同档 backup', async () => {
    routes['/song/newget'] = (_req, res) => {
      json(res, {
        success: true,
        code: 0,
        data: { ID: 2201577, SN: '周杰伦', SS: 8162863, user: { NN: '傲艺' } },
      });
    };
    routes['/song/getSongUrl'] = (_req, res) => {
      json(res, {
        code: 1000,
        message: '',
        data: {
          songid: 2201577,
          songtype: 'bz',
          squrl: `${origin}/cdn/sq.mp3`,
          squrl_backup: `${origin}/cdn-backup/sq.mp3`,
          hqurl: `${origin}/cdn/hq.mp3`,
          hqurl_backup: '',
          lqurl: `${origin}/cdn/lq.mp3`,
          lqurl_backup: '',
        },
      });
    };

    const provider = makeProvider();
    const item = await provider.resolve('2201577');
    assert.ok(item);
    assert.equal(item.title, '周杰伦', '标题取自 newget');
    assert.equal(item.artist, '傲艺');
    assert.equal(item.sizeBytes, 8162863);
    assert.equal(item.url, `${origin}/cdn/sq.mp3`);
    assert.equal(item.backupUrl, `${origin}/cdn-backup/sq.mp3`);
    assert.equal(item.kind, 'audio');
  });

  it('sq 为空时回退 hq / lq', async () => {
    routes['/song/newget'] = (_req, res) => {
      json(res, { success: true, data: { SN: '告白气球', user: { NN: 'MacMine' } } });
    };
    routes['/song/getSongUrl'] = (_req, res) => {
      json(res, {
        code: 1000,
        data: {
          squrl: '',
          squrl_backup: '',
          hqurl: `${origin}/cdn/hq.mp3`,
          hqurl_backup: `${origin}/cdn-backup/hq.mp3`,
          lqurl: `${origin}/cdn/lq.mp3`,
          lqurl_backup: `${origin}/cdn-backup/lq.mp3`,
        },
      });
    };

    const provider = makeProvider();
    const item = await provider.resolve('2873373');
    assert.equal(item?.url, `${origin}/cdn/hq.mp3`);
    assert.equal(item?.backupUrl, `${origin}/cdn-backup/hq.mp3`);

    // 再把 hq 也清空 → 用 lq
    routes['/song/getSongUrl'] = (_req, res) => {
      json(res, { code: 1000, data: { lqurl: `${origin}/cdn/lq.mp3` } });
    };
    provider.clearMetadataCache();
    const low = await provider.resolve('2873373');
    assert.equal(low?.url, `${origin}/cdn/lq.mp3`);
  });

  it('三档全空 → resolve 不出条目', async () => {
    routes['/song/newget'] = (_req, res) => {
      json(res, { success: true, data: { SN: '空', user: { NN: 'x' } } });
    };
    routes['/song/getSongUrl'] = (_req, res) => {
      json(res, { code: 1000, data: { squrl: '', hqurl: '', lqurl: '' } });
    };
    const provider = makeProvider();
    assert.equal(await provider.resolve('1'), undefined);
  });

  it('歌曲不存在（code 28）→ 抛错，错误信息可读', async () => {
    routes['/song/newget'] = (_req, res) => {
      json(res, { success: false, message: '歌曲不存在', code: 28, data: [] });
    };
    routes['/song/getSongUrl'] = (_req, res) => {
      json(res, { message: '歌曲不存在', success: false, data: [], code: 28 });
    };
    const provider = makeProvider();
    await assert.rejects(() => provider.resolve('999999999'), /歌曲不存在/);
  });

  it('非数字 itemId → undefined', async () => {
    const provider = makeProvider();
    assert.equal(await provider.resolve('随便'), undefined);
    assert.equal(await provider.resolve(''), undefined);
  });

  it('元数据缓存命中后不再请求 newget', async () => {
    routes['/home/json'] = (_req, res) => {
      json(res, searchPage([bzItem(2201577, '<em class="keyword">周杰伦</em>')]));
    };
    routes['/song/newget'] = (_req, res) => {
      json(res, { success: true, data: { SN: '周杰伦', SS: 8162863, user: { NN: '傲艺' } } });
    };
    routes['/song/getSongUrl'] = (_req, res) => {
      json(res, { code: 1000, data: { squrl: `${origin}/cdn/sq.mp3` } });
    };

    const provider = makeProvider();
    await provider.search(q('周杰伦'));
    hits.clear();

    const item = await provider.resolve('2201577');
    assert.equal(item?.title, '周杰伦', '标题用 search 时留下的缓存');
    assert.equal(hits.get('/song/newget'), undefined, '不该再请求 newget');
    assert.equal(hits.get('/song/getSongUrl'), 1, '下载地址仍要现取');
  });

  it('newget 挂了不影响 resolve（标题兜底）', async () => {
    routes['/song/newget'] = (_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    };
    routes['/song/getSongUrl'] = (_req, res) => {
      json(res, { code: 1000, data: { hqurl: `${origin}/cdn/hq.mp3` } });
    };
    const provider = makeProvider();
    const item = await provider.resolve('123');
    assert.ok(item);
    assert.equal(item.title, '5sing_123');
    assert.equal(item.url, `${origin}/cdn/hq.mp3`);
  });

  it('非 http(s) 的下载地址被拒', async () => {
    routes['/song/newget'] = (_req, res) => {
      json(res, { success: true, data: { SN: '危险', user: { NN: 'x' } } });
    };
    routes['/song/getSongUrl'] = (_req, res) => {
      json(res, {
        code: 1000,
        data: { squrl: 'file:///etc/passwd', hqurl: 'ftp://x/y.mp3', lqurl: '' },
      });
    };
    const provider = makeProvider();
    assert.equal(await provider.resolve('1'), undefined);
  });
});

describe('FiveSingProvider：超时', () => {
  it('请求挂起 → 抛错而不是无限等', async () => {
    routes['/home/json'] = (_req, _res) => {
      // 故意不响应
    };
    const provider = makeProvider({ timeoutMs: 60 });
    await assert.rejects(() => provider.search(q('晴天')));
  });
});
