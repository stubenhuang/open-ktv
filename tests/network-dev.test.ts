//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createIsolatedDataDir, removeIsolatedDataDir } from './isolated.ts';

/**
 * 开发模式（KTV_DEV=1）下的手机入口。
 *
 * dev.mjs 会给后端子进程打 KTV_DEV=1，服务据此不起 HTTPS 镜像 —— 手机入口
 * 是 Vite 自己（默认也上 TLS，证书与镜像共用 data/certs）。这里验的就是
 * 「默认开启」这条路径：入口必须是 https + Vite 端口。
 *
 * 时序要求与 http.test.ts 相同：环境变量要在动态 import 之前设好，
 * 否则 config.ts 会用默认值求值。
 */
process.env.KTV_DEV = '1';
// 开发模式下不起镜像，但 config.ts 仍会读 HTTPS_PORT，给个随机值避免误伤真实端口
process.env.HTTPS_PORT = '0';
// 没显式设 WEB_PORT 时用默认 5173（config.ts 的默认值）

let dataDir = '';
let server: http.Server;
let baseUrl = '';

before(async () => {
  dataDir = await createIsolatedDataDir('network-dev');
  // 真实 dev 流程里证书是 Vite 的配置阶段签的（vite.config.ts → ensureLanCert），
  // 测试里手动补这一步，才能验到「下载证书」端点
  const { ensureLanCert } = await import('../server/src/lanCert.ts');
  await ensureLanCert();

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

describe('开发模式（默认开 VITE_HTTPS）手机入口', () => {
  it('入口 = https://<局域网IP>:WEB_PORT/m，且不认为麦克风被禁用', async () => {
    const { WEB_PORT } = await import('../server/src/config.ts');
    const info = (await (await fetch(`${baseUrl}/api/network`)).json()) as {
      mobileOrigin: { scheme: string; port: number } | null;
      mobileUrl: string | null;
      mobileUrls: string[];
      selfSigned: boolean;
      micBlocked: boolean;
      reasonCode: string | null;
    };

    assert.deepEqual(info.mobileOrigin, { scheme: 'https', port: WEB_PORT });
    assert.ok(info.mobileUrl?.endsWith(`:${WEB_PORT}/m`));
    assert.ok(info.mobileUrl?.startsWith('https://'));
    assert.equal(info.micBlocked, false, 'https 入口不该标记麦克风被禁用');
    assert.equal(info.selfSigned, true);
    assert.equal(info.reasonCode, null);
    // 二维码能出图（dev 分支不起镜像，直接按 mobileUrl 生成）
    const qr = await fetch(`${baseUrl}/api/network/qr.svg`);
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type') ?? '', /image\/svg\+xml/);
    assert.match(await qr.text(), /^<svg /);
  });

  it('证书下载端点指向同一份自签名证书', async () => {
    const response = await fetch(`${baseUrl}/api/network/cert.crt`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /x-x509-ca-cert/);
  });
});
