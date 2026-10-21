#!/usr/bin/env node
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

/**
 * 备份 Open KTV 的数据目录。
 *
 * 为什么不能「直接拷 data/」：SQLite 开着 WAL 模式时，最近的写入还在
 * `ktv.db-wal` 里没合并回主库。服务运行时直接 cp 三个文件，拷到的
 * 可能是一个过期的主库 + 一份未必对得上的 WAL。所以这里用
 * `VACUUM INTO` 做一份**一致快照**（在线也安全：WAL 下读者不阻塞写者），
 * 再把它和媒体文件一起打进 tar.gz。
 *
 * 打包内容：ktv.db（快照）+ originals / proxies / vocals / works。
 * 刻意排除：
 *   · tmp/    —— 半成品临时文件，重启就会清
 *   · certs/  —— 自签名证书跟着局域网地址走，换网段自动重签，备份没有意义
 *
 * 用法：
 *   node scripts/backup.mjs                  # 输出到 backups/openktv-<时间戳>.tar.gz
 *   node scripts/backup.mjs /path/to/out.tar.gz
 *
 * 恢复：停服务 → 挪走/删除 data/ → tar -xzf 解压到 data/ → 启动。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

/** 随数据一起打包的媒体目录（不存在就跳过） */
const MEDIA_DIRS = ['originals', 'proxies', 'vocals', 'works'];

function fail(message) {
  process.stderr.write(`✖ ${message}\n`);
  process.exit(1);
}

function readable(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** SQL 字符串字面量：单引号翻倍 */
function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

const dbFile = path.join(DATA_DIR, 'ktv.db');
if (!fs.existsSync(dbFile)) {
  fail(`找不到数据库 ${dbFile}——还没启动过服务？`);
}

const outputArg = process.argv[2];
const backupsDir = path.join(ROOT, 'backups');
const outputPath = outputArg
  ? path.resolve(outputArg)
  : path.join(backupsDir, `openktv-${timestamp()}.tar.gz`);

// 输出不能落在数据目录里：tar 会把正在写的备份文件自己也打进去
if (outputPath === DATA_DIR || outputPath.startsWith(DATA_DIR + path.sep)) {
  fail(`备份文件不能放在数据目录里（${DATA_DIR}），换个位置，比如 ${backupsDir}`);
}

const staging = path.join(DATA_DIR, 'tmp', `backup-${timestamp()}`);
fs.mkdirSync(staging, { recursive: true });

let db = null;
try {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // 1. 一致快照：VACUUM INTO 在在线数据库上也能跑（WAL 读者不阻塞写者），
  //    产物包含 WAL 里尚未合并的写入。目标文件必须不存在。
  db = new DatabaseSync(dbFile);
  const snapshot = path.join(staging, 'ktv.db');
  db.exec(`VACUUM INTO ${sqlLiteral(snapshot)}`);
  db.close();
  db = null;

  // 2. 快照完整性检查：备份的价值全在「恢复出来是好的」。
  //    查的是快照本身而不是在线库 —— 要保证的是拷走的这份能用。
  const verify = new DatabaseSync(snapshot);
  const row = verify.prepare('PRAGMA quick_check').get();
  verify.close();
  const verdict = Object.values(row)[0];
  if (verdict !== 'ok') {
    fail(`数据库快照完整性检查没通过：${verdict}`);
  }

  // 3. 打包：快照 + 实际存在的媒体目录。
  //    两个 -C 各管后面的参数：ktv.db 来自 staging，媒体目录来自 DATA_DIR
  //    （tar 的 -C 不是全局开关，放中间就能分段切换根目录）。
  const mediaDirs = MEDIA_DIRS.filter((dir) => fs.existsSync(path.join(DATA_DIR, dir)));
  const tar = spawnSync('tar', ['-czf', outputPath, '-C', staging, 'ktv.db', '-C', DATA_DIR, ...mediaDirs], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (tar.status !== 0) {
    fail(`tar 打包失败：${tar.stderr?.toString().trim() || '未知错误'}`);
  }

  const size = fs.statSync(outputPath).size;
  process.stdout.write(`✔ 备份完成：${outputPath}（${readable(size)}）\n`);
  process.stdout.write(`  内容：ktv.db（快照）/ ${mediaDirs.join(' / ')}\n`);
  process.stdout.write('  恢复：停服务 → 清空 data/ → 解压到 data/ → 启动\n');
} finally {
  db?.close();
  fs.rmSync(staging, { recursive: true, force: true });
}
