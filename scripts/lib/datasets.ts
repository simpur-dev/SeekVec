/**
 * 评测数据集加载与结构校验
 *
 * 关键约束：评测用的「块」必须与浏览器导入链路完全一致，否则 qrels 里的
 * chunkIndex 会与运行时写入 seekdb 的 chunk 对不上。因此这里**不复制**分块/哈希逻辑，
 * 而是直接复用 web 端的实现：
 *   - `web/src/inference/chunk.ts` 的 `chunkText`（默认 maxLength=256 / overlap=32 / minLength=10）
 *   - `web/src/utils/id.ts` 的 `chunkId`（FNV-1a，source + chunkIndex + text）
 * tsx 可直接 import TS，scripts/tsconfig 的 Bundler resolution 也允许省略扩展名。
 *
 * 数据格式（详见 data/eval/README.md）：
 *   data/eval/corpus/<name>.md   一篇文档一个文件，文件名即 source（与浏览器 File.name 相同）
 *   data/eval/queries.jsonl      每行 {qid, category, lang, query, keyword?, relevant:[{source,chunkIndex,grade}]}
 *
 * 未标注的 (source, chunkIndex) 一律按 grade=0 处理（pooled judgment）。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chunkText, type ChunkOptions } from '../../web/src/inference/chunk';
import { chunkId } from '../../web/src/utils/id';

/**
 * 浏览器默认分块参数。
 * 改动这里必须同步浏览器默认值（useIngest 调用 chunkText(text) 不传参），
 * 否则 qrels 的 chunkIndex 会漂移。
 */
export const BROWSER_CHUNK_OPTIONS: Readonly<Required<ChunkOptions>> = Object.freeze({
  maxLength: 256,
  overlap: 32,
  minLength: 10,
});

export type EvalCategory = 'semantic' | 'keyword' | 'paraphrase';
export type EvalLang = 'zh' | 'en' | 'unknown';

export const EVAL_CATEGORIES: readonly EvalCategory[] = ['semantic', 'keyword', 'paraphrase'];

/** 语料原文（一个文件 = 一篇文档） */
export interface CorpusDocument {
  /** 文件名（含扩展名），与浏览器 File.name / qrels.source 一致 */
  source: string;
  text: string;
  lang: EvalLang;
}

/** 分块后的检索单元；id 与浏览器写入 seekdb 的 chunk id 完全一致 */
export interface CorpusChunk {
  id: string;
  source: string;
  chunkIndex: number;
  text: string;
  lang: EvalLang;
}

/** chunk 级相关性标注 */
export interface QrelEntry {
  source: string;
  chunkIndex: number;
  /** 0-3；rel≥1 视为相关 */
  grade: number;
}

/** 一条评测查询 */
export interface EvalQuery {
  qid: string;
  query: string;
  category: EvalCategory;
  lang: EvalLang;
  /** 仅 keyword 类必填：查询必须包含的字面关键词 */
  keyword?: string;
  relevant: QrelEntry[];
}

export interface EvalDataset {
  documents: CorpusDocument[];
  chunks: CorpusChunk[];
  queries: EvalQuery[];
  issues: string[];
}

/** chunk 的稳定键：`source#chunkIndex`（用于把 qrels 解析到 chunk id） */
export function chunkKey(source: string, chunkIndex: number): string {
  return `${source}#${chunkIndex}`;
}

/** 与浏览器 chunkId(source, chunkIndex, text) 相同的 id（这里只是显式 re-export 方便测试） */
export { chunkId };

/**
 * 语言判定：
 * 1) 文件名前缀 `zh-` / `en-` 优先（评测集命名约定）；
 * 2) 否则按文本 CJK 字符占比（≥20% 视为中文）。
 */
export function detectLang(source: string, text: string): EvalLang {
  const base = source.toLowerCase();
  if (base.startsWith('zh-')) return 'zh';
  if (base.startsWith('en-')) return 'en';
  let cjk = 0;
  let visible = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    visible += 1;
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)) cjk += 1;
  }
  if (visible === 0) return 'unknown';
  return cjk / visible >= 0.2 ? 'zh' : 'en';
}

/**
 * 对单篇文档分块（与浏览器 useIngest 的调用方式一致）。
 * 返回的 id 由 chunkId(source, chunkIndex, text) 生成，chunkIndex 为文件内序号。
 */
export function chunkDocument(
  source: string,
  text: string,
  options: ChunkOptions = BROWSER_CHUNK_OPTIONS,
): CorpusChunk[] {
  const chunks = chunkText(text, options);
  const lang = detectLang(source, text);
  return chunks.map((chunk) => ({
    id: chunkId(source, chunk.index, chunk.text),
    source,
    chunkIndex: chunk.index,
    text: chunk.text,
    lang,
  }));
}

