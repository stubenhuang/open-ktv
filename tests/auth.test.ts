import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { before, describe, it } from 'node:test';

/**
 * 访问令牌闸门。
 *
 * 两个注意点：
 *  1. env 必须在动态 import 之前设好 —— config.ts 是加载时求值的；
 *  2. 请求只能从回环发起（服务器就监听在 127.0.0.1 上），所以「非回环被拒」
 *     这条路不走真实 socket，直接用伪造的 req/res 单测中间件本身。
 *     「没配令牌时全放行」则由现有整套 http 测试守着 —— 闸门若在空配置下
 *     误拦，所有 API 测试都会红。
 */

process.env.ACCESS_TOKEN = 'secret-token';

let gate: (req: Request, res: Response, next: () => void) => void;
let isLoopbackAddress: (ip: string | undefined | null) => boolean;

before(async () => {
  const auth = await import('../server/src/auth.ts');
  // 注意：createTokenGate 是工厂，要先调用才拿到中间件本身
  gate = auth.createTokenGate();
  isLoopbackAddress = auth.isLoopbackAddress;
});

interface FakeResult {
  nextCalled: boolean;
  status: number;
  body: { code?: string; error?: string } | null;
}

function fakeExchange(
  remoteAddress: string,
  options: { header?: string; query?: string } = {},
): { req: Request; res: Response; result: FakeResult } {
  const result: FakeResult = { nextCalled: false, status: 200, body: null };
  const req = {
    socket: { remoteAddress },
    path: '/api/tracks',
    query: options.query ? { token: options.query } : {},
    get: (name: string) =>
      name.toLowerCase() === 'x-access-token' ? (options.header ?? null) : null,
  } as unknown as Request;
  const res = {
    status(code: number) {
      result.status = code;
      return res;
    },
    json(body: { code?: string; error?: string }) {
      result.body = body;
      return res;
    },
  } as unknown as Response;
  return { req, res, result };
}

/** 跑一次闸门，返回观测结果 */
function run(remoteAddress: string, options: { header?: string; query?: string } = {}): FakeResult {
  const { req, res, result } = fakeExchange(remoteAddress, options);
  gate(req, res, () => {
    result.nextCalled = true;
  });
  return result;
}

describe('访问令牌闸门', () => {
  it('isLoopbackAddress：回环各种写法都认得', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('127.0.0.2'), true, '整个 127/8 都是回环');
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true, 'IPv4-mapped 回环');
    assert.equal(isLoopbackAddress('::ffff:192.168.1.5'), false, 'mapped 私网不是回环');
    assert.equal(isLoopbackAddress('192.168.1.5'), false);
    assert.equal(isLoopbackAddress(undefined), false);
    assert.equal(isLoopbackAddress(null), false);
  });

  it('回环地址永远放行（桌面本机零感知）', () => {
    for (const address of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
      const result = run(address);
      assert.equal(result.nextCalled, true, `${address} 应放行`);
      assert.equal(result.status, 200);
    }
  });

  it('非回环无令牌：401 + token_required', () => {
    const result = run('192.168.1.5');
    assert.equal(result.nextCalled, false);
    assert.equal(result.status, 401);
    assert.equal(result.body?.code, 'token_required');
  });

  it('非回环带头令牌：正确放行、错误拒绝', () => {
    assert.equal(run('192.168.1.5', { header: 'secret-token' }).nextCalled, true);
    const wrong = run('192.168.1.5', { header: 'wrong-token' });
    assert.equal(wrong.nextCalled, false);
    assert.equal(wrong.status, 401);
  });

  it('非回环带 query 令牌：<audio>/<video> 的 src 走这条路', () => {
    assert.equal(run('192.168.1.5', { query: 'secret-token' }).nextCalled, true);
    assert.equal(run('192.168.1.5', { query: 'nope' }).nextCalled, false);
  });

  it('空串令牌不等于没令牌：不得放行', () => {
    const result = run('192.168.1.5', { header: '   ' });
    assert.equal(result.nextCalled, false);
  });
});
