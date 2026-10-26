/**
 * SeekVec 共享类型定义
 */

export type Modality = 'text' | 'image';

export type ModelKey = 'text_en' | 'text_zh' | 'image';

export type Backend = 'webgpu' | 'wasm';

/** 量化格式：q8（int8 量化）/ fp16 / fp32 */
export type Dtype = 'q8' | 'fp16' | 'fp32';

/**
 * 检索分数的语义：
 * - distance：cosine 距离，越小越相关（纯向量检索）
 * - score：RRF 融合分，越大越相关（混合检索）
 */
export type SearchMetric = 'distance' | 'score';

/** 检索模式（server 明确返回，UI 用于区分纯向量 / 混合检索） */
export type SearchMode = 'vector' | 'hybrid';

/** server 端检索分段耗时（POST /api/search 响应 timings） */
export interface SearchTimings {
  /** 解析集合/校验参数耗时 */
  resolveMs?: number;
  /** SeekDB 库内检索耗时 */
  dbMs?: number;
  /** server 端总耗时 */
  totalMs?: number;
}

export interface ModelInfo {
  id: string;
  dim: 384 | 512;
  modality: Modality;
  /** HuggingFace 固定 revision（远程模式下锁定权重版本，保证可复现） */
  revision?: string;
  /** 各后端默认量化格式（默认 webgpu=fp16、wasm=q8） */
  dtypeByBackend?: Partial<Record<Backend, Dtype>>;
  /** 本地/远程加载涉及的 ONNX 文件（与 scripts/fetch-models.mjs 的清单一致） */
  onnxFiles?: string[];
  /** 旧数字字段保留用于兼容（模型体积展示） */
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
  /** server HTTP 往返耗时 ms（不含端侧向量化） */
  latencyMs: number;
  /** 端侧向量化耗时 ms（不含网络与数据库检索） */
  embeddingMs?: number;
  /** 本次检索的 HTTP 往返耗时 ms（latencyMs 的显式别名，便于评测口径） */
  httpMs?: number;
  /** SeekDB 库内检索耗时 ms（来自 server timings.dbMs） */
  dbMs?: number;
  /** 本次检索使用哪种分数语义，UI 必须按此展示，不能统一按距离算 */
  metric: SearchMetric;
  /** 检索模式：vector=纯向量，hybrid=全文 + 向量 RRF 融合 */
  mode?: SearchMode;
  /** server 端分段耗时 */
  timings?: SearchTimings;
  /** 端到端耗时 ms（UI：到结果渲染后双 rAF；评测栈：到响应返回） */
  e2eMs?: number;
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

/** GET /api/collections/:name 响应（server 契约第 5 节） */
export interface CollectionDetail {
  name: string;
  dimension: 384 | 512;
  distance: string;
  modality: Modality;
  modelKey: ModelKey;
  /** count() 失败时为 null（详情接口整体仍 200） */
  count: number | null;
  schema: {
    /** HNSW 参数（无向量索引时省略） */
    hnsw?: Record<string, unknown>;
    /** 全文索引配置（图片集合为 null） */
    fulltext: Record<string, unknown> | null;
  };
  timings: {
    describeMs: number;
    countMs: number;
    totalMs: number;
  };
}