/** 读取 data/eval/corpus 下的 .md/.txt 文档（按文件名排序，保证确定性） */
export async function loadCorpusDocuments(corpusDir: string): Promise<CorpusDocument[]> {
  let entries: string[];
  try {
    entries = await readdir(corpusDir);
  } catch (error) {
    throw new Error(
      `读取语料目录失败：${corpusDir}（${(error as Error).message}）。请确认 data/eval/corpus 存在。`,
    );
  }
  const files = entries.filter((name) => /\.(md|txt)$/i.test(name)).sort();
  if (files.length === 0) {
    throw new Error(`语料目录为空：${corpusDir}`);
  }
  const documents: CorpusDocument[] = [];
  for (const source of files) {
    const text = await readFile(path.join(corpusDir, source), 'utf8');
    documents.push({ source, text, lang: detectLang(source, text) });
  }
  return documents;
}

/** 加载并分块整个语料目录（chunk 顺序 = source 字典序 + 文件内 chunkIndex） */
export async function loadCorpus(
  corpusDir: string,
  options: ChunkOptions = BROWSER_CHUNK_OPTIONS,
): Promise<CorpusChunk[]> {
  const documents = await loadCorpusDocuments(corpusDir);
  return documents.flatMap((doc) => chunkDocument(doc.source, doc.text, options));
}

/** 解析 JSONL 文本；空行跳过；报错带文件名与行号，方便标注排错 */
export function parseJsonl<T>(content: string, label = '<jsonl>'): T[] {
  const rows: T[] = [];
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch (error) {
      throw new Error(`${label}:${i + 1} 不是合法 JSON：${(error as Error).message}`);
    }
  }
  return rows;
}

