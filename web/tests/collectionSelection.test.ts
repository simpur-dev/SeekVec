import { describe, expect, it } from 'vitest';
import {
  expectedCollectionName,
  isCollectionCompatible,
  pickActiveCollection,
  resolveSearchCollection,
} from '../src/store/collectionSelection';
import type { CollectionSummary } from '../src/types';

const zh: CollectionSummary = {
  name: 'kb_text_zh',
  modelKey: 'text_zh',
  dimension: 512,
  modality: 'text',
  count: 3,
};

const en: CollectionSummary = {
  name: 'kb_text_en',
  modelKey: 'text_en',
  dimension: 384,
  modality: 'text',
  count: 1,
};

const zhWrongDim: CollectionSummary = {
  name: 'kb_text_zh_old',
  modelKey: 'text_zh',
  dimension: 384,
  modality: 'text',
};

const image: CollectionSummary = {
  name: 'kb_image',
  modelKey: 'image',
  dimension: 512,
  modality: 'image',
};

const toMap = (...items: CollectionSummary[]): Record<string, CollectionSummary> =>
  Object.fromEntries(items.map((item) => [item.name, item]));

describe('expectedCollectionName', () => {
  it('约定命名与模型对应', () => {
    expect(expectedCollectionName('text_zh')).toBe('kb_text_zh');
    expect(expectedCollectionName('text_en')).toBe('kb_text_en');
  });
});

describe('isCollectionCompatible', () => {
  it('模态/模型/维度都匹配才算可用', () => {
    expect(isCollectionCompatible(zh, 'text_zh')).toBe(true);
    expect(isCollectionCompatible(zh, 'text_en')).toBe(false);
    expect(isCollectionCompatible(zhWrongDim, 'text_zh')).toBe(false);
    expect(isCollectionCompatible(image, 'text_zh')).toBe(false);
    expect(isCollectionCompatible(undefined, 'text_zh')).toBe(false);
  });
});

describe('pickActiveCollection（启动回填默认选中）', () => {
  it('当前选择仍可用时保留', () => {
    expect(pickActiveCollection(toMap(zh, en), 'kb_text_en', 'text_en')).toBe('kb_text_en');
  });

  it('当前选择失效时回退约定集合', () => {
    expect(pickActiveCollection(toMap(zh), 'deleted_collection', 'text_zh')).toBe(
      'kb_text_zh',
    );
    // 模型切换后旧集合仍存在但不兼容 → 回退新模型的约定集合
    expect(pickActiveCollection(toMap(zh, en), 'kb_text_zh', 'text_en')).toBe('kb_text_en');
  });

  it('约定集合不存在时返回 null（由用户显式选择）', () => {
    expect(pickActiveCollection(toMap(en), null, 'text_zh')).toBeNull();
    expect(pickActiveCollection({}, null, 'text_zh')).toBeNull();
  });
});

describe('resolveSearchCollection（useSearch 只读 activeCollection）', () => {
  it('activeCollection 可用时直接使用，无提示', () => {
    const resolution = resolveSearchCollection(toMap(zh, en), 'kb_text_en', 'text_en');
    expect(resolution.collection?.name).toBe('kb_text_en');
    expect(resolution.notice).toBeNull();
  });

  it('activeCollection 不存在时回退约定集合并提示', () => {
    const resolution = resolveSearchCollection(toMap(zh), 'deleted', 'text_zh');
    expect(resolution.collection?.name).toBe('kb_text_zh');
    expect(resolution.name).toBe('kb_text_zh');
    expect(resolution.notice).toContain('回退到约定集合 kb_text_zh');
  });

  it('activeCollection 与模型不匹配时回退约定集合并提示', () => {
    const resolution = resolveSearchCollection(toMap(zh, en), 'kb_text_zh', 'text_en');
    expect(resolution.collection?.name).toBe('kb_text_en');
    expect(resolution.notice).toContain('不匹配');
  });

  it('约定集合也不可用时返回 null 并给出导入提示', () => {
    const resolution = resolveSearchCollection({}, null, 'text_zh');
    expect(resolution.collection).toBeNull();
    expect(resolution.notice).toContain('未找到文本集合 kb_text_zh');
  });

  it('activeCollection 维度不符且无回退集合时提示维度问题', () => {
    const resolution = resolveSearchCollection(toMap(zhWrongDim), 'kb_text_zh_old', 'text_zh');
    expect(resolution.collection).toBeNull();
    expect(resolution.notice).toContain('384d');
  });
});
