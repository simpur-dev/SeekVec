/**
 * 图片入库路由（v1.1 预留 / stretch）
 * POST /api/images
 * body: { collectionName, ids, embeddings, metadatas, refreshIndex? }
 *
 * 与文本入库共用同一套校验 + 错误语义（400/404/409/503）；
 * 图片向量由 web 端 CLIP 视觉塔产出，server 不做任何推理。
 */
import { Router } from 'express';
import type { Metadata } from 'seekdb';
import { getCollection } from '../db/collections.js';
import { retryOnConnectionError } from '../db/client.js';
import { asyncHandler, HttpError } from './errors.js';
import {
  assertSameLength,
  fail,
  requireJsonBody,
  validateCollectionName,
  validateEmbeddings,
  validateIds,
  validateMetadatas,
  validateRefreshIndex,
} from './validation.js';
import { elapsedMs, nowMs } from '../util/timing.js';

/** 同 document.ts，将 unknown 字段收敛为合法 MetadataValue */
function toMeta(record: Record<string, unknown>): Metadata {
  return Object.fromEntries(
    Object.entries(record).filter(([, v]) => v !== undefined),
  ) as Metadata;
}

function toMetadataList(
  metadatas: Array<Record<string, unknown> | null> | undefined,
): Metadata[] | undefined {
  return metadatas?.map((record) => (record === null ? {} : toMeta(record)));
}

export const imageRouter = Router();

imageRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = requireJsonBody(req.body);
    const collectionName = validateCollectionName(body.collectionName);
    const ids = validateIds(body.ids);
    const embeddings = validateEmbeddings(body.embeddings);
    assertSameLength(embeddings.length, ids.length, 'embeddings');
    // metadatas 为图片必填字段（保持原接口语义），但允许 null 占位
    if (body.metadatas === undefined) {
      fail('metadatas 必填（图片元数据：fileName/size/mimeType/createdAt）', 'INVALID_METADATAS');
    }
    const metadatas = validateMetadatas(body.metadatas, ids.length) ?? [];
    const refreshIndex = validateRefreshIndex(body.refreshIndex);
    const shouldRefresh = refreshIndex !== false;

    const totalStartedAt = nowMs();
    const upsertStartedAt = nowMs();
    await retryOnConnectionError(async () => {
      const collection = await getCollection(collectionName);
      const dimension = collection.dimension;
      const badIndex = embeddings.findIndex((embedding) => embedding.length !== dimension);
      if (badIndex !== -1) {
        throw new HttpError(
          400,
          `第 ${badIndex + 1} 条图片向量维度为 ${embeddings[badIndex].length}，` +
            `集合 ${collectionName} 需要 ${dimension} 维`,
          'DIMENSION_MISMATCH',
        );
      }
      await collection.upsert({
        ids,
        metadatas: toMetadataList(metadatas),
        embeddings,
      });
    });
    const upsertMs = elapsedMs(upsertStartedAt);

    let refreshMs: number | null = null;
    if (shouldRefresh) {
      const refreshStartedAt = nowMs();
      await retryOnConnectionError(async () => {
        const collection = await getCollection(collectionName);
        await collection.refresh_index();
      });
      refreshMs = elapsedMs(refreshStartedAt);
    }

    res.json({
      ok: true,
      count: ids.length,
      timings: { upsertMs, refreshMs, totalMs: elapsedMs(totalStartedAt) },
    });
  }),
);
