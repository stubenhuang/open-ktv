import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { LIBRARY_BLOCK_PRIVATE_NET } from '../config.ts';

/**
 * 曲库地址的私网拦截（opt-in，见 config.ts 的 LIBRARY_BLOCK_PRIVATE_NET）。
 *
 * 威胁模型：曲库清单是**外部数据** —— 条目里的 url 可以指向任何地址，
 * 包括这台机器/内网里的其他服务（云元数据 169.254.169.254、路由器管理页、
 * NAS 后台…）。服务端会替用户去 fetch 这些地址，这就是经典的 SSRF 面。
 *
 * 为什么默认关：README 明确宣传「NAS / 对象存储 / 局域网 HTTP 都能当源用」，
 * 那些恰恰是私网地址。默认拦截等于把宣传出去的功能打死，所以只做开关。
 *
 * 拦截范围（IPv4）：
 *   127.0.0.0/8  回环      10.0.0.0/8      私网      172.16.0.0/12  私网
 *   192.168.0.0/16 私网    169.254.0.0/16  链路本地  100.64.0.0/10  CGNAT
 *   0.0.0.0/8    未指定
 * （IPv6）：::1、::、fc00::/7（唯一本地）、fe80::/10（链路本地）。
 * 域名一律 DNS 解析后按上面判；解析不了按私网处理（保守拒绝）。
 */

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return true;
  const octets = parts.map((part) => Number(part));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = octets as [number, number, number, number];
  if (a === 127 || a === 0) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // fc00::/7（唯一本地）与 fe80::/10（链路本地）看前几个十六进制位
  if (/^f[cd]/.test(lower)) return true;
  if (/^fe[89ab]/.test(lower)) return true;
  return false;
}

/** 一个 IP 字面量是否落在私网/回环/链路本地区间 */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) {
    // IPv4-mapped（::ffff:192.168.1.1）：剥壳后按 v4 判
    const mapped = ip.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPrivateIpv4(mapped[1]!);
    return isPrivateIpv6(ip);
  }
  // 不是合法 IP：按私网处理，让调用方拒绝
  return true;
}

/**
 * 这个 URL 是否「公网 http(s)」。
 *
 * 域名会真做一次 DNS 解析（`all: true` 拿全部地址，任何一个落在私网就拒）——
 * 只查第一个地址是不够的：轮询 DNS 可以给出混合记录。解析失败同样拒绝。
 */
export async function isPublicHttpUrl(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return !isPrivateAddress(host);

  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0) return false;
    return addresses.every((entry) => !isPrivateAddress(entry.address));
  } catch {
    return false;
  }
}

/** 开关没开时永远放行（零成本、零行为变化） */
export async function assertPublicHttpUrl(url: string): Promise<void> {
  if (!LIBRARY_BLOCK_PRIVATE_NET) return;
  if (await isPublicHttpUrl(url)) return;
  throw new Error(
    `地址被拒绝（指向私网或无法解析）：${url}。` +
      'LIBRARY_BLOCK_PRIVATE_NET=1 下不允许曲库访问内网地址；' +
      '如果你的源本来就在内网（NAS 等），把这个开关关掉。',
  );
}

/** 供测试与调试：当前开关状态 */
export function privateNetBlockingEnabled(): boolean {
  return LIBRARY_BLOCK_PRIVATE_NET;
}
