import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/inference/chunk';

describe('chunkText', () => {
  it('短段落保持完整，并按顺序编号', () => {
    const first = '第一段内容足够长，超过十个字符。';
    const second = '第二段内容也不错，同样超过十个字符。';
    const chunks = chunkText(`${first}\n\n${second}`);
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.index)).toEqual([0, 1]);
    expect(chunks[0].text).toBe(first);
  });

  it('过滤短于 minLength 的段落', () => {
    const chunks = chunkText('短\n\n这是一个长度超过十个字符的段落。', { minLength: 10 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('长度超过十个字符');
  });

  it('长段落按 maxLength 滑窗切分且不超过上限', () => {
    const raw = 'a'.repeat(600);
    const chunks = chunkText(raw, { maxLength: 256, overlap: 32 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(256);
      expect(chunk.text.length).toBeGreaterThan(0);
    }
    // 滑窗保证重叠：第二块应从 256-32 的位置开始
    expect(chunks[1].text).toBe(raw.slice(224, 480));
  });

  it('overlap >= maxLength 时不会死循环（返回有限结果）', () => {
    const chunks = chunkText('x'.repeat(100), { maxLength: 10, overlap: 999, minLength: 0 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(100);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(10);
    }
  });

  it('不会把 UTF-16 代理对切成孤立半字符', () => {
    const raw = '😀'.repeat(200);
    const chunks = chunkText(raw, { maxLength: 10, overlap: 2, minLength: 0 });
    const loneSurrogate = /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/;
    for (const chunk of chunks) {
      expect(loneSurrogate.test(chunk.text)).toBe(false);
    }
  });

  it('空输入返回空数组', () => {
    expect(chunkText('')).toEqual([]);
  });
});
