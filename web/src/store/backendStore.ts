/**
 * 当前推理后端与模型加载状态
 *
 * 字段语义：
 * - preferred：探测/配置得到的目标后端（可能是强制的）
 * - actual / backend：模型真正加载成功后的后端（降级后为 wasm）
 * - forced：是否由 URL/localStorage 强制指定（强制口径用于评测，不能静默降级）
 * - reason：降级 / 强制失败原因（UI 必须展示，不能把失败显示成绿色 WebGPU）
 * - modelState / error：模型加载状态与错误，BackendBadge 据此显示红色错误态
 */
import { create } from 'zustand';
import type { Backend, Dtype } from '../types';
import type { BackendProbe } from '../inference/backend';

export type ModelState = 'idle' | 'loading' | 'ready' | 'error';

interface LoadedInfo {
  backend: Backend;
  preferred: Backend;
  forced: boolean;
  dtype: Dtype;
  modelLoadMs: number;
  /** 降级原因（WebGPU 失败自动降级时） */
  reason: string | null;
}

interface LoadingInfo {
  preferred: Backend;
  forced: boolean;
  reason: string | null;
}

interface BackendState {
  /** 兼容旧字段：当前实际后端 */
  backend: Backend | null;
  preferred: Backend | null;
  actual: Backend | null;
  forced: boolean;
  reason: string | null;
  /** WebGPU 适配器信息（性能报告用） */
  adapterInfo: Record<string, string> | null;
  dtype: Dtype | null;
  modelState: ModelState;
  error: string | null;
  /** 模型加载耗时 ms（用于性能展示） */
  modelLoadMs: number | null;
  setProbe: (probe: BackendProbe) => void;
  setLoading: (info: LoadingInfo) => void;
  setLoaded: (info: LoadedInfo) => void;
  setModelError: (message: string, probe?: LoadingInfo | null) => void;
  /** 兼容旧调用：直接设置实际后端 */
  setBackend: (backend: Backend, reason?: string) => void;
  setModelLoadMs: (ms: number | null) => void;
}

export const useBackendStore = create<BackendState>((set) => ({
  backend: null,
  preferred: null,
  actual: null,
  forced: false,
  reason: null,
  adapterInfo: null,
  dtype: null,
  modelState: 'idle',
  error: null,
  modelLoadMs: null,
  setProbe: (probe) =>
    set({
      preferred: probe.preferred,
      actual: probe.available ? probe.backend : null,
      backend: probe.available ? probe.backend : null,
      forced: probe.forced,
      reason: probe.reason,
      adapterInfo: probe.adapterInfo,
    }),
  setLoading: (info) =>
    set({
      preferred: info.preferred,
      forced: info.forced,
      reason: info.reason,
      modelState: 'loading',
      error: null,
    }),
  setLoaded: (info) =>
    set({
      backend: info.backend,
      actual: info.backend,
      preferred: info.preferred,
      forced: info.forced,
      dtype: info.dtype,
      modelLoadMs: info.modelLoadMs,
      modelState: 'ready',
      error: null,
      reason: info.reason,
    }),
  setModelError: (message, probe) =>
    set((state) => ({
      modelState: 'error',
      error: message,
      preferred: probe?.preferred ?? state.preferred,
      forced: probe?.forced ?? state.forced,
      reason: probe?.reason ?? state.reason,
    })),
  setBackend: (backend, reason) =>
    set({ backend, actual: backend, reason: reason ?? null }),
  setModelLoadMs: (modelLoadMs) => set({ modelLoadMs }),
}));