/** 读取 JSONL 文件 */
export async function readJsonl<T>(file: string): Promise<T[]> {
  const content = await readFile(file, 'utf8');
  return parseJsonl<T>(content, file);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCategory(raw: unknown, where: string): EvalCategory {
  if (raw === 'semantic' || raw === 'keyword' || raw === 'paraphrase') return raw;
  throw new RangeError(`${where}: category 必须是 semantic/keyword/paraphrase，实际为 ${JSON.stringify(raw)}`);
}

function parseQrels(raw: unknown, where: string): QrelEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${where}: relevant 必须是非空数组`);
  }
  return raw.map((entry, index) => {
    const at = `${where}.relevant[${index}]`;
    if (!isPlainObject(entry)) throw new Error(`${at}: 必须是对象`);
    const { source, chunkIndex, grade } = entry;
    if (typeof source !== 'string' || source.trim() === '') {
      throw new Error(`${at}.source: 必须是非空字符串`);
    }
    if (typeof chunkIndex !== 'number' || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
      throw new Error(`${at}.chunkIndex: 必须是非负整数`);
    }
    if (typeof grade !== 'number' || !Number.isInteger(grade) || grade < 0 || grade > 3) {
      throw new Error(`${at}.grade: 必须是 0-3 的整数`);
    }
    return { source, chunkIndex, grade };
  });
}

/**
 * 解析并校验 queries.jsonl 的**字段形状**（数据结构层面的硬错误会抛异常）。
 * 语义层面的约束（数量、覆盖度、每条查询的标注要求）由 `validateEvalSet` 返回问题列表。
 */
export function normalizeEvalQueries(rows: readonly unknown[], label = '<queries>'): EvalQuery[] {
  const queries: EvalQuery[] = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const where = `${label} 第 ${i + 1} 行`;
    if (!isPlainObject(raw)) throw new Error(`${where}: 必须是 JSON 对象`);
    const { qid, query, category, lang, keyword, relevant } = raw;
    if (typeof qid !== 'string' || qid.trim() === '') throw new Error(`${where}: qid 必须是非空字符串`);
    if (typeof query !== 'string' || query.trim() === '') throw new Error(`${where}: query 必须是非空字符串`);
    if (keyword !== undefined && (typeof keyword !== 'string' || keyword.trim() === '')) {
      throw new Error(`${where}: keyword 必须是非空字符串或不填`);
    }
    const parsed: EvalQuery = {
      qid,
      query,
      category: parseCategory(category, where),
      lang: lang === 'zh' || lang === 'en' ? lang : detectLang('', query),
      relevant: parseQrels(relevant, where),
    };
    parsed.lang = parsed.lang === 'unknown' ? detectLang('', query) : parsed.lang;
    if (keyword !== undefined) parsed.keyword = keyword;
    queries.push(parsed);
  }
  return queries;
}

/** 读取并解析 queries.jsonl */
export async function loadEvalQueries(file: string): Promise<EvalQuery[]> {
  const rows = await readJsonl<unknown>(file);
  return normalizeEvalQueries(rows, file);
}

/** 加载完整评测集（可选立即校验，issues 为空表示通过） */
export async function loadEvalDataset(dataDir: string, options: { validate?: boolean } = {}): Promise<EvalDataset> {
  const corpusDir = path.join(dataDir, 'corpus');
  const documents = await loadCorpusDocuments(corpusDir);
  const chunks = documents.flatMap((doc) => chunkDocument(doc.source, doc.text));
  const queries = await loadEvalQueries(path.join(dataDir, 'queries.jsonl'));
  const issues = options.validate === false ? [] : validateEvalSet(queries, chunks);
  return { documents, chunks, queries, issues };
}

/**
 * 结构 / 标注约束校验（返回问题列表，不抛异常）：
 * - qid 唯一；
 * - 每条查询：≥3 个不同的相关 source（rel≥1）、≥1 个 rel=3；grade 为 0-3 整数；
 * - 每条 qrels 的 (source, chunkIndex) 必须能解析到真实 chunk，同一 chunk 不重复标注；
 * - keyword 类查询必须有 keyword，且 keyword（大小写不敏感）出现在至少一个 rel=3 的 chunk 文本中。
 */
export function validateEvalSet(queries: readonly EvalQuery[], chunks: readonly CorpusChunk[]): string[] {
  const issues: string[] = [];
  const chunkIndex = new Map<string, CorpusChunk>();
  for (const chunk of chunks) {
    const key = chunkKey(chunk.source, chunk.chunkIndex);
    if (chunkIndex.has(key)) issues.push(`语料重复的 chunk 键：${key}`);
    chunkIndex.set(key, chunk);
  }

  const seenQids = new Set<string>();
  for (const query of queries) {
    const at = `查询 ${query.qid}`;
    if (seenQids.has(query.qid)) issues.push(`${at}: qid 重复`);
    seenQids.add(query.qid);
    if (query.relevant.length === 0) {
      issues.push(`${at}: relevant 为空`);
      continue;
    }
    const relSources = new Set<string>();
    const highGradeChunks: CorpusChunk[] = [];
    const seenKeys = new Set<string>();
    let maxGrade = 0;
    for (const entry of query.relevant) {
      if (!Number.isInteger(entry.grade) || entry.grade < 0 || entry.grade > 3) {
        issues.push(`${at}: ${entry.source}#${entry.chunkIndex} grade=${entry.grade} 非法（应为 0-3 整数）`);
        continue;
      }
      const key = chunkKey(entry.source, entry.chunkIndex);
      if (seenKeys.has(key)) {
        issues.push(`${at}: ${key} 重复标注`);
        continue;
      }
      seenKeys.add(key);
      const chunk = chunkIndex.get(key);
      if (!chunk) {
        issues.push(`${at}: qrels 指向不存在的 chunk ${key}`);
        continue;
      }
      if (entry.grade > 0) relSources.add(entry.source);
      if (entry.grade > maxGrade) maxGrade = entry.grade;
      if (entry.grade === 3) highGradeChunks.push(chunk);
    }
    if (relSources.size < 3) {
      issues.push(`${at}: 相关 source 只有 ${relSources.size} 个，要求 ≥3（rel≥1）`);
    }
    if (maxGrade < 3) {
      issues.push(`${at}: 缺少 rel=3 的高相关标注`);
    }
    if (query.category === 'keyword') {
      const keyword = query.keyword?.trim();
      if (!keyword) {
        issues.push(`${at}: keyword 类查询缺少 keyword`);
      } else if (highGradeChunks.length > 0 && !highGradeChunks.some((chunk) => chunk.text.toLowerCase().includes(keyword.toLowerCase()))) {
        issues.push(`${at}: keyword "${keyword}" 未出现在任何 rel=3 的 chunk 中`);
      }
    }
  }
  return issues;
}

/** 数据集规模摘要（报告与 Markdown 输出共用） */
export interface EvalSetSummary {
  documents: number;
  documentsByLang: Record<EvalLang, number>;
  chunks: number;
  queries: number;
  queriesByCategory: Record<EvalCategory, number>;
  queriesByLang: Record<EvalLang, number>;
  relevantPairs: number;
}

export function summarizeEvalSet(
  documents: readonly CorpusDocument[],
  chunks: readonly CorpusChunk[],
  queries: readonly EvalQuery[],
): EvalSetSummary {
  const byLang = (): Record<EvalLang, number> => ({ zh: 0, en: 0, unknown: 0 });
  const docLang = byLang();
  for (const doc of documents) docLang[doc.lang] += 1;
  const queryLang = byLang();
  const byCategory: Record<EvalCategory, number> = { semantic: 0, keyword: 0, paraphrase: 0 };
  let relevantPairs = 0;
  for (const query of queries) {
    queryLang[query.lang] += 1;
    byCategory[query.category] += 1;
    relevantPairs += query.relevant.length;
  }
  return {
    documents: documents.length,
    documentsByLang: docLang,
    chunks: chunks.length,
    queries: queries.length,
    queriesByCategory: byCategory,
    queriesByLang: queryLang,
    relevantPairs,
  };
}
