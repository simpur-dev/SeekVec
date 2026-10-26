/**
 * 页面启动时从 server 拉取已有集合，回填 kbStore。
 *
 * 修复的问题：kbStore 只存在内存里，刷新后集合清单为空，
 * useSearch 找不到集合会直接返回 null，表现成「检索无反应、无提示」。
 */
import { useEffect } from 'react';
import { listCollections } from '../db/api';
import { useKbStore } from '../store/kbStore';

export function useCollections() {
  const registerCollection = useKbStore((s) => s.registerCollection);
  const setCount = useKbStore((s) => s.setCount);

  useEffect(() => {
    let cancelled = false;
    listCollections()
      .then((collections) => {
        if (cancelled) return;
        for (const collection of collections) {
          registerCollection(collection);
          setCount(collection.name, collection.count ?? null);
        }
      })
      .catch((err) => {
        console.error('[collections] 回填集合失败（检索将不可用）', err);
      });
    return () => {
      cancelled = true;
    };
  }, [registerCollection, setCount]);
}
