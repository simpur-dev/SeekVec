/**
 * SeekVec 共享类型定义
 */

export type Modality = 'text' | 'image';

export type ModelKey = 'text_en' | 'text_zh' | 'image';

export type Backend = 'webgpu' | 'wasm';

/**
 * 检索分数的语义：
 * - distance：cosine 距离，越小越相关（纯向量检索）
 * - score：RRF 融合分，越大越相关（混合检索）
 */
export type SearchMetric = 'distance' | 'score';

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
  /** 仅纯向量检索：cosine 距离 */
  distance?: number;
  /** 仅混合检索：RRF 融合分 */
  score?: number;
}

export interface SearchResult {
  collectionName: string;
  hits: SearchHit[];
  latencyMs: number;
  /** 端侧向量化耗时 ms（不含网络与数据库检索） */
  embeddingMs?: number;
  /** 本次检索使用哪种分数语义，UI 必须按此展示，不能统一按距离算 */
  metric: SearchMetric;
  /** 无可用集合等场景的提示（静默失败改为显式提示） */
  notice?: string;
}

export interface CollectionSummary {
  name: string;
  modelKey: ModelKey;
  dimension: 384 | 512;
  modality: Modality;
  /** 集合内条目数（刷新后回填 StatsBar 用） */
  count?: number | null;
}
