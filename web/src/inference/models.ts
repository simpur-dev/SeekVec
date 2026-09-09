/**
 * 模型注册表
 *
 * v1：默认 text_zh（bge-small-zh）；可切换 text_en（all-MiniLM-L6-v2）
 * v1.1：image（CLIP-ViT-Base-Patch32）作为 stretch goal
 *
 * 所有模型均为 Xenova 仓库的 ONNX 量化版，可经 Transformers.js 直接加载。
 */
import type { ModelInfo, ModelKey } from '../types';

export const MODEL_REGISTRY: Record<ModelKey, ModelInfo> = {
  text_en: {
    id: 'Xenova/all-MiniLM-L6-v2',
    dim: 384,
    modality: 'text',
    quantizedSizeMB: 23,
    fpSizeMB: 90,
  },
  text_zh: {
    id: 'Xenova/bge-small-zh-v1.5',
    dim: 512,
    modality: 'text',
    quantizedSizeMB: 25,
    fpSizeMB: 95,
  },
  image: {
    id: 'Xenova/clip-vit-base-patch32',
    dim: 512,
    modality: 'image',
    quantizedSizeMB: 150,
    fpSizeMB: 600,
  },
};

export const DEFAULT_MODEL: ModelKey = 'text_zh';

export function getModelInfo(key: ModelKey): ModelInfo {
  return MODEL_REGISTRY[key];
}
