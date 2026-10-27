/**
 * 集合管理
 *
 * 合规策略：向量必须由 web 端推理后传入，server 禁止做 embedding。
 * 实现方式：Schema 显式声明 embeddingFunction: null，
 * add/query/hybridSearch 一律传预计算 embeddings（queryEmbeddings）。
 * 不使用 getOrCreateCollection 默认路径——那会隐式绑定 seekdb 的默认向量化组件
 * （Node 端推理），与「端侧运行」审计要求冲突，且该依赖已从 server 移除。
 */
import { getClient } from './client.js';
import { buildSchema } from './schema.js';
import type { Schema } from 'seekdb';
import type {
  CollectionListItem,
  CollectionSchemaInfo,
  ModelKey,
  Modality,
} from '../types.js';

export { dimensionForModel } from './schema.js';
export type { ModelKey };

const DIM_BY_MODEL: Record<ModelKey, 384 | 512> = {
  text_en: 384,
  text_zh: 512,
  image: 512,
};

/** 集合已存在但与请求的模型/维度不兼容（路由层映射为 409） */
export class CollectionSchemaMismatchError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'CollectionSchemaMismatchError';
  }
}

export function dimensionForModelKey(key: ModelKey): 384 | 512 {
  return DIM_BY_MODEL[key];
}

function modalityOfModelKey(key: ModelKey): Modality {
  return key === 'image' ? 'image' : 'text';
}

/**
 * 获取或创建集合（显式 Schema：HNSW cosine + ik 全文索引[仅文本] + embeddingFunction: null）。
 * 创建时 HNSW 索引初始化会有短暂延迟（约 1-3 秒），属正常行为。
 *
 * 若集合已存在，会校验实际维度/模态与请求模型是否一致：
 * 不一致时抛 409，避免把 384d 向量写进 512d 集合（或反之）导致数据被写坏。
 */
export async function ensureCollection(
  name: string,
  modelKey: ModelKey,
  ikMode: 'smart' | 'max_word' = 'smart',
): Promise<{ created: boolean; name: string; dimension: 384 | 512 }> {
  const client = await getClient();
  const dimension = dimensionForModelKey(modelKey);
  const expectedModality = modalityOfModelKey(modelKey);

  const exists = await client.hasCollection(name);
  if (exists) {
    const existing = await client.getCollection({ name, embeddingFunction: null });
    const actualDimension: 384 | 512 = existing.dimension === 384 ? 384 : 512;
    const actualModality: Modality = existing.schema?.fulltextIndex ? 'text' : 'image';
    if (actualDimension !== dimension || actualModality !== expectedModality) {
      throw new CollectionSchemaMismatchError(
        `集合 ${name} 已存在且与模型 ${modelKey} 不兼容：` +
          `实际 ${actualDimension}d/${actualModality}，期望 ${dimension}d/${expectedModality}。` +
          `请更换集合名，或先删除旧集合再导入。`,
      );
    }
    return { created: false, name, dimension: actualDimension };
  }

  await client.createCollection({
    name,
    schema: buildSchema({ modality: expectedModality, dimension, ikMode }),
  });
  collectionHandleCache.delete(name);
  return { created: true, name, dimension };
}

export async function getCollection(name: string) {
  const client = await getClient();
  const now = Date.now();
  const cached = collectionHandleCache.get(name);
  // 缓存 key 带 client 引用：seekdb 重启/重连后 client 会更换，旧句柄自动失效。
  if (cached && cached.client === client && now - cached.cachedAt < COLLECTION_HANDLE_TTL_MS) {
    return cached.collection;
  }
  const collection = await client.getCollection({ name, embeddingFunction: null });
  collectionHandleCache.set(name, { client, collection, cachedAt: now });
  return collection;
}

/** 集合句柄缓存（每请求 getCollection 会做元数据往返；命中后省 ~3–4ms） */
const COLLECTION_HANDLE_TTL_MS = 30_000;
const collectionHandleCache = new Map<
  string,
  { client: Awaited<ReturnType<typeof getClient>>; collection: Awaited<ReturnType<Awaited<ReturnType<typeof getClient>>['getCollection']>>; cachedAt: number }
>();

/** 删除/重建集合时主动失效（避免读到旧 schema/旧句柄） */
export function invalidateCollectionHandle(name: string): void {
  collectionHandleCache.delete(name);
}

/**
 * 删除集合（维护/评测清理用）。
 *
 * 返回 false 表示集合本来就不存在（路由层映射 404），
 * 避免先 hasCollection 再 deleteCollection 的两次往返。
 */
export async function deleteCollection(name: string): Promise<boolean> {
  const client = await getClient();
  const exists = await client.hasCollection(name);
  if (!exists) {
    collectionHandleCache.delete(name);
    return false;
  }
  await client.deleteCollection(name);
  collectionHandleCache.delete(name);
  return true;
}

/**
 * 把 SDK 的 Schema 收敛为可 JSON 序列化的索引摘要：
 * - hnsw：HNSW 参数（维度/距离等）
 * - fulltext：全文索引 analyzer/properties（图片集合为 null）
 */
export function serializeCollectionSchema(schema?: Schema): CollectionSchemaInfo {
  const hnsw = schema?.vectorIndex?.hnsw;
  const fulltext = schema?.fulltextIndex;
  return {
    ...(hnsw ? { hnsw: { ...hnsw } } : {}),
    fulltext: fulltext
      ? {
          analyzer: fulltext.analyzer,
          properties: fulltext.properties ?? null,
        }
      : null,
  };
}

/**
 * 由集合 schema 与维度反推模型 key：
 * - 带全文索引且 384 维 → text_en；带全文索引且 512 维 → text_zh
 * - 无全文索引（或命名含 image）→ image
 */
export function inferModelKey(name: string, dimension: 384 | 512, hasFulltext: boolean): ModelKey {
  if (!hasFulltext || /(^|_)image($|_)/i.test(name)) return 'image';
  return dimension === 384 ? 'text_en' : 'text_zh';
}

/**
 * 列出当前 database 下所有集合（供 web 刷新后恢复集合清单）。
 *
 * 注意：SDK 1.3.0 的 listCollections 默认 withEmbeddingFunction=true，
 * 在 server 模式下列表会返回空数组，必须显式传 false。
 */
export async function listCollections(): Promise<CollectionListItem[]> {
  const client = await getClient();
  const collections = await client.listCollections({ withEmbeddingFunction: false });

  return Promise.all(
    collections.map(async (collection) => {
      const hasFulltext = Boolean(collection.schema?.fulltextIndex);
      const dimension: 384 | 512 = collection.dimension === 384 ? 384 : 512;
      let count: number | null = null;
      try {
        count = await collection.count();
      } catch {
        count = null;
      }
      return {
        name: collection.name,
        modelKey: inferModelKey(collection.name, dimension, hasFulltext),
        dimension,
        modality: (hasFulltext ? 'text' : 'image') as Modality,
        count,
      };
    }),
  );
}
