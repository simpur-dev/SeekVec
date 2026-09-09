/**
 * Server 端类型定义（与 web 端的 types/index.ts 字段对齐）
 */

export type Modality = 'text' | 'image';

export type ModelKey =
  | 'text_en' // Xenova/all-MiniLM-L6-v2, 384d
  | 'text_zh' // Xenova/bge-small-zh-v1.5, 512d
  | 'image';  // Xenova/clip-vit-base-patch32, 512d

export interface CreateCollectionRequest {
  name: string;
  modelKey: ModelKey;
  /** 仅文本集合生效；默认 smart */
  ikMode?: 'smart' | 'max_word';
}

export interface IngestTextRequest {
  collectionName: string;
  /** 文档 ID，必须唯一 */
  ids: string[];
  /** 原文文本，与 ids 一一对应 */
  documents: string[];
  /** 由 web 端 embedding 模型产出，Float32 序列化为 number[] */
  embeddings: number[][];
  /** 元数据，可选 */
  metadatas?: Array<Record<string, unknown>>;
}

export interface IngestImageRequest {
  collectionName: string;
  ids: string[];
  /** CLIP 视觉塔产出 512d 向量 */
  embeddings: number[][];
  /** 图片元数据（包含 fileName / size / mimeType / createdAt） */
  metadatas: Array<Record<string, unknown>>;
}

export interface SearchRequest {
  collectionName: string;
  /** web 端 embedding 模型产出 */
  queryEmbedding: number[];
  /** 取前 k，默认 10 */
  nResults?: number;
  /** 可选：混合检索的全文关键字（仅文本集合生效） */
  keyword?: string;
}

export interface SearchResultItem {
  id: string;
  document?: string;
  metadata?: Record<string, unknown>;
  distance?: number;
}

export interface SearchResponse {
  ids: string[][];
  documents: string[][];
  metadatas: Array<Array<Record<string, unknown> | undefined>>;
  distances?: number[][];
}
