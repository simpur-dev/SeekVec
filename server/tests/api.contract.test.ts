/**
 * API 契约测试（supertest + mock db 模块）
 *
 * 覆盖契约第 5 节：
 * - health 扩展（ok/degraded、版本、refreshIndexSupported、5s 缓存、?deep=1）
 * - 集合维护接口（详情/刷新/删除）
 * - 文档接口（upsert/insert、insert 重复 409、timings、mode、refreshed、
 *   按 source 列 id / 删除）
 * - 检索接口（mode/timings/knnK、keyword 转义、hybrid FIFO 串行）
 * - 通用中间件（x-powered-by、JSON 404、错误码、requestId、请求日志、
 *   400 校验、404、409、503、500 不泄漏 SQL、CORS）
 *
 * DB 层通过 vi.mock 注入：只为 getCollection/ensureCollection/listCollections/
 * deleteCollection/getClient 提供假实现，其余纯函数（schema 序列化、model 推断、
 * 连接错误识别）保留真实实现。
 */
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  getCollection: vi.fn(),
  ensureCollection: vi.fn(),
  listCollections: vi.fn(),
  deleteCollection: vi.fn(),
}));

vi.mock('../src/db/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/client.js')>();
  return {
    ...actual,
    getClient: mocks.getClient,
    retryOnConnectionError: (fn: () => Promise<unknown>) => fn(),
    closeClient: async () => {},
  };
});

vi.mock('../src/db/collections.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/collections.js')>();
  return {
    ...actual,
    getCollection: mocks.getCollection,
    ensureCollection: mocks.ensureCollection,
    listCollections: mocks.listCollections,
    deleteCollection: mocks.deleteCollection,
  };
});

// eslint-disable-next-line import/first
import { createApp } from '../src/app.js';

const DIM = 384;
const COLLECTION = 'kb_text_zh';

const QUERY_VECTOR = Array.from({ length: DIM }, (_, index) => (index % 7) / 1000);

const FULLTEXT_SCHEMA = {
  vectorIndex: { hnsw: { dimension: DIM, distance: 'cosine' } },
  fulltextIndex: { analyzer: 'ik', properties: { ik_mode: 'smart' } },
};

const VECTOR_RESULT = {
  ids: [['a', 'b']],
  documents: [['doc a', 'doc b']],
  metadatas: [[{ source: 'a.md' }, null]],
  distances: [[0.1, 0.2]],
};

const HYBRID_RESULT = {
  ids: [['h1']],
  documents: [['hybrid doc']],
  metadatas: [[null]],
  distances: [[0.95]],
};

interface FakeCollection {
  name: string;
  dimension: number;
  distance: string;
  schema: unknown;
  describe: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  refresh_index: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  hybridSearch: ReturnType<typeof vi.fn>;
}

function makeCollection(overrides: Partial<FakeCollection> = {}): FakeCollection {
  const collection: FakeCollection = {
    name: COLLECTION,
    dimension: DIM,
    distance: 'cosine',
    schema: FULLTEXT_SCHEMA,
    describe: vi.fn(async () => ({
      name: COLLECTION,
      dimension: DIM,
      distance: 'cosine',
      metadata: undefined,
    })),
    count: vi.fn(async () => 7),
    get: vi.fn(async () => ({ ids: [] })),
    add: vi.fn(async () => {}),
    upsert: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    refresh_index: vi.fn(async () => {}),
    query: vi.fn(async () => VECTOR_RESULT),
    hybridSearch: vi.fn(async () => HYBRID_RESULT),
    ...overrides,
  };
  return collection;
}

function makeFakeClient(version = '5.7.25-OceanBase_SeekDB-v1.4.0.0') {
  return {
    isConnected: () => true,
    execute: vi.fn(async (sql: string) => {
      if (/VERSION/i.test(sql)) return [{ version }];
      return [{ '1': 1 }];
    }),
    close: async () => {},
  };
}

function makeApp(options: { logRequests?: boolean } = {}) {
  return createApp({ logRequests: options.logRequests ?? false });
}

function connectionError(): Error {
  return new Error("Can't add new command when connection is in closed state");
}

