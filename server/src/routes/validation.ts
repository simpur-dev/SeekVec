/**
 * 集中式请求校验
 *
 * 所有 /api 路由的入参校验统一走这里，保证：
 * - 同一类字段在所有接口上口径一致（集合名正则、枚举、上限等）
 * - 非法输入统一抛 HttpError(400, message, code)，由错误中间件输出
 *   `{ error, code, requestId }`，不会出现 500 裸错误
 * - 校验失败发生在任何 DB 操作之前，避免把脏数据带进 seekdb
 */
import type { Request } from 'express';
import { HttpError } from './errors.js';
import type { DocumentWriteMode, IkMode, ModelKey } from '../types.js';

/** 集合名：字母/数字/下划线/连字符，1-64 字符 */
export const COLLECTION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const MODEL_KEYS: readonly ModelKey[] = ['text_en', 'text_zh', 'image'];
export const IK_MODES: readonly IkMode[] = ['smart', 'max_word'];
export const DOCUMENT_MODES: readonly DocumentWriteMode[] = ['upsert', 'insert'];

/** nResults 默认值与取值范围 */
export const N_RESULTS_DEFAULT = 10;
export const N_RESULTS_MIN = 1;
export const N_RESULTS_MAX = 50;

/** 单请求 ids / embeddings 条数上限 */
export const MAX_IDS_PER_REQUEST = 512;

/** 混合检索 keyword 最大字符数 */
export const MAX_KEYWORD_LENGTH = 128;

/** 400 校验失败：抛错即中断路由，由统一错误中间件出响应 */
export function fail(message: string, code = 'BAD_REQUEST'): never {
  throw new HttpError(400, message, code);
}

/** body 必须是 JSON 对象（不是数组 / null / 标量） */
export function requireJsonBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail('请求体必须是 JSON 对象', 'INVALID_BODY');
  }
  return body as Record<string, unknown>;
}

/** 集合名校验（用于 body.collectionName / path :name） */
export function validateCollectionName(value: unknown, fieldName = 'collectionName'): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${fieldName} 必填，且必须为字符串`, 'INVALID_COLLECTION_NAME');
  }
  if (!COLLECTION_NAME_RE.test(value)) {
    fail(
      `${fieldName} 非法：仅允许字母、数字、下划线、连字符，长度 1-64（收到 "${value.slice(0, 80)}"）`,
      'INVALID_COLLECTION_NAME',
    );
  }
  return value;
}

/** modelKey 枚举 */
export function validateModelKey(value: unknown): ModelKey {
  if (typeof value !== 'string' || !MODEL_KEYS.includes(value as ModelKey)) {
    fail(`modelKey 非法：可选值 ${MODEL_KEYS.join(' | ')}`, 'INVALID_MODEL_KEY');
  }
  return value as ModelKey;
}

/** ikMode 枚举（可选；不传返回 undefined 让 schema 用默认 smart） */
export function validateIkMode(value: unknown): IkMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !IK_MODES.includes(value as IkMode)) {
    fail(`ikMode 非法：可选值 ${IK_MODES.join(' | ')}`, 'INVALID_IK_MODE');
  }
  return value as IkMode;
}

/** 写入模式枚举（可选；默认 upsert） */
export function validateDocumentMode(value: unknown): DocumentWriteMode {
  if (value === undefined || value === null) return 'upsert';
  if (typeof value !== 'string' || !DOCUMENT_MODES.includes(value as DocumentWriteMode)) {
    fail(`mode 非法：可选值 ${DOCUMENT_MODES.join(' | ')}`, 'INVALID_MODE');
  }
  return value as DocumentWriteMode;
}

/** 通用字符串数组校验 */
function validateStringArray(
  value: unknown,
  options: { field: string; code: string; allowEmpty: boolean },
): string[] {
  if (!Array.isArray(value)) {
    fail(`${options.field} 必须为字符串数组`, options.code);
  }
  if (!options.allowEmpty && value.length === 0) {
    fail(`${options.field} 不能为空数组`, options.code);
  }
  const result: string[] = new Array<string>(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    if (typeof item !== 'string') {
      fail(`${options.field}[${index}] 必须为字符串`, options.code);
    }
    result[index] = item as string;
  }
  return result;
}

/** ids：字符串数组 + 单请求 ≤512 */
export function validateIds(value: unknown, field = 'ids'): string[] {
  const ids = validateStringArray(value, { field, code: 'INVALID_IDS', allowEmpty: false });
  if (ids.length > MAX_IDS_PER_REQUEST) {
    fail(
      `${field} 单次最多 ${MAX_IDS_PER_REQUEST} 条（当前 ${ids.length}）`,
      'TOO_MANY_IDS',
    );
  }
  return ids;
}

/** 文本数组（documents）：字符串数组 */
export function validateDocumentTexts(value: unknown, field = 'documents'): string[] {
  return validateStringArray(value, { field, code: 'INVALID_DOCUMENTS', allowEmpty: false });
}

/** 查询向量：非空有限数数组 */
export function validateQueryEmbedding(value: unknown, field = 'queryEmbedding'): number[] {
  return validateFiniteNumberArray(value, field, 'INVALID_QUERY_EMBEDDING');
}

/** 非空有限数数组（内部通用） */
function validateFiniteNumberArray(value: unknown, field: string, code: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${field} 必须为非空数值数组`, code);
  }
  const numbers: number[] = new Array<number>(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      fail(`${field}[${index}] 必须为有限数字`, code);
    }
    numbers[index] = item as number;
  }
  return numbers;
}

