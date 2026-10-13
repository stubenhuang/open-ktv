import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createIsolatedDataDir, removeIsolatedDataDir } from './isolated.ts';

// 镜像端口也走「随机空闲端口」：config.ts 在模块加载时读 HTTPS_PORT，
// 而所有业务模块都是动态 import 的，所以在文件顶部设好就来得及。
// 否则测试会去抢真实的 8788，CI 上被占用就直接失败。
process.env.HTTPS_PORT = '0';

/**
 * 手机端入口：地址探测、自签名证书、HTTPS 镜像、二维码。
 *
 * 与 http.test.ts 同一套套路：先设 DATA_DIR 再动态 import —— 静态 import 会在
 * 设 DATA_DIR 之前就把 config.ts 求值掉，证书会签到真实 data/ 里去。
 */
let dataDir = '';
let server: http.Server;
let baseUrl = '';

/** openssl 不在 PATH 时跳过证书相关用例（其余用例照跑） */
let opensslOk = false;

before(async () => {
  dataDir = await createIsolatedDataDir('network');
  const { execFile } = await import('node:child_process');
  opensslOk = await new Promise<boolean>((resolve) => {
    execFile('openssl', ['version'], { timeout: 5000 }, (error) => resolve(!error));
  });

  const { createApp } = await import('../server/src/app.ts');
  const { cleanTmpDir } = await import('../server/src/paths.ts');
  cleanTmpDir();

  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  const { stopLanHttpsMirror } = await import('../server/src/lanHttps.ts');
  await stopLanHttpsMirror();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  if (dataDir) await removeIsolatedDataDir(dataDir);
});

/** 走一遍 TLS（自签名证书，关掉校验），返回状态码 / 类型 / 正文 */
function httpsGet(port: number, route: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      `https://127.0.0.1:${port}${route}`,
      { rejectUnauthorized: false },
      (response) => {
        let text = '';
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            type: response.headers['content-type'] ?? '',
            body: text,
          }),
        );
      },
    );
    request.on('error', reject);
  });
}

describe('pickLanAddresses（局域网 IPv4 过滤）', () => {
  it('滤掉回环与 IPv6，保留局域网 IPv4 并去重', async () => {
    const { pickLanAddresses } = await import('../server/src/lan.ts');
    const result = pickLanAddresses({
      lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      en0: [
        { family: 'IPv4', address: '192.168.1.5', internal: false },
        { family: 'IPv6', address: 'fe80::1', internal: false },
      ],
      // 同一个地址出现在两张网卡上只留一份
      en1: [{ family: 'IPv4', address: '192.168.1.5', internal: false }],
      // 老版本 Node 的 family 是数字
      en2: [{ family: 4, address: '10.0.0.7', internal: false }],
    });
    assert.deepEqual(result, ['192.168.1.5', '10.0.0.7']);
  });

  it('空输入 / 全是回环时返回空数组', async () => {
    const { pickLanAddresses } = await import('../server/src/lan.ts');
    assert.deepEqual(pickLanAddresses({}), []);
    assert.deepEqual(
      pickLanAddresses({ lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }),
      [],
    );
  });
});

