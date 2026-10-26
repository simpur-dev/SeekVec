/**
 * POST /api/search
 * body: { collectionName, queryEmbedding, nResults?, keyword? }
 *
 * 纯向量检索：collection.query({ queryEmbeddings })
 * 混合检索：collection.hybridSearch({ query: { whereDocument }, knn: { queryEmbeddings } })
 *
 * RRF 在 SeekDB 库内完成，server 不做客户端拼合（合规必需）。
 *
 * 两种模式的返回分数语义不同，必须分开返回，前端不能都按「距离」展示：
 * - 纯向量：distances = cosine 距离，越小越相关
 * - 混合检索：scores = RRF 融合分，越大越相关
 */
import { Router } from 'express';
import { getCollection } from '../db/collections.js';
import { retryOnConnectionError } from '../db/client.js';
import { errorStatus, HttpError } from './errors.js';
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
    const payload = await retryOnConnectionError(async () => {
      const collection = await getCollection(body.collectionName);
      if (collection.dimension !== body.queryEmbedding.length) {
        throw new HttpError(
          400,
          `查询向量维度 ${body.queryEmbedding.length} 与集合 ${body.collectionName} 的 ${collection.dimension} 维不一致，请检查当前模型`,
        );
      }

      const isHybrid = Boolean(body.keyword?.trim());
      const result = isHybrid
        ? await collection.hybridSearch({
            // 混合检索：全文 + 向量，RRF 在库内合并
            query: { whereDocument: { $contains: body.keyword!.trim() } },
            knn: { queryEmbeddings: [body.queryEmbedding] },
            nResults,
            include: ['documents', 'metadatas', 'distances'],
          })
        : // 纯向量检索（1.3.0 query() 无 knn 键）
          await collection.query({
            queryEmbeddings: [body.queryEmbedding],
            nResults,
            include: ['documents', 'metadatas', 'distances'],
          });

      // SDK 对 hybridSearch 也把融合分放在 result.distances 里；
      // 两者语义相反，这里显式拆成 scores / distances，避免前端误用。
      const base = {
        ids: result.ids ?? [],
        documents: result.documents ?? [],
        metadatas: result.metadatas ?? [],
      };
      return isHybrid
        ? { ...base, scores: result.distances ?? [] }
        : { ...base, distances: result.distances ?? [] };
    });
    res.json(payload);
  } catch (err) {
    console.error('[search] failed', err);
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});
