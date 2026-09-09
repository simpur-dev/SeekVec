/**
 * 端侧推理后端探测
 *
 * 探测顺序：
 *   1. navigator.gpu 可用 → WebGPU
 *   2. 否则 → WASM
 *
 * 同时覆盖运行时失败：pipeline 初始化时报错，调用方应 catch 后降级。
 */
import type { Backend } from '../types';

export async function detectBackend(): Promise<Backend> {
  if (typeof navigator === 'undefined') return 'wasm';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gpu = (navigator as any).gpu;
  if (!gpu) return 'wasm';

  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return 'wasm';
    return 'webgpu';
  } catch {
    return 'wasm';
  }
}

export function backendLabel(backend: Backend): string {
  return backend === 'webgpu' ? 'WebGPU' : 'WASM';
}

export function backendColor(backend: Backend): string {
  return backend === 'webgpu'
    ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
    : 'bg-amber-100 text-amber-700 border-amber-300';
}
