/**
 * SeekVec server 入口
 *
 * 只负责启动/关闭：
 * - 建库（ensureDatabase）与启动时真实连通性检查（SELECT 1），不可达则退出
 * - 监听 HTTP 端口
 * - SIGINT/SIGTERM 优雅关闭（先停 HTTP，再关 seekdb 连接）
 *
 * HTTP 应用组装在 app.ts 的 createApp()，便于 supertest 复用。
 *
 * 合规：严格遵守「端侧向量化」——server 只做存储与检索，
 * 禁止调用任何本地推理库。
 */
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { SERVER_CONFIG } from './config.js';
import {
  closeClient,
  describeConnection,
  ensureDatabase,
  getClient,
} from './db/client.js';

let httpServer: Server | null = null;

async function start(): Promise<void> {
  // 建库（仅 server 模式需要；嵌入式 database 自动创建）
  await ensureDatabase();

  // 启动时建连并做真实连通性检查，seekdb 不可达则立刻报错退出
  const client = await getClient();
  await client.execute('SELECT 1');
  console.log(`[server] seekdb-js connected: ${describeConnection()}`);

  const app = createApp();
  httpServer = app.listen(SERVER_CONFIG.port, () => {
    console.log(`[server] http api listening on http://localhost:${SERVER_CONFIG.port}`);
  });
}

async function shutdown(): Promise<void> {
  console.log('\n[server] shutting down');
  if (httpServer) {
    await new Promise<void>((resolve) => {
      httpServer?.close(() => resolve());
    });
    httpServer = null;
  }
  await closeClient();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
