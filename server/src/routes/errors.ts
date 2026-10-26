/**
 * HTTP 错误辅助：给路由层提供可映射到状态码的错误
 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
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
