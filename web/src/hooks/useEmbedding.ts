/**
 * 加载 embedding 模型并对外提供 embed 接口
 *
 * 内部委托给 inference/runtime 单例：
 * - useSearch / useIngest / 评测入口共享同一实例（不会重复下载/初始化）
 * - 切换模型时通过 generation 丢弃过期加载结果
 * - reload() 全局生效（所有订阅者都会重新初始化）
 */
import { useCallback, useEffect } from 'react';
import {
  ensureRuntime,
  isRuntimeSupersededError,
  reloadRuntime,
} from '../inference/runtime';
import type { ModelKey } from '../types';
import { useRuntimeState } from './useRuntime';

export function useEmbedding(modelKey: ModelKey) {
  const runtime = useRuntimeState();

  // 模型切换 / 全局重载时确保运行时已开始加载
  useEffect(() => {
    void ensureRuntime(modelKey).catch((err) => {
      if (isRuntimeSupersededError(err)) return;
      // 错误已通过运行时状态暴露给 UI，这里只做调试输出
      console.debug('[embedding] 模型加载失败', err);
    });
  }, [modelKey, runtime.generation]);

  const embed = useCallback(
    async (texts: string[]): Promise<number[][]> => {
      const loaded = await ensureRuntime(modelKey);
      if (loaded.pipeline.kind !== 'text') {
        throw new Error('当前模型不是文本 embedding 管线');
      }
      return loaded.pipeline.extract(texts);
    },
    [modelKey, runtime.generation],
  );

  const loading = runtime.status === 'loading' && runtime.modelKey === modelKey;
  const ready = runtime.status === 'ready' && runtime.modelKey === modelKey;
  const error =
    runtime.status === 'error' && runtime.modelKey === modelKey ? runtime.error : null;

  return {
    loading,
    ready,
    error,
    embed,
    reload: reloadRuntime,
    backend: ready ? runtime.backend : runtime.preferredBackend,
    dtype: runtime.dtype,
  };
}
