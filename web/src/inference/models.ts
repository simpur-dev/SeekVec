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
    // 实测 onnx 文件大小（fp32 -> q8）
    quantizedSizeMB: 21.9,
    fpSizeMB: 86.2,
  },
  text_zh: {
    id: 'Xenova/bge-small-zh-v1.5',
    dim: 512,
    modality: 'text',
    quantizedSizeMB: 22.9,
    fpSizeMB: 90.5,
  },
  image: {
    id: 'Xenova/clip-vit-base-patch32',
    dim: 512,
    modality: 'image',
    // v1.1 预留，未实测
    quantizedSizeMB: 150,
    fpSizeMB: 600,
  },
};

export const DEFAULT_MODEL: ModelKey = 'text_zh';

/**
 * v1.1 图片管线开关。
 * CLIP 的文本塔需要 AutoProcessor + CLIPTextModelWithProjection（当前未实现），
 * 保持关闭可避免检索时误触发约 150MB 的 CLIP 模型下载。
 */
export const IMAGE_PIPELINE_ENABLED = false;

export function getModelInfo(key: ModelKey): ModelInfo {
  return MODEL_REGISTRY[key];
}
