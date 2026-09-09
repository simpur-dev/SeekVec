/**
 * 双集合混合检索流程：
 *   - 文本集合：当前选中模型对应的 collection；按 query embedding + 可选 keyword 走 hybridSearch
 *   - 图片集合（v1.1）：用 CLIP 文本塔编码 query，向量检索
 *
 * 不在客户端做跨空间分数拼合——文本/图片结果分区展示。
 */
import { useCallback } from 'react';
import { search } from '../db/api';
import { useModelStore } from '../store/modelStore';
import { useKbStore } from '../store/kbStore';
import { useSearchStore } from '../store/searchStore';
import { useEmbedding } from './useEmbedding';

export function useSearch() {
  const modelKey = useModelStore((s) => s.modelKey);
  const collections = useKbStore((s) => s.collections);
  const setSearching = useSearchStore((s) => s.setSearching);
  const setTextResults = useSearchStore((s) => s.setTextResults);
  const setImageResults = useSearchStore((s) => s.setImageResults);

  // 当前文本模型的 pipeline
  const { embed, ready } = useEmbedding(modelKey);

  const runTextSearch = useCallback(
    async (query: string, keyword: string, nResults: number) => {
      // 找到当前模型对应的文本集合
      const textColl = Object.values(collections).find(
        (c) => c.modelKey === modelKey,
      );
      if (!textColl) {
        setTextResults(null);
        return;
      }
      const vectors = await embed([query]);
      const result = await search({
        collectionName: textColl.name,
        queryEmbedding: vectors[0],
        nResults,
        keyword: keyword || undefined,
      });
      setTextResults(result);
    },
    [collections, modelKey, embed, setTextResults],
  );

  const runImageSearch = useCallback(
    async (query: string, nResults: number) => {
      const imageColl = Object.values(collections).find((c) => c.modelKey === 'image');
      if (!imageColl) {
        setImageResults(null);
        return;
      }
      // v1.1：复用 CLIP 文本塔编码 query；当前 v1 直接降级
      // （CLIP 单独加载留给 v1.1 阶段）
      try {
        const { loadModelWithFallback } = await import('../inference/pipeline');
        const { pipeline, backend } = await loadModelWithFallback('image', 'webgpu');
        if (pipeline.kind !== 'image') throw new Error('CLIP pipeline 不可用');
        const vectors = await pipeline.textTower([query]);
        const result = await search({
          collectionName: imageColl.name,
          queryEmbedding: vectors[0],
          nResults,
        });
        setImageResults(result);
        return backend;
      } catch {
        setImageResults(null);
      }
    },
    [collections, setImageResults],
  );

  const searchAll = useCallback(
    async (query: string, keyword: string, nResults = 10) => {
      if (!query.trim()) return;
      if (!ready) return;
      setSearching(true);
      try {
        await Promise.all([
          runTextSearch(query, keyword, nResults),
          runImageSearch(query, nResults),
        ]);
      } finally {
        setSearching(false);
      }
    },
    [ready, runTextSearch, runImageSearch, setSearching],
  );

  return { searchAll, ready };
}
