/**
 * Server 端类型定义（与 web 端的 types/index.ts 字段对齐）
 *
 * 注意：seekdb SDK 的查询结果里 metadatas / documents 可能是 null
 * （混合检索会对缺失字段补 null），因此这两处类型显式允许 null。
 */

export type Modality = 'text' | 'image';

export type ModelKey =
  | 'text_en' // Xenova/all-MiniLM-L6-v2, 384d
  | 'text_zh' // Xenova/bge-small-zh-v1.5, 512d
  | 'image';  // Xenova/clip-vit-base-patch32, 512d

export type IkMode = 'smart' | 'max_word';

export interface CreateCollectionRequest {
  name: string;
  modelKey: ModelKey;
  /** 仅文本集合生效；默认 smart */
  ikMode?: IkMode;
}

/** 文档写入模式：upsert 幂等覆盖（默认）；insert 仅新增，重复 id 冲突 409 */
export type DocumentWriteMode = 'upsert' | 'insert';

export interface IngestTextRequest {
  collectionName: string;
  /** 文档 ID，必须唯一（web 端用内容 hash 生成，保证重复导入幂等） */
  ids: string[];
  /** 原文文本，与 ids 一一对应 */
  documents: string[];
  /** 由 web 端 embedding 模型产出，Float32 序列化为 number[] */
  embeddings: number[][];
  /** 元数据，可选；允许 null 占位 */
  metadatas?: Array<Record<string, unknown> | null>;
  /** 是否刷新索引，默认 true；批量导入可在中间批次传 false，只刷新一次 */
  refreshIndex?: boolean;
  /** 写入模式，默认 upsert */
  mode?: DocumentWriteMode;
}

export interface IngestImageRequest {
  collectionName: string;
  ids: string[];
  /** CLIP 视觉塔产出 512d 向量 */
  embeddings: number[][];
  /** 图片元数据（包含 fileName / size / mimeType / createdAt） */
  metadatas: Array<Record<string, unknown> | null>;
  /** 是否刷新索引，默认 true */
  refreshIndex?: boolean;
}

export interface IngestTimings {
  /** add/upsert 耗时（含集合解析与维度校验） */
  upsertMs: number;
  /** refresh_index 耗时；未刷新时为 null */
  refreshMs: number | null;
  /** 本次请求总耗时 */
  totalMs: number;
}

export interface IngestTextResponse {
  ok: true;
  count: number;
  mode: DocumentWriteMode;
  refreshed: boolean;
  timings: IngestTimings;
}

export interface SearchRequest {
  collectionName: string;
  /** web 端 embedding 模型产出 */
  queryEmbedding: number[];
  /** 取前 k，默认 10（整数 1..50） */
  nResults?: number;
  /** 可选：混合检索的全文关键字（仅文本集合生效；空串按纯向量处理） */
  keyword?: string;
}

export type SearchMode = 'vector' | 'hybrid';

export interface SearchTimings {
  /** 解析集合 / 校验维度耗时 */
  resolveMs: number;
  /** seekdb 检索耗时 */
  dbMs: number;
  /** 请求总耗时 */
  totalMs: number;
}

export interface SearchResultItem {
  id: string;
  document?: string;
  metadata?: Record<string, unknown>;
  distance?: number;
}

export interface SearchResponse {
  ids: string[][];
  /** SDK 在混合检索下会对缺失文本补 null */
  documents: Array<Array<string | null>>;
  metadatas: Array<Array<Record<string, unknown> | null | undefined>>;
  /** 纯向量检索：cosine 距离，越小越相关 */
  distances?: Array<Array<number | null>>;
  /** 混合检索：SeekDB 返回的 RRF 融合分，越大越相关（语义与 distances 相反） */
  scores?: Array<Array<number | null>>;
  /** 本次实际使用的检索模式 */
  mode: SearchMode;
  timings: SearchTimings;
  /** 传给 knn 的候选窗口大小（= nResults） */
  knnK: number;
}

export interface CollectionListItem {
  name: string;
  modelKey: ModelKey;
  dimension: 384 | 512;
  modality: Modality;
  count: number | null;
}

export interface ListCollectionsResponse {
  collections: CollectionListItem[];
}

/** 集合索引 schema 的 JSON 形态（仅暴露维护接口需要的字段） */
export interface CollectionSchemaInfo {
  /** HNSW 参数（无向量索引时省略） */
  hnsw?: Record<string, unknown>;
  /** 全文索引配置（图片集合为 null） */
  fulltext: Record<string, unknown> | null;
}

export interface CollectionDetailTimings {
  describeMs: number;
  countMs: number;
  totalMs: number;
}

export interface CollectionDetail {
  name: string;
  dimension: 384 | 512;
  distance: string;
  modality: Modality;
  modelKey: ModelKey;
  count: number | null;
  schema: CollectionSchemaInfo;
  timings: CollectionDetailTimings;
}

export interface RefreshCollectionResponse {
  ok: true;
  timings: { refreshMs: number };
}

export interface DeleteCollectionResponse {
  ok: true;
  deleted: true;
}

export interface ListDocumentIdsResponse {
  ids: string[];
  count: number;
}

export interface DeleteDocumentsRequest {
  collectionName: string;
  /** 与 source 二选一；单请求 ≤512 */
  ids?: string[];
  /** 按 metadata.source 过滤删除 */
  source?: string;
}

export interface DeleteDocumentsResponse {
  deleted: number;
}

export type HealthStatus = 'ok' | 'degraded';

export interface HealthSeekdbStatus {
  reachable: boolean;
  /** 探活耗时（毫秒） */
  latencyMs: number;
  version: string | null;
  refreshIndexSupported: boolean;
}

export interface HealthResponse {
  status: HealthStatus;
  ts: number;
  seekdb: HealthSeekdbStatus;
}

/** 统一错误响应：4xx/5xx 一律走该形状 */
export interface ErrorResponse {
  error: string;
  code?: string;
  requestId?: string;
}

/** 400 参数校验错误码 */
export type ValidationErrorCode =
  | 'INVALID_BODY'
  | 'INVALID_COLLECTION_NAME'
  | 'INVALID_MODEL_KEY'
  | 'INVALID_IK_MODE'
  | 'INVALID_N_RESULTS'
  | 'INVALID_IDS'
  | 'INVALID_DOCUMENTS'
  | 'INVALID_EMBEDDINGS'
  | 'INVALID_QUERY_EMBEDDING'
  | 'INVALID_METADATAS'
  | 'INVALID_KEYWORD'
  | 'INVALID_MODE'
  | 'INVALID_REFRESH_INDEX'
  | 'INVALID_SOURCE'
  | 'INVALID_FILTER'
  | 'INVALID_QUERY'
  | 'TOO_MANY_IDS';
