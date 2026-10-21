//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { Router } from 'express';
import QRCode from 'qrcode';
import type { NetworkInfo, NetworkReasonCode } from '../../../shared/types.ts';
import {
  ACCESS_TOKEN,
  DEV_MODE,
  LAN_HTTPS,
  MOBILE_PATH,
  PORT,
  VITE_HTTPS,
  WEB_PORT,
} from '../config.ts';
import { createLogger } from '../logger.ts';
import { fail } from '../httpError.ts';
import { buildLanUrl, lanAddresses } from '../lan.ts';
import { lanCertFile } from '../lanCert.ts';
import { isLoopbackHost, lanHttpsState } from '../lanHttps.ts';

const log = createLogger('network');

/**
 * 手机端入口：地址探测 + 二维码。
 *
 * 三个端点都只读、无副作用：
 *   GET /api/network        地址与入口现状（桌面 QR 卡片的数据源）
 *   GET /api/network/qr.svg mobileUrl 的二维码（SVG，<img> 直接用）
 *   GET /api/network/cert.crt  自签名证书（iPhone 想彻底信任时装它）
 *
 * 入口怎么选（按优先级）：
 *   1. 开发模式 + VITE_HTTPS=1 → https://<ip>:WEB_PORT/m（Vite 的 TLS）
 *   2. 生产模式 + 镜像在跑      → https://<ip>:HTTPS_PORT/m（自签名）
 *   3. 兜底                    → http://<ip>:PORT/m，并标记 micBlocked
 */

/** 二维码按「地址集合 + 目标 URL」缓存：开机不变，没必要每次重新编码 */
let qrCache: { key: string; svg: string } | null = null;

function qrSvgFor(url: string): Promise<string> {
  const key = url;
  if (qrCache && qrCache.key === key) return Promise.resolve(qrCache.svg);
  return QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    // 手机扫桌面上的码：320px 足够大又不用占满卡片
    width: 320,
  }).then((svg) => {
    qrCache = { key, svg };
    return svg;
  });
}

/** 当前手机入口的协议/端口；null = 没有可用入口 */
function mobileOrigin(): { scheme: 'http' | 'https'; port: number } | null {
  // 只绑了回环：手机根本连不进来，别指路
  if (isLoopbackHost()) return null;
  if (DEV_MODE) {
    // 开发模式：Vite 是唯一前端。开了 VITE_HTTPS 手机才有安全上下文
    return VITE_HTTPS ? { scheme: 'https', port: WEB_PORT } : { scheme: 'http', port: WEB_PORT };
  }
  const mirror = lanHttpsState();
  if (mirror.running && mirror.port) return { scheme: 'https', port: mirror.port };
  if (LAN_HTTPS) return null; // 该起没起起来（证书/端口问题），别给假入口
  return { scheme: 'http', port: PORT };
}

export function networkInfo(): NetworkInfo {
  const lanAddresses_ = lanAddresses();
  const origin = mobileOrigin();
  const mobileUrls = origin
    ? lanAddresses_.map((address) => buildLanUrl(address, origin.scheme, origin.port, MOBILE_PATH))
    : [];

  // 配了访问令牌时，把令牌直接编进手机入口地址：扫码即用，不需要用户手输。
  // 桌面端走回环不过这一关，所以二维码里带令牌不影响电脑使用。
  const withToken = (url: string): string =>
    ACCESS_TOKEN ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(ACCESS_TOKEN)}` : url;

  // 只给机器可读码，句子由前端按语言拼（见 locales/*/mobile.ts 的 mobile.reason.*）
  let reasonCode: NetworkReasonCode | null = null;
  if (isLoopbackHost()) {
    reasonCode = 'loopback_only';
  } else if (lanAddresses_.length === 0) {
    reasonCode = 'no_lan_address';
  } else if (!origin) {
    reasonCode = 'https_mirror_down';
  } else if (origin.scheme === 'http') {
    reasonCode = 'http_entry';
  }

  const selfSigned = origin?.scheme === 'https';
  return {
    lanAddresses: lanAddresses_,
    mobilePath: MOBILE_PATH,
    mobileOrigin: origin,
    mobileUrl: mobileUrls[0] ? withToken(mobileUrls[0]) : null,
    mobileUrls: mobileUrls.map(withToken),
    selfSigned,
    micBlocked: origin?.scheme === 'http',
    tokenRequired: Boolean(ACCESS_TOKEN),
    reasonCode,
  };
}

export function createNetworkRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(networkInfo());
  });

  router.get('/qr.svg', async (_req, res) => {
    const info = networkInfo();
    if (!info.mobileUrl) {
      fail(res, 404, 'mobile_entry_unavailable');
      return;
    }
    try {
      const svg = await qrSvgFor(info.mobileUrl);
      res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
    } catch (error) {
      log.error('生成二维码失败', { error });
      fail(res, 500, 'qr_generation_failed');
    }
  });

  /** 自签名证书下载：iPhone 上装完还要去「证书信任设置」里手动打开 */
  router.get('/cert.crt', (_req, res) => {
    const file = lanCertFile();
    if (!file) {
      fail(res, 404, 'certificate_unavailable');
      return;
    }
    res.type('application/x-x509-ca-cert').sendFile(file);
  });

  return router;
}
