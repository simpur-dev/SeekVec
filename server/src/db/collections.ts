/**
 * 集合管理
 *
 * 合规策略：向量必须由 web 端推理后传入，server 禁止做 embedding。
 * 实现方式：Schema 显式声明 embeddingFunction: null，
 * add/query/hybridSearch 一律传预计算 embeddings（queryEmbeddings）。
 * 不使用 getOrCreateCollection 默认路径——那会隐式绑定 @seekdb/default-embed
 * （Node 端推理），与「端侧运行」审计要求冲突，且该依赖已从 server 移除。
 */
import { getClient } from './client.js';
import { buildSchema } from './schema.js';
import type { ModelKey } from '../types.js';

export { dimensionForModel } from './schema.js';
export type { ModelKey };

const DIM_BY_MODEL: Record<ModelKey, 384 | 512> = {
  text_en: 384,
  text_zh: 512,
  image: 512,
};

export function dimensionForModelKey(key: ModelKey): 384 | 512 {
  return DIM_BY_MODEL[key];
}

/**
 * 获取或创建集合（显式 Schema：HNSW cosine + ik 全文索引[仅文本] + embeddingFunction: null）。
 * 创建时 HNSW 索引初始化会有短暂延迟（约 1-3 秒），属正常行为。
 */
export async function ensureCollection(
  name: string,
  modelKey: ModelKey,
  ikMode: 'smart' | 'max_word' = 'smart',
): Promise<{ created: boolean; name: string; dimension: number }> {
  const client = await getClient();
  const dimension = dimensionForModelKey(modelKey);

  const exists = await client.hasCollection(name);
  if (exists) {
    return { created: false, name, dimension };
  }

  await client.createCollection({
    name,
    schema: buildSchema({ modality: modelKey === 'image' ? 'image' : 'text', dimension, ikMode }),
  });
  return { created: true, name, dimension };
}

export async function getCollection(name: string) {
  const client = await getClient();
  return client.getCollection({ name, embeddingFunction: null });
}
