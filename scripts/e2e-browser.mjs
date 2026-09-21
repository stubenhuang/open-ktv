#!/usr/bin/env node
/**
 * 浏览器端端到端验证（Chrome DevTools Protocol）。
 *
 * 这是唯一能真正验证「耳返 + 采集 + 对齐 + 上传 + 合成」这条链路的方式 ——
 * 那些代码跑在浏览器里，node:test 碰不到。
 *
 * 用 Chrome 的假麦克风（--use-fake-device-for-media-stream）代替真人开嗓。
 *
 * 用法：
 *   1. 另开一个终端跑 npm run dev
 *   2. npm run test:e2e
 *
 * 环境变量：
 *   BASE_URL  默认 http://127.0.0.1:5173
 *   HEADLESS  默认 1；设 0 可以看着它自己点（调试很好用）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const HEADLESS = process.env.HEADLESS !== '0';
const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9333);
const CHROME_BIN =
  process.env.CHROME_BIN ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const step = (message) => console.log(`\u001b[36m▶\u001b[0m ${message}`);
const pass = (message) => console.log(`\u001b[32m✔\u001b[0m ${message}`);
const note = (message) => console.log(`  \u001b[2m${message}\u001b[0m`);
const fail = (message) => console.log(`\u001b[31m✖\u001b[0m ${message}`);

/** 喂给 Chrome 当麦克风用的恒定振幅正弦波（路径要在启动 Chrome 之前就定好） */
let FAKE_MIC_TONE = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* --------------------------------- CDP 客户端 -------------------------------- */

function createClient(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const eventHandlers = [];

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of eventHandlers) handler(message);
    }
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
  });

  return {
    ready,
    onEvent(handler) {
      eventHandlers.push(handler);
    },
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(client, expression, label = 'eval') {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const text =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      '未知异常';
    throw new Error(`${label} 抛异常：${text}`);
  }
  return result.result.value;
}

async function waitFor(client, expression, { timeoutMs = 30_000, intervalMs = 250, label = '' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(client, expression, label);
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label || expression}`);
}

/* ---------------------------------- 主流程 ---------------------------------- */

const consoleErrors = [];
let chrome;
let chromeProfileDir;
let client;

async function launchChrome() {
  chromeProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-ktv-cdp-'));
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${chromeProfileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    // Chrome 自己的沙箱在容器/受限环境里会让渲染进程直接崩（Inspector.targetCrashed），
    // 这台机器上必须关掉；同时把向外上报崩溃也一起关掉。
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--no-crash-upload',
    // 假麦克风：不弹权限框，且有一个稳定的音频输入
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    // 用「恒定振幅的正弦波」当麦克风输入，而不是 Chrome 默认的滴滴声。
    // 只有输入是恒定振幅，录制结果里的任何起伏才能被判定成掉音/门限截断。
    `--use-file-for-fake-audio-capture=${FAKE_MIC_TONE}`,
    // 无头环境下没有音频输出设备，必须放开自动播放限制，否则 AudioContext 起不来
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
  ];
  if (HEADLESS) args.push('--headless=new');

  chrome = spawn(CHROME_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.setEncoding('utf8');
  chrome.stderr.on('data', () => {
    /* Chrome 在 macOS 上会刷一堆 crashpad 噪音，忽略 */
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (response.ok) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error('Chrome 调试端口没起来');
}

async function openPage(url) {
  const response = await fetch(
    `http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  );
  if (!response.ok) throw new Error(`创建标签页失败：HTTP ${response.status}`);
  const target = await response.json();
  const page = createClient(target.webSocketDebuggerUrl);
  await page.ready;

  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Log.enable');
  await page.send('DOM.enable');

  page.onEvent((message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      consoleErrors.push(
        `未捕获异常：${details.exception?.description ?? details.text ?? '未知'}`,
      );
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const text = message.params.args
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(' ');
      consoleErrors.push(`console.error：${text}`);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      const text = message.params.entry.text;
      // favicon 之类的静态资源 404 不算应用缺陷
      if (!/favicon/i.test(text)) consoleErrors.push(`日志错误：${text}`);
    }
    if (message.method === 'Inspector.targetCrashed') {
      consoleErrors.push('渲染进程崩溃（Inspector.targetCrashed）');
    }
  });

  return page;
}

