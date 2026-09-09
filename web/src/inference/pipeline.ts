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

const registry = new Map<ModelKey, Promise<ModelPipeline>>();

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
  // 文本塔：用零样本分类任务的底层 feature-extraction pipeline 也能跑，
  // 但更稳妥是另起一个 feature-extraction pipeline（CLIP 的 text encoder 与 visual encoder 在不同子模块中）
  // 这里简化：用同一个 pipeline 处理文本（CLIP 对文本也输出 embedding）
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
      const out = await vision(imageUrls, { pooling: 'mean', normalize: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (out as any).tolist() as number[][];
    },
  };
}

export async function loadModel(modelKey: ModelKey, backend: Backend): Promise<ModelPipeline> {
  const cached = registry.get(modelKey);
  if (cached) return cached;

  const task = (async () => {
    if (modelKey === 'image') {
      return loadImageModel(backend);
    }
    return loadTextModel(modelKey, backend);
  })();

  registry.set(modelKey, task);
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

export function resetRegistry() {
  registry.clear();
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
