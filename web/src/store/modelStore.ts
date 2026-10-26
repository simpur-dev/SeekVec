/**
 * 当前模型状态（modelKey 持久化到 localStorage）
 *
 * 说明：dim 由 modelKey 推导，不单独持久化，避免两者不一致。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ModelKey } from '../types';
import {
  DEFAULT_MODEL,
  getModelInfo,
  isSelectableModelKey,
} from '../inference/models';

type SelectableModelKey = 'text_en' | 'text_zh';

interface ModelState {
  modelKey: SelectableModelKey;
  setModelKey: (key: SelectableModelKey) => void;
  dim: 384 | 512;
}

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      modelKey: isSelectableModelKey(DEFAULT_MODEL) ? DEFAULT_MODEL : 'text_zh',
      dim: getModelInfo(DEFAULT_MODEL).dim,
      setModelKey: (key) =>
        set({
          modelKey: key,
          dim: getModelInfo(key).dim,
        }),
    }),
    {
      name: 'seekvec:model',
      partialize: (state) => ({ modelKey: state.modelKey }),
      // 回填时校验合法模型并从 modelKey 推导 dim
      merge: (persisted, current) => {
        const stored = (persisted as { modelKey?: unknown } | undefined)?.modelKey;
        const modelKey: SelectableModelKey = isSelectableModelKey(stored) ? stored : current.modelKey;
        return { ...current, modelKey, dim: getModelInfo(modelKey).dim };
      },
    },
  ),
);

/** 当前模型的 ModelKey（用于集合/检索/导入） */
export function getCurrentModelKey(): ModelKey {
  return useModelStore.getState().modelKey;
}
