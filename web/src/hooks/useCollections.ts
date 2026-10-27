/**
 * 页面启动时从 server 拉取已有集合，回填 kbStore，并回填默认选中集合。
 *
 * 修复的问题：kbStore 只存在内存里，刷新后集合清单为空，
 * useSearch 找不到集合会直接返回 null，表现成「检索无反应、无提示」。
 *
 * 默认选中规则（契约第 4 节）：
 * - 用户已选且仍可用 → 保留
 * - 失效 → 回退到当前模型的约定集合（kb_text_zh / kb_text_en）
 * - URL `?collection=` 指定的集合优先（它可能稍后才被评测脚本创建，不能覆盖）
 */
import { useEffect } from 'react';
import { listCollections } from '../db/api';
import { getRuntimeConfig } from '../config/runtimeConfig';
import { useKbStore } from '../store/kbStore';
import { useModelStore } from '../store/modelStore';
import { pickActiveCollection } from '../store/collectionSelection';

export function useCollections() {
  const syncCollections = useKbStore((s) => s.syncCollections);
  const setActiveCollection = useKbStore((s) => s.setActiveCollection);
  const modelKey = useModelStore((s) => s.modelKey);

  useEffect(() => {
    let cancelled = false;
    listCollections()
      .then((collections) => {
        if (cancelled) return;
        // server 是集合事实源：整体替换，删除的集合不能残留在 store
        syncCollections(collections);
        const state = useKbStore.getState();
        const pinned = getRuntimeConfig().collection;
        // URL 指定的集合可能是评测脚本稍后创建的：保持选择，不覆盖
        if (pinned && state.activeCollection === pinned) return;
        const nextActive = pickActiveCollection(
          state.collections,
          state.activeCollection,
          modelKey,
        );
        if (nextActive !== state.activeCollection) setActiveCollection(nextActive);
      })
      .catch((err) => {
        console.error('[collections] 回填集合失败（检索将不可用）', err);
      });
    return () => {
      cancelled = true;
    };
  }, [syncCollections, setActiveCollection, modelKey]);
}