/** 批量向量：非空二维数组，每行非空有限数且行长度一致 */
export function validateEmbeddings(value: unknown, field = 'embeddings'): number[][] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${field} 必须为非空二维数值数组`, 'INVALID_EMBEDDINGS');
  }
  const rows: number[][] = new Array<number[]>(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const row: unknown = value[index];
    rows[index] = validateFiniteNumberArray(row, `${field}[${index}]`, 'INVALID_EMBEDDINGS');
  }
  const expected = rows[0].length;
  const badRow = rows.findIndex((row) => row.length !== expected);
  if (badRow !== -1) {
    fail(
      `${field}[${badRow}] 长度 ${rows[badRow].length} 与第一条 ${expected} 不一致`,
      'INVALID_EMBEDDINGS',
    );
  }
  return rows;
}

/**
 * metadatas：可选数组，允许 null 占位（SDK 查询结果里缺元数据即 null），
 * 元素必须为普通对象或 null，长度需与 ids 对齐。
 */
export function validateMetadatas(
  value: unknown,
  expectedLength: number,
  field = 'metadatas',
): Array<Record<string, unknown> | null> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    fail(`${field} 必须为数组`, 'INVALID_METADATAS');
  }
  if (value.length !== expectedLength) {
    fail(
      `${field} 长度 ${value.length} 与 ids 长度 ${expectedLength} 不一致`,
      'INVALID_METADATAS',
    );
  }
  const result: Array<Record<string, unknown> | null> = new Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    if (item === null || item === undefined) {
      result[index] = null;
    } else if (typeof item === 'object' && !Array.isArray(item)) {
      result[index] = item as Record<string, unknown>;
    } else {
      fail(`${field}[${index}] 必须为对象或 null`, 'INVALID_METADATAS');
    }
  }
  return result;
}

/** refreshIndex：可选布尔值 */
export function validateRefreshIndex(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    fail('refreshIndex 必须为布尔值', 'INVALID_REFRESH_INDEX');
  }
  return value as boolean;
}

/** nResults：可选整数，范围 1..50，默认 10 */
export function validateNResults(value: unknown): number {
  if (value === undefined || value === null) return N_RESULTS_DEFAULT;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail('nResults 必须为整数', 'INVALID_N_RESULTS');
  }
  if (value < N_RESULTS_MIN || value > N_RESULTS_MAX) {
    fail(`nResults 必须在 ${N_RESULTS_MIN}-${N_RESULTS_MAX} 之间`, 'INVALID_N_RESULTS');
  }
  return value as number;
}

/** keyword：可选字符串，≤128；空串表示走纯向量（调用方 trim 后判断） */
export function validateKeyword(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    fail('keyword 必须为字符串', 'INVALID_KEYWORD');
  }
  if (value.length > MAX_KEYWORD_LENGTH) {
    fail(
      `keyword 长度不能超过 ${MAX_KEYWORD_LENGTH} 字符（当前 ${value.length}）`,
      'INVALID_KEYWORD',
    );
  }
  return value as string;
}

/** source（metadata 过滤）：可选非空字符串 */
export function validateSource(value: unknown, field = 'source'): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    fail(`${field} 必须为字符串`, 'INVALID_SOURCE');
  }
  if (value.trim().length === 0) {
    fail(`${field} 不能为空字符串`, 'INVALID_SOURCE');
  }
  return value as string;
}

/** ids 与并行数组长度必须一致 */
export function assertSameLength(
  actual: number,
  expected: number,
  field: string,
  expectedField = 'ids',
): void {
  if (actual !== expected) {
    fail(`${field} 长度 ${actual} 与 ${expectedField} 长度 ${expected} 不一致`, 'INVALID_BODY');
  }
}

/** insert 模式下请求内 id 不得重复（与库内重复同等语义 → 409） */
export function assertInsertIdsUnique(ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new HttpError(409, `insert 模式下请求内存在重复 id: ${id}`, 'DOCUMENT_EXISTS');
    }
    seen.add(id);
  }
}

/** 读取单值查询参数（拒绝重复参数/对象语法） */
export function readQueryString(req: Request, name: string): string | undefined {
  const raw = (req.query as Record<string, unknown>)[name];
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') return raw;
  fail(`查询参数 ${name} 必须为单个字符串`, 'INVALID_QUERY');
}

/** ?deep=1 / ?deep=true */
export function isDeepProbe(value: unknown): boolean {
  const first: unknown = Array.isArray(value) ? value[0] : value;
  return first === '1' || first === 'true';
}
