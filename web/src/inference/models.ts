/**
 * 模型注册表
 *
 * v1：默认 text_zh（bge-small-zh）；可切换 text_en（all-MiniLM-L6-v2）
 * v1.1：image（CLIP-ViT-Base-Patch32）作为 stretch goal
 *
 * 所有模型均为 Xenova 仓库的 ONNX 量化版，可经 Transformers.js 直接加载。
 * revision 固定到具体 commit，保证远程加载权重可复现（与 scripts/fetch-models.mjs 一致）。
 */
import type { Backend, Dtype, ModelInfo, ModelKey } from '../types';

/** 所有 ONNX 变体文件（与 scripts/fetch-models.mjs 的清单保持一致） */
const TEXT_ONNX_FILES = [
  'onnx/model_quantized.onnx',
  'onnx/model_fp16.onnx',
  'onnx/model.onnx',
];

const TEXT_EXTRA_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
];

export const MODEL_REGISTRY: Record<ModelKey, ModelInfo> = {
  text_en: {
    id: 'Xenova/all-MiniLM-L6-v2',
    dim: 384,
    modality: 'text',
    // 契约锁定的 revision（正式评测按此版本）
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    dtypeByBackend: { webgpu: 'fp16', wasm: 'q8' },
    onnxFiles: [...TEXT_EXTRA_FILES, ...TEXT_ONNX_FILES],
    // 实测 onnx 文件大小（fp32 -> q8）
    quantizedSizeMB: 21.9,
    fpSizeMB: 86.2,
  },
  text_zh: {
    id: 'Xenova/bge-small-zh-v1.5',
    dim: 512,
    modality: 'text',
    revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781',
    dtypeByBackend: { webgpu: 'fp16', wasm: 'q8' },
    onnxFiles: [...TEXT_EXTRA_FILES, ...TEXT_ONNX_FILES],
    quantizedSizeMB: 22.9,
    fpSizeMB: 90.5,
  },
  image: {
    id: 'Xenova/clip-vit-base-patch32',
    dim: 512,
    modality: 'image',
    // v1.1 预留：CLIP 权重版本尚未锁定（启用前需补 revision）
    dtypeByBackend: { webgpu: 'fp16', wasm: 'q8' },
    onnxFiles: [...TEXT_EXTRA_FILES, ...TEXT_ONNX_FILES],
    // v1.1 预留，未实测
    quantizedSizeMB: 150,
    fpSizeMB: 600,
  },
};

export const DEFAULT_MODEL: ModelKey = 'text_zh';

/** UI 可切换的模型（image 在 v1.1 启用前禁用） */
export const SELECTABLE_MODELS: readonly ModelKey[] = ['text_en', 'text_zh'];

/**
 * v1.1 图片管线开关。
 * CLIP 的文本塔需要 AutoProcessor + CLIPTextModelWithProjection（当前未实现），
 * 保持关闭可避免检索时误触发约 150MB 的 CLIP 模型下载。
 */
export const IMAGE_PIPELINE_ENABLED = false;

export function isModelKey(value: unknown): value is ModelKey {
  return typeof value === 'string' && value in MODEL_REGISTRY;
}

/** 能否作为当前文本模型（屏蔽 image 等未启用模型） */
export function isSelectableModelKey(value: unknown): value is Exclude<ModelKey, 'image'> {
  return value === 'text_en' || value === 'text_zh';
}

export function getModelInfo(key: ModelKey): ModelInfo {
  return MODEL_REGISTRY[key];
}

/**
 * 后端对应的默认 dtype：
 * - 优先读 MODEL_REGISTRY.dtypeByBackend（契约要求）
 * - 兜底规则：webgpu→fp16、wasm→q8
 */
export function defaultDtypeForBackend(modelKey: ModelKey, backend: Backend): Dtype {
  const fromRegistry = MODEL_REGISTRY[modelKey]?.dtypeByBackend?.[backend];
  if (fromRegistry) return fromRegistry;
  return backend === 'webgpu' ? 'fp16' : 'q8';
}

/** 约定命名的文本集合（中文模型 / 英文模型） */
export function defaultCollectionName(modelKey: ModelKey): string {
  return modelKey === 'text_en' ? 'kb_text_en' : 'kb_text_zh';
}