async function runFfmpeg(args, label) {
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    ffmpeg.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} 失败，退出码 ${code}`)),
    );
  });
}

async function makeTestAudio() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-ktv-audio-'));
  // 文件名刻意不带 " - "：那会被解析成「歌手 - 歌名」，测试断言会变绕
  const file = path.join(dir, 'CDP端到端测试伴奏.mp3');

  await runFfmpeg(
    [
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=6',
      '-af',
      'volume=12dB',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '192k',
      file,
    ],
    '生成测试伴奏',
  );

  return file;
}

/**
 * 给 Chrome 当麦克风用的恒定振幅正弦波。
 * 恒定振幅是关键：录制结果里任何「某一段突然变小/变没」都只能来自采集链路。
 */
async function makeFakeMicTone() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-ktv-mic-'));
  const file = path.join(dir, 'fake-mic-tone.wav');

  await runFfmpeg(
    [
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=10',
      '-af',
      'volume=18dB',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      file,
    ],
    '生成假麦克风测试音',
  );

  return file;
}

/** 造一个 mkv（浏览器放不了，必须走服务端转码）—— 验证视频伴奏这条路 */
async function makeTestVideo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-ktv-video-'));
  const file = path.join(dir, 'CDP端到端测试视频伴奏.mkv');

  await runFfmpeg(
    [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=15:duration=8',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:sample_rate=48000:duration=8',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-shortest',
      file,
    ],
    '生成测试视频伴奏',
  );

  return file;
}

/** 按可见文字点按钮 */
const clickByText = (text) => `(() => {
  const nodes = [...document.querySelectorAll('button, a')];
  const hit = nodes.find((node) => node.textContent.trim().includes(${JSON.stringify(text)}));
  if (!hit) return false;
  hit.click();
  return true;
})()`;

/** 测试数据的标题前缀 —— 每次跑之前和跑完之后都按它清理，保证可重复执行 */
const TEST_PREFIX = '端到端测试';

/**
 * 把上次没跑完留下的测试数据清干净。
 * 顺序不能反：被作品引用的伴奏服务端会拒绝删除（409）。
 */
async function purgeStaleTestData(page) {
  return evaluate(
    page,
    `(async () => {
      let removedWorks = 0;
      let removedTracks = 0;

      for (const work of await (await fetch('/api/works')).json()) {
        if (!work.title.includes(${JSON.stringify(TEST_PREFIX)})) continue;
        const response = await fetch('/api/works/' + work.id, { method: 'DELETE' });
        if (response.ok) removedWorks += 1;
      }

      for (const track of await (await fetch('/api/tracks')).json()) {
        if (!track.title.includes(${JSON.stringify(TEST_PREFIX)})) continue;
        const response = await fetch('/api/tracks/' + track.id, { method: 'DELETE' });
        if (response.ok) removedTracks += 1;
      }

      return { removedWorks, removedTracks };
    })()`,
    '清理旧测试数据',
  );
}

/**
 * 通过页面上的文件选择框上传，并返回这次**新增**的伴奏记录。
 *
 * 关键是不能靠「找到同名条目」来判断 —— 上次跑失败的残留会撞名，
 * 结果测试拿着旧记录跑，新上传的那条反而被漏掉。这里改成对比上传前后的 id 集合。
 */
async function uploadViaFileInput(page, filePath) {
  const before = await evaluate(
    page,
    `(async () => (await (await fetch('/api/tracks')).json()).map((t) => t.id))()`,
    '读取上传前的伴奏 id',
  );

  // 伴奏列表异步加载完会重渲染，可能让刚才拿到的 node id 失效
  // （CDP 报 "Could not find node with given id"）—— 重取几次即可
  let attached = false;
  let lastError = null;
  for (let attempt = 0; attempt < 3 && !attached; attempt += 1) {
    try {
      const { root } = await page.send('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await page.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: 'input[type=file]',
      });
      if (!nodeId) throw new Error('页面上找不到文件选择框');
      await page.send('DOM.setFileInputFiles', { nodeId, files: [filePath] });
      attached = true;
    } catch (err) {
      lastError = err;
      await sleep(300);
    }
  }
  if (!attached) throw lastError instanceof Error ? lastError : new Error('挂文件到输入框失败');

  const beforeJson = JSON.stringify(before);
  await waitFor(
    page,
    `(async () => {
      const before = new Set(${beforeJson});
      const list = await (await fetch('/api/tracks')).json();
      const fresh = list.find((t) => !before.has(t.id));
      if (!fresh) return false;
      if (fresh.status === 'failed') return 'failed:' + (fresh.error || '未知原因');
      return fresh.status === 'ready' ? fresh : false;
    })()`,
    { timeoutMs: 120_000, label: `上传并等待就绪：${path.basename(filePath)}` },
  );

  const created = await evaluate(
    page,
    `(async () => {
      const before = new Set(${beforeJson});
      const list = await (await fetch('/api/tracks')).json();
      return list.find((t) => !before.has(t.id)) ?? null;
    })()`,
    '读取新伴奏记录',
  );

  if (!created) throw new Error('上传之后没找到新增的伴奏记录');
  if (created.status !== 'ready') {
    throw new Error(`伴奏没能就绪：status=${created.status}，error=${created.error}`);
  }
  return created;
}

async function main() {
  step(`启动 Chrome（${HEADLESS ? '无头' : '有头'}）`);
  FAKE_MIC_TONE = await makeFakeMicTone();
  await launchChrome();

  const audioFile = await makeTestAudio();
  step(`生成测试伴奏：${path.basename(audioFile)}`);

  const page = await openPage(`${BASE_URL}/`);
  client = page;
  await waitFor(page, `document.body.innerText.includes('伴奏库')`, {
    label: '伴奏库页面渲染',
  });
  pass('伴奏库页面渲染正常');

  const purged = await purgeStaleTestData(page);
  if (purged.removedWorks || purged.removedTracks) {
    note(`清掉了上次残留：作品 ${purged.removedWorks} 个、伴奏 ${purged.removedTracks} 个`);
    await page.send('Page.reload');
    await waitFor(page, `document.body.innerText.includes('伴奏库')`, {
      label: '伴奏库重新渲染',
    });
  }

  /* ------------------------------ 1. 上传伴奏 ------------------------------ */
  step('通过文件选择框上传伴奏');
  // 等伴奏列表加载完再上传：加载中的重渲染会让文件输入框的 CDP node id 失效
  await waitFor(page, `!document.body.innerText.includes('正在加载')`, {
    timeoutMs: 30_000,
    label: '伴奏库加载完成',
  });
  const audioTrack = await uploadViaFileInput(page, audioFile);
  const trackId = audioTrack.id;
  pass(`上传走通了：${audioTrack.title}（${trackId}）`);

  /* ------------------------------ 2. 演唱录音 ------------------------------ */
  step('进入演唱页，等麦克风就绪');

  await page.send('Page.navigate', { url: `${BASE_URL}/sing/${trackId}` });
  await waitFor(page, `document.body.innerText.includes('开始演唱')`, {
    label: '演唱页渲染',
  });

  // 假麦克风会自动授权，等 audio worklet 真正接上
  await waitFor(page, `!document.querySelector('button.btn-primary.btn-lg')?.disabled`, {
    timeoutMs: 30_000,
    label: '「开始演唱」按钮可用（说明麦克风已接入）',
  });
  pass('麦克风已接入，实时音量条在跑');

  const levelMoving = await evaluate(
    page,
    `(async () => {
      const fill = document.querySelector('.meter-fill');
      if (!fill) return false;
      let max = 0;
      for (let i = 0; i < 40; i += 1) {
        max = Math.max(max, parseFloat(fill.style.width) || 0);
        await new Promise((r) => setTimeout(r, 50));
      }
      return max;
    })()`,
    '读取音量条',
  );
  if (!(levelMoving > 0)) {
    throw new Error(`音量条一直没动（宽度最大 ${levelMoving}%），说明采集链路没通`);
  }
  pass(`音量条有反应（峰值宽度 ${levelMoving.toFixed(1)}%）`);

  step('点「开始演唱」，录 3 秒');
  const started = await evaluate(page, clickByText('开始演唱'), '点开始演唱');
  if (!started) throw new Error('找不到「开始演唱」按钮');

  await waitFor(page, `document.body.innerText.includes('录音中')`, {
    timeoutMs: 15_000,
    label: '进入录音状态',
  });
  pass('已经进入录音状态，伴奏在播');

  await sleep(3000);

  step('点「结束演唱」，等合成');
  const stopped = await evaluate(page, clickByText('结束演唱'), '点结束演唱');
  if (!stopped) throw new Error('找不到「结束演唱」按钮');

  await waitFor(page, `location.pathname.startsWith('/works/')`, {
    timeoutMs: 60_000,
    label: '跳转到作品详情页',
  });
  const workId = await evaluate(page, `location.pathname.split('/').pop()`, '读作品 id');
  pass(`已跳转到 /works/${workId}`);

  /* ------------------------------ 3. 作品与重混 ----------------------------- */
  step('等成品 MP3 合成完成');
  await waitFor(page, `document.body.innerText.includes('已就绪')`, {
    timeoutMs: 90_000,
    label: '作品就绪',
  });

  const audioInfo = await evaluate(
    page,
    `(async () => {
      const el = document.querySelector('audio');
      if (!el) return { ok: false, why: '页面上没有 audio 元素' };
      const response = await fetch(el.src);
      return {
        ok: response.ok,
        type: response.headers.get('content-type'),
        bytes: (await response.arrayBuffer()).byteLength,
        src: el.src,
      };
    })()`,
    '校验成品 MP3',
  );
  if (!audioInfo.ok || !audioInfo.type?.includes('audio/mpeg') || audioInfo.bytes < 1000) {
    throw new Error(`成品 MP3 不对：${JSON.stringify(audioInfo)}`);
  }
  pass(`成品 MP3 可播放（${audioInfo.type}，${audioInfo.bytes} 字节）`);

  step('改人声音量 + 换混响，点「重新生成」');
  const applied = await evaluate(
    page,
    `(async () => {
      const sliders = [...document.querySelectorAll('.mix-panel input[type=range]')];
      if (sliders.length < 1) return '找不到滑块';
      const slider = sliders[0];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(slider, '0.5');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));

      const hall = [...document.querySelectorAll('.reverb-option')].find((b) => b.textContent.includes('大厅'));
      if (hall) hall.click();
      await new Promise((r) => setTimeout(r, 120));

      const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('重新生成'));
      if (!button || button.disabled) return '重新生成按钮不可用';
      button.click();
      return 'ok';
    })()`,
    '改参数并重新生成',
  );
  if (applied !== 'ok') throw new Error(`重新生成没触发：${applied}`);

  await waitFor(page, `document.body.innerText.includes('正在合成')`, {
    timeoutMs: 20_000,
    label: '进入合成中',
  });
  await waitFor(page, `document.body.innerText.includes('已就绪')`, {
    timeoutMs: 90_000,
    label: '重混完成',
  });

  const params = await evaluate(
    page,
    `(async () => {
      const id = location.pathname.split('/').pop();
      const work = await (await fetch('/api/works/' + id)).json();
      return work.mixParams;
    })()`,
    '核对混音参数',
  );
  if (params.reverb !== 'hall' || Math.abs(params.vocalGain - 0.5) > 0.001) {
    throw new Error(`混音参数没生效：${JSON.stringify(params)}`);
  }
  pass(`重混成功，参数已落库：${JSON.stringify(params)}`);

  /* ------------------------------ 3.4 实时试听 ------------------------------ */
  step('实时试听：点播放 + 拖滑块，不点「重新生成」也立即生效');

  const previewStart = await evaluate(
    page,
    `(async () => {
      const button = document.querySelector('.preview-transport button');
      if (!button || button.disabled) return '试听按钮不可用';
      button.click();
      return 'ok';
    })()`,
    '点「试听」',
  );
  if (previewStart !== 'ok') throw new Error(`实时试听没启动：${previewStart}`);

  // 引擎要现场解码干声 + 伴奏，起播后按钮才会翻成「暂停」
  await waitFor(
    page,
    `(() => { const b = document.querySelector('.preview-transport button'); return b && b.textContent.includes('暂停'); })()`,
    { timeoutMs: 60_000, label: '预览进入播放中' },
  );
  pass('实时试听已起播（浏览器内 Web Audio 混音，无 ffmpeg 参与）');

  // 测试曲只有 3 秒，趁还在播立刻拖滑块：不点「重新生成」，参数实时送进引擎，
  // 播放不中断、无报错
  const liveTweak = await evaluate(
    page,
    `(async () => {
      const sliders = [...document.querySelectorAll('.mix-panel input[type=range]')];
      if (sliders.length < 1) return '找不到滑块';
      const slider = sliders[0];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(slider, '1.5');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 800));
      const button = document.querySelector('.preview-transport button');
      return button && button.textContent.includes('暂停') ? 'ok' : '播放被参数改动打断了';
    })()`,
    '拖动滑块不断播',
  );
  if (liveTweak !== 'ok') throw new Error(`实时试听被参数改动打断：${liveTweak}`);
  pass('参数改动实时生效，播放不中断（未触发任何重新生成请求）');

  const previewTime = await evaluate(
    page,
    `(() => { const t = document.querySelector('.preview-time'); return t ? t.textContent.trim() : null; })()`,
    '读预览进度',
  );
  note(`预览进度：${previewTime}`);
  if (previewTime && previewTime.startsWith('00:00')) {
    // 不判失败：个别无头环境没有音频时钟，currentTime 不推进
    note('预览进度仍是 00:00（无头环境可能没有音频时钟），仅作提醒');
  }

  await evaluate(
    page,
    `(() => { const b = document.querySelector('.preview-transport button'); if (b && b.textContent.includes('暂停')) b.click(); return true; })()`,
    '暂停预览',
  );

  /* ------------------- 3.5 干声是否连续（掉音检测） ------------------- */
  step('解码干声 WAV，检查包络是否连续（掉音会在这里露出来）');

  const vocal = await evaluate(
    page,
    `(async () => {
      const id = location.pathname.split('/').pop();
      const response = await fetch('/api/works/' + id + '/vocal');
      const bytes = await response.arrayBuffer();
      const ctx = new AudioContext();
      const decoded = await ctx.decodeAudioData(bytes);
      const data = decoded.getChannelData(0);
      const sampleRate = decoded.sampleRate;

      let sumSquares = 0;
      let peak = 0;
      for (let i = 0; i < data.length; i += 1) {
        sumSquares += data[i] * data[i];
        const value = Math.abs(data[i]);
        if (value > peak) peak = value;
      }

      // 按 50ms 一窗算 RMS。输入是恒定振幅正弦波，所以理想的包络应该是一条平线：
      // 任何一个窗口明显掉下去，就说明这一段音频被吞了或被人声门限截断了。
      const windowSize = Math.max(1, Math.floor(sampleRate * 0.05));
      const envelopes = [];
      for (let start = 0; start + windowSize <= data.length; start += windowSize) {
        let sum = 0;
        for (let i = start; i < start + windowSize; i += 1) sum += data[i] * data[i];
        envelopes.push(Math.sqrt(sum / windowSize));
      }

      const sorted = [...envelopes].sort((a, b) => a - b);
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      const max = sorted.length ? sorted[sorted.length - 1] : 0;
      const min = sorted.length ? sorted[0] : 0;
      // 「掉音窗口」：低于中位数 30%
      const dropouts = envelopes.filter((value) => value < median * 0.3).length;
      // 低于中位数 60% 的「发虚窗口」
      const weak = envelopes.filter((value) => value < median * 0.6).length;

      await ctx.close();
      return {
        duration: decoded.duration,
        sampleRate,
        channels: decoded.numberOfChannels,
        rms: Math.sqrt(sumSquares / Math.max(1, data.length)),
        peak,
        windows: envelopes.length,
        median,
        min,
        max,
        dropouts,
        weak,
        // 最小的那一段占中位数的比例，越接近 1 越连续
        minRatio: median > 0 ? min / median : 0,
        dropoutRatio: envelopes.length ? dropouts / envelopes.length : 0,
      };
    })()`,
    '解码并分析干声',
  );

  note(
    `时长 ${vocal.duration.toFixed(2)}s / ${vocal.sampleRate}Hz / ${vocal.channels} 声道 / ` +
      `rms=${vocal.rms.toFixed(4)} peak=${vocal.peak.toFixed(3)}`,
  );
  note(
    `包络：${vocal.windows} 个 50ms 窗，最低 ${vocal.min.toFixed(4)}、中位 ${vocal.median.toFixed(4)}、` +
      `最高 ${vocal.max.toFixed(4)} → 最低/中位=${vocal.minRatio.toFixed(3)}`,
  );
  note(`掉音窗口 ${vocal.dropouts} 个（${(vocal.dropoutRatio * 100).toFixed(1)}%），发虚窗口 ${vocal.weak} 个`);

  if (!(vocal.duration > 2.5)) {
    throw new Error(`干声时长不对：${vocal.duration}s（应该接近录制的 3 秒）`);
  }
  if (!(vocal.rms > 0.0005)) {
    throw new Error(`干声几乎是静音（rms=${vocal.rms}），采集链路没真正录音`);
  }
  // 关键回归点：喂进去的是接近满幅的恒定正弦波，
  // 如果录回来只有 0.1 左右，说明浏览器的降噪/回声消除又在削人声了（实测会削 18dB）。
  if (!(vocal.peak > 0.5)) {
    throw new Error(
      `干声电平被压得太狠：峰值只有 ${vocal.peak.toFixed(3)}，` +
        '但输入是接近满幅的恒定正弦波（-0.06 dBFS）。' +
        '说明浏览器自带的音频处理（回声消除/降噪）没有被关掉，歌声会被当成噪声削掉。',
    );
  }
  // 输入是恒定振幅，包络本该是平线。留一点余量给设备起停和浏览器重采样。
  if (vocal.dropoutRatio > 0.02) {
    throw new Error(
      `录音断断续续：${vocal.windows} 个窗口里有 ${vocal.dropouts} 个掉音` +
        `（${(vocal.dropoutRatio * 100).toFixed(1)}%），最低/中位=${vocal.minRatio.toFixed(3)}。` +
        '输入是恒定振幅正弦波，正常应该接近 1.0。',
    );
  }
  if (vocal.minRatio < 0.5) {
    throw new Error(
      `录音有严重的电平起伏：最低窗口只有中位的 ${(vocal.minRatio * 100).toFixed(0)}%` +
        '（恒定振幅输入下不该出现）。',
    );
  }
  pass(
    `干声连续且电平原样：峰值 ${vocal.peak.toFixed(3)}，最低/中位=${vocal.minRatio.toFixed(3)}，` +
      `掉音窗口 ${vocal.dropouts}/${vocal.windows}`,
  );

  /* ----------------------------- 4. 视频伴奏链路 ---------------------------- */
  step('上传 mkv 视频伴奏，验证转码 + 画面播放');

  const videoFile = await makeTestVideo();
  // 先回到有文件选择框的页面
  await page.send('Page.navigate', { url: `${BASE_URL}/` });
  await waitFor(page, `document.querySelector('input[type=file]') !== null`, {
    label: '伴奏库文件选择框',
  });

  const videoTrack = await uploadViaFileInput(page, videoFile);
  pass(`mkv 自动转码完成：${videoTrack.title}（${videoTrack.id}）`);

  const videoTrackId = videoTrack;
  if (videoTrackId.kind !== 'video') {
    throw new Error(`视频伴奏分类不对：${JSON.stringify(videoTrackId)}`);
  }
  if (videoTrackId.proxyKind !== 'video') {
    throw new Error(`mkv 应该被转码成 mp4 代理，实际 proxyKind=${videoTrackId.proxyKind}`);
  }
  pass(`分类正确：kind=video，proxyKind=${videoTrackId.proxyKind}`);

  await page.send('Page.navigate', { url: `${BASE_URL}/sing/${videoTrackId.id}` });
  await waitFor(page, `document.querySelector('.stage video') !== null`, {
    timeoutMs: 30_000,
    label: '演唱页渲染出 <video>',
  });

  const videoPlayback = await evaluate(
    page,
    `(async () => {
      const video = document.querySelector('.stage video');
      const response = await fetch(video.src);
      const ok = response.ok && (response.headers.get('content-type') || '').includes('video/mp4');
      const bytes = (await response.arrayBuffer()).byteLength;
      // 真的把视频解出来播一下，确认浏览器认这个转码产物
      let canPlay = false;
      try {
        await video.play();
        await new Promise((r) => setTimeout(r, 1200));
        canPlay = video.currentTime > 0.1 && video.videoWidth > 0 && video.videoHeight > 0;
        video.pause();
      } catch (err) {
        canPlay = 'play 失败：' + String(err && err.message);
      }
      return { ok, bytes, canPlay, width: video.videoWidth, height: video.videoHeight };
    })()`,
    '验证视频播放',
  );

  if (!videoPlayback.ok || !(videoPlayback.bytes > 1000)) {
    throw new Error(`视频代理取不到：${JSON.stringify(videoPlayback)}`);
  }
  if (videoPlayback.canPlay !== true) {
    throw new Error(`转码后的视频播不动：${JSON.stringify(videoPlayback)}`);
  }
  pass(
    `转码后的视频能播：${videoPlayback.width}x${videoPlayback.height}，${videoPlayback.bytes} 字节`,
  );

  /* -------------------------------- 5. 收尾 -------------------------------- */
  step('清理测试数据');
  await evaluate(
    page,
    `(async () => {
      // 顺序很重要：先删作品，再删伴奏 —— 被作品引用的伴奏服务端会拒绝删除（409）
      await fetch('/api/works/${workId}', { method: 'DELETE' });
      return true;
    })()`,
    '删除作品',
  );
  // 再按前缀扫一遍，把这次和任何残留的测试伴奏都收干净
  const swept = await purgeStaleTestData(page);
  pass(`已清理测试数据（伴奏 ${swept.removedTracks} 个、作品 ${swept.removedWorks} 个）`);

  const leftovers = await evaluate(
    page,
    `(async () => {
      const tracks = await (await fetch('/api/tracks')).json();
      const works = await (await fetch('/api/works')).json();
      return {
        tracks: tracks.filter((t) => t.title.includes(${JSON.stringify(TEST_PREFIX)})).length,
        works: works.filter((w) => w.title.includes(${JSON.stringify(TEST_PREFIX)})).length,
      };
    })()`,
    '确认没有残留',
  );
  if (leftovers.tracks || leftovers.works) {
    throw new Error(`清理不干净，还剩 ${JSON.stringify(leftovers)}`);
  }
}

async function run() {
  try {
    await main();
    if (consoleErrors.length > 0) {
      console.log('');
      fail(`浏览器控制台有 ${consoleErrors.length} 条报错：`);
      for (const message of consoleErrors.slice(0, 10)) console.log(`   ${message}`);
      process.exitCode = 1;
      return;
    }
    console.log('');
    pass('端到端全部通过，浏览器控制台无报错');
  } catch (error) {
    console.log('');
    fail(error instanceof Error ? error.message : String(error));
    try {
      const diagnostics = await evaluate(
        client,
        `(() => ({
          url: location.href,
          alerts: [...document.querySelectorAll('.alert')].map((n) => n.innerText.trim()),
          startButtonDisabled:
            document.querySelector('button.btn-primary.btn-lg')?.disabled ?? null,
          micSelectOptions: [...document.querySelectorAll('select option')].map((o) => o.textContent),
          bodyText: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 500),
        }))()`,
        '诊断',
      );
      console.log('   页面诊断：');
      console.log(JSON.stringify(diagnostics, null, 2));
    } catch {
      /* 页面可能已经崩了，忽略 */
    }
    if (consoleErrors.length > 0) {
      console.log('   浏览器控制台报错：');
      for (const message of consoleErrors.slice(0, 10)) console.log(`   ${message}`);
    }
    process.exitCode = 1;
  } finally {
    client?.close();
    chrome?.kill('SIGKILL');
    if (chromeProfileDir) {
      await sleep(300);
      fs.rmSync(chromeProfileDir, { recursive: true, force: true });
    }
  }
}

await run();
