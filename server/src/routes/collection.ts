/**
 * POST /api/collections
 * body: { name, modelKey, ikMode? }
 *
 * GET /api/collections
 * 列出已有集合（web 刷新后用它恢复 kbStore）
 */
import { Router } from 'express';
import { ensureCollection, listCollections } from '../db/collections.js';
import { retryOnConnectionError } from '../db/client.js';
import { errorStatus } from './errors.js';
import type { CreateCollectionRequest, ListCollectionsResponse } from '../types.js';

export const collectionsRouter = Router();

collectionsRouter.get('/', async (_req, res) => {
  try {
    const collections = await retryOnConnectionError(() => listCollections());
    const body: ListCollectionsResponse = { collections };
    res.json(body);
  } catch (err) {
    console.error('[collections] listCollections failed', err);
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

collectionsRouter.post('/', async (req, res) => {
  const body = req.body as CreateCollectionRequest;
  if (!body?.name || !body?.modelKey) {
    res.status(400).json({ error: 'name 与 modelKey 必填' });
    return;
  }
  try {
    const result = await retryOnConnectionError(() =>
      ensureCollection(body.name, body.modelKey, body.ikMode),
    );
    res.json(result);
  } catch (err) {
    console.error('[collections] ensureCollection failed', err);
    // 已存在但不兼容的集合 → 409，前端可直接展示原因
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});
