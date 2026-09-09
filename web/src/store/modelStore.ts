/**
 * 当前模型状态
 */
import { create } from 'zustand';
import type { ModelKey } from '../types';
import { DEFAULT_MODEL, getModelInfo } from '../inference/models';

interface ModelState {
  modelKey: ModelKey;
  setModelKey: (key: ModelKey) => void;
  dim: 384 | 512;
}

export const useModelStore = create<ModelState>((set) => ({
  modelKey: DEFAULT_MODEL,
  dim: getModelInfo(DEFAULT_MODEL).dim,
  setModelKey: (key) =>
    set({
      modelKey: key,
      dim: getModelInfo(key).dim,
    }),
}));
