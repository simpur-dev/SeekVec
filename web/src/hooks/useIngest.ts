/**
 * 文本语料导入流程：
 *   1. 读文件 → 分块（确定性 chunk id，重复导入幂等）
 *   2. 端侧 embedding（批处理 16 条/组）
 *   3. upsert 写入 SeekDB，索引只在最后一批刷新
 *
 * 错误处理：失败时把 ingestStatus 置为 error 并向上抛（UI 展示原因）；
 * 同时用 busyRef 防止并发导入。
 */
import { useCallback, useRef } from 'react';
import { chunkText } from '../inference/chunk';
import { chunkId } from '../utils/id';
import { chunkArray } from '../utils/perf';
import { readTextFile } from '../utils/fileReader';
import { ensureCollection, ingestDocuments, getCount } from '../db/api';
import { useModelStore } from '../store/modelStore';
import { useKbStore } from '../store/kbStore';
import { useEmbedding } from './useEmbedding';

const BATCH_SIZE = 16;

interface ChunkRecord {
  id: string;
  text: string;
  source: string;
  chunkIndex: number;
}

export function useIngestText() {
  const modelKey = useModelStore((s) => s.modelKey);
  const { embed, ready, error: modelError, reload } = useEmbedding(modelKey);
  const setIngestStatus = useKbStore((s) => s.setIngestStatus);
  const registerCollection = useKbStore((s) => s.registerCollection);
  const setCount = useKbStore((s) => s.setCount);
  const busyRef = useRef(false);

  const ingestFiles = useCallback(
    async (files: File[], collectionName: string) => {
      if (!ready) throw new Error('embedding 模型尚未加载完成，请等待模型加载或点击重试');
      if (busyRef.current) throw new Error('已有导入任务进行中，请等待完成');
      if (files.length === 0) return;

      busyRef.current = true;
      try {
        setIngestStatus('reading', { total: files.length, done: 0 });

        // 1) 读文件 + 分块（id 由 文件名+块序号+文本 决定）
        const allChunks: ChunkRecord[] = [];
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const text = await readTextFile(file);
          const chunks = chunkText(text);
          chunks.forEach((chunk, chunkIndex) => {
            allChunks.push({
              id: chunkId(file.name, chunkIndex, chunk.text),
              text: chunk.text,
              source: file.name,
              chunkIndex,
            });
          });
          setIngestStatus('reading', { total: files.length, done: i + 1 });
        }

        // 同一次导入内去重（同一文件里完全相同的块会得到相同 id）
        const uniqueChunks = [...new Map(allChunks.map((c) => [c.id, c])).values()];
        const totalChunks = uniqueChunks.length;
        if (totalChunks === 0) {
          throw new Error('没有可导入的文本内容（分块结果为空）');
        }

        // 2) 确保集合存在（server 会校验已存在集合的维度/模态是否与模型匹配）
        const ensured = await ensureCollection(collectionName, modelKey);
        // server 返回的是 number，窄化为模型维度类型
        const dimension: 384 | 512 = ensured.dimension === 384 ? 384 : 512;
        registerCollection({
          name: collectionName,
          modelKey,
          dimension,
          modality: 'text',
          count: 0,
        });

        // 3) 端侧 embedding（批处理 16 条）+ upsert 写入 SeekDB
        setIngestStatus('embedding', { total: totalChunks, done: 0 });
        const batches = chunkArray(uniqueChunks, BATCH_SIZE);
        let done = 0;
        for (let b = 0; b < batches.length; b++) {
          const batch = batches[b];
          const isLast = b === batches.length - 1;
          const vectors = await embed(batch.map((c) => c.text));
          await ingestDocuments({
            collectionName,
            ids: batch.map((c) => c.id),
            documents: batch.map((c) => c.text),
            embeddings: vectors,
            metadatas: batch.map((c) => ({ source: c.source, chunkIndex: c.chunkIndex })),
            // 中间批次不刷新索引，只刷新最后一批
            refreshIndex: isLast,
          });
          done += batch.length;
          setIngestStatus('embedding', { total: totalChunks, done });
        }

        // 4) 收尾
        setIngestStatus('writing', { total: totalChunks, done: totalChunks });
        const total = await getCount(collectionName);
        setCount(collectionName, total);
        registerCollection({
          name: collectionName,
          modelKey,
          dimension,
          modality: 'text',
          count: total,
        });
        setIngestStatus('done', { total: totalChunks, done: totalChunks });
      } catch (err) {
        setIngestStatus('error');
        throw err;
      } finally {
        busyRef.current = false;
      }
    },
    [ready, embed, modelKey, setIngestStatus, registerCollection, setCount],
  );

  return { ingestFiles, ready, error: modelError, reload };
}
