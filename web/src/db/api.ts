/**
 * HTTP API client：与本地 server 通信
 *
 * 所有路径 /api/* 都会被 Vite dev server 代理到 http://localhost:3001
 *
 * 约定（契约第 5 节）：
 * - 请求统一 60s 超时（AbortSignal），错误语义 400/404/409/503/500 由 server 保证
 * - 响应新增字段（mode/timings/refreshed）保证向后兼容：老 server 缺字段时前端按请求参数推算
 * - 新增集合详情 / 刷新 / 删除、文档 id 列表 / 删除接口
 */
import type {
  CollectionDetail,
  CollectionSummary,
  Modality,
  ModelKey,
  SearchHit,
  SearchMode,
  SearchResult,
  SearchTimings,
} from '../types';

/** 请求超时（契约：前端 fetch 60s） */
export const FETCH_TIMEOUT_MS = 60_000;

interface ServerCreateResponse {
  created: boolean;
  name: string;
  dimension: number;
}

interface ServerCollectionsResponse {
  collections: Array<{
    name: string;
    modelKey: ModelKey;
    dimension: 384 | 512;
    modality: Modality;
    count: number | null;
  }>;
}

interface ServerSearchResponse {
  ids: string[][];
  /** SDK 在混合检索下会对缺失文本补 null */
  documents?: Array<Array<string | null>>;
  metadatas?: Array<Array<Record<string, unknown> | null | undefined>>;
  distances?: Array<Array<number | null>>;
  scores?: Array<Array<number | null>>;
  /** server 新增：检索模式 */
  mode?: SearchMode;
  /** server 新增：分段耗时 */
  timings?: SearchTimings;
  knnK?: number;
}

/** nResults 必须为整数 1..50（server 严格校验，不允许 400） */
export function clampNResults(value: number | undefined, fallback = 10): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(50, Math.max(1, parsed));
}

export interface IngestTimings {
  upsertMs: number;
  refreshMs: number | null;
  totalMs: number;
}

export interface IngestDocumentsResponse {
  ok: boolean;
  count: number;
  mode: 'upsert' | 'insert';
  refreshed: boolean;
  timings?: IngestTimings;
}

export interface RefreshCollectionResponse {
  ok: boolean;
  timings: { refreshMs: number };
}

export interface DeleteCollectionResponse {
  ok: boolean;
  deleted: boolean;
}

export interface DocumentIdsResponse {
  ids: string[];
  count: number;
  /** GET ?withSource=1：一次返回全部 id + source，供导入后批量清理 */
  items?: Array<{ id: string; source?: string }>;
}

export interface DeleteDocumentsResponse {
  deleted: number;
}

/** GET /api/health 响应（server 契约第 5 节） */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  ts: number;
  seekdb: {
    reachable: boolean;
    latencyMs: number;
    version: string | null;
    refreshIndexSupported: boolean;
  };
}

function timeoutSignal(): AbortSignal | undefined {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(FETCH_TIMEOUT_MS);
    }
  } catch {
    // 某些环境不支持 AbortSignal.timeout；退回无超时
  }
  return undefined;
}

export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ((err as { name?: string }).name === 'AbortError' ||
      (err as { name?: string }).name === 'TimeoutError')
  );
}

/** 合并调用方取消信号与 60s 超时信号；不支持 AbortSignal.any 时以调用方信号为准。 */
function combineSignals(caller?: AbortSignal): AbortSignal | undefined {
  const timeout = timeoutSignal();
  if (!caller) return timeout;
  if (!timeout) return caller;
  try {
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([caller, timeout]);
  } catch {
    // fallthrough
  }
  return caller;
}

/** 统一请求：JSON 响应 + 60s 超时 + 可选调用方取消 + HTTP 错误转异常 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const callerSignal = init.signal ?? undefined;
  const signal = combineSignals(callerSignal);
  let res: Response;
  try {
    res = await fetch(path, { ...init, signal });
  } catch (err) {
    if (isAbortError(err)) {
      if (callerSignal?.aborted) {
        const aborted = new Error('请求已取消');
        aborted.name = 'AbortError';
        throw aborted;
      }
      throw new Error(`请求超时（${FETCH_TIMEOUT_MS / 1000}s）：${path}`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

function post<T>(path: string, body: unknown, init: RequestInit = {}): Promise<T> {
  return request<T>(path, {
    ...init,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function del<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'DELETE',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

export async function ensureCollection(
  name: string,
  modelKey: ModelKey,
  ikMode?: 'smart' | 'max_word',
): Promise<ServerCreateResponse> {
  return post<ServerCreateResponse>('/api/collections', { name, modelKey, ikMode });
}

/** GET /api/health → seekdb 连接状态（perf 快照记录环境用） */
export async function getHealth(deep = false): Promise<HealthResponse> {
  const query = deep ? '?deep=1' : '';
  return request<HealthResponse>(`/api/health${query}`);
}

/**
 * 列出 server 端已有集合。
 * 页面刷新后 kbStore 会丢失集合清单，靠它恢复，否则检索会找不到集合。
 */
export async function listCollections(): Promise<CollectionSummary[]> {
  const data = await request<ServerCollectionsResponse>('/api/collections');
  return (data.collections ?? []).map((c) => ({
    name: c.name,
    modelKey: c.modelKey,
    dimension: c.dimension,
    modality: c.modality,
    count: c.count,
  }));
}

/** GET /api/collections/:name → 集合详情（维度/distance/schema/耗时） */
export async function getCollectionDetail(name: string): Promise<CollectionDetail> {
  return request<CollectionDetail>(`/api/collections/${encodeURIComponent(name)}`);
}

