import { describe, expect, it } from 'vitest';
import { shouldAcceptSearchResult } from '../src/search/searchGuard';

const base = {
  requestId: 2,
  currentRequestId: 2,
  modelKey: 'text_zh',
  currentModel: 'text_zh',
  collectionName: 'kb_text_zh',
  currentCollectionName: 'kb_text_zh',
};

describe('shouldAcceptSearchResult', () => {
  it('请求代次、模型、集合都未变化时接收', () => {
    expect(shouldAcceptSearchResult(base)).toBe(true);
  });

  it('模型已切换时丢弃旧请求', () => {
    expect(shouldAcceptSearchResult({ ...base, currentModel: 'text_en' })).toBe(false);
  });

  it('集合已切换时丢弃旧请求', () => {
    expect(shouldAcceptSearchResult({ ...base, currentCollectionName: 'other' })).toBe(false);
  });

  it('有更新的检索请求时丢弃旧请求', () => {
    expect(shouldAcceptSearchResult({ ...base, currentRequestId: 3 })).toBe(false);
  });

  it('旧集合已失效（当前 collectionName=null）也丢弃', () => {
    expect(shouldAcceptSearchResult({ ...base, currentCollectionName: null })).toBe(false);
  });
});
