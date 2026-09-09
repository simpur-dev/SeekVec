/**
 * 文档入库路由
 * POST /api/documents
 * body: { collectionName, ids, documents, embeddings, metadatas? }
 */
import { Router } from 'express';
import type { Metadata } from 'seekdb';
import { getCollection } from '../db/collections.js';
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

  try {
    const collection = await getCollection(body.collectionName);
    await collection.add({
      ids: body.ids,
      documents: body.documents,
      metadatas: body.metadatas?.map(toMeta),
      embeddings: body.embeddings,
    });
    await collection.refresh_index();
    res.json({ ok: true, count: body.ids.length });
  } catch (err) {
    console.error('[documents] ingest failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

documentsRouter.get('/:collectionName/count', async (req, res) => {
  try {
    const collection = await getCollection(req.params.collectionName);
    const total = await collection.count();
    res.json({ name: req.params.collectionName, count: total });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
