//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CERT_DIR, DATA_DIR } from './config.ts';
import { createLogger } from './logger.ts';
import { lanAddresses } from './lan.ts';

const log = createLogger('cert');

/** 证书/私钥文件名与记录覆盖地址的侧车文件（都在 CERT_DIR 下） */
const KEY_FILE = 'lan-key.pem';
const CERT_FILE = 'lan-cert.pem';
const META_FILE = 'lan-cert.json';

/** 有效期：10 年。自用局域网证书，过期提醒没有意义，干脆给到用不动 */
const CERT_DAYS = 3650;

export interface LanCert {
  /** PEM 私钥内容 */
  key: string;
  /** PEM 证书内容 */
  cert: string;
  /** 证书覆盖的局域网地址（手机该用哪个 IP 连，全在里面） */
  addresses: string[];
}

interface CertMeta {
  addresses: string[];
  generatedAt: number;
}

function certPaths() {
  return {
    dir: CERT_DIR,
    key: path.join(CERT_DIR, KEY_FILE),
    cert: path.join(CERT_DIR, CERT_FILE),
    meta: path.join(CERT_DIR, META_FILE),
  };
}

function readMeta(file: string): CertMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CertMeta>;
    if (!Array.isArray(parsed.addresses)) return null;
    return { addresses: parsed.addresses.map(String), generatedAt: Number(parsed.generatedAt) || 0 };
  } catch {
    return null;
  }
}

/** 两个地址集合是否一致（顺序无关）—— 决定要不要重签 */
function sameAddresses(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((address) => set.has(address));
}

/**
 * 用 openssl 签一张自签名证书。
 *
 * SAN 走**临时配置文件**而不是 `-addext`：macOS 自带的 LibreSSL 2.5 不支持
 * `-addext`，而配置文件写法在 LibreSSL / OpenSSL 上都能用。
 * 覆盖 127.0.0.1、localhost 和当前所有局域网 IPv4 —— 手机用其中任何一个
 * 地址连进来都不会再报「名称不匹配」。
 */
function runOpenssl(addresses: string[]): Promise<{ key: string; cert: string }> {
  const { dir, key: keyPath, cert: certPath } = certPaths();
  const san = ['IP:127.0.0.1', 'DNS:localhost', ...addresses.map((address) => `IP:${address}`)].join(',');
  const config = [
    '[req]',
    'distinguished_name = dn',
    'x509_extensions = v3_req',
    'prompt = no',
    '[dn]',
    'CN = Open KTV LAN',
    '[v3_req]',
    `subjectAltName = ${san}`,
    'basicConstraints = critical,CA:FALSE',
    'extendedKeyUsage = serverAuth',
    '',
  ].join('\n');

  // 临时 cnf 放在证书目录里：同分区、用完就删，失败也不留垃圾
  fs.mkdirSync(dir, { recursive: true });
  const cnfPath = path.join(dir, 'openssl.cnf');
  fs.writeFileSync(cnfPath, config, 'utf8');

  return new Promise<{ key: string; cert: string }>((resolve, reject) => {
    execFile(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-sha256',
        '-days',
        String(CERT_DAYS),
        '-nodes',
        '-config',
        cnfPath,
        '-keyout',
        keyPath,
        '-out',
        certPath,
      ],
      { timeout: 30_000 },
      (error, _stdout, stderr) => {
        try {
          fs.rmSync(cnfPath, { force: true });
        } catch {
          // 清理失败不影响主流程
        }
        if (error) {
          reject(new Error(`openssl 生成证书失败：${error.message}${stderr ? `（${stderr.trim()}）` : ''}`));
          return;
        }
        resolve({
          key: fs.readFileSync(keyPath, 'utf8'),
          cert: fs.readFileSync(certPath, 'utf8'),
        });
      },
    );
  });
}

/**
 * 取一份可用的自签名证书（没有就现签，地址变了就重签）。
 *
 * 返回 null 表示「拿不到证书」——openssl 不在 PATH、磁盘写不进去等等。
 * 调用方必须能容忍 null：HTTPS 镜像起不来只是手机不能录音，
 * 主服务（http）一点不受影响。
 *
 * @param addresses 覆盖要覆盖的局域网地址（测试用）；省略 = 用 os.networkInterfaces() 现查
 */
export async function ensureLanCert(addresses?: string[]): Promise<LanCert | null> {
  const paths = certPaths();
  const covered = addresses ?? lanAddresses();

  // 一个局域网地址都没有（没连 WiFi）也签：至少 localhost 能用，
  // 而且开发模式 VITE_HTTPS 也指着这份证书
  try {
    fs.mkdirSync(paths.dir, { recursive: true });
  } catch (error) {
    log.warn('建不了证书目录，手机 HTTPS 入口不可用', { dir: paths.dir, error });
    return null;
  }

  const meta = readMeta(paths.meta);
  if (
    meta &&
    sameAddresses(meta.addresses, covered) &&
    fs.existsSync(paths.key) &&
    fs.existsSync(paths.cert)
  ) {
    try {
      return {
        key: fs.readFileSync(paths.key, 'utf8'),
        cert: fs.readFileSync(paths.cert, 'utf8'),
        addresses: meta.addresses,
      };
    } catch {
      // 文件被外部删了：落到下面重新签
    }
  }

  const reason =
    meta === null
      ? '首次启动'
      : `局域网地址变了（${meta.addresses.join(', ') || '无'} → ${covered.join(', ') || '无'}）`;
  log.info('正在生成局域网自签名证书', { reason, addresses: covered, dir: paths.dir });

  try {
    const { key, cert } = await runOpenssl(covered);
    fs.writeFileSync(paths.meta, JSON.stringify({ addresses: covered, generatedAt: Date.now() }, null, 2), 'utf8');
    log.info('局域网自签名证书已就绪', { cert: paths.cert, addresses: covered, dataDir: DATA_DIR });
    return { key, cert, addresses: covered };
  } catch (error) {
    log.warn('拿不到自签名证书，手机 HTTPS 入口不可用（装好 openssl 后可恢复）', { error });
    return null;
  }
}

/** 证书文件是否已经存在（给 /api/network/cert.crt 用） */
export function lanCertFile(): string | null {
  const { cert } = certPaths();
  return fs.existsSync(cert) ? cert : null;
}

/** 供测试/日志：证书目录 */
export function lanCertDir(): string {
  return certPaths().dir;
}

/** 当前系统是否有 openssl（测试用来决定跳过） */
export function hasOpenssl(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('openssl', ['version'], { timeout: 5_000 }, (error) => resolve(!error));
  });
}
