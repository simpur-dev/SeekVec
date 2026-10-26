/**
 * 文本检索流程（图片管线 v1.1 预留）
 *
 * 集合选择（契约第 4 节）：
 * - 只读 kbStore.activeCollection；不存在/维度不符时回退约定命名并提示（不再按命名盲猜）
 * - 回退/失效提示通过 searchStore.collectionNotice 以警示条展示
 *
 * 耗时口径：
 * - embeddingMs：端侧向量化
 * - latencyMs / httpMs：/api/search HTTP 往返
 * - dbMs：server timings.dbMs（SeekDB 库内）
 * - e2eMs：从发起检索到结果渲染完成（双 rAF）
 *
 * 不在客户端做跨空间分数拼合——文本/图片结果分区展示。
 * 分数语义由 server 决定：纯向量返回 distance（越小越相关），
 * 混合检索返回 RRF score（越大越相关），ResultCard 按 metric 分别展示。
 */
import { useCallback, useEffect, useMemo } from 'react';
import { search } from '../db/api';
import { detectBackend } from '../inference/backend';
import { IMAGE_PIPELINE_ENABLED } from '../inference/models';
import { useModelStore } from '../store/modelStore';
import { useKbStore } from '../store/kbStore';
import { useSearchStore } from '../store/searchStore';
import { resolveSearchCollection } from '../store/collectionSelection';
import { runTextSearch } from '../search/textSearch';
import { afterNextPaint } from '../utils/perf';
import { recordPerf } from '../perf/metrics';
import { useEmbedding } from './useEmbedding';
import type { CollectionSummary } from '../types';

export function useSearch() {
  const modelKey = useModelStore((s) => s.modelKey);
  const collections = useKbStore((s) => s.collections);
  const activeCollection = useKbStore((s) => s.activeCollection);
  const setActiveCollection = useKbStore((s) => s.setActiveCollection);
  const setSearching = useSearchStore((s) => s.setSearching);
  const setTextResults = useSearchStore((s) => s.setTextResults);
  const setImageResults = useSearchStore((s) => s.setImageResults);
  const setError = useSearchStore((s) => s.setError);
  const setCollectionNotice = useSearchStore((s) => s.setCollectionNotice);
  const resetResults = useSearchStore((s) => s.reset);

  const { embed, ready, error: modelError, reload, backend, dtype } = useEmbedding(modelKey);

  // 当前模型对应的目标集合（activeCollection 失效时回退约定命名）
  const resolution = useMemo(
    () => resolveSearchCollection(collections, activeCollection, modelKey),
    [collections, activeCollection, modelKey],
  );

  // 切换模型时清空旧结果，避免展示上一模型的检索内容
  useEffect(() => {
    resetResults();
  }, [modelKey, resetResults]);

  // 集合提示：active 失效但存在可用回退集合时展示警示条；
  // activeCollection 为空（首次启动）时自动选中回退集合
  useEffect(() => {
    setCollectionNotice(resolution.collection ? resolution.notice : null);
    if (resolution.collection && activeCollection === null) {
      setActiveCollection(resolution.collection.name);
    }
  }, [resolution, activeCollection, setActiveCollection, setCollectionNotice]);

  const runTextSearchTask = useCallback(
    async (query: string, keyword: string, nResults: number) => {
      if (!resolution.collection) {
        setTextResults({
          collectionName: resolution.name,
          hits: [],
          latencyMs: 0,
          metric: 'distance',
          mode: 'vector',
          notice: resolution.notice ?? '未找到可用的文本集合，请先在「导入文本」中导入文档',
        });
        return;
      }

      const outcome = await runTextSearch({
        collectionName: resolution.collection.name,
        query,
        keyword: keyword || undefined,
        nResults,
        embed,
        modelKey,
        backend,
        dtype,
      });
      const result = outcome.result;
      // 先渲染结果，再计算「端到端 = 到结果渲染完成」并回填
      setTextResults(result);
      await afterNextPaint();
      const e2eMs = Math.max(0, Math.round(performance.now() - outcome.startedAt));
      recordPerf('query.e2e', e2eMs, {
        modelKey,
        backend: backend ?? undefined,
        dtype: dtype ?? undefined,
        meta: { mode: result.mode ?? null, hits: result.hits.length },
      });
      setTextResults({ ...result, e2eMs });
    },
    [resolution, embed, modelKey, backend, dtype, setTextResults],
  );

  const runImageSearch = useCallback(
    async (query: string, nResults: number) => {
      // v1.1 图片管线未启用：不加载 CLIP、不发图片检索请求
      if (!IMAGE_PIPELINE_ENABLED) {
        setImageResults(null);
        return;
      }
      const imageColl = Object.values(collections).find(
        (c: CollectionSummary) => c.modality === 'image',
      );
      if (!imageColl) {
        setImageResults(null);
        return;
      }
      try {
        const { loadModelWithFallback } = await import('../inference/pipeline');
        // 与文本管线一致：先探测实际可用后端，而不是硬编码 webgpu
        const probe = await detectBackend();
        const { pipeline } = await loadModelWithFallback('image', probe.backend, {
          allowFallback: !probe.forced,
        });
        if (pipeline.kind !== 'image') throw new Error('CLIP pipeline 不可用');
        const vectors = await pipeline.textTower([query]);
        const result = await search({
          collectionName: imageColl.name,
          queryEmbedding: vectors[0],
          nResults,
        });
        setImageResults(result);
      } catch (err) {
        console.warn('[search] image pipeline failed', err);
        setImageResults(null);
      }
    },
    [collections, setImageResults],
  );

  const searchAll = useCallback(
    async (query: string, keyword: string, nResults = 10) => {
      if (!query.trim()) return;
      if (!ready) {
        setError('embedding 模型尚未加载完成，请稍后再试');
        return;
      }
      setSearching(true);
      setError(null);
      try {
        await Promise.all([
          runTextSearchTask(query, keyword, nResults),
          runImageSearch(query, nResults),
        ]);
      } catch (err) {
        // 检索失败时给出明确错误，而不是界面毫无反应
        setError((err as Error).message || '检索失败');
      } finally {
        setSearching(false);
      }
    },
    [ready, runTextSearchTask, runImageSearch, setSearching, setError],
  );

  return {
    searchAll,
    ready,
    error: modelError,
    reload,
    /** 当前检索目标集合（null=不可用） */
    targetCollection: resolution.collection,
  };
}
