/**
 * SeekDB Schema factory
 *
 * 双集合设计：
 * - 文本集合：VectorIndexConfig(HNSW, 384/512) + FulltextIndexConfig(ik, ik_mode)
 * - 图片集合：仅 VectorIndexConfig(HNSW, 512)，无 fulltext
 *
 * embeddingFunction 强制设为 null——向量由 web 端端侧推理产出后写入，
 * 严格遵守赛题规则 1「端侧运行」、规则 6「禁止伪装端侧实则走远程」。
 */
import {
  Schema,
  VectorIndexConfig,
  FulltextIndexConfig,
} from 'seekdb';
import type { Modality } from '../types.js';

const DIM_BY_MODEL = {
  text_en: 384,
  text_zh: 512,
  image: 512,
} as const;

export interface BuildSchemaOptions {
  modality: Modality;
  dimension: 384 | 512;
  /** 仅文本集合生效；默认 smart */
  ikMode?: 'smart' | 'max_word';
}

export function buildSchema(opts: BuildSchemaOptions): Schema {
  const vector = new VectorIndexConfig({
    hnsw: {
      dimension: opts.dimension,
      distance: 'cosine',
    },
    embeddingFunction: null,
  });

  if (opts.modality === 'image') {
    return new Schema({ vectorIndex: vector });
  }

  // FulltextIndexConfig(analyzer, properties)
  // analyzer 默认是 'ik'，properties 仅 ik 支持 ik_mode（'smart' | 'max_word'）
  const ikMode = opts.ikMode ?? 'smart';
  return new Schema({
    vectorIndex: vector,
    fulltextIndex: new FulltextIndexConfig('ik', { ik_mode: ikMode }),
  });
}

export function dimensionForModel(modelKey: keyof typeof DIM_BY_MODEL): 384 | 512 {
  return DIM_BY_MODEL[modelKey];
}
