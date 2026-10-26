/**
 * 运行时配置（URL 参数 → 结构化配置）
 *
 * 设计要点：
 * - 只从 URL 查询参数读取，配合 localStorage 的一个例外：后端强制项 `seekvec:backend`
 *   （契约：显式 `?backend=webgpu|wasm` 会写入 localStorage，后续不带参数的访问继续生效；
 *     `?backend=auto` 会清除该强制项）
 * - 解析幂等：getRuntimeConfig() 首次调用后缓存，同一页面生命周期内返回同一对象
 * - 数值参数夹紧到合法区间；枚举参数非法时回退默认值（不抛错，保证页面可用）
 * - `?perf=1` 才启用观测（见 perf/metrics.ts）
 */
import type { Backend, Dtype } from '../types';

export type BackendPreference = 'auto' | 'webgpu' | 'wasm';
export type RefreshPolicy = 'last' | 'each';
export type ModelSourceMode = 'auto' | 'remote' | 'local';
export type ResolvedModelSource = 'remote' | 'local';

/** 后端强制项来源：URL 显式参数 > localStorage > 默认 auto */
export type BackendSource = 'url' | 'storage' | 'default';

export interface RuntimeConfig {
  /** 后端偏好：auto（自动探测/降级）或强制 webgpu/wasm */
  backend: BackendPreference;
  backendSource: BackendSource;
  /** 强制后端（auto 时为 null），供 detectBackend/UI 使用 */
  forcedBackend: Backend | null;
  /** dtype 显式覆盖；null 表示按后端默认（webgpu→fp16、wasm→q8） */
  dtype: Dtype | null;
  /** 批量大小（1..64，默认 16） */
  batch: number;
  /** 索引刷新策略（last=仅最后一批、each=每批） */
  refresh: RefreshPolicy;
  /** onnxruntime-web wasm 线程数（1..8；crossOriginIsolated 时默认 4，否则 1） */
  threads: number;
  crossOriginIsolated: boolean;
  /** 模型来源模式（auto=按构建期 VITE_LOCAL_MODELS 决定） */
  models: ModelSourceMode;
  /** 是否启用观测（?perf=1） */
  perf: boolean;
  /** 初始 activeCollection（可选） */
  collection: string | null;
}

/** 浏览器 localStorage 的最小接口（便于单测注入） */
export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface ParseRuntimeConfigOptions {
  /** 注入 storage（测试用）；显式传 null 表示禁用 localStorage */
  storage?: StorageLike | null;
  /** 覆盖 crossOriginIsolated（测试用） */
  crossOriginIsolated?: boolean;
}

export interface BuildEnv {
  VITE_LOCAL_MODELS?: string;
  VITE_LOCAL_MODEL_PATH?: string;
  VITE_ORT_WASM_PATH?: string;
  VITE_HF_ENDPOINT?: string;
}

export const STORAGE_BACKEND_KEY = 'seekvec:backend';

export const BATCH_DEFAULT = 16;
export const BATCH_MIN = 1;
export const BATCH_MAX = 64;
export const THREADS_MIN = 1;
export const THREADS_MAX = 8;
/** 跨源隔离（COOP/COEP）下 wasm 才可以用多线程 */
export const THREADS_DEFAULT_ISOLATED = 4;
export const THREADS_DEFAULT_PLAIN = 1;
/** 构建期未设置 VITE_ORT_WASM_PATH 时，默认从同源 /ort/ 加载 ORT wasm 资源 */
export const ORT_WASM_PATH_DEFAULT = '/ort/';
/** 本地模型目录默认前缀（web/public/models） */
export const LOCAL_MODEL_PATH_DEFAULT = '/models/';

const BACKENDS: readonly Backend[] = ['webgpu', 'wasm'];
const DTYPES: readonly Dtype[] = ['q8', 'fp16', 'fp32'];
const REFRESH_POLICIES: readonly RefreshPolicy[] = ['last', 'each'];
const MODEL_SOURCES: readonly ModelSourceMode[] = ['auto', 'remote', 'local'];

