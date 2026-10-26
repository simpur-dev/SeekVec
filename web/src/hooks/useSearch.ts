/**
 * 双集合混合检索流程：
 *   - 文本集合：当前选中模型对应的 collection；按 query embedding + 可选 keyword 走 hybridSearch
 *   - 图片集合（v1.1，暂未启用）：按 IMAGE_PIPELINE_ENABLED 开关跳过
 *
 * 不在客户端做跨空间分数拼合——文本/图片结果分区展示。
 *
 * 分数语义由 server 决定：纯向量返回 distance（越小越相关），
 * 混合检索返回 RRF score（越大越相关），ResultCard 按 metric 分别展示。
 */
import { useCallback, useEffect } from 'react';
import { search } from '../db/api';
import { detectBackend } from '../inference/backend';
import { IMAGE_PIPELINE_ENABLED } from '../inference/models';
import { useModelStore } from '../store/modelStore';
import { useKbStore } from '../store/kbStore';
import { useSearchStore } from '../store/searchStore';
import { useEmbedding } from './useEmbedding';
import { timed } from '../utils/perf';
import type { CollectionSummary } from '../types';

export function useSearch() {
  const modelKey = useModelStore((s) => s.modelKey);
  const dim = useModelStore((s) => s.dim);
  const collections = useKbStore((s) => s.collections);
  const setSearching = useSearchStore((s) => s.setSearching);
  const setTextResults = useSearchStore((s) => s.setTextResults);
  const setImageResults = useSearchStore((s) => s.setImageResults);
  const setError = useSearchStore((s) => s.setError);
  const resetResults = useSearchStore((s) => s.reset);

  // 当前文本模型的 pipeline
  const { embed, ready, error: modelError, reload } = useEmbedding(modelKey);

  // 切换模型时清空旧结果，避免展示上一模型的检索内容
  useEffect(() => {
    resetResults();
  }, [modelKey, resetResults]);

  const runTextSearch = useCallback(
    async (query: string, keyword: string, nResults: number) => {
      // 优先用约定命名的集合；刷新后依赖 useCollections 回填的清单
      const expectedName = modelKey === 'text_en' ? 'kb_text_en' : 'kb_text_zh';
      const byName = collections[expectedName];
      const textColl: CollectionSummary | undefined =
        byName && byName.modality === 'text' && byName.dimension === dim
          ? byName
          : Object.values(collections).find(
              (c) => c.modality === 'text' && c.modelKey === modelKey && c.dimension === dim,
            );

      if (!textColl) {
        // 不再静默返回：把原因带到 UI
        const notice =
          byName && byName.dimension !== dim
            ? `集合 ${expectedName} 的维度是 ${byName.dimension}d，与当前模型（${dim}d）不一致，请切换模型或重新导入`
            : `未找到文本集合 ${expectedName}，请先在「导入文本」中导入文档`;
        setTextResults({
          collectionName: expectedName,
          hits: [],
          latencyMs: 0,
          metric: 'distance',
          notice,
        });
        return;
      }

      // 端侧向量化耗时单独计量（赛题性能展示用）
      const { value: vectors, ms: embeddingMs } = await timed('embed-query', () => embed([query]));
      const result = await search({
        collectionName: textColl.name,
        queryEmbedding: vectors[0],
        nResults,
        keyword: keyword || undefined,
      });
      setTextResults({ ...result, embeddingMs });
    },
    [collections, modelKey, dim, embed, setTextResults],
  );

  const runImageSearch = useCallback(
    async (query: string, nResults: number) => {
      // v1.1 图片管线未启用：不加载 CLIP、不发图片检索请求
      if (!IMAGE_PIPELINE_ENABLED) {
        setImageResults(null);
        return;
      }
      const imageColl = Object.values(collections).find((c) => c.modality === 'image');
      if (!imageColl) {
        setImageResults(null);
        return;
      }
      try {
        const { loadModelWithFallback } = await import('../inference/pipeline');
        // 与文本管线一致：先探测实际可用后端，而不是硬编码 webgpu
        const preferred = await detectBackend();
        const { pipeline } = await loadModelWithFallback('image', preferred);
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
          runTextSearch(query, keyword, nResults),
          runImageSearch(query, nResults),
        ]);
      } catch (err) {
        // 检索失败时给出明确错误，而不是界面毫无反应
        setError((err as Error).message || '检索失败');
      } finally {
        setSearching(false);
      }
    },
    [ready, runTextSearch, runImageSearch, setSearching, setError],
  );

  return { searchAll, ready, error: modelError, reload };
}
