import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 离线环境：不使用外部 CDN，所有依赖本地化；worker 以 ES 模块打包
export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  server: {
    host: '0.0.0.0',
    port: 8080,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
