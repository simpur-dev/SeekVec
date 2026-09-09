/**
 * 当前推理后端与降级信息
 */
import { create } from 'zustand';
import type { Backend } from '../types';

interface BackendState {
  backend: Backend | null;
  reason: string | null;
  setBackend: (backend: Backend, reason?: string) => void;
}

export const useBackendStore = create<BackendState>((set) => ({
  backend: null,
  reason: null,
  setBackend: (backend, reason) => set({ backend, reason: reason ?? null }),
}));
