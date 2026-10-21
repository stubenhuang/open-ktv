//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

/**
 * 语言切换的浏览器级烟测（不跑完整 e2e，只验「渲染 + 切语言 + <html lang>」）。
 *
 * 用 headless Chrome 起服务端 build 产物，然后：
 *   1. 首屏是简体中文，`<html lang="zh-CN">`；
 *   2. 切到 English 之后导航栏变成英文，`<html lang="en">`；
 *   3. `?lang=en` 直接打开也是英文；
 *   4. localStorage 记住选择（刷新后仍是英文）。
 *
 * 用法：先 `npm run build`，再 `node scripts/smoke-i18n.mjs`。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Node ≥ 22 自带全局 WebSocket，不需要第三方依赖（与 scripts/e2e-browser.mjs 同一套做法）

const PORT = Number(process.env.SMOKE_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
/**
 * Chrome 可执行文件：`CHROME_BIN` > 平台常见位置。
 *
 * 不引依赖、不硬编码单一位置 —— macOS 开发机与 CI 的 ubuntu-latest 镜像
 * （自带 google-chrome-stable）都能跑。
 */
function resolveChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}
const DEBUG_PORT = Number(process.env.SMOKE_CDP_PORT ?? 9444);

let nextId = 1;
const pending = new Map();

function send(ws, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression) {
  const result = await send(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`页面里求值失败：${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result.value;
}

async function main() {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openktv-smoke-'));
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), HOST: '127.0.0.1', LAN_HTTPS: '0' },
    stdio: 'ignore',
  });
  const CHROME = resolveChrome();
  if (!CHROME) {
    console.error('找不到 Chrome：设 CHROME_BIN 指过去，或装一个 Chrome / Chromium。');
    process.exitCode = 1;
    return;
  }
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--user-data-dir=' + (await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openktv-chrome-'))),
    'about:blank',
  ]);

  const cleanup = async () => {
    chrome.kill('SIGKILL');
    server.kill('SIGKILL');
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  };

  try {
    // 等服务起来
    for (let i = 0; i < 40; i += 1) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    // 等 CDP 端口
    let target = null;
    for (let i = 0; i < 40; i += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
        if (target) break;
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!target) throw new Error('拿不到 Chrome 的 CDP 目标');

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连不上')), { once: true });
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
    const ws = {
      send: (payload) => socket.send(payload),
      close: () => socket.close(),
    };
    await send(ws, 'Runtime.enable');
    await send(ws, 'Page.enable');

    const navText = () =>
      evaluate(ws, `document.querySelector('.app-nav-links')?.innerText.replace(/\\s+/g,' ').trim() ?? ''`);
    const htmlLang = () => evaluate(ws, 'document.documentElement.lang');
    const title = () => evaluate(ws, 'document.title');

    const problems = [];
    const check = (label, actual, expected) => {
      const ok = actual === expected;
      console.log(`${ok ? '✔' : '✖'} ${label}: ${JSON.stringify(actual)}`);
      if (!ok) problems.push(`${label} —— 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
    };

    /* 1. 首屏：简体中文 */
    await send(ws, 'Page.navigate', { url: `${BASE}/` });
    await new Promise((r) => setTimeout(r, 900));
    check('首屏 <html lang>', await htmlLang(), 'zh-CN');
    check('首屏导航栏', await navText(), '伴奏库 点歌台 我的作品');
    check('首屏标题', await title(), 'Open KTV');

    /* 2. 切到 English */
    await evaluate(ws, `
      const select = document.querySelector('.lang-switcher-select');
      select.value = 'en';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      'ok'
    `);
    await new Promise((r) => setTimeout(r, 400));
    check('切英文后 <html lang>', await htmlLang(), 'en');
    check('切英文后导航栏', await navText(), 'Library Discover My works');

    /* 3. localStorage 记住了：刷新还是英文 */
    await send(ws, 'Page.navigate', { url: `${BASE}/` });
    await new Promise((r) => setTimeout(r, 900));
    check('刷新后 <html lang>', await htmlLang(), 'en');
    check('刷新后导航栏', await navText(), 'Library Discover My works');

    /* 4. ?lang=zh-CN 覆盖 localStorage */
    await send(ws, 'Page.navigate', { url: `${BASE}/?lang=zh-CN` });
    await new Promise((r) => setTimeout(r, 900));
    check('?lang=zh-CN 的 <html lang>', await htmlLang(), 'zh-CN');
    check('?lang=zh-CN 的导航栏', await navText(), '伴奏库 点歌台 我的作品');

    /* 5. 语言选择器里两种语言都在 */
    const options = await evaluate(
      ws,
      `[...document.querySelectorAll('.lang-switcher-select option')].map((o) => o.value + ':' + o.textContent).join(' | ')`,
    );
    check('语言选项', options, 'zh-CN:简体中文 | en:English');

    if (problems.length > 0) {
      console.error(`\n烟测没过（${problems.length} 处）：`);
      for (const p of problems) console.error(`  ✗ ${p}`);
      process.exitCode = 1;
      return;
    }
    console.log('\n语言切换烟测全过。');
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
