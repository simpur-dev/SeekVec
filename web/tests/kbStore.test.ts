import { beforeEach, describe, expect, it } from 'vitest';
import { useKbStore } from '../src/store/kbStore';

const summary = (name: string, count: number) => ({
  name,
  modelKey: 'text_zh' as const,
  dimension: 512 as const,
  modality: 'text' as const,
  count,
});

describe('kbStore.syncCollections', () => {
  beforeEach(() => {
    useKbStore.setState({ collections: {}, counts: {}, activeCollection: null });
  });

  it('以 server 列表整体替换，删除的集合不会残留', () => {
    const store = useKbStore.getState();
    store.registerCollection(summary('a', 3));
    store.registerCollection(summary('b', 5));
    store.setCount('a', 3);
    expect(Object.keys(useKbStore.getState().collections).sort()).toEqual(['a', 'b']);

    useKbStore.getState().syncCollections([summary('b', 7)]);
    const state = useKbStore.getState();
    expect(Object.keys(state.collections)).toEqual(['b']);
    expect(state.counts).toEqual({ b: 7 });
  });
});
