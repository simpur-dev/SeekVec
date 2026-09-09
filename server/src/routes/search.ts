/**
 * POST /api/search
 * body: { collectionName, queryEmbedding, nResults?, keyword? }
 *
 * 纯向量检索：collection.query({ knn: { queryEmbeddings } })
 * 混合检索：collection.hybridSearch({ query: { whereDocument }, knn: { queryEmbeddings } })
 *
 * RRF 在 SeekDB 库内完成，server 不做客户端拼合（合规必需）。
 */
import { Router } from 'express';
import { getCollection } from '../db/collections.js';
import type { SearchRequest } from '../types.js';

export const searchRouter = Router();

searchRouter.post('/', async (req, res) => {
  const body = req.body as SearchRequest;
  if (!body?.collectionName || !Array.isArray(body.queryEmbedding)) {
    res.status(400).json({ error: 'collectionName 与 queryEmbedding 必填' });
    return;
  }

  const nResults = body.nResults ?? 10;

  try {
    const collection = await getCollection(body.collectionName);

    let result;
    if (body.keyword?.trim()) {
      // 混合检索：全文 + 向量，RRF 在库内合并
      result = await collection.hybridSearch({
        query: { whereDocument: { $contains: body.keyword.trim() } },
        knn: { queryEmbeddings: [body.queryEmbedding] },
        nResults,
        include: ['documents', 'metadatas', 'distances'],
      });
    } else {
      // 纯向量检索（1.3.0 query() 无 knn 键）
      result = await collection.query({
        queryEmbeddings: [body.queryEmbedding],
        nResults,
        include: ['documents', 'metadatas', 'distances'],
      });
    }

    // 统一返回格式
    res.json({
      ids: result.ids ?? [],
      documents: result.documents ?? [],
      metadatas: result.metadatas ?? [],
      distances: result.distances ?? [],
    });
  } catch (err) {
    console.error('[search] failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});
