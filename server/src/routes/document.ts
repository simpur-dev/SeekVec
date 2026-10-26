/**
 * 文档入库路由
 * POST /api/documents
 * body: { collectionName, ids, documents, embeddings, metadatas?, refreshIndex? }
 *
 * 幂等性：使用 upsert 而不是 add —— web 端 chunk id 由内容 hash 生成，
 * 同一文件重复导入会覆盖同一批 id，不会产生重复分块。
 *
 * 索引刷新：默认每批刷新；web 端可在中间批次传 refreshIndex=false，
 * 只在最后一批刷新一次，减少索引刷新开销（赛题"索引刷新策略"）。
 */
import { Router } from 'express';
import type { Metadata } from 'seekdb';
import { getCollection } from '../db/collections.js';
import { retryOnConnectionError } from '../db/client.js';
import { errorStatus, HttpError } from './errors.js';
import type { IngestTextRequest } from '../types.js';

/**
 * 将 Record<string, unknown> 收敛为 Metadata（移除 undefined 避免类型冲突）。
 * 1.3.0 AddOptions.metadatas: Metadata | Metadata[]
 * MetadataValue 不含 undefined。
 */
function toMeta(record: Record<string, unknown>): Metadata {
  return Object.fromEntries(
    Object.entries(record).filter(([, v]) => v !== undefined),
  ) as Metadata;
}

export const documentsRouter = Router();

documentsRouter.post('/', async (req, res) => {
  const body = req.body as IngestTextRequest;
  if (
    !body?.collectionName ||
    !Array.isArray(body.ids) ||
    !Array.isArray(body.documents) ||
    !Array.isArray(body.embeddings)
  ) {
    res.status(400).json({ error: 'ids / documents / embeddings 必填' });
    return;
  }
  if (
    body.ids.length !== body.documents.length ||
    body.ids.length !== body.embeddings.length
  ) {
    res.status(400).json({ error: 'ids / documents / embeddings 长度不一致' });
    return;
  }
  if (body.metadatas && body.metadatas.length !== body.ids.length) {
    res.status(400).json({ error: 'metadatas 与 ids 长度不一致' });
    return;
  }

  try {
    const result = await retryOnConnectionError(async () => {
      const collection = await getCollection(body.collectionName);
      const dimension = collection.dimension;
      const badIndex = body.embeddings.findIndex((embedding) => embedding.length !== dimension);
      if (badIndex !== -1) {
        throw new HttpError(
          400,
          `第 ${badIndex + 1} 条向量维度为 ${body.embeddings[badIndex].length}，` +
            `集合 ${body.collectionName} 需要 ${dimension} 维；请检查模型与集合名是否匹配`,
        );
      }
      await collection.upsert({
        ids: body.ids,
        documents: body.documents,
        metadatas: body.metadatas?.map(toMeta),
        embeddings: body.embeddings,
      });
      if (body.refreshIndex !== false) {
        await collection.refresh_index();
      }
      return { ok: true as const, count: body.ids.length };
    });
    res.json(result);
  } catch (err) {
    console.error('[documents] ingest failed', err);
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

documentsRouter.get('/:collectionName/count', async (req, res) => {
  try {
    const total = await retryOnConnectionError(async () => {
      const collection = await getCollection(req.params.collectionName);
      return collection.count();
    });
    res.json({ name: req.params.collectionName, count: total });
  } catch (err) {
    console.error('[documents] count failed', err);
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});
