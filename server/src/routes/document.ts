/**
 * 文档路由
 *
 * - POST   /api/documents                      文本入库（mode: upsert 默认 / insert）
 * - GET    /api/documents?collectionName=&source=   按 metadata.source 列出文档 id
 * - DELETE /api/documents                      按 ids 或 source 删除文档
 * - GET    /api/documents/:collectionName/count     集合条目数（兼容旧接口）
 *
 * 幂等性：默认 upsert —— web 端 chunk id 由内容 hash 生成，
 * 同一文件重复导入会覆盖同一批 id，不会产生重复分块。
 * insert 模式用于「刚创建的空集合」首次导入：任何 id 已存在都视为冲突（409 DOCUMENT_EXISTS），
 * 让前端能明确区分「复用旧集合」与「新建集合」。
 *
 * 索引刷新：默认每批刷新；web 端可在中间批次传 refreshIndex=false，
 * 只在最后一批刷新一次，减少索引刷新开销（赛题"索引刷新策略"）。
 */
import { Router } from 'express';
import type { Metadata } from 'seekdb';
import { getCollection } from '../db/collections.js';
import { retryOnConnectionError } from '../db/client.js';
import { asyncHandler, HttpError } from './errors.js';
import {
  assertInsertIdsUnique,
  assertSameLength,
  fail,
  readQueryString,
  requireJsonBody,
  validateCollectionName,
  validateDocumentMode,
  validateDocumentTexts,
  validateEmbeddings,
  validateIds,
  validateMetadatas,
  validateRefreshIndex,
  validateSource,
} from './validation.js';
import { elapsedMs, nowMs } from '../util/timing.js';
import type {
  DeleteDocumentsRequest,
  DeleteDocumentsResponse,
  IngestTextResponse,
  ListDocumentIdsResponse,
} from '../types.js';

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

/** null 元数据（SDK 结果里的占位）→ 空对象，保证与 ids 对齐 */
function toMetadataList(
  metadatas: Array<Record<string, unknown> | null> | undefined,
): Metadata[] | undefined {
  return metadatas?.map((record) => (record === null ? {} : toMeta(record)));
}

function isDuplicateEntryError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /duplicate entry/i.test(message);
}

export const documentsRouter = Router();

documentsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = requireJsonBody(req.body);
    const collectionName = validateCollectionName(body.collectionName);
    const mode = validateDocumentMode(body.mode);
    const ids = validateIds(body.ids);
    const documents = validateDocumentTexts(body.documents);
    const embeddings = validateEmbeddings(body.embeddings);
    assertSameLength(documents.length, ids.length, 'documents');
    assertSameLength(embeddings.length, ids.length, 'embeddings');
    const metadatas = validateMetadatas(body.metadatas, ids.length);
    const refreshIndex = validateRefreshIndex(body.refreshIndex);
    const shouldRefresh = refreshIndex !== false;
    if (mode === 'insert') assertInsertIdsUnique(ids);

    const totalStartedAt = nowMs();

    // 1) add / upsert（含集合解析与维度校验）
    const upsertStartedAt = nowMs();
    await retryOnConnectionError(async () => {
      const collection = await getCollection(collectionName);
      const dimension = collection.dimension;
      const badIndex = embeddings.findIndex((embedding) => embedding.length !== dimension);
      if (badIndex !== -1) {
        throw new HttpError(
          400,
          `第 ${badIndex + 1} 条向量维度为 ${embeddings[badIndex].length}，` +
            `集合 ${collectionName} 需要 ${dimension} 维；请检查模型与集合名是否匹配`,
          'DIMENSION_MISMATCH',
        );
      }

      const writeOptions = {
        ids,
        documents,
        embeddings,
        ...(metadatas ? { metadatas: toMetadataList(metadatas) } : {}),
      };

      if (mode === 'insert') {
        // 先查已存在的 id，给出确定的 409（而不是依赖 DB 报错文本）
        const existing = await collection.get({ ids, include: [] });
        const existingIds = [...existing.ids];
        if (existingIds.length > 0) {
          throw new HttpError(
            409,
            `insert 模式下 id 已存在（共 ${existingIds.length} 个，如 ` +
              `${existingIds.slice(0, 3).join(', ')}），请改用 upsert 或更换 id`,
            'DOCUMENT_EXISTS',
          );
        }
        try {
          await collection.add(writeOptions);
        } catch (err) {
          if (err instanceof HttpError) throw err;
          if (isDuplicateEntryError(err)) {
            throw new HttpError(409, 'insert 模式下文档 id 已存在', 'DOCUMENT_EXISTS');
          }
          throw err;
        }
      } else {
        await collection.upsert(writeOptions);
      }
    });
    const upsertMs = elapsedMs(upsertStartedAt);

    // 2) 索引刷新（可选）
    let refreshMs: number | null = null;
    if (shouldRefresh) {
      const refreshStartedAt = nowMs();
      await retryOnConnectionError(async () => {
        // 重新取集合：连接自愈后旧 Collection 可能持有失效连接
        const collection = await getCollection(collectionName);
        await collection.refresh_index();
      });
      refreshMs = elapsedMs(refreshStartedAt);
    }

    const result: IngestTextResponse = {
      ok: true,
      count: ids.length,
      mode,
      refreshed: shouldRefresh,
      timings: {
        upsertMs,
        refreshMs,
        totalMs: elapsedMs(totalStartedAt),
      },
    };
    res.json(result);
  }),
);

/** 按 metadata.source 过滤列出文档 id（web 用于「每文件导入后清理陈旧 id」） */
documentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const collectionName = validateCollectionName(
      readQueryString(req, 'collectionName'),
      'collectionName',
    );
    const source = validateSource(readQueryString(req, 'source'), 'source');

    const ids = await retryOnConnectionError(async () => {
      const collection = await getCollection(collectionName);
      const result = await collection.get({
        include: [],
        ...(source === undefined ? {} : { where: { source } }),
      });
      return [...result.ids];
    });

    const body: ListDocumentIdsResponse = { ids, count: ids.length };
    res.json(body);
  }),
);

/** 删除文档：ids 或 source 二选一（ids 单请求 ≤512） */
documentsRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const body = requireJsonBody(req.body) as unknown as DeleteDocumentsRequest;
    const collectionName = validateCollectionName(body.collectionName);
    const ids = body.ids === undefined ? undefined : validateIds(body.ids);
    const source = validateSource(body.source, 'source');
    if ((ids === undefined) === (source === undefined)) {
      fail('ids 与 source 必须且只能提供一个', 'INVALID_FILTER');
    }

    const deleted = await retryOnConnectionError(async () => {
      const collection = await getCollection(collectionName);
      if (ids !== undefined) {
        const existing = await collection.get({ ids, include: [] });
        await collection.delete({ ids });
        return existing.ids.length;
      }
      const filterSource = source as string;
      const existing = await collection.get({
        include: [],
        where: { source: filterSource },
      });
      await collection.delete({ where: { source: filterSource } });
      return existing.ids.length;
    });

    const response: DeleteDocumentsResponse = { deleted };
    res.json(response);
  }),
);

/** 兼容旧接口：GET /api/documents/:collectionName/count */
documentsRouter.get(
  '/:collectionName/count',
  asyncHandler(async (req, res) => {
    const collectionName = validateCollectionName(req.params.collectionName, 'collectionName');
    const total = await retryOnConnectionError(async () => {
      const collection = await getCollection(collectionName);
      return collection.count();
    });
    res.json({ name: collectionName, count: total });
  }),
);
