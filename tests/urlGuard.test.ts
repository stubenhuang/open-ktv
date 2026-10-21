//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

/**
 * 曲库私网地址拦截（LIBRARY_BLOCK_PRIVATE_NET=1）。
 *
 * env 必须在动态 import 之前设好 —— config.ts / urlGuard.ts 都是加载时求值。
 * 全程不碰外网：公网用例一律用 IP 字面量（免 DNS），域名解析失败用 .invalid
 * （RFC 6761 保证 NXDOMAIN）。
 */

process.env.LIBRARY_BLOCK_PRIVATE_NET = '1';

let guard: typeof import('../server/src/library/urlGuard.ts');
let filterPrivateItems: typeof import('../server/src/library/providers/httpIndex.ts').filterPrivateItems;

before(async () => {
  guard = await import('../server/src/library/urlGuard.ts');
  ({ filterPrivateItems } = await import('../server/src/library/providers/httpIndex.ts'));
});

describe('私网地址判定', () => {
  it('IPv4 私网/回环/链路本地全部命中', () => {
    for (const ip of [
      '127.0.0.1',
      '127.255.255.255',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '192.168.255.255',
      '169.254.169.254', // 云元数据地址，最典型的 SSRF 目标
      '100.64.0.1', // CGNAT
      '0.0.0.0',
    ]) {
      assert.equal(guard.isPrivateAddress(ip), true, `${ip} 应判为私网`);
    }
  });

  it('IPv4 公网地址放行（含 172.32 —— 常被误当成私网的那一位）', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '100.63.255.255', '100.128.0.1']) {
      assert.equal(guard.isPrivateAddress(ip), false, `${ip} 应判为公网`);
    }
  });

  it('IPv6：回环/唯一本地/链路本地命中，公网放行', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1']) {
      assert.equal(guard.isPrivateAddress(ip), true, `${ip} 应判为私网`);
    }
    for (const ip of ['2001:db8::1', '2606:4700::1111']) {
      assert.equal(guard.isPrivateAddress(ip), false, `${ip} 应判为公网`);
    }
  });

  it('IPv4-mapped IPv6 按 v4 判', () => {
    assert.equal(guard.isPrivateAddress('::ffff:192.168.1.1'), true);
    assert.equal(guard.isPrivateAddress('::ffff:8.8.8.8'), false);
  });

  it('非法 IP 保守按私网处理', () => {
    assert.equal(guard.isPrivateAddress('不是IP'), true);
    assert.equal(guard.isPrivateAddress('999.1.1.1'), true);
  });
});

describe('isPublicHttpUrl', () => {
  it('协议只认 http(s)', async () => {
    assert.equal(await guard.isPublicHttpUrl('file:///etc/passwd'), false);
    assert.equal(await guard.isPublicHttpUrl('ftp://example.com/x'), false);
    assert.equal(await guard.isPublicHttpUrl('not a url'), false);
  });

  it('IP 字面量：公网过、私网拒（不碰 DNS）', async () => {
    assert.equal(await guard.isPublicHttpUrl('https://8.8.8.8/x.mp3'), true);
    assert.equal(await guard.isPublicHttpUrl('http://127.0.0.1:8787/api/tracks'), false);
    assert.equal(await guard.isPublicHttpUrl('http://192.168.1.5/x.mp3'), false);
    assert.equal(await guard.isPublicHttpUrl('http://[::1]/x.mp3'), false);
    assert.equal(await guard.isPublicHttpUrl('http://169.254.169.254/latest/meta-data'), false);
  });

  it('域名解析失败按拒绝处理', async () => {
    // .invalid 是保留 TLD，必然 NXDOMAIN，不依赖真实网络状况
    assert.equal(await guard.isPublicHttpUrl('http://nonexistent.invalid/x.mp3'), false);
  });

  it('assertPublicHttpUrl：私网抛错且文案说得出所以然', async () => {
    await assert.rejects(
      guard.assertPublicHttpUrl('http://127.0.0.1/x'),
      (error: Error) => {
        assert.match(error.message, /地址被拒绝/);
        assert.match(error.message, /LIBRARY_BLOCK_PRIVATE_NET/);
        return true;
      },
    );
    // 公网 IP 字面量静默放行
    await guard.assertPublicHttpUrl('https://8.8.8.8/x.mp3');
  });
});

describe('曲库条目过滤', () => {
  const item = (url: string, lrcUrl: string | null = null) => ({
    providerId: 'p',
    itemId: url,
    title: '歌',
    artist: null,
    durationSec: null,
    kind: 'audio' as const,
    url,
    lrcUrl,
    sizeBytes: null,
  });

  it('私网 url / lrcUrl 的条目被滤掉，公网保留', async () => {
    const kept = await filterPrivateItems([
      item('http://8.8.8.8/a.mp3'),
      item('http://127.0.0.1/a.mp3'),
      item('http://192.168.1.5/a.mp3'),
      item('http://8.8.8.8/b.mp3', 'http://10.0.0.1/b.lrc'),
    ]);
    assert.deepEqual(
      kept.map((one) => one.url),
      ['http://8.8.8.8/a.mp3'],
    );
  });

  it('空清单原样返回，不炸', async () => {
    assert.deepEqual(await filterPrivateItems([]), []);
  });
});
