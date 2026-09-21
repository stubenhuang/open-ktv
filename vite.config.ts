import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 开发时 Vite 跑 WEB_PORT（默认 5173），把 /api 代理到 Node 服务的 PORT（默认 8787）；
 * 生产时由 Node 直接托管 web/dist。
 *
 * 两个端口都从环境变量读，跟 server/src/config.ts 保持一致 ——
 * 否则 PORT=9000 时前端还在往 8787 发请求（openktv.sh 依赖这一点）。
 */
const apiPort = Number(process.env.PORT ?? 8787);
const webPort = Number(process.env.WEB_PORT ?? 5173);

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // 显式绑 IPv4：某些环境下 localhost 只解析到 ::1，会导致 127.0.0.1 连不上
    host: '127.0.0.1',
    port: webPort,
    // 端口被占就直接报错，而不是悄悄换一个 —— 否则 openktv.sh 报的地址是错的
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
});
