/**
 * 量化方案元数据
 *
 * 用于技术说明文档引用。
 */

export interface QuantNote {
  modelKey: string;
  quantized: 'int8';
  quantizedSizeMB: number;
  fp32SizeMB: number;
  compressionRatio: number;
  /** 引用 bench.ts 实测数据；初版提供参考值 */
  cosineSimDrop?: number;
  recallAt10Drop?: number;
}

export const QUANT_NOTES = {
  all_MiniLM_L6_v2: {
    modelKey: 'Xenova/all-MiniLM-L6-v2',
    quantized: 'int8' as const,
    quantizedSizeMB: 23,
    fp32SizeMB: 90,
    compressionRatio: 90 / 23,
  },
  bge_small_zh: {
    modelKey: 'Xenova/bge-small-zh-v1.5',
    quantized: 'int8' as const,
    quantizedSizeMB: 25,
    fp32SizeMB: 95,
    compressionRatio: 95 / 25,
  },
  clip_vit_base_patch32: {
    modelKey: 'Xenova/clip-vit-base-patch32',
    quantized: 'int8' as const,
    quantizedSizeMB: 150,
    fp32SizeMB: 600,
    compressionRatio: 4,
  },
} satisfies Record<string, QuantNote>;