describe('ensureLanCert（自签名证书）', () => {
  // skip 选项在用例「定义时」求值，那时候 before() 还没跑，
  // 所以 openssl 可用性必须在用例内部判断
  it('首次签发、同址复用、换址重签', async (t) => {
    if (!opensslOk) {
      t.skip('没有 openssl，跳过证书用例');
      return;
    }
    const { ensureLanCert } = await import('../server/src/lanCert.ts');
    const first = await ensureLanCert(['192.168.1.5']);
    assert.ok(first, '第一次调用必须签出证书');
    assert.match(first.key, /BEGIN (RSA )?PRIVATE KEY/);
    assert.match(first.cert, /BEGIN CERTIFICATE/);
    assert.deepEqual(first.addresses, ['192.168.1.5']);

    // 文件落在隔离 DATA_DIR 的 certs/ 下，不碰真实数据
    const certFile = path.join(dataDir, 'certs', 'lan-cert.pem');
    assert.ok(fs.existsSync(certFile));

    // 同一地址二次调用：复用（证书文件不被重写）
    const before = fs.statSync(certFile).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await ensureLanCert(['192.168.1.5']);
    assert.ok(second);
    assert.equal(second.cert, first.cert, '地址没变就该复用同一份证书');
    assert.equal(fs.statSync(certFile).mtimeMs, before, '复用不应重写证书文件');

    // 地址变了：重签，SAN 覆盖新地址（手机换网段 / 换网卡的场景）
    const third = await ensureLanCert(['192.168.1.6']);
    assert.ok(third);
    assert.notEqual(third.cert, first.cert, '局域网地址变了必须重签');
    assert.deepEqual(third.addresses, ['192.168.1.6']);
    const { execFile } = await import('node:child_process');
    const text = await new Promise<string>((resolve, reject) => {
      execFile('openssl', ['x509', '-in', certFile, '-noout', '-text'], (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      );
    });
    assert.match(text, /192\.168\.1\.6/, '新证书的 SAN 要覆盖新地址');
    assert.match(text, /127\.0\.0\.1/, 'SAN 也要覆盖回环（桌面自测用）');

    // 证书下载端点能把它发出来（iPhone 想彻底信任时装它）
    const response = await fetch(`${baseUrl}/api/network/cert.crt`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /x-x509-ca-cert/);
    assert.match(await response.text(), /BEGIN CERTIFICATE/);
  });
});

describe('GET /api/network', () => {
  it('形状与字段自洽', async () => {
    const info = (await (await fetch(`${baseUrl}/api/network`)).json()) as {
      lanAddresses: string[];
      mobilePath: string;
      mobileOrigin: { scheme: string; port: number } | null;
      mobileUrl: string | null;
      mobileUrls: string[];
      selfSigned: boolean;
      micBlocked: boolean;
      reason: string | null;
    };

    assert.ok(Array.isArray(info.lanAddresses));
    assert.equal(info.mobilePath, '/m');
    // 入口有没有都行（CI 上可能没网卡），但有入口时这几个字段必须自洽
    if (info.mobileOrigin && info.lanAddresses.length > 0) {
      assert.ok(info.mobileUrl?.endsWith('/m'));
      assert.equal(info.mobileUrls.length, info.lanAddresses.length);
      assert.equal(info.mobileUrl, info.mobileUrls[0]);
      assert.equal(info.micBlocked, info.mobileOrigin.scheme === 'http');
      assert.equal(info.selfSigned, info.mobileOrigin.scheme === 'https');
      assert.equal(info.reason, null, '入口正常时不该有告警');
    }
  });

  it('镜像没起来时二维码端点 404 并带上原因', async () => {
    const { lanHttpsState, stopLanHttpsMirror } = await import('../server/src/lanHttps.ts');
    await stopLanHttpsMirror();
    assert.equal(lanHttpsState().running, false);
    const response = await fetch(`${baseUrl}/api/network/qr.svg`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: string };
    assert.ok(body.error.length > 0, '404 也要说清楚为什么');
  });
});

describe('手机 HTTPS 镜像', () => {
  it('起镜像后：TLS 能应答、二维码是 SVG、手机端路由有 SPA 兜底', async () => {
    const { startLanHttpsMirror, shouldStartLanHttps, stopLanHttpsMirror } = await import(
      '../server/src/lanHttps.ts'
    );
    if (!shouldStartLanHttps()) {
      // HOST 绑了回环 / 关掉了 LAN_HTTPS：镜像本来就不该起
      return;
    }

    const { createApp } = await import('../server/src/app.ts');
    const state = await startLanHttpsMirror(createApp());
    assert.equal(state.running, true, '镜像应该起得来');
    assert.ok(state.port);
    assert.equal(state.selfSigned, true);

    // 自签名证书：关掉校验，验的是「TLS 通道通 + app 在服务」
    const health = await httpsGet(state.port, '/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true, queue: { active: null, waiting: 0 } });

    // 镜像起来后 /api/network 应该换成 https 入口
    const info = (await (await fetch(`${baseUrl}/api/network`)).json()) as {
      mobileOrigin: { scheme: string; port: number } | null;
      micBlocked: boolean;
      selfSigned: boolean;
      reason: string | null;
    };
    assert.equal(info.mobileOrigin?.scheme, 'https');
    assert.equal(info.mobileOrigin?.port, state.port);
    assert.equal(info.micBlocked, false);
    assert.equal(info.selfSigned, true);
    assert.equal(info.reason, null);

    // 二维码：SVG，且 viewBox 在（页面里要自适应缩放）
    const qr = await fetch(`${baseUrl}/api/network/qr.svg`);
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type') ?? '', /image\/svg\+xml/);
    const svg = await qr.text();
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /viewBox/);

    // SPA 兜底：手机端路由（含二级路径）都要吐 index.html，而不是 404。
    // 前置条件：仓库里构建过前端（web/dist 在 .gitignore 里，CI 上可能没有）
    if (fs.existsSync(path.join(process.cwd(), 'web', 'dist', 'index.html'))) {
      for (const route of ['/m', '/m/sing/whatever']) {
        const page = await httpsGet(state.port, route);
        assert.equal(page.status, 200, `${route} 应该返回 200`);
        assert.match(page.type, /text\/html/);
        assert.match(page.body, /id="root"/, 'SPA 兜底要给前端外壳');
      }
    }

    await stopLanHttpsMirror();
  });
});
