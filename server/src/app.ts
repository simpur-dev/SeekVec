/**
 * Express app 工厂
 *
 * - `createApp()` 只组装中间件与路由，不监听端口、不主动连数据库，
 *   因此 supertest 可以直接 `request(createApp())` 做契约测试
 * - 真正启动/关闭（ensureDatabase、连接检查、listen、SIGINT）在 index.ts
 *
 * 中间件顺序：requestId → 请求日志 → CORS → JSON 解析 → 路由 → 404 → 错误中间件
 */
import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express } from 'express';
import { SERVER_CONFIG } from './config.js';
import { collectionsRouter } from './routes/collection.js';
import { documentsRouter } from './routes/document.js';
import { searchRouter } from './routes/search.js';
import { imageRouter } from './routes/image.js';
import { createHealthRouter } from './routes/health.js';
import { errorHandler, notFoundHandler, requestIdOf } from './routes/errors.js';
import { elapsedMs, nowMs } from './util/timing.js';

export const REQUEST_ID_HEADER = 'x-request-id';

export interface CreateAppOptions {
  /** 覆盖 CORS 白名单（测试/嵌入场景用） */
  corsOrigins?: string[];
  /** 是否打印 `[api] METHOD PATH STATUS ms requestId` 请求日志（测试可关闭） */
  logRequests?: boolean;
}

/** 组装 Express 应用（纯函数，无副作用：不 listen、不连 DB） */
export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  const corsOrigins = options.corsOrigins
    ? [...options.corsOrigins]
    : [...SERVER_CONFIG.corsOrigins];
  const logRequests = options.logRequests ?? true;

  // 不暴露 Express 指纹
  app.disable('x-powered-by');

  // 1) requestId：透传入站 x-request-id，便于前端/网关串联日志
  app.use((req, res, next) => {
    const incoming = req.header(REQUEST_ID_HEADER);
    const requestId =
      incoming && incoming.trim().length > 0 ? incoming.trim().slice(0, 128) : randomUUID();
    res.locals.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  });

  // 2) 请求日志：[api] METHOD PATH STATUS ms requestId
  if (logRequests) {
    app.use((req, res, next) => {
      const startedAt = nowMs();
      res.on('finish', () => {
        const path = req.originalUrl.split('?')[0];
        console.log(
          `[api] ${req.method} ${path} ${res.statusCode} ${elapsedMs(startedAt)}ms ${requestIdOf(res)}`,
        );
      });
      next();
    });
  }

  // 3) CORS 白名单（已 trim）与 JSON body（上限 20mb，向量批量导入够用）
  app.use(cors({ origin: corsOrigins, credentials: false }));
  app.use(express.json({ limit: '20mb' }));

  // 4) 业务路由
  app.use('/api/health', createHealthRouter());
  app.use('/api/collections', collectionsRouter);
  app.use('/api/documents', documentsRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/images', imageRouter);

  // 5) 未匹配路由 → JSON 404；所有错误 → 统一错误中间件
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
