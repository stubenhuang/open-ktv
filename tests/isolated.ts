import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 给需要碰磁盘的测试（db / mixJob / http）准备一个临时的 DATA_DIR。
 *
 * 关键时序：`config.ts` 在**模块加载时**就读 DATA_DIR 算出路径，
 * 所以必须先调 createIsolatedDataDir() 设好环境变量，再动态 import 业务模块
 * （静态 import 会被提升到环境变量赋值之前执行，指到真实 data/ 上）。
 */
export async function createIsolatedDataDir(prefix: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `open-ktv-${prefix}-`));
  process.env.DATA_DIR = dir;
  return dir;
}

export async function removeIsolatedDataDir(dir: string): Promise<void> {
  delete process.env.DATA_DIR;
  await fs.promises.rm(dir, { recursive: true, force: true });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
