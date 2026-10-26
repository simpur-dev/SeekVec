/**
 * 图片入库路由（v1.1 stretch）
 * POST /api/images
 * body: { collectionName, ids, embeddings, metadatas, refreshIndex? }
 */
import { Router } from 'express';
import type { Metadata } from 'seekdb';
import { getCollection } from '../db/collections.js';
import { retryOnConnectionError } from '../db/client.js';
import { errorStatus, HttpError } from './errors.js';
import type { IngestImageRequest } from '../types.js';

/** 同 document.ts，将 unknown 字段收敛为合法 MetadataValue */
function toMeta(record: Record<string, unknown>): Metadata {
  return Object.fromEntries(
    Object.entries(record).filter(([, v]) => v !== undefined),
  ) as Metadata;
}

export const imageRouter = Router();

imageRouter.post('/', async (req, res) => {
  const body = req.body as IngestImageRequest;
  if (
    !body?.collectionName ||
    !Array.isArray(body.ids) ||
    !Array.isArray(body.embeddings) ||
    !Array.isArray(body.metadatas)
  ) {
    res.status(400).json({ error: '字段不完整' });
    return;
  }
  if (body.ids.length !== body.embeddings.length || body.ids.length !== body.metadatas.length) {
    res.status(400).json({ error: 'ids / embeddings / metadatas 长度不一致' });
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
          `第 ${badIndex + 1} 条图片向量维度为 ${body.embeddings[badIndex].length}，` +
            `集合 ${body.collectionName} 需要 ${dimension} 维`,
        );
      }
      await collection.upsert({
        ids: body.ids,
        metadatas: body.metadatas.map(toMeta),
        embeddings: body.embeddings,
      });
      if (body.refreshIndex !== false) {
        await collection.refresh_index();
      }
      return { ok: true as const, count: body.ids.length };
    });
    res.json(result);
  } catch (err) {
    console.error('[images] ingest failed', err);
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});