/** POST /api/collections/:name/refresh → 手动刷新索引（导入失败补偿也用） */
export async function refreshCollection(name: string): Promise<RefreshCollectionResponse> {
  return post<RefreshCollectionResponse>(
    `/api/collections/${encodeURIComponent(name)}/refresh`,
    {},
  );
}

/** DELETE /api/collections/:name → 删除集合（评测清理 / 维护） */
export async function deleteCollection(name: string): Promise<DeleteCollectionResponse> {
  return del<DeleteCollectionResponse>(`/api/collections/${encodeURIComponent(name)}`);
}

/**
 * GET /api/documents?collectionName=&source= → 某来源文件的全部文档 id。
 * 导入后用它对比新旧 chunk，删除陈旧分块（文件内容变短/改写的场景）。
 */
export async function listDocumentIds(
  collectionName: string,
  source: string,
): Promise<DocumentIdsResponse> {
  const params = new URLSearchParams({ collectionName, source });
  return request<DocumentIdsResponse>(`/api/documents?${params.toString()}`);
}

/**
 * GET /api/documents?collectionName=&withSource=1
 * 一次请求返回集合全部 id + source；导入后用它按 source 批量清理陈旧块，
 * 避免「每文件一次 list」造成 120 次往返（导入耗时主要短板）。
 * 旧 server 不支持 items 时由调用方回退到 listDocumentIds 逐 source 清理。
 */
export async function listDocumentItems(collectionName: string): Promise<DocumentIdsResponse> {
  const params = new URLSearchParams({ collectionName, withSource: '1' });
  return request<DocumentIdsResponse>(`/api/documents?${params.toString()}`);
}

/** DELETE /api/documents → 按 ids 或 source 删除文档（单请求 ids ≤512） */
export async function deleteDocuments(
  collectionName: string,
  idsOrOptions: string[] | { ids?: string[]; source?: string },
): Promise<DeleteDocumentsResponse> {
  const body =
    Array.isArray(idsOrOptions)
      ? { collectionName, ids: idsOrOptions }
      : { collectionName, ...idsOrOptions };
  return del<DeleteDocumentsResponse>('/api/documents', body);
}

export async function ingestDocuments(args: {
  collectionName: string;
  ids: string[];
  documents: string[];
  embeddings: number[][];
  metadatas?: Array<Record<string, unknown>>;
  /** 写入模式：ensureCollection.created=true 时用 insert，否则 upsert */
  mode?: 'upsert' | 'insert';
  /** 中间批次传 false，只在最后一批刷新索引 */
  refreshIndex?: boolean;
}): Promise<IngestDocumentsResponse> {
  const data = await post<Partial<IngestDocumentsResponse>>('/api/documents', args);
  // 兼容老 server：缺少 mode/refreshed 时按请求参数推算
  const mode = data.mode ?? args.mode ?? 'upsert';
  const refreshed = data.refreshed ?? args.refreshIndex !== false;
  return {
    ok: data.ok ?? true,
    count: data.count ?? args.ids.length,
    mode,
    refreshed,
    timings: data.timings,
  };
}

export async function ingestImages(args: {
  collectionName: string;
  ids: string[];
  embeddings: number[][];
  metadatas: Array<Record<string, unknown>>;
  refreshIndex?: boolean;
}): Promise<{ ok: boolean; count: number }> {
  return post<{ ok: boolean; count: number }>('/api/images', args);
}

export async function search(args: {
  collectionName: string;
  queryEmbedding: number[];
  nResults?: number;
  keyword?: string;
  signal?: AbortSignal;
}): Promise<SearchResult> {
  const hasKeyword = Boolean(args.keyword?.trim());
  const t0 = performance.now();
  const data = await post<ServerSearchResponse>(
    '/api/search',
    {
      collectionName: args.collectionName,
      queryEmbedding: args.queryEmbedding,
      nResults: clampNResults(args.nResults),
      keyword: args.keyword,
    },
    args.signal ? { signal: args.signal } : {},
  );
  const httpMs = performance.now() - t0;
  // server 对混合检索返回 scores（越大越相关），纯向量返回 distances（越小越相关）
  const metric = data.scores ? 'score' : 'distance';
  const mode: SearchMode = data.mode ?? (hasKeyword ? 'hybrid' : 'vector');
  return {
    collectionName: args.collectionName,
    hits: toHits(data),
    latencyMs: httpMs,
    httpMs,
    dbMs: data.timings?.dbMs,
    metric,
    mode,
    timings: data.timings,
  };
}

export async function getCount(collectionName: string): Promise<number | null> {
  try {
    const data = await request<{ count?: number | null }>(
      `/api/documents/${encodeURIComponent(collectionName)}/count`,
    );
    return data.count ?? null;
  } catch {
    // 计数失败不影响主流程（StatsBar 会显示上次已知值）
    return null;
  }
}

export function toHits(data: ServerSearchResponse): SearchHit[] {
  const ids = data.ids?.[0] ?? [];
  const docs = data.documents?.[0] ?? [];
  const metas = data.metadatas?.[0] ?? [];
  const scores = data.scores?.[0];
  const dists = data.distances?.[0] ?? [];
  return ids.map((id, i) => ({
    id,
    // SDK 可能返回 null 占位，统一收敛为 undefined（web 类型不含 null）
    document: docs[i] ?? undefined,
    metadata: metas[i] ?? undefined,
    distance: scores ? undefined : (dists[i] ?? undefined),
    score: scores?.[i] ?? undefined,
  }));
}
