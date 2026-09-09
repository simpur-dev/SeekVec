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

interface ServerSearchResponse {
  ids: string[][];
  documents?: string[][];
  metadatas?: Array<Array<Record<string, unknown> | undefined>>;
  distances?: number[][];
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

export async function ingestDocuments(args: {
  collectionName: string;
  ids: string[];
  documents: string[];
  embeddings: number[][];
  metadatas?: Array<Record<string, unknown>>;
}): Promise<{ ok: boolean; count: number }> {
  return post<{ ok: boolean; count: number }>('/api/documents', args);
}

export async function ingestImages(args: {
  collectionName: string;
  ids: string[];
  embeddings: number[][];
  metadatas: Array<Record<string, unknown>>;
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
  const hits = toHits(data);
  return {
    collectionName: args.collectionName,
    hits,
    latencyMs,
  };
}

export async function getCount(collectionName: string): Promise<number | null> {
  const res = await fetch(`/api/documents/${encodeURIComponent(collectionName)}/count`);
  if (!res.ok) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = (await res.json()) as any;
  return (j.count as number | null) ?? null;
}

export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch('/api/health');
    return res.ok;
  } catch {
    return false;
  }
}

export function toHits(data: ServerSearchResponse): SearchHit[] {
  const ids = data.ids?.[0] ?? [];
  const docs = data.documents?.[0] ?? [];
  const metas = data.metadatas?.[0] ?? [];
  const dists = data.distances?.[0] ?? [];
  return ids.map((id, i) => ({
    id,
    document: docs[i],
    metadata: metas[i],
    distance: dists[i],
  }));
}

export function modalityOf(modelKey: ModelKey): Modality {
  return modelKey === 'image' ? 'image' : 'text';
}

export function makeSummary(
  name: string,
  modelKey: ModelKey,
  dimension: 384 | 512,
): CollectionSummary {
  return {
    name,
    modelKey,
    dimension,
    modality: modalityOf(modelKey),
  };
}
