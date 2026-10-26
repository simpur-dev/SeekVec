/**
 * EmbeddingPipeline：多模型懒加载、单例缓存
 *
 * 设计要点：
 * - 模型按需懒加载，Map 缓存；缓存 key = `modelKey:backend:dtype`
 * - dtype 参数化：默认 webgpu→fp16、wasm→q8（MODEL_REGISTRY.dtypeByBackend），
 *   可用 `?dtype=` 覆盖；同一模型不同 dtype 视为不同缓存项
 * - 强制后端（?backend=webgpu|wasm）失败时不静默降级；auto 模式 WebGPU 失败降级 WASM 并返回原因
 * - ORT wasm 资源默认同源 `/ort/`（构建期 VITE_ORT_WASM_PATH 未设置时），
 *   避免 COEP 下跨源 worker 被拦截；wasm 线程数按运行时配置设置
 * - `?models=remote|local|auto` 控制模型来源（auto 时看构建期 VITE_LOCAL_MODELS）
 * - 模型 download / init 用 Transformers.js progress_callback 拆分并记录到 perf/metrics，
 *   cold/warm 用 localStorage 标记
 * - 文本 embedding 走 feature-extraction 任务；图片走 image-feature-extraction（v1.1）
 *
 * 注意：所有 embedding 严格在浏览器端完成；不向 server 或云端发送模型输入。
 */
import { pipeline, env, RawImage } from '@huggingface/transformers';
import type { Backend, Dtype, ModelKey } from '../types';
import { MODEL_REGISTRY, defaultDtypeForBackend } from './models';
import {
  getRuntimeConfig,
  resolveLocalModelPath,
  resolveModelSource,
  resolveOrtWasmPath,
  readBuildEnv,
} from '../config/runtimeConfig';
import { recordPerf } from '../perf/metrics';

// ── Transformers.js 环境配置（模块初始化时一次性生效） ─────────────
const buildEnv = readBuildEnv();
const runtimeConfig = getRuntimeConfig();

/** 把同源路径转成绝对 URL（避免 Vite dev 对动态导入注入 ?import） */
function toAbsoluteUrl(pathOrUrl: string): string {
  if (typeof window === 'undefined' || !window.location?.origin) return pathOrUrl;
  try {
    return new URL(pathOrUrl, window.location.origin).href;
  } catch {
    return pathOrUrl;
  }
}

env.useBrowserCache = true;

// 模型下载源（huggingface.co 不可达的环境可指向镜像）
if (buildEnv.VITE_HF_ENDPOINT) {
  env.remoteHost = buildEnv.VITE_HF_ENDPOINT;
}

// ONNX Runtime wasm 资源：默认同源 /ort/，可用 VITE_ORT_WASM_PATH 覆盖
//
// 注意：必须转成「绝对 URL」再交给 ORT：
// onnxruntime-web 在运行时 `import(wasmPaths + 'ort-wasm-simd-threaded.jsep.mjs')`，
// Vite dev 的 @vite/client `injectQuery` 会对以 `/` 或 `.` 开头的动态导入 URL 追加 `?import`，
// 而 Vite 禁止从源码 import /public 下的文件（返回 500）。
// 绝对 URL（http://localhost:5173/ort/...）不会被改写，dev/preview/build 行为一致。
const ortWasmPathRaw = resolveOrtWasmPath(buildEnv);
const ortWasmPath = toAbsoluteUrl(ortWasmPathRaw);
const wasmBackendEnv = env.backends?.onnx?.wasm;
if (wasmBackendEnv) {
  wasmBackendEnv.wasmPaths = ortWasmPath;
  // 线程数：crossOriginIsolated 时才允许 >1，?threads= 可覆盖
  wasmBackendEnv.numThreads = runtimeConfig.threads;
  // 强制关闭 SIMD 时性能会更差；这里保持 ORT 默认（开启）
}

// 模型来源：local 时禁用远程下载，remote 时禁用本地目录
const modelSource = resolveModelSource(runtimeConfig, buildEnv);
if (modelSource === 'local') {
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = resolveLocalModelPath(buildEnv);
} else {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
}

/** 取当前 pipeline 环境配置摘要（调试/报告用） */
export function getPipelineEnvInfo(): {
  modelSource: 'local' | 'remote';
  localModelPath: string;
  ortWasmPath: string;
  threads: number;
  dtypeOverride: Dtype | null;
} {
  return {
    modelSource,
    localModelPath: env.localModelPath,
    ortWasmPath,
    threads: runtimeConfig.threads,
    dtypeOverride: runtimeConfig.dtype,
  };
}

