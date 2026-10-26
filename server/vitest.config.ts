import { defineConfig } from 'vitest/config';

/**
 * server 端单测：只测不依赖 seekdb 连接的纯逻辑
 * （Schema 构建 / 错误映射 / 模型推断 / 连接错误识别）。
 *
 * server 源码使用 NodeNext 风格 `./foo.js` 相对引用，
 * 这里把 .js 后缀 alias 掉，让 Vite 解析到同名 .ts 文件。
 */
export default defineConfig({
  resolve: {
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: '$1' }],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
