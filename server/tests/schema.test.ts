import { describe, expect, it } from 'vitest';
import {
  buildSchema,
  dimensionForModel,
} from '../src/db/schema.js';

type VectorCfg = { hnsw?: { dimension?: number; distance?: string } };
type FulltextCfg = { analyzer?: string; properties?: Record<string, unknown> };

describe('buildSchema', () => {
  it('文本集合：HNSW cosine + ik smart 全文索引', () => {
    const schema = buildSchema({ modality: 'text', dimension: 512 });
    const vector = schema.vectorIndex as unknown as VectorCfg;
    const fulltext = schema.fulltextIndex as unknown as FulltextCfg;

    expect(vector.hnsw?.dimension).toBe(512);
    expect(vector.hnsw?.distance).toBe('cosine');
    expect(fulltext.analyzer).toBe('ik');
    expect(fulltext.properties?.ik_mode).toBe('smart');
  });

  it('文本集合支持 max_word 分词模式', () => {
    const schema = buildSchema({ modality: 'text', dimension: 384, ikMode: 'max_word' });
    const fulltext = schema.fulltextIndex as unknown as FulltextCfg;
    expect(fulltext.properties?.ik_mode).toBe('max_word');
  });

  it('图片集合只有向量索引，没有全文索引', () => {
    const schema = buildSchema({ modality: 'image', dimension: 512 });
    expect(schema.vectorIndex).toBeDefined();
    expect(schema.fulltextIndex).toBeUndefined();
  });
});

describe('dimensionForModel', () => {
  it('按模型返回正确维度', () => {
    expect(dimensionForModel('text_en')).toBe(384);
    expect(dimensionForModel('text_zh')).toBe(512);
    expect(dimensionForModel('image')).toBe(512);
  });
});
