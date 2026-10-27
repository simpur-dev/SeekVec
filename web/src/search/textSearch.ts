/**
 * 文本检索核心流程（与 React 解耦，供 useSearch / window.__seekvecEval 共用）
 *
 * 分段计时口径（perf 事件）：
 * - query.embed：端侧 query 向量化
 * - query.http：/api/search HTTP 往返
 * - db.search：SeekDB 库内检索（server timings.dbMs）
 * - query.e2e：由调用方补齐（UI=渲染后双 rAF；评测栈=调用返回）
 */
import type { Backend, Dtype, ModelKey, SearchResult } from '../types';
import { search } from '../db/api';
import { recordPerf } from '../perf/metrics';

export interface TextSearchParams {
  collectionName: string;
  query: string;
  keyword?: string;
  nResults?: number;
  embed: (texts: string[]) => Promise<number[][]>;
  modelKey: ModelKey;
  backend?: Backend | null;
  dtype?: Dtype | null;
  /** 调用方取消信号：模型/集合切换或新查询时中止 HTTP */
  signal?: AbortSignal;
}

export interface TextSearchOutcome {
  result: SearchResult;
  /** 本次检索开始时间（performance.now()），调用方据此计算端到端耗时 */
  startedAt: number;
}

/** 执行一次文本检索：端侧向量化 + server 检索，返回带分段耗时的结果 */
export async function runTextSearch(params: TextSearchParams): Promise<TextSearchOutcome> {
  const startedAt = performance.now();
  const throwIfAborted = () => {
    if (!params.signal?.aborted) return;
    const err = new Error('检索已取消');
    err.name = 'AbortError';
    throw err;
  };
  throwIfAborted();

  const embedStart = performance.now();
  const vectors = await params.embed([params.query]);
  throwIfAborted();
  const embeddingMs = performance.now() - embedStart;
  recordPerf('query.embed', embeddingMs, {
    modelKey: params.modelKey,
    backend: params.backend ?? undefined,
    dtype: params.dtype ?? undefined,
    meta: { queryLength: params.query.length },
  });

  const result = await search({
    collectionName: params.collectionName,
    queryEmbedding: vectors[0],
    nResults: params.nResults,
    keyword: params.keyword,
    ...(params.signal ? { signal: params.signal } : {}),
  });

  const httpMs = result.httpMs ?? result.latencyMs;
  recordPerf('query.http', httpMs, {
    modelKey: params.modelKey,
    backend: params.backend ?? undefined,
    dtype: params.dtype ?? undefined,
    meta: { mode: result.mode ?? null, hits: result.hits.length },
  });

  const dbMs = result.dbMs ?? result.timings?.dbMs;
  if (typeof dbMs === 'number') {
    recordPerf('db.search', dbMs, {
      modelKey: params.modelKey,
      meta: { mode: result.mode ?? null, hits: result.hits.length },
    });
  }

  const mode = result.mode ?? (params.keyword?.trim() ? 'hybrid' : 'vector');
  const e2eMs = Math.round(performance.now() - startedAt);
  const merged: SearchResult = {
    ...result,
    embeddingMs,
    httpMs,
    mode,
    e2eMs,
  };
  return { result: merged, startedAt };
}
