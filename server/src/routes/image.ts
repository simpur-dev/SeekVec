/**
 * 图片入库路由（v1.1 stretch）
 * POST /api/images
 * body: { collectionName, ids, embeddings, metadatas }
 */
import { Router } from 'express';
import type { Metadata } from 'seekdb';
import { getCollection } from '../db/collections.js';
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

  try {
    const collection = await getCollection(body.collectionName);
    await collection.add({
      ids: body.ids,
      metadatas: body.metadatas.map(toMeta),
      embeddings: body.embeddings,
    });
    await collection.refresh_index();
    res.json({ ok: true, count: body.ids.length });
  } catch (err) {
    console.error('[images] ingest failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});
