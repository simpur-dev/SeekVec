/**
 * POST /api/search
 * body: { collectionName, queryEmbedding, nResults?, keyword? }
 *
 * 纯向量检索：collection.query({ queryEmbeddings })
 * 混合检索：collection.hybridSearch({ query: { whereDocument }, knn: { queryEmbeddings, nResults } })
 *
 * RRF 在 SeekDB 库内完成，server 不做客户端拼合（合规必需）。
 *
 * 两种模式的返回分数语义不同，必须分开返回，前端不能都按「距离」展示：
 * - 纯向量：distances = cosine 距离，越小越相关
 * - 混合检索：scores = RRF 融合分，越大越相关
 *
 * 混合检索的两个坑（已处理）：
 * 1. keyword 会进入 DBMS_HYBRID_SEARCH 内部的 query_string（Lucene 语法），
 *    必须转义特殊字符，否则 `+`、`(`、`"` 等会被当语法导致查不到/报错；
 *    空串/纯空白按纯向量处理。
 * 2. SDK 的 hybridSearch 先 `SET @search_parm` 再取 SQL，两步非原子，
 *    并发请求会互相覆盖会话变量；用进程内 FIFO 互斥串行化。
 */
import { Router } from 'express';
import { getCollection } from '../db/collections.js';
import { retryOnConnectionError } from '../db/client.js';
import { asyncHandler, HttpError } from './errors.js';
import {
  requireJsonBody,
  validateCollectionName,
  validateKeyword,
  validateNResults,
  validateQueryEmbedding,
} from './validation.js';
import { escapeQueryStringKeyword } from '../util/lucene.js';
import { hybridSearchMutex } from '../util/asyncMutex.js';
import { elapsedMs, nowMs } from '../util/timing.js';
import type { SearchMode, SearchResponse } from '../types.js';

export { hybridSearchMutex };

/** SDK 查询结果的最小结构（只声明本路由用到的字段） */
interface SearchDbResult {
  ids: string[][];
  documents?: Array<Array<string | null>>;
  metadatas?: Array<Array<Record<string, unknown> | null>>;
  distances?: Array<Array<number | null>>;
}

export const searchRouter = Router();

searchRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const totalStartedAt = nowMs();

    const body = requireJsonBody(req.body);
    const collectionName = validateCollectionName(body.collectionName);
    const queryEmbedding = validateQueryEmbedding(body.queryEmbedding);
    const nResults = validateNResults(body.nResults);
    const keyword = validateKeyword(body.keyword);

    const trimmedKeyword = keyword?.trim() ?? '';
    const mode: SearchMode = trimmedKeyword.length > 0 ? 'hybrid' : 'vector';
    // knn 候选窗口显式传 nResults：SDK 默认 10，不传会与请求的 nResults 不一致
    const knnK = nResults;

    const { result, resolveMs, dbMs } = await retryOnConnectionError(async () => {
      const resolveStartedAt = nowMs();
      const collection = await getCollection(collectionName);
      if (collection.dimension !== queryEmbedding.length) {
        throw new HttpError(
          400,
          `查询向量维度 ${queryEmbedding.length} 与集合 ${collectionName} 的 ${collection.dimension} 维不一致，请检查当前模型`,
          'DIMENSION_MISMATCH',
        );
      }
      const resolveElapsed = elapsedMs(resolveStartedAt);

      const dbStartedAt = nowMs();
      const queryResult: SearchDbResult =
        mode === 'hybrid'
          ? ((await hybridSearchMutex.runExclusive(() =>
              collection.hybridSearch({
                // 混合检索：全文 + 向量，RRF 在库内合并
                query: { whereDocument: { $contains: escapeQueryStringKeyword(trimmedKeyword) } },
                // 显式 nResults：SDK 默认 10，必须与请求一致
                knn: { queryEmbeddings: [queryEmbedding], nResults: knnK },
                nResults: knnK,
                include: ['documents', 'metadatas', 'distances'],
              }),
            )) as unknown as SearchDbResult)
          : ((await collection.query({
              queryEmbeddings: [queryEmbedding],
              nResults: knnK,
              include: ['documents', 'metadatas', 'distances'],
            })) as unknown as SearchDbResult);

      return { result: queryResult, resolveMs: resolveElapsed, dbMs: elapsedMs(dbStartedAt) };
    });

    const base = {
      ids: result.ids ?? [],
      documents: result.documents ?? [],
      metadatas: result.metadatas ?? [],
      mode,
      knnK,
      timings: {
        resolveMs,
        dbMs,
        totalMs: elapsedMs(totalStartedAt),
      },
    };

    // SDK 对 hybridSearch 也把融合分放在 result.distances 里；
    // 两者语义相反，这里显式拆成 scores / distances，避免前端误用。
    const response: SearchResponse =
      mode === 'hybrid'
        ? { ...base, scores: result.distances ?? [] }
        : { ...base, distances: result.distances ?? [] };
    res.json(response);
  }),
);
