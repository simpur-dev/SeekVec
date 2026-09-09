/**
 * 加载 embedding 模型并对外提供 embed 接口
 *
 * 流程：
 *   1. 探测后端
 *   2. 调用 loadModelWithFallback（WebGPU 失败自动降级 WASM）
 *   3. 更新 backendStore
 *   4. 缓存 pipeline 实例
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadModelWithFallback } from '../inference/pipeline';
import type { Backend, ModelKey } from '../types';
import { useBackendStore } from '../store/backendStore';
import { detectBackend } from '../inference/backend';

interface EmbeddingState {
  loading: boolean;
  ready: boolean;
  error: string | null;
}

export function useEmbedding(modelKey: ModelKey) {
  const [state, setState] = useState<EmbeddingState>({
    loading: false,
    ready: false,
    error: null,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pipelineRef = useRef<any>(null);
  const setBackend = useBackendStore((s) => s.setBackend);

  const init = useCallback(async () => {
    setState({ loading: true, ready: false, error: null });
    try {
      const preferred: Backend = (await detectBackend()) ?? 'wasm';
      const { pipeline, backend } = await loadModelWithFallback(modelKey, preferred);
      pipelineRef.current = pipeline;
      setBackend(backend, backend === 'wasm' ? '未检测到 WebGPU 或初始化失败' : null);
      setState({ loading: false, ready: true, error: null });
    } catch (err) {
      setState({
        loading: false,
        ready: false,
        error: (err as Error).message,
      });
    }
  }, [modelKey, setBackend]);

  useEffect(() => {
    pipelineRef.current = null;
    init();
  }, [init]);

  const embed = useCallback(
    async (texts: string[]): Promise<number[][]> => {
      if (!pipelineRef.current || pipelineRef.current.kind !== 'text') {
        throw new Error('embedding pipeline 未就绪');
      }
      return pipelineRef.current.extract(texts);
    },
    [],
  );

  return { ...state, embed, reload: init };
}
