/**
 * 当前推理后端与降级信息
 */
import { create } from 'zustand';
import type { Backend } from '../types';

interface BackendState {
  backend: Backend | null;
  reason: string | null;
  /** 模型加载耗时 ms（用于性能展示） */
  modelLoadMs: number | null;
  setBackend: (backend: Backend, reason?: string) => void;
  setModelLoadMs: (ms: number | null) => void;
}

export const useBackendStore = create<BackendState>((set) => ({
  backend: null,
  reason: null,
  modelLoadMs: null,
  setBackend: (backend, reason) => set({ backend, reason: reason ?? null }),
  setModelLoadMs: (modelLoadMs) => set({ modelLoadMs }),
}));
