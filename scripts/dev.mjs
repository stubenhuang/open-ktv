#!/usr/bin/env node
/**
 * 零依赖的开发启动器：并行跑 Vite 前端和 Node 后端，带前缀着色输出。
 * 用法：npm run dev
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const CYAN = '\u001b[36m';
const MAGENTA = '\u001b[35m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let shuttingDown = false;

/**
 * @param {string} name
 * @param {string} color
 * @param {string[]} args
 */
function run(name, color, args) {
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // 开发模式默认开详细日志；用户显式设了 LOG_LEVEL 就听他的
    env: { ...process.env, FORCE_COLOR: '1', LOG_LEVEL: process.env.LOG_LEVEL ?? 'debug' },
  });
  children.push(child);

  const prefix = `${color}[${name}]${RESET} `;
  const pipe = (stream, isErr) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const out = isErr ? process.stderr : process.stdout;
        out.write(`${prefix}${DIM}${line}${RESET}\n`);
      }
    });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const why = signal ? `signal ${signal}` : `code ${code}`;
    process.stderr.write(`${prefix}进程退出（${why}），正在停止其余进程…\n`);
    shutdown(code ?? 1);
  });

  return child;
}

/** @param {number} code */
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 150).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('server', CYAN, ['--watch', '--disable-warning=ExperimentalWarning', 'server/src/index.ts']);
run('web', MAGENTA, ['./node_modules/vite/bin/vite.js']);
