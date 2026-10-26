/**
 * HTTP 错误辅助 + 统一错误中间件
 *
 * 错误语义（契约）：
 * - 400 参数错误（validation.ts 抛出 HttpError(400, msg, code)）
 * - 404 资源不存在（集合不存在 / 路由不存在）
 * - 409 冲突（集合不兼容 / insert 模式重复 id）
 * - 503 连接类错误（seekdb 不可达）
 * - 500 其他；500 响应绝不回传原始 SQL / 内部堆栈，仅日志里保留
 *
 * 所有错误响应形状统一为 `{ error, code?, requestId }`。
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isConnectionError } from '../db/client.js';
import type { ErrorResponse } from '../types.js';

export class HttpError extends Error {
  readonly status: number;
  /** 稳定的机器可读错误码（如 DOCUMENT_EXISTS / COLLECTION_NOT_FOUND） */
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/** 从任意错误中提取 HTTP 状态码（默认 500） */
export function errorStatus(err: unknown): number {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status;
  const msg = err instanceof Error ? err.message : String(err);
  // seekdb SDK 在集合不存在时抛 "Collection not found: xxx"
  if (/collection not found/i.test(msg)) return 404;
  return 500;
}

/** 读取请求级 requestId（由 app.ts 的中间件写入 res.locals） */
export function requestIdOf(res: Response): string {
  const value = res.locals?.requestId;
  return typeof value === 'string' ? value : '';
}

/**
 * async 路由包装器：把 Promise rejection 交给统一错误中间件，
 * 避免 Express 4 下 async 抛错变成 unhandled rejection。
 */
export function asyncHandler(
  handler: (req: Request, res: Response) => Promise<unknown> | unknown,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void Promise.resolve()
      .then(() => handler(req, res))
      .catch(next);
  };
}

const DEFAULT_CODE_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  503: 'SEEKDB_UNAVAILABLE',
};

export interface MappedError {
  status: number;
  code: string;
  /** 可直接返回给客户端的文案（已脱敏） */
  message: string;
}

const INTERNAL_MESSAGE = '服务器内部错误';
const CONNECTION_MESSAGE = 'seekdb 连接不可用，请稍后重试';

function genericMessageFor(status: number): string {
  switch (status) {
    case 400:
      return '请求参数无效';
    case 404:
      return '资源不存在';
    case 409:
      return '资源冲突';
    default:
      return INTERNAL_MESSAGE;
  }
}

/** 把任意错误映射为「状态码 + 错误码 + 脱敏文案」 */
export function mapError(err: unknown): MappedError {
  const anyErr = err as
    | {
        type?: unknown;
        status?: unknown;
        statusCode?: unknown;
        name?: unknown;
        message?: unknown;
        code?: unknown;
      }
    | null
    | undefined;

  // express.json() 的 body-parser 错误
  if (anyErr?.type === 'entity.parse.failed') {
    return { status: 400, code: 'INVALID_JSON', message: '请求体不是合法 JSON' };
  }
  if (anyErr?.type === 'entity.too.large') {
    return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: '请求体过大' };
  }

  if (err instanceof HttpError) {
    const status = Number.isInteger(err.status) ? err.status : 500;
    // 5xx 只回传通用文案，避免把内部细节（SQL 等）泄漏给客户端
    const message = status >= 500 ? INTERNAL_MESSAGE : err.message;
    return {
      status,
      code: err.code ?? DEFAULT_CODE_BY_STATUS[status] ?? 'HTTP_ERROR',
      message,
    };
  }

  const name = typeof anyErr?.name === 'string' ? anyErr.name : '';
  const message = typeof anyErr?.message === 'string' ? anyErr.message : String(err);

  // 集合已存在但 schema 不兼容 → 409
  if (name === 'CollectionSchemaMismatchError') {
    return { status: 409, code: 'COLLECTION_SCHEMA_MISMATCH', message };
  }
  // 连接类错误优先于文本匹配（连接断开时的报错可能形似其它错误）
  if (isConnectionError(err)) {
    return { status: 503, code: 'SEEKDB_UNAVAILABLE', message: CONNECTION_MESSAGE };
  }
  // seekdb 集合不存在（SDK InvalidCollectionError: "Collection not found: xxx"）
  if (name === 'InvalidCollectionError' || /collection not found/i.test(message)) {
    return { status: 404, code: 'COLLECTION_NOT_FOUND', message };
  }
  // insert 模式重复主键（SDK/MySQL 原文：Duplicate entry '...' for key ...）
  if (/duplicate entry/i.test(message)) {
    return { status: 409, code: 'DOCUMENT_EXISTS', message: 'insert 模式下文档 id 已存在' };
  }
  // SDK 参数类错误（例如非法向量维度）→ 400
  if (name === 'SeekdbValueError' || name === 'InvalidArgumentError') {
    return { status: 400, code: 'INVALID_ARGUMENT', message };
  }
  if (typeof anyErr?.status === 'number' && anyErr.status >= 400 && anyErr.status < 500) {
    const status = anyErr.status;
    return {
      status,
      code: DEFAULT_CODE_BY_STATUS[status] ?? 'HTTP_ERROR',
      message: genericMessageFor(status),
    };
  }

  return { status: 500, code: 'INTERNAL_ERROR', message: INTERNAL_MESSAGE };
}

/** 统一错误中间件（必须注册在最后） */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const mapped = mapError(err);
  const requestId = requestIdOf(res);
  if (mapped.status >= 500) {
    // 完整错误只进日志（含 SQL/堆栈），不出现在响应里
    console.error(`[api] error ${mapped.code} requestId=${requestId}`, err);
  } else if (mapped.status === 503) {
    console.warn(`[api] unavailable requestId=${requestId}:`, (err as Error)?.message ?? err);
  }
  const body: ErrorResponse = { error: mapped.message, code: mapped.code, requestId };
  res.status(mapped.status).json(body);
}

/** 未匹配路由 → 统一 JSON 404（替代 Express 默认 HTML 404） */
export function notFoundHandler(req: Request, res: Response): void {
  const body: ErrorResponse = {
    error: `接口不存在: ${req.method} ${req.path}`,
    code: 'NOT_FOUND',
    requestId: requestIdOf(res),
  };
  res.status(404).json(body);
}
