/**
 * HTTP API client：与本地 server 通信
 *
 * 所有路径 /api/* 都会被 Vite dev server 代理到 http://localhost:3001
 */
import type {
  CollectionSummary,
  Modality,
  ModelKey,
  SearchResult,
  SearchHit,
} from '../types';

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
  documents?: string[][];
  metadatas?: Array<Array<Record<string, unknown> | undefined>>;
  distances?: number[][];
  scores?: number[][];
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function ensureCollection(
  name: string,
  modelKey: ModelKey,
  ikMode?: 'smart' | 'max_word',
): Promise<ServerCreateResponse> {
  return post<ServerCreateResponse>('/api/collections', { name, modelKey, ikMode });
}

/**
 * 列出 server 端已有集合。
 * 页面刷新后 kbStore 会丢失集合清单，靠它恢复，否则检索会找不到集合。
 */
export async function listCollections(): Promise<CollectionSummary[]> {
  const res = await fetch('/api/collections');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  const data = (await res.json()) as ServerCollectionsResponse;
  return (data.collections ?? []).map((c) => ({
    name: c.name,
    modelKey: c.modelKey,
    dimension: c.dimension,
    modality: c.modality,
    count: c.count,
  }));
}

export async function ingestDocuments(args: {
  collectionName: string;
  ids: string[];
  documents: string[];
  embeddings: number[][];
  metadatas?: Array<Record<string, unknown>>;
  /** 中间批次传 false，只在最后一批刷新索引 */
  refreshIndex?: boolean;
}): Promise<{ ok: boolean; count: number }> {
  return post<{ ok: boolean; count: number }>('/api/documents', args);
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
}): Promise<SearchResult> {
  const t0 = performance.now();
  const data = await post<ServerSearchResponse>('/api/search', {
    collectionName: args.collectionName,
    queryEmbedding: args.queryEmbedding,
    nResults: args.nResults ?? 10,
    keyword: args.keyword,
  });
  const latencyMs = performance.now() - t0;
  // server 对混合检索返回 scores（越大越相关），纯向量返回 distances（越小越相关）
  const metric = data.scores ? 'score' : 'distance';
  return {
    collectionName: args.collectionName,
    hits: toHits(data),
    latencyMs,
    metric,
  };
}

export async function getCount(collectionName: string): Promise<number | null> {
  const res = await fetch(`/api/documents/${encodeURIComponent(collectionName)}/count`);
  if (!res.ok) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = (await res.json()) as any;
  return (j.count as number | null) ?? null;
}

export function toHits(data: ServerSearchResponse): SearchHit[] {
  const ids = data.ids?.[0] ?? [];
  const docs = data.documents?.[0] ?? [];
  const metas = data.metadatas?.[0] ?? [];
  const scores = data.scores?.[0];
  const dists = data.distances?.[0] ?? [];
  return ids.map((id, i) => ({
    id,
    document: docs[i],
    metadata: metas[i],
    distance: scores ? undefined : dists[i],
    score: scores?.[i],
  }));
}
