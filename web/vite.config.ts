import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite dev server 配置
 *
 * 1. /api 代理到本地 server（避免 CORS）
 * 2. COOP/COEP 响应头：让 onnxruntime-web 启用 WASM 多线程
 *    （SharedArrayBuffer 需要 cross-origin isolation）
 * 3. server.fs 允许上级目录，方便 monorepo 调试
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  build: {
    target: 'esnext',
  },
});
