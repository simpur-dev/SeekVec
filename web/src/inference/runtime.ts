/**
 * 推理运行时单例（共享状态机）
 *
 * 目标（契约第 4 节）：
 * - 同一时刻只有一个 embedding 模型处于加载/就绪状态，key = `modelKey:backend:dtype`
 * - useSearch / useIngest / 评测入口共享同一实例，避免重复下载与重复初始化
 * - generation 令牌防止「切换模型/重载」竞态：旧请求完成时若已换代则丢弃结果
 * - reload() 全局生效：所有订阅者（两个 hook）都会收到通知并重新初始化
 * - 加载失败在 backendStore 中标记 error（BackendBadge 显示红色错误，而不是绿色 WebGPU）
 *
 * 说明：pipeline 层自身按 `modelKey:backend:dtype` 缓存已成功加载的实例，
 * 因此 reload() 对已成功的模型是廉价的（不会重新下载）；失败项会被移除缓存后重试。
 */
import type { Backend, Dtype, ModelKey } from '../types';
import {
  detectBackend,
  resetBackendProbeCache,
  type BackendProbe,
} from '../inference/backend';
import { defaultDtypeForBackend } from '../inference/models';
import { loadModelWithFallback, type LoadedModelWithFallback } from '../inference/pipeline';
import {
  getRuntimeConfig,
  resetRuntimeConfigCache,
  setStoredBackendPreference,
} from '../config/runtimeConfig';
import { setMetricsContext } from '../perf/metrics';
import { useBackendStore } from '../store/backendStore';

export interface LoadedRuntime {
  modelKey: ModelKey;
  backend: Backend;
  dtype: Dtype;
  /** 真实加载 key（可能因 auto 降级而不同于探测阶段 key） */
  key: string;
  pipeline: LoadedModelWithFallback['pipeline'];
  modelLoadMs: number;
  warm: boolean;
  generation: number;
}

export type RuntimeStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface RuntimeState {
  status: RuntimeStatus;
  /** 目标/已加载模型 */
  modelKey: ModelKey | null;
  /** 实际（或加载中的目标）后端 */
  backend: Backend | null;
  preferredBackend: Backend | null;
  forced: boolean;
  dtype: Dtype | null;
  error: string | null;
  modelLoadMs: number | null;
  generation: number;
}

/** 竞态回收：本次加载已被更新的 generation 取代 */
export class RuntimeSupersededError extends Error {
  constructor() {
    super('模型加载请求已被新的请求取代');
    this.name = 'RuntimeSupersededError';
  }
}

export function isRuntimeSupersededError(err: unknown): err is RuntimeSupersededError {
  return err instanceof RuntimeSupersededError;
}

let generation = 0;
let loaded: LoadedRuntime | null = null;
let state: RuntimeState = {
  status: 'idle',
  modelKey: null,
  backend: null,
  preferredBackend: null,
  forced: false,
  dtype: null,
  error: null,
  modelLoadMs: null,
  generation,
};
const listeners = new Set<() => void>();
/** 同一请求（模型/配置/generation 相同）的在途 Promise 共享 */
const inflight = new Map<string, Promise<LoadedRuntime>>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<RuntimeState>): void {
  state = { ...state, ...patch };
  emit();
}

export function getRuntimeState(): RuntimeState {
  return state;
}

export function subscribeRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前已加载的运行时（未就绪时为 null） */
export function getLoadedRuntime(): LoadedRuntime | null {
  return loaded;
}

/** 让外部（调试/评测）能拿到已加载的文本 embedding 能力 */
export async function ensureTextEmbedder(modelKey: ModelKey): Promise<(texts: string[]) => Promise<number[][]>> {
  const runtime = await ensureRuntime(modelKey);
  if (runtime.pipeline.kind !== 'text') {
    throw new Error('当前模型不是文本 embedding 管线');
  }
  return runtime.pipeline.extract;
}

function publishLoading(modelKey: ModelKey, probe: BackendProbe, dtype: Dtype): void {
  useBackendStore.getState().setLoading({
    preferred: probe.preferred,
    forced: probe.forced,
    reason: probe.reason,
  });
  setState({
    status: 'loading',
    modelKey,
    backend: probe.backend,
    preferredBackend: probe.preferred,
    forced: probe.forced,
    dtype,
    error: null,
    modelLoadMs: null,
  });
}

function publishError(
  modelKey: ModelKey,
  probe: BackendProbe,
  dtype: Dtype | null,
  message: string,
): void {
  useBackendStore.getState().setModelError(message, {
    preferred: probe.preferred,
    forced: probe.forced,
    reason: probe.reason,
  });
  setState({
    status: 'error',
    modelKey,
    backend: probe.backend,
    preferredBackend: probe.preferred,
    forced: probe.forced,
    dtype,
    error: message,
    modelLoadMs: null,
  });
}

function requestKeyFor(modelKey: ModelKey): string {
  const config = getRuntimeConfig();
  return `${modelKey}:${generation}:${config.backend}:${config.dtype ?? 'auto'}`;
}

