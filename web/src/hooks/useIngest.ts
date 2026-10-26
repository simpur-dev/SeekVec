/**
 * 文本语料导入 hook（流程实现见 ingest/ingestText.ts，与 React 解耦）
 *
 * - 批次大小 / 索引刷新策略来自运行时配置（?batch=、?refresh=）
 * - 模型未就绪或已有导入任务时给出明确错误
 * - 进度状态写入 kbStore（IngestPanel/StatsBar 展示）
 */
import { useCallback } from 'react';
import { ingestTextFiles, type IngestOutcome } from '../ingest/ingestText';
import { useKbStore } from '../store/kbStore';
import { useModelStore } from '../store/modelStore';
import { getRuntimeConfig } from '../config/runtimeConfig';
import { useEmbedding } from './useEmbedding';

export function useIngestText() {
  const modelKey = useModelStore((s) => s.modelKey);
  const { embed, ready, error: modelError, reload } = useEmbedding(modelKey);

  const ingestFiles = useCallback(
    async (files: File[], collectionName: string): Promise<IngestOutcome> => {
      if (!ready) {
        throw new Error('embedding 模型尚未加载完成，请等待模型加载或点击重试');
      }
      const config = getRuntimeConfig();
      return ingestTextFiles({
        files,
        collectionName,
        modelKey,
        embed,
        batch: config.batch,
        refresh: config.refresh,
        onStatus: (status, progress) =>
          useKbStore.getState().setIngestStatus(status, progress),
      });
    },
    [ready, embed, modelKey],
  );

  return { ingestFiles, ready, error: modelError, reload };
}
