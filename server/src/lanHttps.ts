//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { createServer, type Server } from 'node:https';
import type { Express } from 'express';
import { HOST, HTTPS_PORT, LAN_HTTPS, DEV_MODE } from './config.ts';
import { createLogger } from './logger.ts';
import { ensureLanCert } from './lanCert.ts';

const log = createLogger('lan-https');

/**
 * 手机端 HTTPS 镜像。
 *
 * 背景（README「手机演唱」有同样一份说明）：手机浏览器只在安全上下文里开放
 * 麦克风，而 `http://192.168.x.x` 不算安全上下文（W3C Secure Contexts §3.1
 * 只豁免 https / 127.0.0.0/8 / localhost / file）。所以给手机单独开一条
 * TLS 通道：同一个 Express 实例、同一份数据，只是多一个端口。
 *
 *  · 只在**生产模式**起：开发模式的手机入口是 Vite 自己（VITE_HTTPS=1），
 *    由 vite.config.ts 读同一份证书，避免两个服务器抢着写证书文件；
 *  · HOST 绑回环（本机自用）时不起 —— 手机根本连不进来；
 *  · 端口被占 / openssl 缺失都只告警：手机不能录音，但桌面毫无影响。
 */

export interface LanHttpsState {
  /** 镜像是否正在监听 */
  running: boolean;
  /** 实际监听端口（没起时为 null） */
  port: number | null;
  /** 起不来的原因（正常为 null） */
  reason: string | null;
  /** 是不是自签名证书（手机首次要手动信任） */
  selfSigned: boolean;
}

let state: LanHttpsState = {
  running: false,
  port: null,
  reason: null,
  selfSigned: false,
};

let server: Server | null = null;

/** 当前是否该起镜像（纯判断，方便单测与日志） */
export function shouldStartLanHttps(): boolean {
  if (DEV_MODE) return false;
  if (!LAN_HTTPS) return false;
  return !isLoopbackHost();
}

/** HOST 是不是回环（手机连不进来那种） */
export function isLoopbackHost(): boolean {
  return HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
}

export function lanHttpsState(): LanHttpsState {
  return state;
}

/** 起镜像；幂等，返回最终状态 */
export async function startLanHttpsMirror(app: Express): Promise<LanHttpsState> {
  if (state.running) return state;
  if (!shouldStartLanHttps()) {
    state = { running: false, port: null, reason: null, selfSigned: false };
    return state;
  }

  const cert = await ensureLanCert();
  if (!cert) {
    state = {
      running: false,
      port: null,
      reason: '拿不到自签名证书（openssl 不在 PATH？）',
      selfSigned: false,
    };
    log.warn('手机 HTTPS 入口没起来：拿不到自签名证书', { hint: '装好 openssl 后重启即可恢复' });
    return state;
  }

  const instance = createServer({ key: cert.key, cert: cert.cert }, app);

  await new Promise<void>((resolve) => {
    instance.once('error', (error: NodeJS.ErrnoException) => {
      state = {
        running: false,
        port: null,
        reason:
          error.code === 'EADDRINUSE'
            ? `端口 ${HTTPS_PORT} 已被占用`
            : `HTTPS 服务启动失败：${error.message}`,
        selfSigned: false,
      };
      log.warn('手机 HTTPS 入口没起来', { port: HTTPS_PORT, error });
      resolve();
    });
    instance.listen(HTTPS_PORT, '0.0.0.0', () => {
      // HTTPS_PORT 可能是 0（测试要随机空闲端口）：以真实监听端口为准
      const address = instance.address();
      const port = address && typeof address === 'object' ? address.port : HTTPS_PORT;
      server = instance;
      state = {
        running: true,
        port,
        reason: null,
        selfSigned: true,
      };
      log.info(`手机 HTTPS 入口已就绪：https://<局域网IP>:${port}/m（自签名证书，首次需手动信任）`);
      resolve();
    });
  });

  return state;
}

/** 关掉镜像（服务退出时调用；没起过就是空操作） */
export async function stopLanHttpsMirror(): Promise<void> {
  const instance = server;
  server = null;
  state = { running: false, port: null, reason: null, selfSigned: false };
  if (!instance) return;
  await new Promise<void>((resolve) => {
    instance.close(() => resolve());
    instance.closeAllConnections();
  });
}