function notFoundError(name = 'no_such_collection'): Error {
  const err = new Error(`Collection not found: ${name}`);
  err.name = 'InvalidCollectionError';
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.getClient.mockResolvedValue(makeFakeClient());
  mocks.getCollection.mockResolvedValue(makeCollection());
  mocks.ensureCollection.mockResolvedValue({
    created: true,
    name: COLLECTION,
    dimension: 512,
  });
  mocks.listCollections.mockResolvedValue([]);
  mocks.deleteCollection.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* health                                                              */
/* ------------------------------------------------------------------ */

describe('GET /api/health', () => {
  it('seekdb 可达 → ok + version + refreshIndexSupported', async () => {
    const client = makeFakeClient();
    mocks.getClient.mockResolvedValue(client);

    const res = await request(makeApp()).get('/api/health?deep=1').expect(200);

    expect(res.body.status).toBe('ok');
    expect(typeof res.body.ts).toBe('number');
    expect(res.body.seekdb).toEqual(
      expect.objectContaining({
        reachable: true,
        version: '5.7.25-OceanBase_SeekDB-v1.4.0.0',
        refreshIndexSupported: true,
      }),
    );
    expect(typeof res.body.seekdb.latencyMs).toBe('number');
    expect(res.body.seekdb.latencyMs).toBeGreaterThanOrEqual(0);
    // 两次轻量查询：SELECT 1 + SELECT VERSION()
    expect(client.execute).toHaveBeenCalledTimes(2);
  });

  it('seekdb 不可达 → status degraded 且 HTTP 仍为 200', async () => {
    mocks.getClient.mockRejectedValue(connectionError());

    const res = await request(makeApp()).get('/api/health?deep=1').expect(200);

    expect(res.body.status).toBe('degraded');
    expect(res.body.seekdb.reachable).toBe(false);
    expect(res.body.seekdb.version).toBeNull();
    expect(res.body.seekdb.refreshIndexSupported).toBe(false);
  });

  it('seekdb < 1.3.0 → refreshIndexSupported=false', async () => {
    mocks.getClient.mockResolvedValue(makeFakeClient('5.7.25-OceanBase_SeekDB-v1.2.0'));

    const res = await request(makeApp()).get('/api/health?deep=1').expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body.seekdb.refreshIndexSupported).toBe(false);
  });

  it('默认缓存 5s，?deep=1 强制打穿缓存', async () => {
    const client = makeFakeClient();
    mocks.getClient.mockResolvedValue(client);
    const app = makeApp();

    await request(app).get('/api/health').expect(200);
    const callsAfterFirst = client.execute.mock.calls.length;
    expect(callsAfterFirst).toBe(2);

    await request(app).get('/api/health').expect(200);
    expect(client.execute.mock.calls.length).toBe(callsAfterFirst);

    await request(app).get('/api/health?deep=1').expect(200);
    expect(client.execute.mock.calls.length).toBe(callsAfterFirst + 2);
  });
});

/* ------------------------------------------------------------------ */
/* collections                                                         */
/* ------------------------------------------------------------------ */

describe('GET /api/collections', () => {
  it('返回集合列表（字段保持兼容）', async () => {
    mocks.listCollections.mockResolvedValue([
      { name: COLLECTION, modelKey: 'text_zh', dimension: 512, modality: 'text', count: 3 },
    ]);

    const res = await request(makeApp()).get('/api/collections').expect(200);

    expect(res.body).toEqual({
      collections: [
        { name: COLLECTION, modelKey: 'text_zh', dimension: 512, modality: 'text', count: 3 },
      ],
    });
  });

  it('连接类错误 → 503 SEEKDB_UNAVAILABLE', async () => {
    mocks.listCollections.mockRejectedValue(connectionError());

    const res = await request(makeApp()).get('/api/collections').expect(503);

    expect(res.body.code).toBe('SEEKDB_UNAVAILABLE');
    expect(typeof res.body.error).toBe('string');
    expect(typeof res.body.requestId).toBe('string');
  });
});

