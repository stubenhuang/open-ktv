#!/usr/bin/env node
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

/**
 * i18n 一致性检查（`npm run check:i18n`）。
 *
 * 查四件事，任何一件不过就以非零退出：
 *
 *  1. **键集一致** —— 每种语言必须有参考语言（zh-CN）的全部键，也不能多出键；
 *  2. **占位符一致** —— 同一条文案在各语言里的 `{name}` 集合必须相同
 *     （否则换语言就少一个词，而且类型检查看不出来）；
 *  3. **服务端错误码对账** —— 每个 ApiErrorCode 都要有 `error.<码>` 文案，
 *     且占位符与服务端英文模板一致；
 *  4. **源码键引用有效** —— 代码里 `t('...')` / `plural('...')` 用到的键都必须存在。
 *
 * 模板字面量（`` t(`mobile.reason.${code}`) ``）按静态前缀校验：该前缀下至少要
 * 有一条文案，且代码里出现的动态部分由 TypeScript 的类型系统另行保证。
 *
 * 这个脚本是 CI 的一部分（.github/workflows/ci.yml），也是翻译时的唯一验收标准。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localesDir = path.join(root, 'web/src/i18n/locales');
const sharedTypes = path.join(root, 'shared/types.ts');
const serverError = path.join(root, 'server/src/httpError.ts');
const sourceDir = path.join(root, 'web/src');

const REFERENCE = 'zh-CN';
const problems = [];

function fail(message) {
  problems.push(message);
}

/* --------------------------------- 读目录 --------------------------------- */

/** 把一个 locales/<locale>/<area>.ts 里的键抠出来（不执行 TS，按字面解析） */
function readAreaFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const entries = [];
  // 只认 `'key': 'value',` 这种单行形式（本项目文案目录的既定写法）
  const re = new RegExp(
    String.raw`^\s{2}'([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|\`((?:[^\`\\]|\\.)*)\`)\s*,?\s*$`,
    'gm',
  );
  let match;
  while ((match = re.exec(text)) !== null) {
    entries.push({ key: match[1], value: match[2] ?? match[3] ?? '' });
  }
  return entries;
}

function readLocale(locale) {
  const dir = path.join(localesDir, locale);
  const messages = new Map();
  if (!fs.existsSync(dir)) {
    fail(`locales/${locale}/ 目录不存在`);
    return messages;
  }
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.ts')).sort()) {
    for (const { key, value } of readAreaFile(path.join(dir, file))) {
      if (messages.has(key)) fail(`${locale}/${file}：键 "${key}" 重复定义`);
      messages.set(key, value);
    }
  }
  return messages;
}

const locales = fs
  .readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (!locales.includes(REFERENCE)) fail(`缺少参考语言目录 ${REFERENCE}/`);

const catalogs = new Map();
for (const locale of locales) catalogs.set(locale, readLocale(locale));

const reference = catalogs.get(REFERENCE) ?? new Map();

/* ----------------------------- 1. 键集与占位符 ----------------------------- */

function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

for (const locale of locales) {
  if (locale === REFERENCE) continue;
  const catalog = catalogs.get(locale);
  for (const key of reference.keys()) {
    if (!catalog.has(key)) fail(`${locale}：缺键 "${key}"`);
  }
  for (const key of catalog.keys()) {
    if (!reference.has(key)) fail(`${locale}：多出参考语言没有的键 "${key}"`);
  }
}

for (const locale of locales) {
  const catalog = catalogs.get(locale);
  for (const [key, value] of reference) {
    const other = catalog.get(key);
    if (other === undefined) continue;
    const a = placeholders(value).join(',');
    const b = placeholders(other).join(',');
    if (a !== b) fail(`${locale}："${key}" 占位符不一致（${REFERENCE} 是 {${a}}，这里是 {${b}}）`);
    if (!other.trim()) fail(`${locale}："${key}" 是空文案`);
  }
}

/* --------------------------- 2. 服务端错误码对账 --------------------------- */

/** 去掉块注释 —— 目录与类型文件里的文档注释里有 `{name}` 这类占位符示例，会干扰解析 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 读一个导出的字符串联合类型（`export type X = 'a' | 'b'` 或带 `{ ... }` 的写法）。
 *
 * 直接从 `=` 扫到这一句结束（分号，或下一个顶层声明），不假设有没有花括号 ——
 * ApiErrorCode 是没有花括号的那种，NetworkReasonCode 也是。
 */
