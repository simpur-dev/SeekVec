/**
 * SeekVec server 入口
 *
 * - Express HTTP API
 * - seekdb-js 嵌入式客户端（懒初始化）
 * - 严格遵守「端侧向量化」：server 只做存储与检索，禁止调用任何 embedding/ONNX 推理
 */
import express from 'express';
import cors from 'cors';
import { SERVER_CONFIG } from './config.js';
import { collectionsRouter } from './routes/collection.js';
import { documentsRouter } from './routes/document.js';
import { searchRouter } from './routes/search.js';
import { imageRouter } from './routes/image.js';
import {
  getClient,
  closeClient,
  describeConnection,
  ensureDatabase,
} from './db/client.js';

const app = express();

app.use(
  cors({
    origin: SERVER_CONFIG.corsOrigins,
    credentials: false,
  }),
);
app.use(express.json({ limit: '20mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

app.use('/api/collections', collectionsRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/search', searchRouter);
app.use('/api/images', imageRouter);

async function start() {
  // 建库（仅 server 模式需要；嵌入式 database 自动创建）
  await ensureDatabase();

  // 启动时建连并做真实连通性检查，seekdb 不可达则立刻报错退出
  const client = await getClient();
  await client.execute('SELECT 1');
  console.log(`[server] seekdb-js connected: ${describeConnection()}`);

  app.listen(SERVER_CONFIG.port, () => {
    console.log(`[server] http api listening on http://localhost:${SERVER_CONFIG.port}`);
  });
}

async function shutdown() {
  console.log('\n[server] shutting down');
  await closeClient();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
