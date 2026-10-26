import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite dev / preview server 配置
 *
 * 1. /api 代理到本地 server（避免 CORS）；dev 与 preview 保持一致
 * 2. COOP/COEP 响应头：让 onnxruntime-web 启用 WASM 多线程
 *    （SharedArrayBuffer 需要 cross-origin isolation；dev 与 preview 都注入）
 * 3. transformers 排除预构建（其内部 ORT 资源需按运行时路径加载）
 */
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const apiProxy = {
  '/api': {
    target: 'http://localhost:3001',
    changeOrigin: true,
  },
} as const;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: apiProxy,
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    port: 4173,
    host: true,
    // preview 与 dev 使用同一套代理，保证构建产物验收口径一致
    proxy: apiProxy,
    headers: crossOriginIsolationHeaders,
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  build: {
    target: 'esnext',
  },
});
