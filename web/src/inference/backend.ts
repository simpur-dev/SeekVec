/**
 * 端侧推理后端探测（强制后端 + 降级原因）
 *
 * 语义（与契约第 2 节一致）：
 * - preference=auto：优先 WebGPU；不可用时降级 WASM，并在 reason 中说明原因
 * - preference=webgpu|wasm：强制后端。可用时 available=true；
 *   不可用时 available=false + reason（调用方应报错而不是静默降级，
 *   否则评测 `?backend=` 口径失真）
 * - detectBackend() 读取 runtimeConfig 的后端偏好，并做短时缓存，
 *   避免 useBackendProbe 与模型加载各请求一次 GPU adapter
 */
import type { Backend } from '../types';
import { getRuntimeConfig, type BackendPreference } from '../config/runtimeConfig';

export interface BackendProbe {
  /** 目标后端（auto 时为在可用后端中选出的那个；强制时即强制值） */
  backend: Backend;
  /** 配置偏好（auto 时表示"期望 WebGPU"） */
  preferred: Backend;
  /** 是否强制指定 */
  forced: boolean;
  /** backend 是否真实可用（强制不可用时为 false） */
  available: boolean;
  reason: string | null;
  adapterInfo: Record<string, string> | null;
}

interface GpuAdapterLike {
  info?: Record<string, unknown>;
  requestAdapterInfo?: () => Promise<Record<string, unknown>>;
}

interface GpuLike {
  requestAdapter: () => Promise<GpuAdapterLike | null>;
}

function getGpu(): GpuLike | null {
  if (typeof navigator === 'undefined') return null;
  const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
  return gpu ?? null;
}

/** 收集 GPU 适配器信息（不同 Chrome 版本字段可能是 getter 或异步方法） */
async function readAdapterInfo(adapter: GpuAdapterLike): Promise<Record<string, string> | null> {
  const keys = ['vendor', 'architecture', 'device', 'description'] as const;
  const pick = (source: Record<string, unknown> | null | undefined) => {
    if (!source) return null;
    const out: Record<string, string> = {};
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim() !== '') out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : null;
  };
  const sync = pick(adapter.info);
  if (sync) return sync;
  try {
    if (typeof adapter.requestAdapterInfo === 'function') {
      return pick(await adapter.requestAdapterInfo());
    }
  } catch {
    // 新版 Chrome 已移除 requestAdapterInfo，忽略
  }
  return null;
}

/** 纯探测：不读写配置缓存，便于单测 */
export async function probeBackend(preference: BackendPreference): Promise<BackendProbe> {
  if (preference === 'wasm') {
    return {
      backend: 'wasm',
      preferred: 'wasm',
      forced: true,
      available: true,
      reason: null,
      adapterInfo: null,
    };
  }

  const gpu = getGpu();
  if (!gpu) {
    if (preference === 'webgpu') {
      return {
        backend: 'webgpu',
        preferred: 'webgpu',
        forced: true,
        available: false,
        reason: '强制 WebGPU 不可用：navigator.gpu 不存在（需 HTTPS/localhost 安全上下文）',
        adapterInfo: null,
      };
    }
    return {
      backend: 'wasm',
      preferred: 'webgpu',
      forced: false,
      available: false,
      reason: '浏览器不支持 WebGPU（navigator.gpu 不可用），已降级 WASM',
      adapterInfo: null,
    };
  }

  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      if (preference === 'webgpu') {
        return {
          backend: 'webgpu',
          preferred: 'webgpu',
          forced: true,
          available: false,
          reason: '强制 WebGPU 不可用：未获取到 GPU 适配器',
          adapterInfo: null,
        };
      }
      return {
        backend: 'wasm',
        preferred: 'webgpu',
        forced: false,
        available: false,
        reason: '未获取到 WebGPU 适配器，已降级 WASM',
        adapterInfo: null,
      };
    }
    return {
      backend: 'webgpu',
      preferred: 'webgpu',
      forced: preference === 'webgpu',
      available: true,
      reason: null,
      adapterInfo: await readAdapterInfo(adapter),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (preference === 'webgpu') {
      return {
        backend: 'webgpu',
        preferred: 'webgpu',
        forced: true,
        available: false,
        reason: `强制 WebGPU 探测失败：${message}`,
        adapterInfo: null,
      };
    }
    return {
      backend: 'wasm',
      preferred: 'webgpu',
      forced: false,
      available: false,
      reason: `WebGPU 探测失败（${message}），已降级 WASM`,
      adapterInfo: null,
    };
  }
}

interface ProbeCacheEntry {
  preference: BackendPreference;
  result: BackendProbe;
  at: number;
}

const PROBE_CACHE_TTL_MS = 5000;
let probeCache: ProbeCacheEntry | null = null;

/** 清空探测缓存（强制后端变更 / 重载时调用） */
export function resetBackendProbeCache(): void {
  probeCache = null;
}

/** 按当前运行时配置探测后端（短时缓存，重复调用不会重复请求 adapter） */
export async function detectBackend(force = false): Promise<BackendProbe> {
  const preference = getRuntimeConfig().backend;
  if (
    !force &&
    probeCache &&
    probeCache.preference === preference &&
    Date.now() - probeCache.at < PROBE_CACHE_TTL_MS
  ) {
    return probeCache.result;
  }
  const result = await probeBackend(preference);
  probeCache = { preference, result, at: Date.now() };
  return result;
}

export function backendLabel(backend: Backend): string {
  return backend === 'webgpu' ? 'WebGPU' : 'WASM';
}

export function backendColor(backend: Backend): string {
  return backend === 'webgpu'
    ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
    : 'bg-amber-100 text-amber-700 border-amber-300';
}
