import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FETCH_TIMEOUT_MS,
  clampNResults,
  deleteCollection,
  deleteDocuments,
  getCollectionDetail,
  ingestDocuments,
  listDocumentIds,
  refreshCollection,
  search,
} from '../src/db/api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('search 响应解析（契约第 5 节新增字段）', () => {
  it('解析 server 返回的 mode / timings / dbMs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ids: [['a']],
          documents: [['doc']],
          metadatas: [[{}]],
          scores: [[1.2]],
          mode: 'hybrid',
          timings: { resolveMs: 1, dbMs: 2, totalMs: 3 },
          knnK: 10,
        }),
      ),
    );
    const result = await search({
      collectionName: 'kb_text_zh',
      queryEmbedding: [0.1],
      keyword: '量化',
    });
    expect(result.mode).toBe('hybrid');
    expect(result.metric).toBe('score');
    expect(result.dbMs).toBe(2);
    expect(result.timings).toEqual({ resolveMs: 1, dbMs: 2, totalMs: 3 });
    expect(result.httpMs).toBeGreaterThanOrEqual(0);
    expect(result.latencyMs).toBe(result.httpMs);
  });

  it('老 server 缺 mode/timings 时按关键字推算 mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ids: [['a']],
          documents: [['doc']],
          metadatas: [[{}]],
          distances: [[0.4]],
        }),
      ),
    );
    const vectorResult = await search({
      collectionName: 'kb_text_zh',
      queryEmbedding: [0.1],
    });
    expect(vectorResult.mode).toBe('vector');
    expect(vectorResult.dbMs).toBeUndefined();
    expect(vectorResult.timings).toBeUndefined();

    const hybridResult = await search({
      collectionName: 'kb_text_zh',
      queryEmbedding: [0.1],
      keyword: '检索',
    });
    // 只有关键字但没有 scores（老 server 纯向量返回）→ metric 仍是 distance
    expect(hybridResult.metric).toBe('distance');
    expect(hybridResult.mode).toBe('hybrid');
  });

  it('nResults 夹紧到 server 允许的整数 1..50，避免 400', async () => {
    expect(clampNResults(undefined)).toBe(10);
    expect(clampNResults(0)).toBe(1);
    expect(clampNResults(-3)).toBe(1);
    expect(clampNResults(999)).toBe(50);
    expect(clampNResults(7.6)).toBe(8);
    expect(clampNResults(Number.NaN)).toBe(10);

    const fetchMock = vi.fn(async () =>
      jsonResponse({ ids: [[]], documents: [[]], metadatas: [[]], mode: 'vector', timings: {} }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await search({ collectionName: 'kb_text_zh', queryEmbedding: [0.1], nResults: 999 });
    let body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.nResults).toBe(50);
    await search({ collectionName: 'kb_text_zh', queryEmbedding: [0.1], nResults: 0 });
    body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.nResults).toBe(1);
  });

  it('SDK 返回 null 占位时收敛为 undefined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ids: [['a', 'b']],
          documents: [['doc', null]],
          metadatas: [[null, { source: 'x' }]],
          distances: [[null, 0.5]],
          mode: 'vector',
        }),
      ),
    );
    const result = await search({ collectionName: 'kb_text_zh', queryEmbedding: [0.1] });
    expect(result.hits[0].document).toBe('doc');
    expect(result.hits[1].document).toBeUndefined();
    expect(result.hits[0].metadata).toBeUndefined();
    expect(result.hits[0].distance).toBeUndefined();
    expect(result.hits[1].distance).toBe(0.5);
  });
});

describe('ingestDocuments 响应解析', () => {
  it('解析新 server 的 mode/refreshed/timings', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        count: 2,
        mode: 'insert',
        refreshed: true,
        timings: { upsertMs: 10, refreshMs: 5, totalMs: 15 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await ingestDocuments({
      collectionName: 'kb_text_zh',
      ids: ['a', 'b'],
      documents: ['a', 'b'],
      embeddings: [[0.1], [0.2]],
      mode: 'insert',
      refreshIndex: true,
    });
    expect(result).toMatchObject({ ok: true, count: 2, mode: 'insert', refreshed: true });
    expect(result.timings).toEqual({ upsertMs: 10, refreshMs: 5, totalMs: 15 });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.signal).toBeDefined();
    expect(JSON.parse(init.body as string)).toMatchObject({ mode: 'insert', refreshIndex: true });
  });

  it('兼容老 server 响应（无 mode/refreshed/timings）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, count: 1 })));
    const result = await ingestDocuments({
      collectionName: 'kb_text_zh',
      ids: ['a'],
      documents: ['a'],
      embeddings: [[0.1]],
      mode: 'upsert',
      refreshIndex: false,
    });
    expect(result.mode).toBe('upsert');
    expect(result.refreshed).toBe(false);
    expect(result.timings).toBeUndefined();
  });
});

describe('集合/文档新接口', () => {
  it('getCollectionDetail GET /api/collections/:name', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ name: 'kb_text_zh' }));
    vi.stubGlobal('fetch', fetchMock);
    const detail = await getCollectionDetail('kb_text_zh');
    expect(detail.name).toBe('kb_text_zh');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/collections/kb_text_zh');
  });

  it('refreshCollection POST /api/collections/:name/refresh', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, timings: { refreshMs: 7 } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await refreshCollection('kb_text_zh');
    expect(result.timings.refreshMs).toBe(7);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/collections/kb_text_zh/refresh');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('deleteCollection DELETE /api/collections/:name', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, deleted: true }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await deleteCollection('bench_1');
    expect(result.deleted).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/collections/bench_1');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });

  it('listDocumentIds 带 collectionName/source 查询参数', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ids: ['a'], count: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await listDocumentIds('kb_text_zh', 'demo.md');
    expect(result).toMatchObject({ ids: ['a'], count: 1 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url.startsWith('/api/documents?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('collectionName')).toBe('kb_text_zh');
    expect(params.get('source')).toBe('demo.md');
  });

  it('deleteDocuments 支持 ids 数组与 source 两种参数', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ deleted: 2 }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteDocuments('kb_text_zh', ['a', 'b']);
    let init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body as string)).toEqual({
      collectionName: 'kb_text_zh',
      ids: ['a', 'b'],
    });

    await deleteDocuments('kb_text_zh', { source: 'demo.md' });
    init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      collectionName: 'kb_text_zh',
      source: 'demo.md',
    });
  });
});

describe('请求超时（60s）', () => {
  it('超时/中断错误转成可读提示', async () => {
    const timeoutError = new Error('aborted');
    timeoutError.name = 'AbortError';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw timeoutError;
      }),
    );
    await expect(
      search({ collectionName: 'kb_text_zh', queryEmbedding: [0.1] }),
    ).rejects.toThrow(/请求超时/);
    expect(FETCH_TIMEOUT_MS).toBe(60_000);
  });

  it('普通网络错误原样抛出', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    await expect(
      search({ collectionName: 'kb_text_zh', queryEmbedding: [0.1] }),
    ).rejects.toThrow('network down');
  });
});
