/**
 * 订阅推理运行时单例（useSyncExternalStore）
 */
import { useSyncExternalStore } from 'react';
import {
  getRuntimeState,
  subscribeRuntime,
  type RuntimeState,
} from '../inference/runtime';

export function useRuntimeState(): RuntimeState {
  return useSyncExternalStore(subscribeRuntime, getRuntimeState, getRuntimeState);
}

/** 兼容旧组件：只取已就绪的文本 embedding 能力 */
export function useRuntimeBackend() {
  const runtime = useRuntimeState();
  return {
    backend: runtime.status === 'ready' ? runtime.backend : runtime.preferredBackend,
    dtype: runtime.dtype,
    forced: runtime.forced,
    status: runtime.status,
  };
}
