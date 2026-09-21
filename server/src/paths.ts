import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';

export const ORIGINALS_DIR = path.join(DATA_DIR, 'originals');
export const PROXIES_DIR = path.join(DATA_DIR, 'proxies');
export const VOCALS_DIR = path.join(DATA_DIR, 'vocals');
export const WORKS_DIR = path.join(DATA_DIR, 'works');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const DB_FILE = path.join(DATA_DIR, 'ktv.db');

const ALL_DIRS = [DATA_DIR, ORIGINALS_DIR, PROXIES_DIR, VOCALS_DIR, WORKS_DIR, TMP_DIR];

export function ensureDirs(): void {
  for (const dir of ALL_DIRS) fs.mkdirSync(dir, { recursive: true });
}

/** 清空临时目录（启动时调用，避免上次崩溃留下的垃圾） */
export function cleanTmpDir(): void {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
}