/** 解析构建期 Vite 环境变量（Node/单测环境安全） */
export function readBuildEnv(): BuildEnv {
  const viteEnv =
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return {
    VITE_LOCAL_MODELS: viteEnv.VITE_LOCAL_MODELS,
    VITE_LOCAL_MODEL_PATH: viteEnv.VITE_LOCAL_MODEL_PATH,
    VITE_ORT_WASM_PATH: viteEnv.VITE_ORT_WASM_PATH,
    VITE_HF_ENDPOINT: viteEnv.VITE_HF_ENDPOINT,
  };
}

function readCrossOriginIsolated(): boolean {
  const scope = globalThis as unknown as { crossOriginIsolated?: boolean };
  return scope.crossOriginIsolated === true;
}

function resolveStorage(options: ParseRuntimeConfigOptions): StorageLike | null {
  if (options.storage !== undefined) return options.storage;
  try {
    const scope = globalThis as unknown as { localStorage?: StorageLike };
    return scope.localStorage ?? null;
  } catch {
    // Safari 隐私模式等场景访问 localStorage 可能抛错
    return null;
  }
}

function readStorage(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: StorageLike | null, key: string, value: string | null): void {
  if (!storage) return;
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // 写失败（配额/隐私模式）不影响配置解析
  }
}

function readLocationSearch(): string {
  try {
    const scope = globalThis as unknown as { location?: { search?: string } };
    return scope.location?.search ?? '';
  } catch {
    return '';
  }
}

function isBackend(value: string): value is Backend {
  return (BACKENDS as readonly string[]).includes(value);
}

function isDtype(value: string): value is Dtype {
  return (DTYPES as readonly string[]).includes(value);
}

function isRefreshPolicy(value: string): value is RefreshPolicy {
  return (REFRESH_POLICIES as readonly string[]).includes(value);
}

function isModelSource(value: string): value is ModelSourceMode {
  return (MODEL_SOURCES as readonly string[]).includes(value);
}

/** 读取整数参数：非数字 → 默认值；超出范围 → 夹紧到边界 */
function readIntParam(
  params: URLSearchParams,
  name: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultValue;
  const rounded = Math.round(parsed);
  return Math.min(max, Math.max(min, rounded));
}

/** 读取枚举参数：非法值 → 默认值 */
function readEnumParam<T extends string>(
  params: URLSearchParams,
  name: string,
  defaultValue: T,
  guard: (value: string) => value is T,
): T {
  const raw = params.get(name);
  if (raw === null) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  return guard(normalized) ? (normalized as T) : defaultValue;
}

const COLLECTION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 纯函数：解析配置（不读全局缓存，便于单测）。
 * @param search 形如 `?batch=32&perf=1` 的查询串（可省略前导 `?`）
 */
