import { describe, expect, it } from 'vitest';
import { chunkId } from '../src/utils/id';

describe('chunkId', () => {
  it('相同来源/序号/文本生成稳定 id（重复导入幂等的前提）', () => {
    const a = chunkId('doc.md', 0, 'hello world');
    const b = chunkId('doc.md', 0, 'hello world');
    expect(a).toBe(b);
    expect(a).toMatch(/^chunk_[a-z0-9]+$/);
  });

  it('来源、序号、文本任一变化都会得到不同 id', () => {
    const base = chunkId('doc.md', 0, 'hello');
    expect(chunkId('other.md', 0, 'hello')).not.toBe(base);
    expect(chunkId('doc.md', 1, 'hello')).not.toBe(base);
    expect(chunkId('doc.md', 0, 'hello!')).not.toBe(base);
  });
});
