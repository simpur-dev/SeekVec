/**
 * POST /api/collections
 * body: { name, modelKey, ikMode? }
 */
import { Router } from 'express';
import { ensureCollection } from '../db/collections.js';
import type { CreateCollectionRequest } from '../types.js';

export const collectionsRouter = Router();

collectionsRouter.post('/', async (req, res) => {
  const body = req.body as CreateCollectionRequest;
  if (!body?.name || !body?.modelKey) {
    res.status(400).json({ error: 'name 与 modelKey 必填' });
    return;
  }
  try {
    const result = await ensureCollection(body.name, body.modelKey, body.ikMode);
    res.json(result);
  } catch (err) {
    console.error('[collections] ensureCollection failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});
