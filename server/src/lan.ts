//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import os from 'node:os';

/**
 * 局域网地址探测。
 *
 * 手机要通过 WiFi 连进来，得知道这台机器在局域网里的 IP。这里只取
 * **非内部（non-internal）的 IPv4**：
 *
 *  · 内部地址（127.0.0.0/8）手机连不上，列出来只会让人困惑；
 *  · 链路本地（169.254.x.x）是网线没插好时的自管理地址，同样没用；
 *  · IPv6 局域网地址暂时不列：浏览器里要写成 `[fe80::1%en0]` 这种带域名的
 *    形式，二维码和手输都不友好，而自签名证书的 SAN 也难覆盖。
 */

/** os.networkInterfaces() 的单条记录（只要用得到的两个字段） */
export interface NetworkInterfaceLike {
  family?: string | number;
  address: string;
  internal: boolean | null;
}

/**
 * 从 os.networkInterfaces() 的结果里挑出局域网 IPv4（去重、保序）。
 *
 * 单独导出纯函数是为了能单测：os 的真实输出随机器而变，
 * 而「过滤规则」必须可验证。
 */
export function pickLanAddresses(interfaces: Record<string, NetworkInterfaceLike[]>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      // family 在不同 Node 版本可能是 'IPv4' 也可能是数字 4
      const family = String(entry.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (entry.internal) continue;
      const address = entry.address;
      if (!address || seen.has(address)) continue;
      seen.add(address);
      result.push(address);
    }
  }
  return result;
}

/** 当前机器的局域网 IPv4 列表；一个都没有（没连网）时返回空数组 */
export function lanAddresses(): string[] {
  return pickLanAddresses(os.networkInterfaces() as Record<string, NetworkInterfaceLike[]>);
}

/** 拼一个手机端入口地址；IPv6 字面量由调用方加方括号（目前只走 IPv4） */
export function buildLanUrl(address: string, scheme: 'http' | 'https', port: number, path: string): string {
  return `${scheme}://${address}:${port}${path}`;
}