/**
 * 确保指定模型已加载并就绪。
 * 并发调用（useSearch + useIngest + 评测入口）共享同一个加载 Promise。
 */
export async function ensureRuntime(modelKey: ModelKey): Promise<LoadedRuntime> {
  const requestKey = requestKeyFor(modelKey);
  const pending = inflight.get(requestKey);
  if (pending) return pending;

  const task = doEnsureRuntime(modelKey, generation).finally(() => {
    inflight.delete(requestKey);
  });
  inflight.set(requestKey, task);
  return task;
}

async function doEnsureRuntime(modelKey: ModelKey, requestGeneration: number): Promise<LoadedRuntime> {
  const ensureGeneration = () => {
    if (requestGeneration !== generation) throw new RuntimeSupersededError();
  };

  const config = getRuntimeConfig();
  const probe = await detectBackend();
  ensureGeneration();

  // 强制后端不可用：不静默降级（保证 ?backend= 评测口径真实），直接报错
  if (!probe.available) {
    const message = probe.reason ?? `强制后端 ${probe.backend} 不可用`;
    if (probe.forced) {
      publishError(modelKey, probe, config.dtype, message);
      throw new Error(message);
    }
  }

  const targetBackend: Backend = probe.available ? probe.backend : 'wasm';
  const dtype = config.dtype ?? defaultDtypeForBackend(modelKey, targetBackend);
  const targetKey = `${modelKey}:${targetBackend}:${dtype}`;

  // 命中已加载实例（同一 generation）
  if (loaded && loaded.key === targetKey && loaded.generation === generation) {
    setState({
      status: 'ready',
      modelKey,
      backend: loaded.backend,
      preferredBackend: probe.preferred,
      forced: probe.forced,
      dtype: loaded.dtype,
      error: null,
      modelLoadMs: loaded.modelLoadMs,
    });
    return loaded;
  }

  publishLoading(modelKey, probe, dtype);
  const startedAt = performance.now();
  let result: LoadedModelWithFallback;
  try {
    result = await loadModelWithFallback(modelKey, targetBackend, {
      dtype: config.dtype,
      // 强制后端不允许自动降级
      allowFallback: !probe.forced,
    });
  } catch (err) {
    ensureGeneration();
    const message = err instanceof Error ? err.message : String(err);
    const detail = probe.forced
      ? `强制后端 ${probe.backend} 加载失败：${message}`
      : `embedding 模型加载失败：${message}`;
    publishError(modelKey, probe, dtype, detail);
    throw err instanceof Error ? err : new Error(detail);
  }
  ensureGeneration();

  const modelLoadMs = Math.round(performance.now() - startedAt);
  const actualKey = `${modelKey}:${result.backend}:${result.dtype}`;
  const runtime: LoadedRuntime = {
    modelKey,
    backend: result.backend,
    dtype: result.dtype,
    key: actualKey,
    pipeline: result.pipeline,
    modelLoadMs,
    warm: result.warm,
    generation,
  };
  loaded = runtime;

  // perf 上下文：模型/后端/dtype 供事件与快照补齐
  setMetricsContext({ modelKey, dtype: result.dtype, backend: result.backend });

  useBackendStore.getState().setLoaded({
    backend: result.backend,
    preferred: probe.preferred,
    forced: probe.forced,
    dtype: result.dtype,
    modelLoadMs,
    // auto 模式降级原因：加载期失败原因优先，其次探测阶段原因
    reason: result.reason ?? probe.reason,
  });
  setState({
    status: 'ready',
    modelKey,
    backend: result.backend,
    preferredBackend: probe.preferred,
    forced: probe.forced,
    dtype: result.dtype,
    error: null,
    modelLoadMs,
  });
  return runtime;
}

/**
 * 全局重载：generation+1，所有订阅者重新触发 ensureRuntime。
 * 已成功加载的模型由 pipeline 缓存复用；失败项会真正重试。
 */
export function reloadRuntime(): void {
  generation += 1;
  loaded = null;
  // 清理旧 generation 的在途请求记录，避免无限增长
  inflight.clear();
  setState({
    status: 'idle',
    error: null,
    modelLoadMs: null,
    generation,
  });
}

/**
 * 强制指定后端（null = 恢复 auto）：
 * 写入 localStorage `seekvec:backend` 并全局重载。
 * 注意 URL 显式 ?backend= 优先于 localStorage。
 */
export function setForcedBackend(backend: Backend | null): void {
  setStoredBackendPreference(backend);
  resetRuntimeConfigCache();
  resetBackendProbeCache();
  reloadRuntime();
}

/** 测试用：重置运行时到初始状态 */
export function resetRuntimeForTest(): void {
  generation = 0;
  loaded = null;
  inflight.clear();
  state = {
    status: 'idle',
    modelKey: null,
    backend: null,
    preferredBackend: null,
    forced: false,
    dtype: null,
    error: null,
    modelLoadMs: null,
    generation,
  };
  emit();
}
