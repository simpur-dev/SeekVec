/**
 * 全局 window 扩展：?perf=1 时由 perf/metrics.ts 与 perf/evalApi.ts 安装
 */
import type { IngestTimes } from '../ingest/ingestText';
import type { MetricsSnapshot, MetricsSummary } from '../perf/metrics';
import type { SearchResult } from './index';

declare global {
  interface Window {
    /** 观测入口（?perf=1） */
    __seekvecPerf?: {
      snapshot: () => MetricsSnapshot;
      summary: () => MetricsSummary;
      clear: () => void;
    };
    /** 评测入口（?perf=1）：直接驱动真实 runtime + API */
    __seekvecEval?: {
      search: (
        query: string,
        keyword?: string,
        nResults?: number,
      ) => Promise<SearchResult & { e2eMs: number }>;
      ingestFiles: (
        files: File[],
        collectionName: string,
      ) => Promise<{ count: number; times: IngestTimes }>;
      reset: () => Promise<void>;
    };
  }
}

export {};
