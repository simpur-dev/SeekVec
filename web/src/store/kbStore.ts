/**
 * 知识库状态：集合列表、当前集合、文档计数、ingest 状态
 *
 * - activeCollection 持久化到 localStorage（刷新后保持用户选择）
 * - URL `?collection=` 的初始值由 main.tsx 在启动时写入（URL 优先于持久化值）
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CollectionSummary } from '../types';

export type IngestStatus = 'idle' | 'reading' | 'embedding' | 'writing' | 'done' | 'error';

interface KbState {
  collections: Record<string, CollectionSummary>;
  counts: Record<string, number | null>;
  /** 当前检索/导入使用的集合（null=未选择） */
  activeCollection: string | null;
  ingestStatus: IngestStatus;
  ingestProgress: { total: number; done: number };
  setIngestStatus: (
    status: KbState['ingestStatus'],
    progress?: { total: number; done: number },
  ) => void;
  registerCollection: (summary: CollectionSummary) => void;
  /** 以 server 返回的完整列表为准替换集合清单（删除的集合不能残留） */
  syncCollections: (list: CollectionSummary[]) => void;
  setCount: (name: string, count: number | null) => void;
  setActiveCollection: (name: string | null) => void;
}

export const useKbStore = create<KbState>()(
  persist(
    (set) => ({
      collections: {},
      counts: {},
      activeCollection: null,
      ingestStatus: 'idle',
      ingestProgress: { total: 0, done: 0 },
      setIngestStatus: (ingestStatus, progress) =>
        set((s) => ({
          ingestStatus,
          ingestProgress: progress ?? s.ingestProgress,
        })),
      registerCollection: (summary) =>
        set((s) => ({
          collections: { ...s.collections, [summary.name]: summary },
        })),
      syncCollections: (list) =>
        set(() => {
          const collections: Record<string, CollectionSummary> = {};
          const counts: Record<string, number | null> = {};
          for (const collection of list) {
            collections[collection.name] = collection;
            counts[collection.name] = collection.count ?? null;
          }
          return { collections, counts };
        }),
      setCount: (name, count) =>
        set((s) => ({ counts: { ...s.counts, [name]: count } })),
      setActiveCollection: (activeCollection) => set({ activeCollection }),
    }),
    {
      name: 'seekvec:kb',
      // 只持久化用户选择；集合清单每次启动从 server 回填（README 口径：server 才是事实源）
      partialize: (state) => ({ activeCollection: state.activeCollection }),
    },
  ),
);