describe('POST /api/collections', () => {
  it('成功创建 → created/name/dimension', async () => {
    const res = await request(makeApp())
      .post('/api/collections')
      .send({ name: COLLECTION, modelKey: 'text_zh', ikMode: 'max_word' })
      .expect(200);

    expect(res.body).toEqual({ created: true, name: COLLECTION, dimension: 512 });
    expect(mocks.ensureCollection).toHaveBeenCalledWith(COLLECTION, 'text_zh', 'max_word');
  });

  it('name 非法 → 400 INVALID_COLLECTION_NAME', async () => {
    const res = await request(makeApp())
      .post('/api/collections')
      .send({ name: 'bad name', modelKey: 'text_zh' })
      .expect(400);

    expect(res.body.code).toBe('INVALID_COLLECTION_NAME');
    expect(mocks.ensureCollection).not.toHaveBeenCalled();
  });

  it('modelKey 非法 → 400 INVALID_MODEL_KEY', async () => {
    const res = await request(makeApp())
      .post('/api/collections')
      .send({ name: COLLECTION, modelKey: 'bge' })
      .expect(400);

    expect(res.body.code).toBe('INVALID_MODEL_KEY');
  });

  it('ikMode 非法 → 400 INVALID_IK_MODE', async () => {
    const res = await request(makeApp())
      .post('/api/collections')
      .send({ name: COLLECTION, modelKey: 'text_zh', ikMode: 'ik' })
      .expect(400);

    expect(res.body.code).toBe('INVALID_IK_MODE');
  });
});

describe('GET /api/collections/:name', () => {
  it('成功返回详情：dimension/distance/modality/modelKey/count/schema/timings', async () => {
    mocks.getCollection.mockResolvedValue(makeCollection());

    const res = await request(makeApp()).get(`/api/collections/${COLLECTION}`).expect(200);

    expect(res.body).toMatchObject({
      name: COLLECTION,
      dimension: 384,
      distance: 'cosine',
      modality: 'text',
      modelKey: 'text_en',
      count: 7,
      schema: { fulltext: { analyzer: 'ik', properties: { ik_mode: 'smart' } } },
    });
    expect(res.body.schema.hnsw).toEqual({ dimension: 384, distance: 'cosine' });
    expect(typeof res.body.timings.describeMs).toBe('number');
    expect(typeof res.body.timings.countMs).toBe('number');
    expect(typeof res.body.timings.totalMs).toBe('number');
  });

  it('图片集合 modality=image、fulltext=null', async () => {
    mocks.getCollection.mockResolvedValue(
      makeCollection({
        name: 'kb_image',
        schema: { vectorIndex: { hnsw: { dimension: 512, distance: 'cosine' } } },
        describe: vi.fn(async () => ({
          name: 'kb_image',
          dimension: 512,
          distance: 'cosine',
          metadata: undefined,
        })),
      }),
    );

    const res = await request(makeApp()).get('/api/collections/kb_image').expect(200);

    expect(res.body.modality).toBe('image');
    expect(res.body.modelKey).toBe('image');
    expect(res.body.dimension).toBe(512);
    expect(res.body.schema.fulltext).toBeNull();
  });

  it('集合不存在 → 404 COLLECTION_NOT_FOUND', async () => {
    mocks.getCollection.mockRejectedValue(notFoundError());

    const res = await request(makeApp()).get('/api/collections/no_such_collection').expect(404);

    expect(res.body.code).toBe('COLLECTION_NOT_FOUND');
  });

  it('name 非法 → 400 INVALID_COLLECTION_NAME', async () => {
    const res = await request(makeApp()).get('/api/collections/bad%20name').expect(400);

    expect(res.body.code).toBe('INVALID_COLLECTION_NAME');
  });

  it('count 失败时不整体 500，count=null 且 timings 仍在', async () => {
    mocks.getCollection.mockResolvedValue(
      makeCollection({
        count: vi.fn(async () => {
          throw new Error('count boom');
        }),
      }),
    );

    const res = await request(makeApp()).get(`/api/collections/${COLLECTION}`).expect(200);

    expect(res.body.count).toBeNull();
    expect(typeof res.body.timings.countMs).toBe('number');
  });
});

describe('POST /api/collections/:name/refresh', () => {
  it('成功刷新 → ok + timings.refreshMs', async () => {
    const collection = makeCollection();
    mocks.getCollection.mockResolvedValue(collection);

    const res = await request(makeApp())
      .post(`/api/collections/${COLLECTION}/refresh`)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(typeof res.body.timings.refreshMs).toBe('number');
    expect(collection.refresh_index).toHaveBeenCalledTimes(1);
  });

  it('集合不存在 → 404', async () => {
    mocks.getCollection.mockRejectedValue(notFoundError());

    const res = await request(makeApp())
      .post('/api/collections/no_such_collection/refresh')
      .expect(404);

    expect(res.body.code).toBe('COLLECTION_NOT_FOUND');
  });
});