function readUnion(file, typeName) {
  const text = stripComments(fs.readFileSync(file, 'utf8'));
  const anchor = new RegExp(`export\\s+type\\s+${typeName}\\b`).exec(text);
  if (!anchor) {
    fail(`${path.basename(file)}：找不到 ${typeName}`);
    return [];
  }
  const eq = text.indexOf('=', anchor.index + anchor[0].length);
  if (eq < 0) return [];

  let depth = 0;
  let end = text.length;
  for (let i = eq; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
    else if (depth === 0 && ch === ';') {
      end = i;
      break;
    }
  }
  return [...text.slice(eq, end).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
}

function readServerTemplates(file) {
  const text = stripComments(fs.readFileSync(file, 'utf8'));
  const templates = new Map();
  const re = /^\s{2}([a-z0-9_]+):\s*(?:'((?:[^'\\]|\\.)*)'|\n?\s*'((?:[^'\\]|\\.)*)')\s*,?\s*$/gm;
  let match;
  while ((match = re.exec(text)) !== null) {
    templates.set(match[1], match[2] ?? match[3] ?? '');
  }
  return templates;
}

const errorCodes = readUnion(sharedTypes, 'ApiErrorCode');
const serverTemplates = readServerTemplates(serverError);

for (const code of errorCodes) {
  const key = `error.${code}`;
  if (!reference.has(key)) fail(`${REFERENCE}：错误码 "${code}" 没有对应文案 "${key}"`);
  const serverTemplate = serverTemplates.get(code);
  if (serverTemplate === undefined) {
    fail(`server/src/httpError.ts：错误码 "${code}" 没有英文兜底文案`);
    continue;
  }
  for (const locale of locales) {
    const value = catalogs.get(locale).get(key);
    if (value === undefined) continue;
    const a = placeholders(serverTemplate).join(',');
    const b = placeholders(value).join(',');
    if (a !== b) {
      fail(`${locale}："${key}" 占位符与服务端不一致（服务端是 {${a}}，这里是 {${b}}）`);
    }
  }
}

for (const code of serverTemplates.keys()) {
  if (!errorCodes.includes(code)) {
    fail(`server/src/httpError.ts：错误码 "${code}" 不在 shared/types.ts 的 ApiErrorCode 里`);
  }
}

/* --------------------------- 3. 源码里的键引用 --------------------------- */

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'i18n') continue; // 目录自己不是调用方
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const usedKeys = new Set();
const prefixes = new Set();

for (const file of walk(sourceDir)) {
  // 注释行不算调用点：文档里常拿 `t('xxx.yyy')` 当例子，那不是真的在用这个键。
  // 只按行剔掉整行注释，行内注释（`... // 说明`）后面的代码照旧扫。
  const text = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
  const rel = path.relative(root, file);
  const re = /\b(?:t|plural|translateWith)\(\s*(?:'([^']+)'|`([^`]+)`)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match[1]) {
      usedKeys.add(match[1]);
      if (!reference.has(match[1])) {
        fail(`${rel}：用了不存在的键 "${match[1]}"`);
      }
      continue;
    }
    // 模板字面量：取 `${` 之前的静态前缀
    const template = match[2];
    const cut = template.indexOf('${');
    const prefix = cut < 0 ? template : template.slice(0, cut);
    if (!prefix) continue;
    prefixes.add(prefix);
    const any = [...reference.keys()].some((key) => key.startsWith(prefix));
    if (!any) fail(`${rel}：模板键前缀 "${prefix}" 在目录里没有任何匹配`);
  }
}

/* --------------------------------- 汇总 --------------------------------- */

if (problems.length > 0) {
  console.error(`i18n 检查没过（${problems.length} 处）：\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error('\n修复提示：');
  console.error('  · 缺键 → 在 locales/<语言>/<分区>.ts 里补上；');
  console.error('  · 多键 / 占位符不一致 → 以 zh-CN 为准对齐；');
  console.error('  · 服务端错误码 → shared/types.ts 与 server/src/httpError.ts 同时加；');
  console.error('  · 键名写错 → 改代码，别改目录（键是给翻译用的稳定标识）。');
  process.exit(1);
}

console.log(
  `i18n OK：${locales.length} 种语言 × ${reference.size} 条文案，占位符与服务端错误码均一致，` +
    `源码引用 ${usedKeys.size} 个静态键 + ${prefixes.size} 个动态前缀。`,
);
