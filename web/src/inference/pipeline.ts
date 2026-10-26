/**
 * EmbeddingPipeline：多模型懒加载、单例缓存
 *
 * 设计要点：
 * - 模型按需懒加载，Map 缓存；同 key 二次调用直接返回缓存实例
 * - WebGPU 优先；运行时失败 catch 后自动降级 WASM 并重试一次
 * - 文本 embedding 走 Transformers.js feature-extraction 任务
 * - 图片 embedding 走 image-feature-extraction（CLIP 视觉塔）
 * - CLIP 文本塔与视觉塔共享同一 ONNX 模型，初始化一次即可
 *
 * 注意：所有 embedding 严格在浏览器端完成；不向 server 或云端发送模型输入。
 */
import { pipeline, env, RawImage } from '@huggingface/transformers';
import type { Backend, ModelKey } from '../types';
import { MODEL_REGISTRY } from './models';

// Transformers.js 环境配置
env.allowLocalModels = false;
env.useBrowserCache = true;

// 可选资源覆盖（默认不设置，行为与官方默认完全一致）：
// - VITE_HF_ENDPOINT：模型下载源，如 https://hf-mirror.com/（huggingface.co 不可达的环境）
// - VITE_ORT_WASM_PATH：ONNX Runtime wasm 资源目录，如 /ort/（jsDelivr CDN 不可达时本地托管）
// 使用方式：在 web/.env.local 中设置（该文件已被 .gitignore 忽略）。
const viteEnv =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
if (viteEnv.VITE_HF_ENDPOINT) {
  env.remoteHost = viteEnv.VITE_HF_ENDPOINT;
}
if (viteEnv.VITE_ORT_WASM_PATH) {
  const wasmBackend = env.backends?.onnx?.wasm;
  if (wasmBackend) wasmBackend.wasmPaths = viteEnv.VITE_ORT_WASM_PATH;
}
// 可选：使用本地模型目录（web/public/models，已被 .gitignore 忽略），
// 适合无外网环境；开启后本地存在的模型不再走远程下载。
if (viteEnv.VITE_LOCAL_MODELS === '1') {
  env.allowLocalModels = true;
  env.localModelPath = viteEnv.VITE_LOCAL_MODEL_PATH ?? '/models/';
}

interface TextPipeline {
  kind: 'text';
  extract: (texts: string[]) => Promise<number[][]>;
}

interface ImagePipeline {
  kind: 'image';
  textTower: (texts: string[]) => Promise<number[][]>;
  visionTower: (imageUrls: string[]) => Promise<number[][]>;
}

type ModelPipeline = TextPipeline | ImagePipeline;

// 缓存键包含 backend：同一模型在 WebGPU 加载失败后，仍可用 WASM 重新加载
const registry = new Map<string, Promise<ModelPipeline>>();

async function loadTextModel(
  modelKey: 'text_en' | 'text_zh',
  backend: Backend,
): Promise<TextPipeline> {
  const info = MODEL_REGISTRY[modelKey];
  const extractor = await pipeline('feature-extraction', info.id, {
    device: backend,
    dtype: 'q8',
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

async function loadImageModel(backend: Backend): Promise<ImagePipeline> {
  const info = MODEL_REGISTRY.image;
  const modelId = info.id;
  // 用 image-feature-extraction 拿视觉塔向量
  const vision = await pipeline('image-feature-extraction', modelId, {
    device: backend,
    dtype: 'q8',
  });
  // 文本塔：v1.1 应改用 AutoProcessor + CLIPTextModelWithProjection 获取 text_embeds，
  // 当前 feature-extraction 方式对 CLIPModel 不可用（返回 undefined last_hidden_state）。
  // 在 v1.1 启用前由 IMAGE_PIPELINE_ENABLED=false 保护，不会走到这里。
  const text = await pipeline('feature-extraction', modelId, {
    device: backend,
    dtype: 'q8',
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

export async function loadModel(modelKey: ModelKey, backend: Backend): Promise<ModelPipeline> {
  const cacheKey = `${modelKey}:${backend}`;
  const cached = registry.get(cacheKey);
  if (cached) return cached;

  const task = (async () => {
    if (modelKey === 'image') {
      return loadImageModel(backend);
    }
    return loadTextModel(modelKey, backend);
  })();

  registry.set(cacheKey, task);
  // 加载失败时移除缓存，否则降级重试会拿到同一个 rejected Promise（自动降级失效）
  task.catch(() => {
    if (registry.get(cacheKey) === task) registry.delete(cacheKey);
  });
  return task;
}

export async function loadModelWithFallback(
  modelKey: ModelKey,
  preferredBackend: Backend,
): Promise<{ pipeline: ModelPipeline; backend: Backend }> {
  try {
    const p = await loadModel(modelKey, preferredBackend);
    return { pipeline: p, backend: preferredBackend };
  } catch (err) {
    if (preferredBackend === 'webgpu') {
      console.warn(`[pipeline] WebGPU failed, fallback to WASM:`, err);
      const p = await loadModel(modelKey, 'wasm');
      return { pipeline: p, backend: 'wasm' };
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
