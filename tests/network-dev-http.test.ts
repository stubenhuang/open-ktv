import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createIsolatedDataDir, removeIsolatedDataDir } from './isolated.ts';

/**
 * 开发模式 + VITE_HTTPS=0（逃生开关）。
 *
 * 默认已经开 TLS（见 tests/network-dev.test.ts），这个文件守住另一头：
 * 显式关掉时，入口降级成 http，并且必须如实告诉页面「手机浏览器会禁用麦克风」，
 * 同时给出修复办法。降级可以，骗人不可以。
 */
process.env.KTV_DEV = '1';
process.env.VITE_HTTPS = '0';
process.env.HTTPS_PORT = '0';

let dataDir = '';
let server: http.Server;
let baseUrl = '';

before(async () => {
  dataDir = await createIsolatedDataDir('network-dev-http');
  const { createApp } = await import('../server/src/app.ts');
  const { cleanTmpDir } = await import('../server/src/paths.ts');
  cleanTmpDir();

  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  if (dataDir) await removeIsolatedDataDir(dataDir);
});

describe('开发模式 + VITE_HTTPS=0', () => {
  it('入口降级 http，标记 micBlocked 并说明怎么恢复', async () => {
    const { WEB_PORT } = await import('../server/src/config.ts');
    const info = (await (await fetch(`${baseUrl}/api/network`)).json()) as {
      mobileOrigin: { scheme: string; port: number } | null;
      mobileUrl: string | null;
      selfSigned: boolean;
      micBlocked: boolean;
      reason: string | null;
    };

    assert.deepEqual(info.mobileOrigin, { scheme: 'http', port: WEB_PORT });
    assert.ok(info.mobileUrl?.startsWith(`http://`));
    assert.ok(info.mobileUrl?.endsWith(`:${WEB_PORT}/m`));
    assert.equal(info.micBlocked, true);
    assert.equal(info.selfSigned, false);
    assert.match(info.reason ?? '', /VITE_HTTPS=1/);
  });
});
