/**
 * SeekVec 共享类型定义
 */

export type Modality = 'text' | 'image';

export type ModelKey = 'text_en' | 'text_zh' | 'image';

export type Backend = 'webgpu' | 'wasm';

export interface ModelInfo {
  id: string;
  dim: 384 | 512;
  modality: Modality;
  quantizedSizeMB?: number;
  fpSizeMB?: number;
}

export interface SearchHit {
  id: string;
  document?: string;
  metadata?: Record<string, unknown>;
  distance?: number;
}

export interface SearchResult {
  collectionName: string;
  hits: SearchHit[];
  latencyMs: number;
}

export interface CollectionSummary {
  name: string;
  modelKey: ModelKey;
  dimension: 384 | 512;
  modality: Modality;
}
