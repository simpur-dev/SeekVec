/**
 * 知识库状态：集合列表、文档计数、ingest 状态
 */
import { create } from 'zustand';
import type { CollectionSummary } from '../types';

interface KbState {
  collections: Record<string, CollectionSummary>;
  counts: Record<string, number | null>;
  ingestStatus: 'idle' | 'reading' | 'embedding' | 'writing' | 'done' | 'error';
  ingestProgress: { total: number; done: number };
  setIngestStatus: (
    status: KbState['ingestStatus'],
    progress?: { total: number; done: number },
  ) => void;
  registerCollection: (summary: CollectionSummary) => void;
  setCount: (name: string, count: number | null) => void;
}

export const useKbStore = create<KbState>((set) => ({
  collections: {},
  counts: {},
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
  setCount: (name, count) =>
    set((s) => ({ counts: { ...s.counts, [name]: count } })),
}));
