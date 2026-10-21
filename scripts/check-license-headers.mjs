#!/usr/bin/env node
/**
 * SPDX 许可头检查（`npm run check:license`）。
 *
 * MIT 的要求是「版权声明与许可声明要出现在所有副本里」。仓库根的 LICENSE 覆盖了
 * 源文件被整体分发的场合，但单个文件被拷走、被复制进别的项目时，那份声明就丢了。
 * 所以每个源文件第一行放一个 SPDX 短标识：
 *
 *   // SPDX-License-Identifier: MIT
 *   // Copyright (c) 2026 stubenhuang
 *
 * 这条是**给机器看的**：`licensee` / `reuse` / GitHub 的 license 检测都认它，
 * 人也不用在每个文件顶部贴 20 行全文。CI 里跑这个脚本，漏一个文件就红。
 *
 * `--fix` 会把缺的头补上（幂等：已经有头的文件不动）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SPDX_TEXT = 'SPDX-License-Identifier: MIT';
const COPYRIGHT_TEXT = 'Copyright (c) 2026 stubenhuang';

/** 需要带头的位置：源码、脚本、测试、社区健康文件与 CI 配置 */
const TARGET_DIRS = ['web/src', 'server/src', 'shared', 'scripts', 'tests', '.github', 'docs'];

/**
 * 这些文件不进检查：
 *  · JSON / 锁文件 —— 没有注释语法，塞进去会把 `JSON.parse` 和别的工具全炸掉；
 *  · 生成物 —— `web/dist/` 由 vite build 产出，已 gitignore；
 *  · 第三方 / 手写工具脚本里的这两个 worklet 是给浏览器直接加载的，头部注释会被
 *    当成模块内容执行不掉（它们不是 ES module，是 classic script）。
 */
const SKIP_FILES = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.server.json',
  'web/public/accomp-onset.js',
  'web/public/pcm-worklet.js',
]);

/**
 * 注释语法：按扩展名选注释符。
 *
 * `line` 是行注释符（`//` / `#`）；`block` 是块注释的起止对，用于 CSS 这类
 * 没有行注释的语言。
 */
const SYNTAX = {
  '.ts': { line: '//' },
  '.tsx': { line: '//' },
  '.mjs': { line: '//' },
  '.js': { line: '//' },
  '.cjs': { line: '//' },
  '.css': { block: ['/*', ' */'] },
  '.sh': { line: '#' },
  '.yml': { line: '#' },
  '.yaml': { line: '#' },
};

const problems = [];

function targetFiles() {
  const files = [];
  for (const dir of TARGET_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    walk(abs, files);
  }
  for (const name of ['vite.config.ts', 'openktv.sh']) {
    const full = path.join(root, name);
    if (fs.existsSync(full)) files.push(full);
  }
  return files;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    const ext = path.extname(entry.name);
    if (!SYNTAX[ext]) continue;
    if (SKIP_FILES.has(path.relative(root, full))) continue;
    out.push(full);
  }
}

function hasHeader(text) {
  return text.includes('SPDX-License-Identifier: MIT');
}

function prependHeader(file, fix) {
  const syntax = SYNTAX[path.extname(file)];
  const original = fs.readFileSync(file, 'utf8');
  if (hasHeader(original)) return;

  const lines = syntax.line
    ? [syntax.line, `${syntax.line} ${SPDX_TEXT}`, `${syntax.line} ${COPYRIGHT_TEXT}`]
    : [syntax.block[0], ` ${SPDX_TEXT}`, ` ${COPYRIGHT_TEXT}`, syntax.block[1]];

  // shebang 必须留在第一行（CLI 脚本要靠它启动）
  const first = original.split('\n')[0] ?? '';
  const shebang = first.startsWith('#!') ? first : null;
  const body = shebang ? original.slice(first.length + 1) : original;
  const header = `${shebang ? `${shebang}\n` : ''}${lines.join('\n')}\n\n`;

  if (!fix) {
    problems.push(path.relative(root, file));
    return;
  }
  fs.writeFileSync(file, header + body, 'utf8');
}

const fix = process.argv.includes('--fix');
const files = targetFiles();
for (const file of files) prependHeader(file, fix);

if (problems.length > 0) {
  console.error(`有 ${problems.length} 个文件缺 SPDX 许可头：\n`);
  for (const file of problems) console.error(`  ✗ ${file}`);
  console.error('\n跑 `npm run check:license -- --fix` 可以自动补上。');
  process.exit(1);
}

console.log(`许可头 OK：${files.length} 个源文件都带 SPDX-License-Identifier: MIT${fix ? '（已补全）' : ''}。`);
