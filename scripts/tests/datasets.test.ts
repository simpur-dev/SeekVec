/**
 * scripts/lib/datasets.ts 单元测试
 *
 * 重点保证「评测数据与浏览器分块链路一致」：
 *   - data/eval 的 chunk 必须与直接调用 web/src/inference/chunk.ts chunkText +
 *     web/src/utils/id.ts chunkId 的结果完全一致（否则 qrels 的 chunkIndex 会漂移）；
 *   - 数据集规模/语言/类别与实施契约一致；
 *   - qrels 能解析到真实 chunk，且每条查询满足 ≥3 个相关 source、≥1 条 grade=3、
 *     keyword 类查询的关键词出现在 grade=3 chunk 中；
 *   - JSONL 解析与结构校验的报错行为；
 *   - validateEvalSet 对人为构造的坏数据能发现问题。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { chunkText } from '../../web/src/inference/chunk';
import { chunkId } from '../../web/src/utils/id';
import {
  BROWSER_CHUNK_OPTIONS,
  chunkDocument,
  chunkKey,
  detectLang,
  loadCorpusDocuments,
  loadEvalDataset,
  loadEvalQueries,
  normalizeEvalQueries,
  parseJsonl,
  summarizeEvalSet,
  validateEvalSet,
  type CorpusChunk,
  type EvalDataset,
  type EvalQuery,
} from '../lib/datasets';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVAL_DIR = path.join(REPO_ROOT, 'data', 'eval');
const PERF_DIR = path.join(REPO_ROOT, 'data', 'perf');
const DEMO_DIR = path.join(REPO_ROOT, 'data', 'demo');

function countCjk(text: string): number {
  let count = 0;
  for (const ch of text) if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)) count += 1;
  return count;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

describe('分块与 chunk id 与 web 端一致', () => {
  it('BROWSER_CHUNK_OPTIONS 与 chunkText 默认值一致', () => {
    expect(BROWSER_CHUNK_OPTIONS).toEqual({ maxLength: 256, overlap: 32, minLength: 10 });
  });

  it('chunkDocument 生成的 id/text/chunkIndex 等于直接调用 chunkText + chunkId', () => {
    const text = '第一段内容足够长，用于测试分块结果是否与浏览器完全一致。\n\n第二段内容同样足够长，确保不会被最小长度过滤掉。';
    const expected = chunkText(text).map((chunk) => ({ text: chunk.text, chunkIndex: chunk.index }));
    const actual = chunkDocument('unit-test.md', text).map((chunk) => ({ text: chunk.text, chunkIndex: chunk.chunkIndex }));
    expect(actual).toEqual(expected);
    for (const chunk of chunkDocument('unit-test.md', text)) {
      expect(chunk.id).toBe(chunkId('unit-test.md', chunk.chunkIndex, chunk.text));
    }
  });

  it('detectLang：文件名前缀优先，其次按 CJK 占比', () => {
    expect(detectLang('zh-01.md', 'abc')).toBe('zh');
    expect(detectLang('en-01.md', '中文')).toBe('en');
    expect(detectLang('note.md', '这是一段比较长的中文内容，用来触发 CJK 判定。')).toBe('zh');
    expect(detectLang('note.md', 'This is a plain English sentence.')).toBe('en');
  });
});

describe('data/eval 数据集', () => {
  let dataset: EvalDataset;

  beforeAll(async () => {
    dataset = await loadEvalDataset(EVAL_DIR, { validate: true });
  });

  it('规模符合契约：60 篇（zh 40 / en 20）、查询三类各 20、结构校验无问题', () => {
    expect(dataset.issues).toEqual([]);
    const summary = summarizeEvalSet(dataset.documents, dataset.chunks, dataset.queries);
    expect(summary.documents).toBe(60);
    expect(summary.documentsByLang.zh).toBe(40);
    expect(summary.documentsByLang.en).toBe(20);
    expect(summary.queries).toBe(60);
    expect(summary.queriesByCategory).toEqual({ semantic: 20, keyword: 20, paraphrase: 20 });
    expect(summary.queriesByLang.zh).toBe(40);
    expect(summary.queriesByLang.en).toBe(20);
    expect(summary.chunks).toBeGreaterThanOrEqual(60);
    expect(summary.chunks).toBeLessThanOrEqual(120);
    expect(summary.relevantPairs).toBeGreaterThanOrEqual(60 * 3);
  });

  it('文档长度：中文 40–120 字、英文 40–120 词', () => {
    for (const doc of dataset.documents) {
      if (doc.lang === 'zh') {
        const chars = countCjk(doc.text);
        expect(chars, `${doc.source} 中文字数`).toBeGreaterThanOrEqual(40);
        expect(chars, `${doc.source} 中文字数`).toBeLessThanOrEqual(120);
      } else if (doc.lang === 'en') {
        const words = countWords(doc.text);
        expect(words, `${doc.source} 英文词数`).toBeGreaterThanOrEqual(40);
        expect(words, `${doc.source} 英文词数`).toBeLessThanOrEqual(120);
      } else {
        throw new Error(`文档 ${doc.source} 语言未知`);
      }
    }
  });

  it('每个 chunk 都等于「直接调用 web chunkText/chunkId」的结果', () => {
    for (const doc of dataset.documents) {
      const expected = chunkText(doc.text).map((chunk) => ({
        id: chunkId(doc.source, chunk.index, chunk.text),
        source: doc.source,
        chunkIndex: chunk.index,
        text: chunk.text,
      }));
      const actual = dataset.chunks
        .filter((chunk) => chunk.source === doc.source)
        .map(({ id, source, chunkIndex, text }) => ({ id, source, chunkIndex, text }));
      expect(actual, doc.source).toEqual(expected);
    }
  });

  it('chunk id 唯一且格式稳定（chunk_ + base36）', () => {
    const ids = dataset.chunks.map((chunk) => chunk.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^chunk_[0-9a-z]+$/);
  });

  it('每条查询：≥3 个相关 source、≥1 条 grade=3、qrels 指向真实 chunk', () => {
    const chunkKeys = new Set(dataset.chunks.map((chunk) => chunkKey(chunk.source, chunk.chunkIndex)));
    for (const query of dataset.queries) {
      const relSources = new Set(
        query.relevant.filter((entry) => entry.grade >= 1).map((entry) => entry.source),
      );
      expect(relSources.size, `${query.qid} 相关 source 数`).toBeGreaterThanOrEqual(3);
      expect(
        query.relevant.some((entry) => entry.grade === 3),
        `${query.qid} 缺少 grade=3`,
      ).toBe(true);
      for (const entry of query.relevant) {
        expect(Number.isInteger(entry.grade)).toBe(true);
        expect(entry.grade).toBeGreaterThanOrEqual(0);
        expect(entry.grade).toBeLessThanOrEqual(3);
        expect(chunkKeys.has(chunkKey(entry.source, entry.chunkIndex)), `${query.qid} → ${entry.source}`).toBe(true);
      }
      if (query.category === 'keyword') {
        expect(query.keyword, `${query.qid} keyword 必填`).toBeTruthy();
        const highGradeChunks = query.relevant
          .filter((entry) => entry.grade === 3)
          .map((entry) => dataset.chunks.find((chunk) => chunkKey(chunk.source, chunk.chunkIndex) === chunkKey(entry.source, entry.chunkIndex)));
        expect(highGradeChunks.some((chunk) => chunk?.text.toLowerCase().includes(query.keyword!.toLowerCase()))).toBe(true);
      }
    }
  });

  it('query 的 qid 唯一且三类前缀规范', () => {
    const qids = dataset.queries.map((query) => query.qid);
    expect(new Set(qids).size).toBe(qids.length);
    for (const query of dataset.queries) {
      expect(query.query.trim().length).toBeGreaterThan(0);
      expect(['sem-', 'kw-', 'pp-'].some((prefix) => query.qid.startsWith(prefix)), query.qid).toBe(true);
    }
  });
});

describe('data/perf 与 data/demo', () => {
  it('perf 语料：120 篇文档 = 120 chunks，10 条查询', async () => {
    const docs = await loadCorpusDocuments(path.join(PERF_DIR, 'corpus'));
    expect(docs.length).toBe(120);
    const chunks = docs.flatMap((doc) => chunkDocument(doc.source, doc.text));
    expect(chunks.length).toBe(120);
    for (const doc of docs) expect(chunkDocument(doc.source, doc.text).length, doc.source).toBe(1);
    const queries = (await readFile(path.join(PERF_DIR, 'queries.txt'), 'utf8'))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    expect(queries.length).toBe(10);
  });

  it('demo 文档：4 篇示例，每篇 1–2 chunk', async () => {
    const docs = await loadCorpusDocuments(DEMO_DIR);
    const demoDocs = docs.filter((doc) => doc.source !== 'README.md');
    expect(demoDocs.length).toBe(4);
    for (const doc of demoDocs) {
      const chunks = chunkDocument(doc.source, doc.text);
      expect(chunks.length, doc.source).toBeGreaterThanOrEqual(1);
      expect(chunks.length, doc.source).toBeLessThanOrEqual(2);
    }
  });
});

describe('JSONL 解析与结构校验', () => {
  it('parseJsonl 跳过空行、支持 BOM，报错带行号', () => {
    const rows = parseJsonl<{ a: number }>('\uFEFF{"a":1}\n\n  \n{"a":2}\n', 'x.jsonl');
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(() => parseJsonl('{"a":1}\nnot-json\n', 'x.jsonl')).toThrow(/x\.jsonl:2/);
  });

  it('normalizeEvalQueries 拒绝未知 category / 非法 grade / 空 relevant', () => {
    const base = { qid: 'q1', query: 'q', category: 'semantic', relevant: [] };
    expect(() => normalizeEvalQueries([{ ...base, category: 'typo' }])).toThrow(/category/);
    expect(() =>
      normalizeEvalQueries([
        { ...base, relevant: [{ source: 'zh-01.md', chunkIndex: 0, grade: 9 }] },
      ]),
    ).toThrow(/grade/);
    expect(() => normalizeEvalQueries([base])).toThrow(/relevant/);
  });

  it('loadEvalQueries 能读取真实 queries.jsonl', async () => {
    const queries = await loadEvalQueries(path.join(EVAL_DIR, 'queries.jsonl'));
    expect(queries.length).toBe(60);
  });
});

describe('validateEvalSet 的负向检测', () => {
  const chunks: CorpusChunk[] = [
    chunkDocument('zh-01.md', '这是一篇用于单元测试的中文文档，内容长度足够生成一个 chunk。')[0],
    chunkDocument('zh-02.md', '这是另一篇用于单元测试的中文文档，内容长度足够生成一个 chunk。')[0],
    chunkDocument('zh-03.md', '这是第三篇用于单元测试的中文文档，内容长度足够生成一个 chunk。')[0],
  ];

  function makeQuery(overrides: Partial<EvalQuery> = {}): EvalQuery {
    return {
      qid: 'unit-01',
      query: '测试查询',
      category: 'semantic',
      lang: 'zh',
      relevant: [
        { source: 'zh-01.md', chunkIndex: 0, grade: 3 },
        { source: 'zh-02.md', chunkIndex: 0, grade: 2 },
        { source: 'zh-03.md', chunkIndex: 0, grade: 1 },
      ],
      ...overrides,
    };
  }

  it('合法查询返回空问题列表', () => {
    expect(validateEvalSet([makeQuery()], chunks)).toEqual([]);
  });

  it('检测相关 source 不足、缺少 grade=3、chunk 不存在、重复标注', () => {
    const issues = validateEvalSet(
      [
        makeQuery({
          relevant: [
            { source: 'zh-01.md', chunkIndex: 0, grade: 2 },
            { source: 'zh-01.md', chunkIndex: 0, grade: 2 },
            { source: 'missing.md', chunkIndex: 0, grade: 3 },
          ],
        }),
      ],
      chunks,
    );
    const joined = issues.join('\n');
    expect(joined).toMatch(/重复标注/);
    expect(joined).toMatch(/不存在的 chunk/);
    expect(joined).toMatch(/相关 source 只有/);
    expect(joined).toMatch(/缺少 rel=3/);
  });

  it('检测 keyword 缺失或未出现在 grade=3 chunk 中', () => {
    const issues = validateEvalSet(
      [
        makeQuery({ category: 'keyword' }),
        makeQuery({ qid: 'unit-02', category: 'keyword', keyword: '不存在的关键词' }),
      ],
      chunks,
    );
    const joined = issues.join('\n');
    expect(joined).toMatch(/缺少 keyword/);
    expect(joined).toMatch(/未出现在任何 rel=3/);
  });
});
