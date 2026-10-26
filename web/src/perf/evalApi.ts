/**
 * 评测桥接：?perf=1 时暴露 window.__seekvecEval
 *
 * 契约（第 3 节）：
 * - search(query, keyword?, nResults?) → SearchResult & {e2eMs}
 * - ingestFiles(files, collectionName) → {count, times}
 * - reset() → 清空观测数据与检索状态
 *
 * 直接走真实 runtime + /api 链路（不做任何 mock），bench-browser 通过它驱动应用。
 */
import { getRuntimeConfig } from '../config/runtimeConfig';
import { clearPerf, installPerfGlobals, recordPerf } from './metrics';
import { ensureRuntime } from '../inference/runtime';
import { runTextSearch } from '../search/textSearch';
import { ingestTextFiles } from '../ingest/ingestText';
import { resolveSearchCollection } from '../store/collectionSelection';
import { useKbStore } from '../store/kbStore';
import { useModelStore } from '../store/modelStore';
import { useSearchStore } from '../store/searchStore';
import { afterNextPaint, roundMs } from '../utils/perf';

/** 安装 window.__seekvecEval（仅 ?perf=1） */
export function installEvalApi(): void {
  if (!getRuntimeConfig().perf) return;
  if (typeof window === 'undefined') return;

  // 保证 __seekvecPerf 也已安装
  installPerfGlobals();

  window.__seekvecEval = {
    async search(query: string, keyword?: string, nResults = 10) {
      const modelKey = useModelStore.getState().modelKey;
      const runtime = await ensureRuntime(modelKey);
      if (runtime.pipeline.kind !== 'text') {
        throw new Error('当前模型不是文本 embedding 管线');
      }
      const kb = useKbStore.getState();
      const resolution = resolveSearchCollection(kb.collections, kb.activeCollection, modelKey);
      if (!resolution.collection) {
        throw new Error(resolution.notice ?? '未找到可用集合，请先 ingestFiles 导入语料');
      }

      const startedAt = performance.now();
      const outcome = await runTextSearch({
        collectionName: resolution.collection.name,
        query,
        keyword: keyword || undefined,
        nResults,
        embed: runtime.pipeline.extract,
        modelKey,
        backend: runtime.backend,
        dtype: runtime.dtype,
      });
      // 评测栈没有 UI 渲染：等一帧后再计 e2e（有 rAF 时双 rAF，否则立即返回）
      await afterNextPaint();
      const e2eMs = roundMs(performance.now() - startedAt);
      recordPerf('query.e2e', e2eMs, {
        modelKey,
        backend: runtime.backend,
        dtype: runtime.dtype,
        meta: { mode: outcome.result.mode ?? null, via: 'eval' },
      });
      return { ...outcome.result, e2eMs };
    },

    async ingestFiles(files: File[], collectionName: string) {
      const modelKey = useModelStore.getState().modelKey;
      const runtime = await ensureRuntime(modelKey);
      if (runtime.pipeline.kind !== 'text') {
        throw new Error('当前模型不是文本 embedding 管线');
      }
      const config = getRuntimeConfig();
      const outcome = await ingestTextFiles({
        files,
        collectionName,
        modelKey,
        embed: runtime.pipeline.extract,
        batch: config.batch,
        refresh: config.refresh,
        onStatus: (status, progress) =>
          useKbStore.getState().setIngestStatus(status, progress),
      });
      return { count: outcome.count, times: outcome.times };
    },

    async reset() {
      clearPerf();
      useSearchStore.getState().reset();
      useKbStore.getState().setIngestStatus('idle');
    },
  };
}
