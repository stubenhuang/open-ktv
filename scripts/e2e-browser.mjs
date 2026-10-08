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

/** 造一个 mkv（视频伴奏）—— 现在用它验证「伴奏库不再支持视频」这条拦截 */
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
 *
 * 先删作品再删伴奏：删伴奏本身不再被作品拦截（作品的 track_id 会被置空），
 * 但先删作品才不会留下一堆「伴奏已删除」的孤儿作品。
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

/** 打开伴奏库的上传弹窗（点上传区 → 等 .upload-modal-panel 出现） */
async function openUploadDialog(page) {
  const clicked = await evaluate(
    page,
    `(() => {
      const zone = document.querySelector('.dropzone');
      if (!zone) return '页面上没有上传区';
      zone.click();
      return 'ok';
    })()`,
    '点上传区',
  );
  if (clicked !== 'ok') throw new Error(`打不开上传弹窗：${clicked}`);
  await waitFor(page, `document.querySelector('.upload-modal-panel') !== null`, {
    timeoutMs: 10_000,
    label: '上传弹窗打开',
  });
}

/**
 * 通过上传弹窗选文件并提交，返回这次**新增**的伴奏记录。
 *
 * 伴奏库的上传走二级弹窗（音频必选 + 歌词可选），所以不能直接把文件挂到
 * 页面的 input 上 —— 要先点上传区把弹窗打开，文件选择框在弹窗里。
 *
 * @param page CDP 页面
 * @param audioPath 音频文件路径
 * @param lyricsPath 可选：歌词文件路径（会一起带进弹窗）
 */
