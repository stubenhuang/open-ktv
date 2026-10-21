//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { ensureLanCert } from './server/src/lanCert.ts';

/**
 * 开发时 Vite 跑 WEB_PORT（默认 5173），把 /api 代理到 Node 服务的 PORT（默认 8787）；
 * 生产时由 Node 直接托管 web/dist。
 *
 * 两个端口都从环境变量读，跟 server/src/config.ts 保持一致 ——
 * 否则 PORT=9000 时前端还在往 8787 发请求（openktv.sh 依赖这一点）。
 */
const apiPort = Number(process.env.PORT ?? 8787);
const webPort = Number(process.env.WEB_PORT ?? 5173);

/**
 * 开发模式的 TLS 开关（默认开）。
 *
 * 为什么开发模式也要 HTTPS：手机浏览器只在安全上下文里开放麦克风，
 * `http://192.168.x.x` 不算（W3C Secure Contexts §3.1）。生产模式由 Node 服务
 * 起一条 HTTPS 镜像（server/src/lanHttps.ts）；开发模式没有那条镜像，
 * 手机入口就是 Vite 自己，所以 Vite 默认也上 TLS —— 证书与镜像共用
 * data/certs 下的同一份。`VITE_HTTPS=0` 可整体关掉（桌面开发回到纯 http，
 * 但手机不能录音）。
 *
 * 注意：开了之后桌面开发地址是 https://127.0.0.1:5173，首次会有一次
 * 自签名证书警告，点「高级 → 继续访问」即可。
 */
const viteHttps = (process.env.VITE_HTTPS ?? '1') !== '0';

export default defineConfig(async () => {
  const lanCert = viteHttps ? await ensureLanCert() : null;
  if (viteHttps && !lanCert) {
    // 不抛：开发服务照样起（退回 http），只是手机不能录音（页面上会说明原因）
    process.emitWarning('Vite 拿不到自签名证书（没装 openssl？），开发服务将退回 http，手机端无法使用麦克风');
  }

  return {
    root: 'web',
    plugins: [react()],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      /*
       * 绑所有地址（IPv4 + IPv6）：手机要能通过局域网 IP 连进来，
       * 同时 127.0.0.1 / ::1 也照旧可用 —— 之前写死 127.0.0.1 是为了规避
       * 「localhost 只解析到 ::1」的坑，host: true 把这个坑一起cover了。
       */
      host: true,
      port: webPort,
      // 端口被占就直接报错，而不是悄悄换一个 —— 否则 openktv.sh 报的地址是错的
      strictPort: true,
      // 手机端录音需要安全上下文：开了 VITE_HTTPS 才挂证书（HMR 自动走 wss）
      https: lanCert ? { key: lanCert.key, cert: lanCert.cert } : undefined,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: false,
        },
      },
    },
  };
});
