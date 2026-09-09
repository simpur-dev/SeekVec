/**
 * 文本语料导入流程：
 *   1. 读文件 → 分块
 *   2. 端侧 embedding（批处理 16 条/组）
 *   3. POST /api/documents 写入（每批独立写，无状态泄漏）
 */
import { useCallback } from 'react';
import { chunkText } from '../inference/chunk';
import { genId } from '../utils/id';
import { readTextFile } from '../utils/fileReader';
import { ensureCollection, ingestDocuments, getCount, makeSummary } from '../db/api';
import { useModelStore } from '../store/modelStore';
import { useKbStore } from '../store/kbStore';
import { useEmbedding } from './useEmbedding';

const BATCH_SIZE = 16;

export function useIngestText() {
  const modelKey = useModelStore((s) => s.modelKey);
  const dim = useModelStore((s) => s.dim);
  const { embed, ready } = useEmbedding(modelKey);
  const setIngestStatus = useKbStore((s) => s.setIngestStatus);
  const registerCollection = useKbStore((s) => s.registerCollection);
  const setCount = useKbStore((s) => s.setCount);

  const ingestFiles = useCallback(
    async (files: File[], collectionName: string) => {
      if (!ready) throw new Error('embedding 模型尚未加载完成');
      if (files.length === 0) return;

      setIngestStatus('reading', { total: files.length, done: 0 });

      // 1) 读文件 + 分块
      const allChunks: { text: string; source: string }[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const text = await readTextFile(file);
        const chunks = chunkText(text);
        for (const c of chunks) {
          allChunks.push({ text: c.text, source: file.name });
        }
        setIngestStatus('reading', { total: files.length, done: i + 1 });
      }

      const texts = allChunks.map((c) => c.text);
      const totalChunks = texts.length;

      // 2) 确保集合存在（按当前模型 dimension）
      await ensureCollection(collectionName, modelKey);
      registerCollection(makeSummary(collectionName, modelKey, dim));

      // 3) 端侧 embedding（批处理 16 条）+ 逐批写入 SeekDB
      setIngestStatus('embedding', { total: totalChunks, done: 0 });

      for (let start = 0; start < totalChunks; start += BATCH_SIZE) {
        const end = Math.min(start + BATCH_SIZE, totalChunks);
        const batch = texts.slice(start, end);
        const batchChunks = allChunks.slice(start, end);

        const vectors = await embed(batch);

        await ingestDocuments({
          collectionName,
          ids: batchChunks.map((_, j) => genId(`chunk_${start + j}`)),
          documents: batch,
          embeddings: vectors,
          metadatas: batchChunks.map((c) => ({ source: c.source })),
        });

        setIngestStatus('embedding', { total: totalChunks, done: end });
      }

      // 4) 收尾
      const total = await getCount(collectionName);
      setCount(collectionName, total);
      setIngestStatus('done', { total: totalChunks, done: totalChunks });
    },
    [ready, embed, modelKey, dim, setIngestStatus, registerCollection, setCount],
  );

  return { ingestFiles, ready };
}