async function uploadViaFileInput(page, audioPath, lyricsPath = null) {
  const before = await evaluate(
    page,
    `(async () => (await (await fetch('/api/tracks')).json()).map((t) => t.id))()`,
    '读取上传前的伴奏 id',
  );

  await openUploadDialog(page);

  // 弹窗里有两个文件选择框：[0] 音频、[1] 歌词（各在自己的 .field 里，按序号取）
  const attach = async (index, filePath) => {
    let attached = false;
    let lastError = null;
    for (let attempt = 0; attempt < 3 && !attached; attempt += 1) {
      try {
        const { root } = await page.send('DOM.getDocument', { depth: -1, pierce: true });
        const { nodeIds } = await page.send('DOM.querySelectorAll', {
          nodeId: root.nodeId,
          selector: '.upload-modal-panel input[type=file]',
        });
        const nodeId = nodeIds?.[index];
        if (!nodeId) throw new Error(`弹窗里找不到第 ${index + 1} 个文件选择框`);
        await page.send('DOM.setFileInputFiles', { nodeId, files: [filePath] });
        attached = true;
      } catch (err) {
        lastError = err;
        await sleep(300);
      }
    }
    if (!attached) throw lastError instanceof Error ? lastError : new Error('挂文件到输入框失败');
  };

  await attach(0, audioPath);
  if (lyricsPath) {
    await attach(1, lyricsPath);
  }

  const submitted = await evaluate(
    page,
    `(() => {
      const button = [...document.querySelectorAll('.upload-modal-panel button')]
        .find((b) => b.textContent.trim() === '开始上传');
      if (!button || button.disabled) return '「开始上传」不可用（音频没选上？）';
      button.click();
      return 'ok';
    })()`,
    '点开始上传',
  );
  if (submitted !== 'ok') throw new Error(`上传没触发：${submitted}`);

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
    { timeoutMs: 120_000, label: `上传并等待就绪：${path.basename(audioPath)}` },
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

  // 上传弹窗里一起带上的歌词文件（验证「音频 + 可选歌词」这条路）
  const lrcFile = path.join(path.dirname(audioFile), 'CDP端到端测试歌词.lrc');
  fs.writeFileSync(
    lrcFile,
    ['[00:00.00]弹窗带来的第一句', '[00:01.00]弹窗带来的第二句', '[00:02.00]弹窗带来的第三句'].join(
      '\n',
    ),
    'utf8',
  );

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
  step('通过上传弹窗选音频 + 歌词');
  // 等伴奏列表加载完再上传：加载中的重渲染会让节点的 CDP id 失效
  await waitFor(page, `!document.body.innerText.includes('正在加载')`, {
    timeoutMs: 30_000,
    label: '伴奏库加载完成',
  });
  const audioTrack = await uploadViaFileInput(page, audioFile, lrcFile);
  const trackId = audioTrack.id;
  pass(`上传走通了：${audioTrack.title}（${trackId}）`);

  // 歌词是跟着弹窗一起提交的：上传完成即应入库
  const dialogLyrics = await evaluate(
    page,
    `(async () => {
      const track = await (await fetch('/api/tracks/${trackId}')).json();
      return JSON.stringify({ hasLyrics: track.hasLyrics, lyrics: track.lyrics });
    })()`,
    '核对弹窗上传的歌词',
  );
  const dialogLyricsState = JSON.parse(dialogLyrics);
  if (!dialogLyricsState.hasLyrics || !dialogLyricsState.lyrics.includes('弹窗带来的第一句')) {
    throw new Error(`弹窗里选的歌词没入库：${dialogLyrics}`);
  }
  pass('弹窗里选的 .lrc 跟伴奏一起入库了');

  /* ------------------------------ 1.5 贴歌词 ------------------------------ */
  step('给伴奏贴一份 LRC 歌词');
  const lyricsSaved = await evaluate(
    page,
    `(async () => {
      const lrc = ['[00:00.00]第一句歌词', '[00:01.00]第二句歌词', '[00:02.00]第三句歌词'].join('\\n');
      const response = await fetch('/api/tracks/${trackId}', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lyrics: lrc }),
      });
      if (!response.ok) return 'HTTP ' + response.status;
      const track = await response.json();
      if (!track.hasLyrics) return 'hasLyrics 还是 false';
      return track.lyrics.includes('第一句歌词') ? 'ok' : '歌词内容不对：' + track.lyrics;
    })()`,
    'PATCH 歌词',
  );
  if (lyricsSaved !== 'ok') throw new Error(`歌词没存上：${lyricsSaved}`);
  pass('歌词已入库（经过服务端规范化）');

  // 纯文本歌词必须被拒（不能被静默降级成静态歌词）。
  // 这一步刻意从 Node 发起而不是页面：400 会被 Chrome 记成控制台报错，
  // 而本脚本最后会断言「控制台无报错」——不该让一条预期内的 400 把整轮判失败。
  const plainTextRejected = await fetch(`${BASE_URL}/api/tracks/${trackId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lyrics: '这是一段没有时间戳的歌词' }),
  });
  if (plainTextRejected.status !== 400) {
    throw new Error(`纯文本歌词应返回 400，实际 ${plainTextRejected.status}`);
  }
  pass('纯文本歌词被拒（400），没有静默降级');

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

  // 小窗（待唱状态）歌词字号梯：三档必须严格递减，否则「下一句次大」就看不出来。
  // 注意 t=0 时第一句就已经算「当前行」了（时间是 0，落在第一行的时间窗里）。
  const smallLadder = await evaluate(
    page,
    `(() => {
      const view = document.querySelector('.lyrics-view');
      if (!view) return { error: '没有 .lyrics-view' };
      const size = (selector) => {
        const node = view.querySelector(selector);
        return node ? Number.parseFloat(getComputedStyle(node).fontSize) : null;
      };
      return {
        active: size('.lyric-active'),
        next: size('.lyric-next'),
        plain: size('.lyric-line:not(.lyric-active):not(.lyric-next)'),
      };
    })()`,
    '检查小窗歌词字号梯',
  );
  if (smallLadder.error) throw new Error(smallLadder.error);
  if (!(smallLadder.active > smallLadder.next && smallLadder.next > smallLadder.plain)) {
    throw new Error(
      `小窗字号梯应递减：当前 ${smallLadder.active}px > 下一句 ${smallLadder.next}px > 普通 ${smallLadder.plain}px`,
    );
  }
  pass(
    `小窗歌词字号梯：普通 ${smallLadder.plain}px / 下一句 ${smallLadder.next}px / 当前 ${smallLadder.active}px`,
  );

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

  // 录音中应该进全屏歌词层，完成/取消按钮在右上方
  await waitFor(page, `document.querySelector('.stage-fullscreen') !== null`, {
    timeoutMs: 10_000,
    label: '全屏歌词层出现',
  });
  const fullscreen = await evaluate(
    page,
    `(() => {
      const stage = document.querySelector('.stage-fullscreen');
      const actions = document.querySelector('.stage-fs-actions');
      if (!stage || !actions) return { error: '缺 .stage-fullscreen 或 .stage-fs-actions' };
      const style = getComputedStyle(stage);
      const rect = actions.getBoundingClientRect();
      return {
        position: style.position,
        fixed: style.position === 'fixed',
        coversViewport: stage.getBoundingClientRect().height >= window.innerHeight - 1,
        // 右上方：贴顶、贴右
        topRight: rect.top < 60 && rect.right > window.innerWidth - 40,
        buttons: [...actions.querySelectorAll('button')].map((b) => b.textContent.trim()),
        status: (document.querySelector('.stage-fs-status') || {}).textContent || '',
      };
    })()`,
    '检查全屏歌词层',
  );
  if (fullscreen.error) throw new Error(fullscreen.error);
  if (!fullscreen.fixed) throw new Error(`全屏层不是 fixed 定位：${fullscreen.position}`);
  if (!fullscreen.coversViewport) throw new Error('全屏层没铺满视口');
  if (!fullscreen.topRight) throw new Error('完成/取消按钮不在右上方');
  if (!fullscreen.buttons.includes('完成录制') || !fullscreen.buttons.includes('取消录制')) {
    throw new Error(`右上方按钮不对：${JSON.stringify(fullscreen.buttons)}`);
  }
  if (!fullscreen.status.includes('录音中')) throw new Error(`全屏层没有录音状态：${fullscreen.status}`);
  pass(`全屏歌词层就绪（右上角：${fullscreen.buttons.join(' / ')}）`);

  // 跟唱歌词：三行都要渲染出来，且当前行随伴奏推进（这一探本身也花掉一部分录音时间）
  const lyricsProbe = await evaluate(
    page,
    `(async () => {
      const view = document.querySelector('.lyrics-view');
      if (!view) return JSON.stringify({ error: '没有 .lyrics-view' });
      const lines = [...view.querySelectorAll('.lyric-line')];
      const activeText = () => {
        const active = view.querySelector('.lyric-active');
        return active ? active.textContent.trim() : null;
      };
      const first = activeText();
      await new Promise((r) => setTimeout(r, 1400));
      const second = activeText();
      // 字号梯：当前行 > 下一句 > 普通行（再加一档，和没唱到的行拉开层次）
      const fontSize = (selector) => {
        const node = view.querySelector(selector);
        return node ? Number.parseFloat(getComputedStyle(node).fontSize) : null;
      };
      return JSON.stringify({
        count: lines.length,
        first,
        second,
        hasNext: Boolean(view.querySelector('.lyric-next')),
        active: fontSize('.lyric-active'),
        next: fontSize('.lyric-next'),
        plain: fontSize('.lyric-line:not(.lyric-active):not(.lyric-next):not(.lyric-past)'),
      });
    })()`,
    '检查歌词跟唱',
  );
  const lyricsState = JSON.parse(lyricsProbe);
  if (lyricsState.error) throw new Error(`歌词没渲染：${lyricsProbe}`);
  if (lyricsState.count !== 3) throw new Error(`歌词行数不对：${lyricsProbe}`);
  if (!lyricsState.first || !lyricsState.second) {
    throw new Error(`歌词没有高亮行（滚动/时钟没接上）：${lyricsProbe}`);
  }
  if (lyricsState.first === lyricsState.second) {
    throw new Error(`歌词没有随播放推进：${lyricsProbe}`);
  }
  if (!lyricsState.hasNext) throw new Error('没有「下一句」行（.lyric-next）');
  if (!(lyricsState.active > lyricsState.next)) {
    throw new Error(
      `全屏里当前行应比下一句大：当前 ${lyricsState.active}px、下一句 ${lyricsState.next}px`,
    );
  }
  // 普通行不一定存在（测试歌只有 3 行，唱到第 2 句时第三句就是「下一句」）
  if (lyricsState.plain !== null && !(lyricsState.next > lyricsState.plain)) {
    throw new Error(
      `全屏里下一句应比普通行大：下一句 ${lyricsState.next}px、普通 ${lyricsState.plain}px`,
    );
  }
  pass(
    `歌词跟唱正常：「${lyricsState.first}」→「${lyricsState.second}」，字号梯 ` +
      `${lyricsState.plain ?? '-'}/${lyricsState.next}/${lyricsState.active}px`,
  );

  // 逐字填充：当前行被拆成字符 span，且随播放一个字一个字点亮
  // （采样窗控制在 1.2s 内：测试伴奏只有 6 秒，后面还要留时间点「完成录制」）
  const karaokeProbe = await evaluate(
    page,
    `(async () => {
      const samples = [];
      for (let i = 0; i < 12; i += 1) {
        const active = document.querySelector('.lyric-active');
        const chars = active ? [...active.querySelectorAll('.lyric-char')] : [];
        samples.push({
          text: active ? active.textContent.trim() : null,
          total: chars.length,
          lit: chars.filter((c) => c.classList.contains('is-lit')).length,
        });
        await new Promise((r) => setTimeout(r, 100));
      }
      return JSON.stringify(samples);
    })()`,
    '检查逐字填充',
  );
  const karaoke = JSON.parse(karaokeProbe);
  for (const sample of karaoke) {
    if (sample.text && sample.total > 0) {
      // 有字的行：每个字一个 span（emoji/代理对按码点拆）
      if (sample.total !== [...sample.text].length) {
        throw new Error(`字符 span 数和文本长度不符：${JSON.stringify(sample)}`);
      }
    }
  }
  const byText = new Map();
  for (const sample of karaoke) {
    if (!sample.text || sample.total === 0) continue;
    byText.set(sample.text, Math.max(byText.get(sample.text) ?? 0, sample.lit));
  }
  const progressed = [...byText.entries()].filter(([, lit]) => lit > 0);
  if (progressed.length === 0) {
    throw new Error(`逐字填充没亮过：${karaokeProbe}`);
  }
  pass(
    `逐字填充正常（${progressed.map(([text, lit]) => `「${text}」${lit} 字`).join('，')}）`,
  );

  await sleep(800);

  step('点「完成录制」，等合成');
  const stopped = await evaluate(page, clickByText('完成录制'), '点完成录制');
  if (!stopped) throw new Error('找不到「完成录制」按钮');

  // 收尾（stopRecording 的 flush + 上传）期间全屏层不能消失、按钮要禁用，
  // 否则会被重复点成两次提交。合成很快时页面可能已经跳走，两种情况都放行。
  await waitFor(
    page,
    `(() => {
      if (location.pathname.startsWith('/works/')) return true;
      const btn = document.querySelector('.stage-fs-actions button.btn-primary');
      return Boolean(btn) && btn.disabled;
    })()`,
    { timeoutMs: 20_000, label: '进入收尾态（按钮禁用）或已跳转' },
  );

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

  // 成品 MP3 的播放/下载已挪到作品库列表页，详情页只剩「实时试听 + 混音调整」，
  // 所以这里直接用接口校验成品，不再依赖页面上的 audio 元素
  const audioInfo = await evaluate(
    page,
    `(async () => {
      const response = await fetch('/api/works/${workId}/audio');
      return {
        ok: response.ok,
        type: response.headers.get('content-type'),
        bytes: (await response.arrayBuffer()).byteLength,
      };
    })()`,
    '校验成品 MP3',
  );
  if (!audioInfo.ok || !audioInfo.type?.includes('audio/mpeg') || audioInfo.bytes < 1000) {
    throw new Error(`成品 MP3 不对：${JSON.stringify(audioInfo)}`);
  }
  pass(`成品 MP3 可播放（${audioInfo.type}，${audioInfo.bytes} 字节）`);

  /* --------------------- 3.5 取消录制：原路退回待唱状态 --------------------- */
  step('再唱一次然后取消：验证「取消录制」按钮');
  await page.send('Page.navigate', { url: `${BASE_URL}/sing/${trackId}` });
  // 等按钮渲染出来并且真的可用（麦克风要重新接入，别在 React 挂载前就点）
  await waitFor(
    page,
    `(() => { const b = document.querySelector('button.btn-primary.btn-lg'); return Boolean(b) && !b.disabled; })()`,
    { timeoutMs: 30_000, label: '演唱页就绪（麦克风再次接入）' },
  );
  const restarted = await evaluate(page, clickByText('开始演唱'), '点开始演唱');
  if (!restarted) throw new Error('找不到「开始演唱」按钮');

  await waitFor(page, `document.querySelector('.stage-fullscreen') !== null`, {
    timeoutMs: 15_000,
    label: '再次进入全屏歌词层',
  });
  const cancelled = await evaluate(page, clickByText('取消录制'), '点取消录制');
  if (!cancelled) throw new Error('找不到「取消录制」按钮');

  await waitFor(
    page,
    `document.querySelector('.stage-fullscreen') === null && !document.body.innerText.includes('录音中')`,
    { timeoutMs: 10_000, label: '退出全屏并回到待唱状态' },
  );
  const backToIdle = await evaluate(
    page,
    `(() => ({
      startEnabled: !document.querySelector('button.btn-primary.btn-lg')?.disabled,
      cancelGone: !document.body.innerText.includes('取消录制'),
    }))()`,
    '确认回到待唱状态',
  );
  if (!backToIdle.startEnabled || !backToIdle.cancelGone) {
    throw new Error(`取消后状态不对：${JSON.stringify(backToIdle)}`);
  }
  pass('取消录制后退回待唱状态（开始按钮重新可用）');

  // 后面的混音面板/实时试听都长在作品详情页上，先导航回去
  await page.send('Page.navigate', { url: `${BASE_URL}/works/${workId}` });
  await waitFor(page, `document.querySelector('.mix-group-head') !== null`, {
    timeoutMs: 30_000,
    label: '回到作品详情页',
  });

  /* --------------------- 3.3 编辑页排版：一屏放完 + 分组常驻展开 --------------------- */
  step('编辑页排版：所有元素一屏放完，分组不可折叠');
  // 无头 Chrome 默认视口只有 800px 宽；编辑页按桌面尺寸验，逐个视口高度确认不出滚动条
  const VIEWPORTS = [
    { width: 1440, height: 900, label: '1440x900' },
    { width: 1280, height: 800, label: '1280x800' },
    { width: 1366, height: 768, label: '1366x768' },
    { width: 1024, height: 768, label: '1024x768' },
  ];
  for (const viewport of VIEWPORTS) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(300);
    const editLayout = await evaluate(
      page,
      `(() => {
        const doc = document.documentElement;
        const panel = document.querySelector('.mix-panel');
        const apply = document.querySelector('.mix-apply');
        if (!panel || !apply) return JSON.stringify({ error: '没有 .mix-panel 或 .mix-apply' });

        // 一屏放完：页面本身不允许出现滚动条（横竖都不行）
        const overflowY = doc.scrollHeight - window.innerHeight;
        const overflowX = doc.scrollWidth - window.innerWidth;

        // 分组常驻展开：面板里一个 details/summary 都不该有（修音不能折叠）
        const collapsible = panel.querySelectorAll('details, summary').length;

        // 每个交互控件都要落在视口内（被裁掉的控件等于不存在）
        const offscreen = [...panel.querySelectorAll('input, button')]
          .map((n) => ({ n, rect: n.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width > 0 && (rect.top < 0 || rect.bottom > window.innerHeight + 0.5))
          .map(({ n, rect }) => (n.textContent || n.className).trim().slice(0, 10) + '@' + Math.round(rect.top));

        const applyRect = apply.getBoundingClientRect();
        const groups = [...document.querySelectorAll('.mix-group-head')].map((n) =>
          n.firstElementChild.textContent.trim());
        return JSON.stringify({
          overflowY,
          overflowX,
          collapsible,
          offscreen,
          groups,
          applyInViewport: applyRect.top >= 0 && applyRect.bottom <= window.innerHeight,
          presetCount: panel.querySelectorAll('.option-grid:not(.option-grid-4) .reverb-option').length,
          reverbCount: panel.querySelectorAll('.option-grid-4 .reverb-option').length,
        });
      })()`,
      `检查编辑页排版（${viewport.label}）`,
    );
    const layout = JSON.parse(editLayout);
    if (layout.error) throw new Error(`编辑页排版不对：${layout}`);
    if (layout.overflowY > 1) {
      throw new Error(`${viewport.label} 编辑页出现了纵向滚动条（溢出 ${layout.overflowY}px），不满足「一屏放完」`);
    }
    if (layout.overflowX > 1) {
      throw new Error(`${viewport.label} 编辑页出现了横向滚动条（溢出 ${layout.overflowX}px）`);
    }
    if (layout.collapsible > 0) {
      throw new Error(`混音面板里还有 ${layout.collapsible} 个可折叠元素（修音等分组必须常驻展开）`);
    }
    if (layout.offscreen.length) {
      throw new Error(`${viewport.label} 有控件被挤出视口：${layout.offscreen.join(' / ')}`);
    }
    if (!layout.applyInViewport) throw new Error(`${viewport.label}「合成」按钮不在视口内`);
    if (layout.presetCount !== 10) throw new Error(`预设应有 10 个，实际 ${layout.presetCount}`);
    if (layout.reverbCount !== 8) throw new Error(`混响应有 8 种，实际 ${layout.reverbCount}`);
    pass(
      `${viewport.label}：一屏放完（无滚动条）、预设 ${layout.presetCount} 种 / 混响 ${layout.reverbCount} 种、` +
        `分组 ${layout.groups.join('·')} 全部常驻展开`,
    );
  }
  await page.send('Emulation.clearDeviceMetricsOverride');

  /* ------------- 3.3b 悬停说明：说明文字收进小图标，hover / 聚焦才展开 ------------- */
  step('悬停说明：说明收进 i / ! 小图标，hover 与键盘聚焦都能展开');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(300);

  const hintState = await evaluate(
    page,
    `(() => {
      const icons = [...document.querySelectorAll('.hint-icon')];
      const bubbles = [...document.querySelectorAll('.hint-bubble')];
      // 默认全部收起
      const allHidden = bubbles.every((b) => getComputedStyle(b).visibility === 'hidden');
      // 收起的气泡是绝对定位、照样占布局：伸到视口外会把文档撑出滚动条
      const bubblesInViewport = bubbles.every((b) => {
        const r = b.getBoundingClientRect();
        return r.width === 0 || (r.left >= -0.5 && r.right <= window.innerWidth + 0.5);
      });
      // 读屏不依赖悬停：全文必须在 aria-label 里
      const ariaOk = icons.every((b) => (b.getAttribute('aria-label') || '').length > 8);
      // 图标本身是按钮（可聚焦、触屏可点），且气泡对读屏隐藏
      const markupOk = icons.every((b) => b.tagName === 'BUTTON') &&
        bubbles.every((b) => b.getAttribute('aria-hidden') === 'true');
      // 常驻说明文字确实没了：面板里不该再有成段的 .mix-hint / preview 说明
      const staleText = document.querySelectorAll('.mix-hint').length;
      return JSON.stringify({
        icons: icons.length,
        warns: document.querySelectorAll('.hint-warn').length,
        allHidden,
        bubblesInViewport,
        ariaOk,
        markupOk,
        staleText,
      });
    })()`,
    '检查悬停说明默认状态',
  );
  const hints = JSON.parse(hintState);
  if (hints.icons < 6) throw new Error(`说明图标太少：${hintState}`);
  if (hints.warns < 2) throw new Error(`warn 语气图标应有 2 个（去齿音 / 降噪），实际 ${hints.warns}`);
  if (!hints.allHidden) throw new Error(`有气泡默认就是展开的：${hintState}`);
  if (!hints.bubblesInViewport) throw new Error(`收起的气泡伸到了视口外（会把文档撑出滚动条）：${hintState}`);
  if (!hints.ariaOk) throw new Error(`有图标没带完整 aria-label：${hintState}`);
  if (!hints.markupOk) throw new Error(`图标/气泡的标记不对：${hintState}`);
  if (hints.staleText) throw new Error(`还残留 ${hints.staleText} 处常驻说明文字`);
  pass(`${hints.icons} 个说明图标默认收起、不撑布局，其中 ${hints.warns} 个是 warn 语气`);

  // hover：鼠标移到图标上，气泡要展开且落在视口内
  // （变量名带 hint 前缀：后面视频上传那段也用 root/nodeIds）
  const { root: hintRoot } = await page.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeIds: hintNodeIds } = await page.send('DOM.querySelectorAll', {
    nodeId: hintRoot.nodeId,
    selector: '.mix-panel .hint-icon',
  });
  if (!hintNodeIds?.length) throw new Error('混音面板里找不到说明图标');
  const hintIconBox = await page.send('DOM.getBoxModel', { nodeId: hintNodeIds[0] });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: hintIconBox.model.content[0] + hintIconBox.model.width / 2,
    y: hintIconBox.model.content[1] + hintIconBox.model.height / 2,
  });
  await sleep(250);
  const hovered = await evaluate(
    page,
    `(() => {
      const bubble = document.querySelector('.mix-panel .hint-icon').closest('.hint').querySelector('.hint-bubble');
      const cs = getComputedStyle(bubble);
      const r = bubble.getBoundingClientRect();
      return JSON.stringify({
        visibility: cs.visibility,
        opacity: cs.opacity,
        text: bubble.textContent.trim(),
        inViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
      });
    })()`,
    'hover 展开气泡',
  );
  const hover = JSON.parse(hovered);
  if (hover.visibility !== 'visible' || Number(hover.opacity) < 0.9 || hover.text.length < 8) {
    throw new Error(`hover 没有展开气泡：${hovered}`);
  }
  if (!hover.inViewport) throw new Error(`展开的气泡不在视口内：${hovered}`);
  pass(`hover 展开气泡：「${hover.text.slice(0, 16)}…」`);

  // 鼠标移开 → 收起
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
  await sleep(250);
  const rehidden = await evaluate(
    page,
    `getComputedStyle(document.querySelector('.mix-panel .hint-bubble')).visibility`,
    '鼠标移开',
  );
  if (rehidden !== 'hidden') throw new Error(`鼠标移开后气泡没收起（${rehidden}）`);
  pass('鼠标移开后气泡收起');

  // 键盘聚焦也要能展开（Tab / 触屏点按走这条路）
  const focused = await evaluate(
    page,
    `(() => {
      const icon = document.querySelector('.hint-warn .hint-icon');
      if (!icon) return JSON.stringify({ error: '没有 warn 图标' });
      icon.focus();
      const bubble = icon.closest('.hint').querySelector('.hint-bubble');
      return JSON.stringify({
        visibility: getComputedStyle(bubble).visibility,
        text: bubble.textContent.trim(),
      });
    })()`,
    '键盘聚焦展开气泡',
  );
  const focus = JSON.parse(focused);
  if (focus.error || focus.visibility !== 'visible' || focus.text.length < 8) {
    throw new Error(`键盘聚焦没有展开气泡：${focused}`);
  }
  pass(`键盘聚焦也能展开（warn 语气：「${focus.text.slice(0, 14)}…」）`);

  // 点说明图标不该误触旁边的控件（图标在 label 外，点它不等于勾选降噪）
  const noSideEffect = await evaluate(
    page,
    `(() => {
      const before = document.querySelector('#mix-noise-reduction').checked;
      const hint = [...document.querySelectorAll('.hint')].find((h) =>
        h.querySelector('.hint-icon').closest('.mix-check'));
      hint.querySelector('.hint-icon').click();
      const after = document.querySelector('#mix-noise-reduction').checked;
      return JSON.stringify({ before, after });
    })()`,
    '点说明图标不误触控件',
  );
  const sideEffect = JSON.parse(noSideEffect);
  if (sideEffect.before !== sideEffect.after) {
    throw new Error(`点说明图标把降噪复选框切换了：${noSideEffect}`);
  }
  pass('点说明图标不会误触旁边的控件');
  await page.send('Emulation.clearDeviceMetricsOverride');
  /* --------------------- 3.4 混音面板：分组 / 预设 --------------------- */
  step('混音面板：分组建在、点预设会写进参数');
  const panel = await evaluate(
    page,
    `(async () => {
      const groups = [...document.querySelectorAll('.mix-group-head')].map((n) => n.textContent);
      const needed = ['音量', '音效', '修音'];
      const missing = needed.filter((name) => !groups.some((g) => g.includes(name)));
      if (missing.length) return JSON.stringify({ error: '缺少分组：' + missing.join(',') });

      // 预设只是「一组具名参数」，点一下应该把数值写进滑块
      const eqBefore = [...document.querySelectorAll('.mix-panel input[type=range]')]
        .map((s) => s.value).join(',');
      const magnetic = [...document.querySelectorAll('.reverb-option')]
        .find((b) => b.textContent.includes('磁性'));
      if (!magnetic) return JSON.stringify({ error: '找不到「磁性」预设' });
      magnetic.click();
      await new Promise((r) => setTimeout(r, 250));
      const eqAfter = [...document.querySelectorAll('.mix-panel input[type=range]')]
        .map((s) => s.value).join(',');

      const stillActive = [...document.querySelectorAll('.reverb-option.active')]
        .some((b) => b.textContent.includes('磁性'));

      return JSON.stringify({ changed: eqBefore !== eqAfter, stillActive });
    })()`,
    '检查混音面板',
  );
  const panelState = JSON.parse(panel);
  if (panelState.error) throw new Error(`混音面板不对：${panel}`);
  if (!panelState.changed) throw new Error('点预设没有改变任何参数');
  if (!panelState.stillActive) throw new Error('点了预设但按钮没有高亮');
  pass('混音分组齐全，预设能写进参数并正确高亮');

  step('实时试听：点播放 + 拖滑块，不点「合成」也立即生效');

  const previewStart = await evaluate(
    page,
    `(async () => {
      const button = document.querySelector('.preview-transport [data-preview-toggle]');
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
    `(() => { const b = document.querySelector('.preview-transport [data-preview-toggle]'); return b && b.textContent.includes('暂停'); })()`,
    { timeoutMs: 60_000, label: '预览进入播放中' },
  );
  pass('实时试听已起播（浏览器内 Web Audio 混音，无 ffmpeg 参与）');

  /*
   * 回归：拖进度条 / 改人声对齐都走引擎的 startSources()（停旧轨、起新轨）。
   * 旧轨 stop() 触发的 ended 是异步派发的，等它到的时候 stopping 已被重置成 false，
   * 会被误判成「自然播完」——试听当场结束、进度条跳到最后。起播代数就是防这个的。
   * 这两步紧跟起播之后做：测试干声只有 ~3.15s，别等它自然播完。
   *
   * 断言挑「还在播 + 时间文本没变成 结尾/结尾」：无头环境可能没有音频时钟，
   * currentTime 不推进，所以不能断言位置前进，只能断言它没被甩到结尾。
   */
  const readTransport = `(() => {
    const button = document.querySelector('.preview-transport [data-preview-toggle]');
    const bar = document.querySelector('.preview-transport input[type=range]');
    const time = document.querySelector('.preview-time');
    return JSON.stringify({
      playing: Boolean(button && button.textContent.includes('暂停')),
      seek: bar ? bar.value : null,
      time: time ? time.textContent.trim() : null,
    });
  })()`;

  step('实时试听：拖进度条不该把播放打断、不该把进度条甩到结尾');

  const seekState = await evaluate(
    page,
    `(async () => {
      const before = ${readTransport};
      const bar = document.querySelector('.preview-transport input[type=range]');
      if (!bar) return JSON.stringify({ error: '找不到试听进度条' });
      if (!JSON.parse(before).playing) return JSON.stringify({ error: '预览没在播放' });
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(bar, String(Number(bar.max) * 0.4));
      bar.dispatchEvent(new Event('input', { bubbles: true }));
      // 等过 seek 合并窗（120ms）+ 旧轨 ended 的派发
      await new Promise((r) => setTimeout(r, 500));
      return ${readTransport};
    })()`,
    '拖动试听进度条',
  );
  const seekResult = JSON.parse(seekState);
  if (seekResult.error) throw new Error(seekResult.error);
  if (!seekResult.playing) {
    throw new Error(`拖进度条把试听打断了（像被误判成播完）：${seekState}`);
  }
  if (seekResult.time && /^(\S+)\s*\/\s*\1$/.test(seekResult.time)) {
    throw new Error(`拖进度条后进度条被甩到结尾：${seekResult.time}`);
  }
  pass(`拖进度条后续播正常（${seekResult.time}，滑块 ${seekResult.seek}）`);

  step('实时试听：改人声对齐（触发两轨重排）也不该打断播放');

  const offsetState = await evaluate(
    page,
    `(async () => {
      // 分组不再折叠，毫秒输入框直接在页面上（.ms-input）
      const input = document.querySelector('.mix-offset-row input.ms-input');
      if (!input) return JSON.stringify({ error: '找不到人声对齐微调的毫秒输入框' });
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '300');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // 对齐重排在引擎里有 120ms 防抖，等它排完再看
      await new Promise((r) => setTimeout(r, 500));
      return ${readTransport};
    })()`,
    '改人声对齐微调',
  );
  const offsetResult = JSON.parse(offsetState);
  if (offsetResult.error) throw new Error(offsetResult.error);
  if (!offsetResult.playing) {
    throw new Error(`改人声对齐把试听打断了（像被误判成播完）：${offsetState}`);
  }
  if (offsetResult.time && /^(\S+)\s*\/\s*\1$/.test(offsetResult.time)) {
    throw new Error(`改人声对齐后进度条被甩到结尾：${offsetResult.time}`);
  }
  pass(`改人声对齐后续播正常（${offsetResult.time}）`);

  // 测试曲只有 3 秒，趁还在播立刻拖滑块：不点「合成」，参数实时送进引擎，
  // 播放不中断、无报错。
  // 滑块按 data-mix-param 定位（不再靠「第几个 range」—— 面板里滑块越来越多，
  // 排布一改就会点错参数）。
  const liveTweak = await evaluate(
    page,
    `(async () => {
      const slider = document.querySelector('.mix-panel input[data-mix-param="vocalGain"]');
      if (!slider) return '找不到人声音量滑块';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(slider, '1.5');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 800));
      const button = document.querySelector('.preview-transport [data-preview-toggle]');
      return button && button.textContent.includes('暂停') ? 'ok' : '播放被参数改动打断了';
    })()`,
    '拖动滑块不断播',
  );
  if (liveTweak !== 'ok') throw new Error(`实时试听被参数改动打断：${liveTweak}`);
  pass('参数改动实时生效，播放不中断（未触发任何合成请求）');

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
    `(() => { const b = document.querySelector('.preview-transport [data-preview-toggle]'); if (b && b.textContent.includes('暂停')) b.click(); return true; })()`,
    '暂停预览',
  );

  /* --------------------- 3.6 合成后直接返回作品库并定位 --------------------- */
  step('改人声音量 + 换混响，点「合成」→ 应直接返回作品库并定位到作品');

  const synth = await evaluate(
    page,
    `(async () => {
      const slider = document.querySelector('.mix-panel input[data-mix-param="vocalGain"]');
      if (!slider) return '找不到人声音量滑块';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(slider, '0.5');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));

      const hall = [...document.querySelectorAll('.reverb-option')].find((b) => b.textContent.includes('大厅'));
      if (hall) hall.click();
      await new Promise((r) => setTimeout(r, 120));

      const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '合成');
      if (!button || button.disabled) return '合成按钮不可用';
      button.click();
      return 'ok';
    })()`,
    '改参数并点合成',
  );
  if (synth !== 'ok') throw new Error(`合成没触发：${synth}`);

  await waitFor(page, `location.pathname === '/works'`, {
    timeoutMs: 20_000,
    label: '返回作品库',
  });
  pass('点「合成」后直接返回作品库（不在详情页等结果）');

  // 列表页此时显示「正在合成…」徽章，轮询到 ready 再核对参数
  await waitFor(
    page,
    `(async () => {
      const work = await (await fetch('/api/works/${workId}')).json();
      return work.status === 'ready';
    })()`,
    { timeoutMs: 90_000, label: '重混完成' },
  );

  const params = await evaluate(
    page,
    `(async () => {
      const work = await (await fetch('/api/works/${workId}')).json();
      return work.mixParams;
    })()`,
    '核对混音参数',
  );
  if (params.reverb !== 'hall' || Math.abs(params.vocalGain - 0.5) > 0.001) {
    throw new Error(`混音参数没生效：${JSON.stringify(params)}`);
  }
  pass(`重混成功，参数已落库：${JSON.stringify(params)}`);

  // 定位：返回列表后目标作品应被滚动到视口内（高亮类 2.6s 后会撤，不断言类）
  const located = await evaluate(
    page,
    `(() => {
      const card = document.querySelector('[data-work-id="${workId}"]');
      if (!card) return 'no-card';
      const rect = card.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0 ? 'in-view' : 'off-screen';
    })()`,
    '检查作品定位',
  );
  if (located !== 'in-view') throw new Error(`作品没有定位到视口内：${located}`);
  pass('返回作品库后已定位到该作品（滚动到视口内）');

  /* ------------------- 3.5 干声是否连续（掉音检测） ------------------- */
  step('解码干声 WAV，检查包络是否连续（掉音会在这里露出来）');

  const vocal = await evaluate(
    page,
    `(async () => {
      const response = await fetch('/api/works/${workId}/vocal');
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

  /* ------------------------ 4. 伴奏库不再支持视频 ------------------------ */
  step('上传视频被拒（弹窗前端拦截 + 服务端兜底）');

  const videoFile = await makeTestVideo();
  await page.send('Page.navigate', { url: `${BASE_URL}/` });
  await waitFor(page, `document.body.innerText.includes('伴奏库')`, {
    label: '伴奏库重新渲染',
  });

  // ① 前端：弹窗里选到非音频文件，行内报错、不产生新伴奏
  await openUploadDialog(page);
  const { root } = await page.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeIds } = await page.send('DOM.querySelectorAll', {
    nodeId: root.nodeId,
    selector: '.upload-modal-panel input[type=file]',
  });
  if (!nodeIds?.[0]) throw new Error('上传弹窗里没有音频选择框');
  await page.send('DOM.setFileInputFiles', { nodeId: nodeIds[0], files: [videoFile] });

  await waitFor(
    page,
    `document.querySelector('.upload-modal-panel').innerText.includes('只支持音频文件')`,
    { timeoutMs: 10_000, label: '弹窗提示只支持音频' },
  );
  pass('弹窗拦下了视频文件（行内提示，不提交）');

  const submitDisabled = await evaluate(
    page,
    `(() => {
      const button = [...document.querySelectorAll('.upload-modal-panel button')]
        .find((b) => b.textContent.trim() === '开始上传');
      return button ? button.disabled : 'no-button';
    })()`,
    '检查开始上传是否禁用',
  );
  if (submitDisabled !== true) {
    throw new Error(`只选了非法文件时「开始上传」应保持禁用，实际 ${submitDisabled}`);
  }
  await evaluate(page, clickByText('取消'), '关掉上传弹窗');

  // ② 服务端：绕过前端直传同一个 mkv，必须被 ffprobe 判定拦下
  const rejected = await fetch(`${BASE_URL}/api/tracks`, {
    method: 'POST',
    body: (() => {
      const form = new FormData();
      form.append(
        'file',
        new Blob([fs.readFileSync(videoFile)], { type: 'video/x-matroska' }),
        path.basename(videoFile),
      );
      return form;
    })(),
  });
  if (rejected.status !== 400) {
    throw new Error(`视频上传应返回 400，实际 ${rejected.status}`);
  }
  const rejectedBody = await rejected.json();
  if (!/音频/.test(rejectedBody.error ?? '')) {
    throw new Error(`视频被拒的文案不对：${JSON.stringify(rejectedBody)}`);
  }
  pass('服务端也拦下了视频（400：只支持音频格式）');

  const stillAudioOnly = await evaluate(
    page,
    `(async () => (await (await fetch('/api/tracks')).json()).every((t) => t.kind !== 'video'))()`,
    '确认库里没有视频伴奏',
  );
  if (stillAudioOnly !== true) throw new Error('视频混进库里了');
  pass('库里没有视频伴奏');

  /* ------------------------------ 5. 点歌台渲染 ----------------------------- */
  step('打开点歌台（曲库源没配也要能正常渲染）');
  await page.send('Page.navigate', { url: `${BASE_URL}/discover` });
  await waitFor(page, `document.body.innerText.includes('点歌台')`, {
    timeoutMs: 20_000,
    label: '点歌台渲染',
  });

  // 内置 5sing 源默认开着，所以正常情况下这里一定出现搜索框；
  // 只有既没配 LIBRARY_SOURCES、又把 FIVESING_ENABLED=0 时才显示配置指引。
  // 两种都算通过 —— 这个用例只保证页面不炸。
  const discover = await evaluate(
    page,
    `(() => ({
      hasGuide: document.body.innerText.includes('还没有配置任何曲库源'),
      hasSearch: Boolean(document.querySelector('.library-search-bar')),
      navHasLink: [...document.querySelectorAll('.app-nav-link')].some((a) => a.textContent.includes('点歌台')),
    }))()`,
    '检查点歌台',
  );
  if (!discover.hasGuide && !discover.hasSearch) {
    throw new Error(`点歌台既没有配置指引也没有搜索框：${JSON.stringify(discover)}`);
  }
  if (!discover.navHasLink) throw new Error('导航里没有「点歌台」入口');
  pass(discover.hasGuide ? '点歌台渲染正常（未配置源 → 显示配置指引）' : '点歌台渲染正常（已配置源 → 显示搜索框）');

  // 有源时才验「搜索按钮」：打字不发请求，点按钮（或回车）才发。
  // 用包一层 fetch 来数 /api/library/search 的调用次数。
  if (!discover.hasGuide) {
    step('点歌台：打字不自动搜，点「搜索」才发请求');

    const searched = await evaluate(
      page,
      `(async () => {
        const input = document.querySelector('.library-search-bar input');
        const button = [...document.querySelectorAll('.library-search-bar button')]
          .find((b) => b.textContent.trim() === '搜索');
        if (!input || !button) return JSON.stringify({ error: '缺搜索框或搜索按钮' });

        // 数搜索请求：包一层 fetch，记 /api/library/search 的次数
        window.__searchCalls = 0;
        const native = window.fetch;
        window.fetch = (...args) => {
          if (String(args[0]).includes('/api/library/search')) window.__searchCalls += 1;
          return native(...args);
        };
        window.__restoreFetch = () => { window.fetch = native; };

        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '晴');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 900));

        const afterTyping = window.__searchCalls;
        setter.call(input, '晴天');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 900));
        const afterMoreTyping = window.__searchCalls;

        button.click();
        await new Promise((r) => setTimeout(r, 300));
        const afterClick = window.__searchCalls;

        // 数完就撤，别影响后面的步骤
        window.__restoreFetch();

        return JSON.stringify({ afterTyping, afterMoreTyping, afterClick });
      })()`,
      '检查搜索按钮行为',
    );
    const searchState = JSON.parse(searched);
    if (searchState.error) throw new Error(searchState.error);
    if (searchState.afterTyping !== 0 || searchState.afterMoreTyping !== 0) {
      throw new Error(`打字时不该发搜索请求，实际发了 ${searchState.afterMoreTyping} 次`);
    }
    if (searchState.afterClick < 1) {
      throw new Error('点「搜索」没有发请求');
    }
    pass(`打字 0 次请求，点「搜索」立刻发起（${searchState.afterClick} 次）`);
  }

  // 只有想验点歌链路时才跑这段（默认不跑，避免 e2e 依赖外部资源）：
  //   E2E_LIBRARY_SOURCE=1 LIBRARY_SOURCES="本地测试源=<清单URL>" FIVESING_ENABLED=0 npm run dev
  // FIVESING_ENABLED=0 很重要 —— 不然搜索会连带命中内置 5sing 的结果，
  // 点到的卡片就不一定是本地清单那条了。
  if (process.env.E2E_LIBRARY_SOURCE === '1') {
    step('点歌台：搜索 → 点歌 → 自动入库 → 去演唱');

    const searched = await evaluate(
      page,
      `(() => {
        const input = document.querySelector('.library-search-bar input');
        if (!input) return '没有搜索框';
        const button = [...document.querySelectorAll('.library-search-bar button')]
          .find((b) => b.textContent.trim() === '搜索');
        if (!button) return '没有搜索按钮';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '晴天');
        // 刻意只派发 input：点歌台不再边打字边搜，必须点「搜索」才发请求
        input.dispatchEvent(new Event('input', { bubbles: true }));
        button.click();
        return 'ok';
      })()`,
      '输入搜索词并点搜索',
    );
    if (searched !== 'ok') throw new Error(`搜索不可用：${searched}`);

    await waitFor(
      page,
      `[...document.querySelectorAll('.track-item .track-title')].some((n) => n.textContent.includes('晴天'))`,
      { timeoutMs: 20_000, label: '搜索结果出现' },
    );
    pass('搜索命中「晴天」（关键词过滤走的是本地清单缓存）');

    const requested = await evaluate(
      page,
      `(() => {
        const item = [...document.querySelectorAll('.track-item')].find((n) => n.innerText.includes('晴天'));
        if (!item) return '没有结果卡片';
        const button = [...item.querySelectorAll('button')].find((b) => b.textContent.includes('点歌'));
        if (!button) return '没有点歌按钮';
        button.click();
        return 'ok';
      })()`,
      '点歌',
    );
    if (requested !== 'ok') throw new Error(`点歌没触发：${requested}`);

    // 卡片从「下载中…」翻成「已入库」才算真的走完下载 + 入库
    await waitFor(
      page,
      `(() => {
        const item = [...document.querySelectorAll('.track-item')].find((n) => n.innerText.includes('晴天'));
        return Boolean(item && item.innerText.includes('已入库'));
      })()`,
      { timeoutMs: 90_000, label: '点歌入库完成' },
    );
    pass('点歌完成，卡片显示「已入库」');

    const imported = await evaluate(
      page,
      `(async () => {
        const tracks = await (await fetch('/api/tracks')).json();
        const track = tracks.find((t) => t.title === '晴天' && t.source === 'library');
        if (!track) return JSON.stringify({ error: '库里没有 source=library 的晴天' });
        const detail = await (await fetch('/api/tracks/' + track.id)).json();
        return JSON.stringify({ hasLyrics: detail.hasLyrics, lyrics: detail.lyrics });
      })()`,
      '核对入库结果',
    );
    const importedState = JSON.parse(imported);
    if (importedState.error) throw new Error(importedState.error);
    if (!importedState.hasLyrics) throw new Error(`点歌没有带上源站歌词：${imported}`);
    pass('入库来源标成 library，且源站歌词自动带了出来');

    const dedupe = await evaluate(
      page,
      `(async () => {
        const countLibrary = async () => (await (await fetch('/api/tracks')).json())
          .filter((t) => t.source === 'library').length;
        const before = await countLibrary();
        const sources = await (await fetch('/api/library/sources')).json();
        // 内置 5sing 源固定排在前面，这里要找的是自建清单源（id 带 http-index: 前缀）
        const source = sources.sources.find((s) => s.id.startsWith('http-index:')) ?? sources.sources[0];
        const response = await fetch('/api/library/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId: source.id, itemId: 'qingtian' }),
        });
        const body = await response.json();
        return JSON.stringify({
          status: response.status,
          alreadyImported: body.alreadyImported === true,
          before,
          after: await countLibrary(),
        });
      })()`,
      '重复点歌',
    );
    const dedupeState = JSON.parse(dedupe);
    if (dedupeState.status !== 200 || !dedupeState.alreadyImported) {
      throw new Error(`重复点歌没有复用已有条目：${dedupe}`);
    }
    if (dedupeState.after !== dedupeState.before) {
      throw new Error(`重复点歌产生了重复条目：${dedupe}`);
    }
    pass(`重复点歌直接复用已有条目（库里仍为 ${dedupeState.after} 条）`);

    await evaluate(
      page,
      `(async () => {
        const tracks = await (await fetch('/api/tracks')).json();
        for (const track of tracks) {
          if (track.source === 'library') await fetch('/api/tracks/' + track.id, { method: 'DELETE' });
        }
        return true;
      })()`,
      '清理点歌数据',
    );
    pass('已清理点歌产生的伴奏');
  }

  /* -------------------------------- 6. 收尾 -------------------------------- */
  step('清理测试数据');
  await evaluate(
    page,
    `(async () => {
      // 先删作品再删伴奏：删伴奏不再被作品拦截，但先删作品才不会留下孤儿作品
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
        `(async () => ({
          url: location.href,
          alerts: [...document.querySelectorAll('.alert')].map((n) => n.innerText.trim()),
          // 麦克风到底怎么了：把 enumerateDevices / getUserMedia 的真实结果摊开，
          // 否则「未检测到设备」既可能是权限、也可能是 Chrome 的假设备没生效
          micProbe: await (async () => {
            const out = { hasApi: Boolean(navigator.mediaDevices?.getUserMedia) };
            try {
              const devices = await navigator.mediaDevices.enumerateDevices();
              out.inputs = devices.filter((d) => d.kind === 'audioinput').length;
              out.kinds = devices.map((d) => d.kind);
            } catch (err) {
              out.enumerateError = String(err);
            }
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              out.gum = 'ok:' + stream.getAudioTracks().length;
              for (const track of stream.getTracks()) track.stop();
            } catch (err) {
              out.gum = 'failed:' + (err && err.name) + ':' + (err && err.message);
            }
            return out;
          })(),
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
