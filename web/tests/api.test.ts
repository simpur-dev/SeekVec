import { afterEach, describe, expect, it, vi } from 'vitest';
import { search, toHits } from '../src/db/api';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toHits', () => {
  it('纯向量检索：distance 映射到 hit.distance', () => {
    const hits = toHits({
      ids: [['a', 'b']],
      documents: [['doc a', 'doc b']],
      metadatas: [[{ source: 'x' }, undefined]],
      distances: [[0.2, 0.7]],
    });
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ id: 'a', document: 'doc a', distance: 0.2 });
    expect(hits[0].score).toBeUndefined();
    expect(hits[1].metadata).toBeUndefined();
  });

  it('混合检索：score 映射到 hit.score，且不产生 distance', () => {
    const hits = toHits({
      ids: [['a']],
      documents: [['doc a']],
      metadatas: [[{}]],
      scores: [[1.73]],
    });
    expect(hits[0].score).toBe(1.73);
    expect(hits[0].distance).toBeUndefined();
  });
});

describe('search', () => {
  it('响应含 scores 时 metric 为 score', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ ids: [['a']], documents: [['doc']], metadatas: [[{}]], scores: [[1.5]] }),
      ),
    );
    const result = await search({ collectionName: 'kb_text_zh', queryEmbedding: [0.1] });
    expect(result.metric).toBe('score');
    expect(result.hits[0].score).toBe(1.5);
    expect(result.collectionName).toBe('kb_text_zh');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('响应含 distances 时 metric 为 distance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ ids: [['a']], documents: [['doc']], metadatas: [[{}]], distances: [[0.4]] }),
      ),
    );
    const result = await search({ collectionName: 'kb_text_zh', queryEmbedding: [0.1] });
    expect(result.metric).toBe('distance');
    expect(result.hits[0].distance).toBe(0.4);
  });

  it('HTTP 错误时抛出带状态码的错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(
      search({ collectionName: 'kb_text_zh', queryEmbedding: [0.1] }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