export interface TextPipeline {
  kind: 'text';
  extract: (texts: string[]) => Promise<number[][]>;
}

export interface ImagePipeline {
  kind: 'image';
  textTower: (texts: string[]) => Promise<number[][]>;
  visionTower: (imageUrls: string[]) => Promise<number[][]>;
}

export type ModelPipeline = TextPipeline | ImagePipeline;

export interface LoadedModel {
  pipeline: ModelPipeline;
  backend: Backend;
  dtype: Dtype;
  /** true=模型已命中本地缓存/浏览器缓存（warm） */
  warm: boolean;
}

export interface LoadedModelWithFallback extends LoadedModel {
  preferredBackend: Backend;
  /** 降级原因（WebGPU 失败自动降级 WASM 时非空） */
  reason: string | null;
}

// ── cold/warm 标记（localStorage） ──────────────────────────────────
const WARM_FLAG_PREFIX = 'seekvec:model-cache:';

function readWarmFlag(cacheKey: string): boolean {
  try {
    return globalThis.localStorage?.getItem(`${WARM_FLAG_PREFIX}${cacheKey}`) === '1';
  } catch {
    return false;
  }
}

function writeWarmFlag(cacheKey: string): void {
  try {
    globalThis.localStorage?.setItem(`${WARM_FLAG_PREFIX}${cacheKey}`, '1');
  } catch {
    // 隐私模式/配额不足时忽略：仅影响 warm 标记
  }
}

/** 清空模型缓存与 warm 标记（评测 cold 模式 / 调试用） */
export function clearModelCache(): void {
  modelCache.clear();
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(WARM_FLAG_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // ignore
  }
}