describe('DELETE /api/collections/:name', () => {
  it('成功删除 → ok/deleted', async () => {
    const res = await request(makeApp()).delete(`/api/collections/${COLLECTION}`).expect(200);

    expect(res.body).toEqual({ ok: true, deleted: true });
    expect(mocks.deleteCollection).toHaveBeenCalledWith(COLLECTION);
  });

  it('不存在 → 404（统一 deleted:false 语义）', async () => {
    mocks.deleteCollection.mockResolvedValue(false);

    const res = await request(makeApp()).delete('/api/collections/no_such_collection').expect(404);

    expect(res.body.code).toBe('COLLECTION_NOT_FOUND');
  });
});

/* ------------------------------------------------------------------ */
/* documents                                                           */
/* ------------------------------------------------------------------ */

const INGEST_BODY = {
  collectionName: COLLECTION,
  ids: ['a', 'b'],
  documents: ['文档 A', 'doc B'],
  embeddings: [QUERY_VECTOR, QUERY_VECTOR],
  metadatas: [{ source: 'a.md' }, null],
};

describe('POST /api/documents', () => {
  it('upsert 成功：mode/timings/refreshed + metadatas null 收敛为空对象', async () => {
    const collection = makeCollection();
    mocks.getCollection.mockResolvedValue(collection);

    const res = await request(makeApp()).post('/api/documents').send(INGEST_BODY).expect(200);

    expect(res.body).toMatchObject({ ok: true, count: 2, mode: 'upsert', refreshed: true });
    expect(typeof res.body.timings.upsertMs).toBe('number');
    expect(typeof res.body.timings.refreshMs).toBe('number');
    expect(typeof res.body.timings.totalMs).toBe('number');
    expect(collection.upsert).toHaveBeenCalledTimes(1);
    expect(collection.add).not.toHaveBeenCalled();
    expect(collection.refresh_index).toHaveBeenCalledTimes(1);
    const upsertArgs = collection.upsert.mock.calls[0][0];
    expect(upsertArgs.ids).toEqual(['a', 'b']);
    expect(upsertArgs.metadatas).toEqual([{ source: 'a.md' }, {}]);
  });

  it('refreshIndex=false → refreshed:false、refreshMs:null、不刷新索引', async () => {
    const collection = makeCollection();
    mocks.getCollection.mockResolvedValue(collection);

    const res = await request(makeApp())
      .post('/api/documents')
      .send({ ...INGEST_BODY, refreshIndex: false })
      .expect(200);

    expect(res.body.refreshed).toBe(false);
    expect(res.body.timings.refreshMs).toBeNull();
    expect(collection.refresh_index).not.toHaveBeenCalled();
  });

  it('mode=insert 成功 → collection.add', async () => {
    const collection = makeCollection();
    mocks.getCollection.mockResolvedValue(collection);

    const res = await request(makeApp())
      .post('/api/documents')
      .send({ ...INGEST_BODY, mode: 'insert' })
      .expect(200);

    expect(res.body.mode).toBe('insert');
    expect(collection.add).toHaveBeenCalledTimes(1);
    expect(collection.upsert).not.toHaveBeenCalled();
  });

  it('mode=insert 且 id 已存在 → 409 DOCUMENT_EXISTS（不写库）', async () => {
    const collection = makeCollection({
      get: vi.fn(async () => ({ ids: ['a'] })),
    });
    mocks.getCollection.mockResolvedValue(collection);

    const res = await request(makeApp())
      .post('/api/documents')
      .send({ ...INGEST_BODY, mode: 'insert' })
      .expect(409);

    expect(res.body.code).toBe('DOCUMENT_EXISTS');
    expect(collection.add).not.toHaveBeenCalled();
  });

  it('mode=insert 请求内重复 id → 409 DOCUMENT_EXISTS', async () => {
    const res = await request(makeApp())
      .post('/api/documents')
      .send({
        ...INGEST_BODY,
        mode: 'insert',
        ids: ['dup', 'dup'],
        documents: ['x', 'y'],
      })
      .expect(409);

    expect(res.body.code).toBe('DOCUMENT_EXISTS');
  });

  it('add 抛 duplicate entry → 409 DOCUMENT_EXISTS', async () => {
    const collection = makeCollection({
      get: vi.fn(async () => ({ ids: [] })),
      add: vi.fn(async () => {
        throw new Error("Duplicate entry 'a' for key 'PRIMARY'");
      }),
    });
    mocks.getCollection.mockResolvedValue(collection);

    const res = await request(makeApp())
      .post('/api/documents')
      .send({ ...INGEST_BODY, mode: 'insert' })
      .expect(409);

    expect(res.body.code).toBe('DOCUMENT_EXISTS');
  });

  it('mode 非法 → 400 INVALID_MODE', async () => {
    const res = await request(makeApp())
      .post('/api/documents')
      .send({ ...INGEST_BODY, mode: 'replace' })
      .expect(400);

    expect(res.body.code).toBe('INVALID_MODE');
  });

  it('ids 超 512 → 400 TOO_MANY_IDS', async () => {
    const ids = Array.from({ length: 513 }, (_, index) => `id-${index}`);
    const res = await request(makeApp())
      .post('/api/documents')
      .send({
        ...INGEST_BODY,
        ids,
        documents: ids.map((id) => id),
        embeddings: ids.map(() => QUERY_VECTOR),
      })
      .expect(400);

    expect(res.body.code).toBe('TOO_MANY_IDS');
  });

  it('embeddings 含非数字 → 400 INVALID_EMBEDDINGS', async () => {
    const res = await request(makeApp())
      .post('/api/documents')
      .send({ ...INGEST_BODY, embeddings: [['x', 'y'], QUERY_VECTOR] })
      .expect(400);

    expect(res.body.code).toBe('INVALID_EMBEDDINGS');
  });

  it('ids/documents 长度不一致 → 400 INVALID_BODY', async () => {
    const res = await request(makeApp())
      .post('/api/documents')
      .send({ ...INGEST_BODY, documents: ['only one'] })
      .expect(400);

    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('向量维度与集合不一致 → 400 DIMENSION_MISMATCH', async () => {
    mocks.getCollection.mockResolvedValue(makeCollection());

    const res = await request(makeApp())
      .post('/api/documents')
      .send({ ...INGEST_BODY, embeddings: [[0.1, 0.2], [0.3, 0.4]] })
      .expect(400);

    expect(res.body.code).toBe('DIMENSION_MISMATCH');
  });

  it('集合不存在 → 404', async () => {
    mocks.getCollection.mockRejectedValue(notFoundError());

    const res = await request(makeApp())
      .post('/api/documents')
      .send({ ...INGEST_BODY, collectionName: 'no_such_collection' })
      .expect(404);

    expect(res.body.code).toBe('COLLECTION_NOT_FOUND');
  });

  it('未知 500 不泄漏 SQL 原文', async () => {
    mocks.getCollection.mockRejectedValue(
      new Error('SELECT password FROM secret_table WHERE id = 1'),
    );

    const res = await request(makeApp())
      .post('/api/documents')
      .send({ ...INGEST_BODY, collectionName: 'no_such_collection' })
      .expect(500);

    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toBe('服务器内部错误');
    expect(JSON.stringify(res.body)).not.toContain('SELECT');
    expect(JSON.stringify(res.body)).not.toContain('secret_table');
  });
});

describe('GET /api/documents?collectionName=&source=', () => {
  it('按 source 返回 ids 与 count', async () => {
    const collection = makeCollection({
      get: vi.fn(async () => ({ ids: ['a', 'b'] })),
    });
    mocks.getCollection.mockResolvedValue(collection);

    const res = await request(makeApp())
      .get('/api/documents')
      .query({ collectionName: COLLECTION, source: 'docs/a.md' })
      .expect(200);

    expect(res.body).toEqual({ ids: ['a', 'b'], count: 2 });
    const getArgs = collection.get.mock.calls[0][0];
    expect(getArgs.where).toEqual({ source: 'docs/a.md' });
    expect(getArgs.include).toEqual([]);
  });

  it('collectionName 缺失 → 400 INVALID_COLLECTION_NAME', async () => {
    const res = await request(makeApp()).get('/api/documents?source=a.md').expect(400);

    expect(res.body.code).toBe('INVALID_COLLECTION_NAME');
  });

  it('collectionName 非法 → 400', async () => {
    const res = await request(makeApp())
      .get('/api/documents')
      .query({ collectionName: 'bad name' })
      .expect(400);

    expect(res.body.code).toBe('INVALID_COLLECTION_NAME');
  });
});

describe('DELETE /api/documents', () => {
  it('按 ids 删除 → deleted 数量', async () => {
    const collection = makeCollection({
      get: vi.fn(async () => ({ ids: ['a', 'b'] })),
    });
    mocks.getCollection.mockResolvedValue(collection);

    const res = await request(makeApp())
      .delete('/api/documents')
      .send({ collectionName: COLLECTION, ids: ['a', 'b'] })
      .expect(200);

    expect(res.body).toEqual({ deleted: 2 });
    expect(collection.delete).toHaveBeenCalledWith({ ids: ['a', 'b'] });
  });

  it('按 source 删除 → deleted 数量', async () => {
    const collection = makeCollection({
      get: vi.fn(async () => ({ ids: ['a', 'b', 'c'] })),
    });
    mocks.getCollection.mockResolvedValue(collection);

    const res = await request(makeApp())
      .delete('/api/documents')
      .send({ collectionName: COLLECTION, source: 'a.md' })
      .expect(200);

    expect(res.body).toEqual({ deleted: 3 });
    expect(collection.delete).toHaveBeenCalledWith({ where: { source: 'a.md' } });
  });

  it('ids 与 source 同时提供 → 400 INVALID_FILTER', async () => {
    const res = await request(makeApp())
      .delete('/api/documents')
      .send({ collectionName: COLLECTION, ids: ['a'], source: 'a.md' })
      .expect(400);

    expect(res.body.code).toBe('INVALID_FILTER');
  });

  it('ids 与 source 都不提供 → 400 INVALID_FILTER', async () => {
    const res = await request(makeApp())
      .delete('/api/documents')
      .send({ collectionName: COLLECTION })
      .expect(400);

    expect(res.body.code).toBe('INVALID_FILTER');
  });

  it('ids 超 512 → 400 TOO_MANY_IDS', async () => {
    const ids = Array.from({ length: 513 }, (_, index) => `id-${index}`);
    const res = await request(makeApp())
      .delete('/api/documents')
      .send({ collectionName: COLLECTION, ids })
      .expect(400);

    expect(res.body.code).toBe('TOO_MANY_IDS');
  });
});

describe('GET /api/documents/:collectionName/count（兼容旧接口）', () => {
  it('返回 name/count', async () => {
    const res = await request(makeApp())
      .get(`/api/documents/${COLLECTION}/count`)
      .expect(200);

    expect(res.body).toEqual({ name: COLLECTION, count: 7 });
  });
});

/* ------------------------------------------------------------------ */
/* search                                                              */
/* ------------------------------------------------------------------ */

describe('POST /api/search', () => {
  it('纯向量检索：mode=vector、knnK=nResults、timings、distances', async () => {
    const collection = makeCollection();
    mocks.getCollection.mockResolvedValue(collection);

    const res = await request(makeApp())
      .post('/api/search')
      .send({ collectionName: COLLECTION, queryEmbedding: QUERY_VECTOR, nResults: 5 })
      .expect(200);

    expect(res.body.mode).toBe('vector');
    expect(res.body.knnK).toBe(5);
    expect(res.body.distances).toEqual([[0.1, 0.2]]);
    expect(res.body.scores).toBeUndefined();
    expect(typeof res.body.timings.resolveMs).toBe('number');
    expect(typeof res.body.timings.dbMs).toBe('number');
    expect(typeof res.body.timings.totalMs).toBe('number');
    const queryArgs = collection.query.mock.calls[0][0];
    expect(queryArgs.nResults).toBe(5);
    expect(collection.hybridSearch).not.toHaveBeenCalled();
  });

  it('nResults 缺省 → 10', async () => {
    const res = await request(makeApp())
      .post('/api/search')
      .send({ collectionName: COLLECTION, queryEmbedding: QUERY_VECTOR })
      .expect(200);

    expect(res.body.knnK).toBe(10);
  });

  it('混合检索：keyword 转义 + 显式 knn.nResults + scores', async () => {
    const collection = makeCollection();
    mocks.getCollection.mockResolvedValue(collection);

    const res = await request(makeApp())
      .post('/api/search')
      .send({
        collectionName: COLLECTION,
        queryEmbedding: QUERY_VECTOR,
        nResults: 3,
        keyword: 'OceanBase +向量(检索)',
      })
      .expect(200);

    expect(res.body.mode).toBe('hybrid');
    expect(res.body.knnK).toBe(3);
    expect(res.body.scores).toEqual([[0.95]]);
    expect(res.body.distances).toBeUndefined();
    expect(collection.query).not.toHaveBeenCalled();

    const hybridArgs = collection.hybridSearch.mock.calls[0][0];
    expect(hybridArgs.knn.nResults).toBe(3);
    expect(hybridArgs.nResults).toBe(3);
    expect(hybridArgs.query.whereDocument.$contains).toBe('OceanBase \\+向量\\(检索\\)');
  });

  it('keyword 为空白串 → 走纯向量', async () => {
    const collection = makeCollection();
    mocks.getCollection.mockResolvedValue(collection);

    const res = await request(makeApp())
      .post('/api/search')
      .send({ collectionName: COLLECTION, queryEmbedding: QUERY_VECTOR, keyword: '   ' })
      .expect(200);

    expect(res.body.mode).toBe('vector');
    expect(collection.hybridSearch).not.toHaveBeenCalled();
  });

  it('keyword 超 128 字符 → 400 INVALID_KEYWORD', async () => {
    const res = await request(makeApp())
      .post('/api/search')
      .send({
        collectionName: COLLECTION,
        queryEmbedding: QUERY_VECTOR,
        keyword: 'k'.repeat(129),
      })
      .expect(400);

    expect(res.body.code).toBe('INVALID_KEYWORD');
  });

  it.each([[0], [51], [1.5], ['10']])('nResults=%s → 400 INVALID_N_RESULTS', async (value) => {
    const res = await request(makeApp())
      .post('/api/search')
      .send({ collectionName: COLLECTION, queryEmbedding: QUERY_VECTOR, nResults: value })
      .expect(400);

    expect(res.body.code).toBe('INVALID_N_RESULTS');
  });

  it('queryEmbedding 非法 → 400 INVALID_QUERY_EMBEDDING', async () => {
    const res = await request(makeApp())
      .post('/api/search')
      .send({ collectionName: COLLECTION, queryEmbedding: [1, 'x'] })
      .expect(400);

    expect(res.body.code).toBe('INVALID_QUERY_EMBEDDING');
  });

  it('查询向量维度不一致 → 400 DIMENSION_MISMATCH', async () => {
    mocks.getCollection.mockResolvedValue(makeCollection());

    const res = await request(makeApp())
      .post('/api/search')
      .send({ collectionName: COLLECTION, queryEmbedding: [0.1, 0.2] })
      .expect(400);

    expect(res.body.code).toBe('DIMENSION_MISMATCH');
  });

  it('集合不存在 → 404', async () => {
    mocks.getCollection.mockRejectedValue(notFoundError());

    const res = await request(makeApp())
      .post('/api/search')
      .send({ collectionName: 'no_such_collection', queryEmbedding: QUERY_VECTOR })
      .expect(404);

    expect(res.body.code).toBe('COLLECTION_NOT_FOUND');
  });

  it('检索时连接类错误 → 503 SEEKDB_UNAVAILABLE', async () => {
    mocks.getCollection.mockResolvedValue(makeCollection());
    const collection = makeCollection({
      query: vi.fn(async () => {
        throw connectionError();
      }),
    });
    mocks.getCollection.mockResolvedValue(collection);

    const res = await request(makeApp())
      .post('/api/search')
      .send({ collectionName: COLLECTION, queryEmbedding: QUERY_VECTOR })
      .expect(503);

    expect(res.body.code).toBe('SEEKDB_UNAVAILABLE');
  });

  it('并发混合检索被 FIFO 互斥串行化（防 @search_parm 串味）', async () => {
    const collection = makeCollection();
    let active = 0;
    let maxActive = 0;
    collection.hybridSearch.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return HYBRID_RESULT;
    });
    mocks.getCollection.mockResolvedValue(collection);

    const app = makeApp();
    const body = {
      collectionName: COLLECTION,
      queryEmbedding: QUERY_VECTOR,
      nResults: 5,
      keyword: 'OceanBase',
    };
    const [first, second] = await Promise.all([
      request(app).post('/api/search').send(body).expect(200),
      request(app).post('/api/search').send(body).expect(200),
    ]);

    expect(first.body.mode).toBe('hybrid');
    expect(second.body.mode).toBe('hybrid');
    expect(collection.hybridSearch).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* images（v1.1 预留）                                                 */
/* ------------------------------------------------------------------ */

describe('POST /api/images', () => {
  it('成功入库 → ok/count/timings', async () => {
    const collection = makeCollection({ dimension: 2 });
    mocks.getCollection.mockResolvedValue(collection);

    const res = await request(makeApp())
      .post('/api/images')
      .send({
        collectionName: 'kb_image',
        ids: ['img-1'],
        embeddings: [[0.1, 0.2]],
        metadatas: [{ fileName: 'a.png', source: 'a.png' }],
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(1);
    expect(typeof res.body.timings.upsertMs).toBe('number');
    expect(collection.upsert).toHaveBeenCalledTimes(1);
  });

  it('metadatas 缺失 → 400 INVALID_METADATAS', async () => {
    const res = await request(makeApp())
      .post('/api/images')
      .send({ collectionName: 'kb_image', ids: ['img-1'], embeddings: [[0.1, 0.2]] })
      .expect(400);

    expect(res.body.code).toBe('INVALID_METADATAS');
  });

  it('维度不一致 → 400 DIMENSION_MISMATCH', async () => {
    mocks.getCollection.mockResolvedValue(makeCollection({ dimension: 512 }));

    const res = await request(makeApp())
      .post('/api/images')
      .send({
        collectionName: 'kb_image',
        ids: ['img-1'],
        embeddings: [[0.1, 0.2]],
        metadatas: [null],
      })
      .expect(400);

    expect(res.body.code).toBe('DIMENSION_MISMATCH');
  });

  it('连接类错误 → 503', async () => {
    mocks.getCollection.mockRejectedValue(connectionError());

    const res = await request(makeApp())
      .post('/api/images')
      .send({
        collectionName: 'kb_image',
        ids: ['img-1'],
        embeddings: [[0.1, 0.2]],
        metadatas: [null],
      })
      .expect(503);

    expect(res.body.code).toBe('SEEKDB_UNAVAILABLE');
  });
});

/* ------------------------------------------------------------------ */
/* 通用中间件                                                          */
/* ------------------------------------------------------------------ */

describe('通用中间件与错误语义', () => {
  it('关闭 x-powered-by', async () => {
    const res = await request(makeApp()).get('/api/collections').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('未知路由 → JSON 404 {error, code, requestId}', async () => {
    const res = await request(makeApp()).get('/api/not-exists').expect(404);

    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.code).toBe('NOT_FOUND');
    expect(typeof res.body.error).toBe('string');
    expect(typeof res.body.requestId).toBe('string');
  });

  it('非法 JSON body → 400 INVALID_JSON', async () => {
    const res = await request(makeApp())
      .post('/api/search')
      .set('Content-Type', 'application/json')
      .send('{"broken":')
      .expect(400);

    expect(res.body.code).toBe('INVALID_JSON');
  });

  it('requestId：入站 x-request-id 透传，并出现在错误响应里', async () => {
    const res = await request(makeApp())
      .post('/api/search')
      .set('x-request-id', 'req-test-123')
      .send({ collectionName: 'bad name', queryEmbedding: [0.1] })
      .expect(400);

    expect(res.headers['x-request-id']).toBe('req-test-123');
    expect(res.body.requestId).toBe('req-test-123');
  });

  it('请求日志格式：[api] METHOD PATH STATUS ms requestId', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = makeApp({ logRequests: true });

    await request(app).get('/api/collections').set('x-request-id', 'log-req').expect(200);
    await new Promise((resolve) => setImmediate(resolve));

    const lines = logSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('[api] '));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/^\[api\] GET \/api\/collections 200 [\d.]+ms log-req$/);
  });

  it('CORS 只放行白名单 origin', async () => {
    const app = makeApp();
    const allowed = await request(app)
      .get('/api/collections')
      .set('Origin', 'http://localhost:5173')
      .expect(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const denied = await request(app)
      .get('/api/collections')
      .set('Origin', 'http://evil.example')
      .expect(200);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
