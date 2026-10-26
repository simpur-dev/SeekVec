/**
 * 集合路由
 *
 * - GET    /api/collections                 列出集合（web 刷新后恢复 kbStore）
 * - POST   /api/collections                 创建/确保集合（已存在但不兼容 → 409）
 * - GET    /api/collections/:name           集合详情（describe + schema + count + timings）
 * - POST   /api/collections/:name/refresh   手动刷新向量索引（维护/补偿）
 * - DELETE /api/collections/:name           删除集合（维护/评测清理）
 */
import { Router } from 'express';
import {
  deleteCollection,
  ensureCollection,
  getCollection,
  inferModelKey,
  listCollections,
  serializeCollectionSchema,
} from '../db/collections.js';
import { isConnectionError, retryOnConnectionError } from '../db/client.js';
import { asyncHandler, HttpError } from './errors.js';
import {
  requireJsonBody,
  validateCollectionName,
  validateIkMode,
  validateModelKey,
} from './validation.js';
import { elapsedMs, nowMs } from '../util/timing.js';
import type {
  CollectionDetail,
  DeleteCollectionResponse,
  ListCollectionsResponse,
  Modality,
  RefreshCollectionResponse,
} from '../types.js';

export const collectionsRouter = Router();

/** 构建集合详情（describe/schema/count 分段计时） */
async function buildCollectionDetail(name: string): Promise<CollectionDetail> {
  const startedAt = nowMs();
  return retryOnConnectionError(async () => {
    const collection = await getCollection(name);

    const describeStartedAt = nowMs();
    const described = await collection.describe();
    const describeMs = elapsedMs(describeStartedAt);

    const schema = serializeCollectionSchema(collection.schema);
    const hasFulltext = Boolean(collection.schema?.fulltextIndex);
    const dimension: 384 | 512 = described.dimension === 384 ? 384 : 512;
    const modality: Modality = hasFulltext ? 'text' : 'image';

    // count 失败不应让详情整体 500（与 listCollections 的容错口径一致）；
    // 但连接类错误必须继续抛，交给 retry / 503 映射。
    let count: number | null = null;
    const countStartedAt = nowMs();
    try {
      count = await collection.count();
    } catch (err) {
      if (isConnectionError(err)) throw err;
      count = null;
    }
    const countMs = elapsedMs(countStartedAt);

    return {
      name,
      dimension,
      distance: described.distance,
      modality,
      modelKey: inferModelKey(name, dimension, hasFulltext),
      count,
      schema,
      timings: {
        describeMs,
        countMs,
        totalMs: elapsedMs(startedAt),
      },
    };
  });
}

collectionsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const collections = await retryOnConnectionError(() => listCollections());
    const body: ListCollectionsResponse = { collections };
    res.json(body);
  }),
);

collectionsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = requireJsonBody(req.body);
    const name = validateCollectionName(body.name, 'name');
    const modelKey = validateModelKey(body.modelKey);
    const ikMode = validateIkMode(body.ikMode);
    const result = await retryOnConnectionError(() =>
      ensureCollection(name, modelKey, ikMode),
    );
    res.json(result);
  }),
);

collectionsRouter.get(
  '/:name',
  asyncHandler(async (req, res) => {
    const name = validateCollectionName(req.params.name, 'name');
    res.json(await buildCollectionDetail(name));
  }),
);

collectionsRouter.post(
  '/:name/refresh',
  asyncHandler(async (req, res) => {
    const name = validateCollectionName(req.params.name, 'name');
    const startedAt = nowMs();
    await retryOnConnectionError(async () => {
      // 重新取集合：连接自愈后旧 Collection 可能持有失效连接
      const collection = await getCollection(name);
      await collection.refresh_index();
    });
    const body: RefreshCollectionResponse = {
      ok: true,
      timings: { refreshMs: elapsedMs(startedAt) },
    };
    res.json(body);
  }),
);

collectionsRouter.delete(
  '/:name',
  asyncHandler(async (req, res) => {
    const name = validateCollectionName(req.params.name, 'name');
    const deleted = await retryOnConnectionError(() => deleteCollection(name));
    if (!deleted) {
      throw new HttpError(404, `集合不存在: ${name}`, 'COLLECTION_NOT_FOUND');
    }
    const body: DeleteCollectionResponse = { ok: true, deleted: true };
    res.json(body);
  }),
);
