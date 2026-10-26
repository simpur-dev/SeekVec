import { describe, expect, it } from 'vitest';
import { CollectionSchemaMismatchError, inferModelKey } from '../src/db/collections.js';
import { HttpError, errorStatus } from '../src/routes/errors.js';

describe('errorStatus', () => {
  it('优先使用错误对象上的 status', () => {
    expect(errorStatus(new HttpError(400, 'bad'))).toBe(400);
    expect(errorStatus(new CollectionSchemaMismatchError('mismatch'))).toBe(409);
  });

  it('集合不存在映射为 404', () => {
    expect(errorStatus(new Error('Collection not found: kb_text_zh'))).toBe(404);
  });

  it('未知错误默认 500', () => {
    expect(errorStatus(new Error('boom'))).toBe(500);
    expect(errorStatus('string error')).toBe(500);
  });
});

describe('inferModelKey', () => {
  it('带全文索引按维度区分中英文模型', () => {
    expect(inferModelKey('kb_text_en', 384, true)).toBe('text_en');
    expect(inferModelKey('kb_text_zh', 512, true)).toBe('text_zh');
  });

  it('无全文索引视为图片集合', () => {
    expect(inferModelKey('kb_image', 512, false)).toBe('image');
  });

  it('命名含 image 时即使带全文索引也按图片处理', () => {
    expect(inferModelKey('kb_image_test', 512, true)).toBe('image');
  });
});