export function parseRuntimeConfig(
  search: string,
  options: ParseRuntimeConfigOptions = {},
): RuntimeConfig {
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  const storage = resolveStorage(options);
  const isolated = options.crossOriginIsolated ?? readCrossOriginIsolated();

  // ── 后端：URL 显式值优先，并同步 localStorage 强制项 ──────────────
  let backend: BackendPreference = 'auto';
  let backendSource: BackendSource = 'default';
  const rawBackend = params.get('backend');
  if (rawBackend !== null) {
    const normalized = rawBackend.trim().toLowerCase();
    if (normalized === 'auto') {
      backend = 'auto';
      backendSource = 'url';
      // 显式 auto：清除历史强制项
      writeStorage(storage, STORAGE_BACKEND_KEY, null);
    } else if (isBackend(normalized)) {
      backend = normalized;
      backendSource = 'url';
      writeStorage(storage, STORAGE_BACKEND_KEY, normalized);
    }
    // 非法值：忽略该参数，后续按 localStorage/默认处理
  }
  if (backendSource === 'default') {
    const stored = readStorage(storage, STORAGE_BACKEND_KEY);
    const normalized = stored?.trim().toLowerCase() ?? '';
    if (isBackend(normalized)) {
      backend = normalized;
      backendSource = 'storage';
    }
  }

  // ── dtype：显式覆盖，缺省时由后端决定 ─────────────────────────────
  const rawDtype = params.get('dtype');
  let dtype: Dtype | null = null;
  if (rawDtype !== null) {
    const normalized = rawDtype.trim().toLowerCase();
    if (isDtype(normalized)) dtype = normalized;
  }

  // ── batch / threads / refresh / models / perf / collection ────────
  const batch = readIntParam(params, 'batch', BATCH_DEFAULT, BATCH_MIN, BATCH_MAX);
  const threadsDefault = isolated ? THREADS_DEFAULT_ISOLATED : THREADS_DEFAULT_PLAIN;
  const threads = readIntParam(params, 'threads', threadsDefault, THREADS_MIN, THREADS_MAX);
  const refresh = readEnumParam(params, 'refresh', 'last', isRefreshPolicy);
  const models = readEnumParam(params, 'models', 'auto', isModelSource);
  const perfRaw = params.get('perf');
  const perf = perfRaw !== null && ['1', 'true'].includes(perfRaw.trim().toLowerCase());
  // 集合名与服务端校验规则一致；非法则忽略（避免把奇怪字符带到请求里）
  const rawCollection = params.get('collection')?.trim() ?? '';
  const collection = COLLECTION_NAME_PATTERN.test(rawCollection) ? rawCollection : null;

  return {
    backend,
    backendSource,
    forcedBackend: backend === 'auto' ? null : backend,
    dtype,
    batch,
    refresh,
    threads,
    crossOriginIsolated: isolated,
    models,
    perf,
    collection,
  };
}

let cachedConfig: RuntimeConfig | null = null;

/** 幂等读取运行时配置：同一页面生命周期内只解析一次 */
export function getRuntimeConfig(): RuntimeConfig {
  if (!cachedConfig) cachedConfig = parseRuntimeConfig(readLocationSearch());
  return cachedConfig;
}

/** 清空缓存（测试 / 运行时强制后端变更后调用） */
export function resetRuntimeConfigCache(): void {
  cachedConfig = null;
}

/**
 * 设置 localStorage 强制后端（null 表示恢复 auto），并失效配置缓存。
 * 注意：URL 显式 `?backend=` 的优先级高于 localStorage。
 */
export function setStoredBackendPreference(backend: Backend | null): void {
  const storage = resolveStorage({});
  writeStorage(storage, STORAGE_BACKEND_KEY, backend);
  resetRuntimeConfigCache();
}

/** dtype 解析：显式覆盖优先，否则 webgpu→fp16、wasm→q8 */
export function resolveDtype(backend: Backend, override: Dtype | null): Dtype {
  return override ?? (backend === 'webgpu' ? 'fp16' : 'q8');
}

/**
 * 模型来源解析：
 * - remote/local 显式指定
 * - auto：构建期 VITE_LOCAL_MODELS=1 时用本地模型目录，否则远程下载
 */
export function resolveModelSource(
  config: Pick<RuntimeConfig, 'models'>,
  buildEnv: BuildEnv = readBuildEnv(),
): ResolvedModelSource {
  if (config.models === 'local') return 'local';
  if (config.models === 'remote') return 'remote';
  return buildEnv.VITE_LOCAL_MODELS === '1' ? 'local' : 'remote';
}

/** 本地模型目录前缀 */
export function resolveLocalModelPath(buildEnv: BuildEnv = readBuildEnv()): string {
  return buildEnv.VITE_LOCAL_MODEL_PATH ?? LOCAL_MODEL_PATH_DEFAULT;
}

/** ORT wasm 资源路径：构建期显式配置优先，否则同源 /ort/ */
export function resolveOrtWasmPath(buildEnv: BuildEnv = readBuildEnv()): string {
  return buildEnv.VITE_ORT_WASM_PATH ?? ORT_WASM_PATH_DEFAULT;
}