// Transformers.js progress_callback 的最小结构（避免依赖未从包根导出的类型）
interface ProgressInfoLike {
  status: string;
  name?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

interface LoadInstrumentation {
  startedAt: number;
  warm: boolean;
  downloadStart: number | null;
  downloadEnd: number | null;
  files: Set<string>;
}

function createInstrumentation(cacheKey: string): LoadInstrumentation {
  return {
    startedAt: performance.now(),
    warm: readWarmFlag(cacheKey),
    downloadStart: null,
    downloadEnd: null,
    files: new Set<string>(),
  };
}

function trackProgress(state: LoadInstrumentation, info: ProgressInfoLike): void {
  const now = performance.now();
  if (info.file) state.files.add(info.file);
  if (info.status === 'initiate' || info.status === 'download') {
    if (state.downloadStart === null) state.downloadStart = now;
  } else if (info.status === 'done') {
    state.downloadEnd = now;
  }
}

function recordModelLoad(
  phase: 'success' | 'failure',
  modelKey: ModelKey,
  backend: Backend,
  dtype: Dtype,
  state: LoadInstrumentation,
  errorMessage?: string,
): void {
  const total = performance.now() - state.startedAt;
  const downloadMs =
    state.downloadStart !== null && state.downloadEnd !== null && state.downloadEnd > state.downloadStart
      ? state.downloadEnd - state.downloadStart
      : 0;
  const initMs = Math.max(0, total - downloadMs);
  const meta = {
    modelId: MODEL_INFO_ID[modelKey],
    fileCount: state.files.size,
    ...(phase === 'failure' ? { error: errorMessage } : {}),
  };
  recordPerf('model.download', downloadMs, { backend, modelKey, dtype, warm: state.warm, meta });
  recordPerf('model.init', initMs, { backend, modelKey, dtype, warm: state.warm, meta });
  recordPerf('model.total', total, { backend, modelKey, dtype, warm: state.warm, meta });
}

const MODEL_INFO_ID: Record<ModelKey, string> = {
  text_en: MODEL_REGISTRY.text_en.id,
  text_zh: MODEL_REGISTRY.text_zh.id,
  image: MODEL_REGISTRY.image.id,
};

// ── pipeline 构建 ─────────────────────────────────────────────────
async function createTextPipeline(
  modelKey: 'text_en' | 'text_zh',
  backend: Backend,
  dtype: Dtype,
  progress_callback: (info: ProgressInfoLike) => void,
): Promise<TextPipeline> {
  const info = MODEL_REGISTRY[modelKey];
  const extractor = await pipeline('feature-extraction', info.id, {
    device: backend,
    dtype,
    progress_callback,
    // revision 固定权重版本（本地模型模式下会被忽略）
    ...(info.revision ? { revision: info.revision } : {}),
  });
  return {
    kind: 'text',
    extract: async (texts: string[]) => {
      const out = await extractor(texts, { pooling: 'mean', normalize: true });
      // out 是 Tensor；.tolist() 转为 number[][]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (out as any).tolist() as number[][];
    },
  };
}

async function createImagePipeline(
  backend: Backend,
  dtype: Dtype,
  progress_callback: (info: ProgressInfoLike) => void,
): Promise<ImagePipeline> {
  const info = MODEL_REGISTRY.image;
  // 用 image-feature-extraction 拿视觉塔向量
  const vision = await pipeline('image-feature-extraction', info.id, {
    device: backend,
    dtype,
    progress_callback,
    ...(info.revision ? { revision: info.revision } : {}),
  });
  // 文本塔：v1.1 应改用 AutoProcessor + CLIPTextModelWithProjection 获取 text_embeds，
  // 当前 feature-extraction 方式对 CLIPModel 不可用（返回 undefined last_hidden_state）。
  // 在 v1.1 启用前由 IMAGE_PIPELINE_ENABLED=false 保护，不会走到这里。
  const text = await pipeline('feature-extraction', info.id, {
    device: backend,
    dtype,
    progress_callback,
    ...(info.revision ? { revision: info.revision } : {}),
  });

  return {
    kind: 'image',
    textTower: async (texts: string[]) => {
      const out = await text(texts, { pooling: 'mean', normalize: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (out as any).tolist() as number[][];
    },
    visionTower: async (imageUrls: string[]) => {
      // image-feature-extraction 的选项只支持 pool（见 transformers.js 类型定义）
      const out = await vision(imageUrls, { pool: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (out as any).tolist() as number[][];
    },
  };
}

// 缓存 key 包含 backend + dtype：同一模型在不同后端/量化格式下是不同实例
const modelCache = new Map<string, Promise<LoadedModel>>();

async function createAndInstrument(
  modelKey: ModelKey,
  backend: Backend,
  dtype: Dtype,
  cacheKey: string,
): Promise<LoadedModel> {
  const state = createInstrumentation(cacheKey);
  const progress_callback = (info: ProgressInfoLike) => trackProgress(state, info);
  try {
    const built =
      modelKey === 'image'
        ? await createImagePipeline(backend, dtype, progress_callback)
        : await createTextPipeline(modelKey, backend, dtype, progress_callback);
    recordModelLoad('success', modelKey, backend, dtype, state);
    writeWarmFlag(cacheKey);
    return { pipeline: built, backend, dtype, warm: state.warm };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordModelLoad('failure', modelKey, backend, dtype, state, message);
    throw err;
  }
}

/**
 * 加载模型（带缓存）。dtype 缺省按后端默认值解析。
 * 加载失败会移除缓存，便于重试/降级拿到新的尝试。
 */
export async function loadModel(
  modelKey: ModelKey,
  backend: Backend,
  dtypeOverride: Dtype | null = getRuntimeConfig().dtype,
): Promise<LoadedModel> {
  const dtype = dtypeOverride ?? defaultDtypeForBackend(modelKey, backend);
  const cacheKey = `${modelKey}:${backend}:${dtype}`;
  const cached = modelCache.get(cacheKey);
  if (cached) return cached;

  const task = createAndInstrument(modelKey, backend, dtype, cacheKey);
  modelCache.set(cacheKey, task);
  // 加载失败时移除缓存，否则降级重试会拿到同一个 rejected Promise（自动降级失效）
  task.catch(() => {
    if (modelCache.get(cacheKey) === task) modelCache.delete(cacheKey);
  });
  return task;
}

/**
 * 加载模型；auto 模式下允许 WebGPU 失败后降级 WASM。
 * @param allowFallback 强制后端（?backend=）时应传 false，保证评测口径可信
 */
export async function loadModelWithFallback(
  modelKey: ModelKey,
  preferredBackend: Backend,
  options: { dtype?: Dtype | null; allowFallback?: boolean } = {},
): Promise<LoadedModelWithFallback> {
  const dtype = options.dtype ?? null;
  try {
    const loaded = await loadModel(modelKey, preferredBackend, dtype);
    return { ...loaded, preferredBackend, reason: null };
  } catch (err) {
    if (preferredBackend === 'webgpu' && options.allowFallback !== false) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[pipeline] WebGPU 加载失败，降级 WASM：', err);
      const loaded = await loadModel(modelKey, 'wasm', dtype);
      return {
        ...loaded,
        preferredBackend,
        reason: `WebGPU 加载失败（${message}），已降级 WASM`,
      };
    }
    throw err;
  }
}

/**
 * 把图片文件转为 RawImage 实例，供 image-feature-extraction 使用
 */
export async function fileToRawImage(file: File | Blob): Promise<RawImage> {
  const url = URL.createObjectURL(file);
  try {
    return await RawImage.fromURL(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
