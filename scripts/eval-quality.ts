/**
 * SeekVec 检索质量评测（Node CPU，Transformers.js）
 *
 * 目标：在 data/eval 评测集上，对同一模型比较 fp32 与 q8（可选 fp16）的检索质量，
 * 输出 Recall@1/3/5、nDCG@5/10、MRR，以及相对 fp32 基线的变化量和质量门判定。
 *
 * 评测链路（与浏览器应用保持同一口径）：
 *   1) 语料按浏览器默认参数分块（复用 web/src/inference/chunk.ts，见 scripts/lib/datasets.ts）；
 *   2) 用 Transformers.js 在 Node CPU 上对 chunk 与 query 做 embedding（pooling=mean, normalize=true）；
 *   3) 纯向量余弦排序（与 seekdb 向量检索的排序目标一致；不含索引近似误差与混合检索）；
 *   4) qrels 为 chunk 级 0-3 级标注，macro 平均跨查询汇总。
 *
 * 注意：本脚本测的是「量化对 embedding 质量的影响」，不是 seekdb 检索延迟，也不含混合检索；
 * 浏览器端到端主口径由 scripts/bench-browser.mjs 覆盖。
 *
 * 用法（仓库根目录）：
 *   npx tsx scripts/eval-quality.ts                     # 默认 2 模型 × fp32/q8/fp16
 *   npx tsx scripts/eval-quality.ts --validate-only     # 只校验 data/eval 数据
 *   npx tsx scripts/eval-quality.ts --out docs/benchmarks/eval-quality
 *   npx tsx scripts/eval-quality.ts --models text_zh --dtypes fp32,q8
 *
 * 环境变量：
 *   SEEKVEC_LOCAL_MODELS=1        只用本地模型（web/public/models 或 SEEKVEC_LOCAL_MODEL_PATH），不联网
 *   SEEKVEC_LOCAL_MODELS=0        只用远程下载（HF_ENDPOINT / 本地缓存）
 *   SEEKVEC_LOCAL_MODEL_PATH      本地模型根目录（默认 <repo>/web/public/models）
 *   SEEKVEC_CACHE_DIR             远程模型缓存目录（默认 <repo>/scripts/.cache）
 *   HF_ENDPOINT                   下载镜像，如 https://hf-mirror.com/
 *
 * 退出码：0 = 数据合法且质量门全部通过（或没有可比较项）；1 = 数据非法 / 质量门失败 / 无可评测项。
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, env } from '@huggingface/transformers';
import {
  BROWSER_CHUNK_OPTIONS,
  chunkKey,
  loadEvalDataset,
  summarizeEvalSet,
  type CorpusChunk,
  type EvalCategory,
  type EvalLang,
  type EvalQuery,
  type EvalSetSummary,
} from './lib/datasets';
import { mrr, ndcgAtK, rankIdsByScore, recallAtK } from './lib/evalMetrics';
import { mean } from './lib/stats';

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_VERSION = 1;

/** 质量门（实施契约 §8）：Recall@5 降幅 ≤ 2pp，nDCG@10 降幅 ≤ 0.02（绝对差） */
const GATE = { recallAt5MaxDrop: 0.02, ndcgAt10MaxDrop: 0.02 } as const;

const K_RECALL = [1, 3, 5] as const;
const K_NDCG = [5, 10] as const;
const TOP_N_FOR_AUDIT = 10;

type Dtype = 'fp32' | 'fp16' | 'q8';
const ALL_DTYPES: readonly Dtype[] = ['fp32', 'q8', 'fp16'];

/** 契约 §6 内置 revision（models.lock.json 缺失时的回退） */
const BUILTIN_MODELS: readonly LockModel[] = [
  {
    key: 'text_zh',
    id: 'Xenova/bge-small-zh-v1.5',
    revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781',
    dim: 512,
    files: [],
  },
  {
    key: 'text_en',
    id: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    dim: 384,
    files: [],
  },
];

const BUILTIN_DTYPE_FILES: Readonly<Record<Dtype, string>> = {
  q8: 'onnx/model_quantized.onnx',
  fp16: 'onnx/model_fp16.onnx',
  fp32: 'onnx/model.onnx',
};

interface LockFileEntry {
  path: string;
  size: number;
  sha256: string;
}

interface LockModel {
  key: string;
  id: string;
  revision?: string;
  dim?: number;
  files: LockFileEntry[];
}

interface ModelsLock {
  dtypeToFile?: Partial<Record<Dtype, string>>;
  models: LockModel[];
}

interface CliOptions {
  dataDir: string;
  outDir: string;
  models: string[];
  dtypes: Dtype[];
  batch: number;
  validateOnly: boolean;
}

interface MetricSet {
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  ndcgAt5: number;
  ndcgAt10: number;
  mrr: number;
}

interface QueryMetrics extends MetricSet {
  qid: string;
  category: EvalCategory;
  lang: EvalLang;
}

interface DtypeFileMeta {
  relPath: string;
  absPath: string;
  exists: boolean;
  bytes: number | null;
  sha256: string | null;
  sha256FromLock: string | null;
  sha256Match: boolean | null;
}

interface DtypeRun {
  dtype: Dtype;
  status: 'ok' | 'skipped';
  reason: string | null;
  onnx: DtypeFileMeta;
  embedMs: { corpus: number; queries: number } | null;
  metrics: MetricSet | null;
  byCategory: Record<EvalCategory, { n: number; metrics: MetricSet }> | null;
  byLang: Record<EvalLang, { n: number; metrics: MetricSet }> | null;
  perQuery: QueryMetrics[] | null;
  topN: Array<{ qid: string; ranked: Array<{ id: string; source: string; chunkIndex: number; score: number }> }> | null;
  error: string | null;
}

interface ModelRun {
  key: string;
  id: string;
  revision: string;
  dim: number | null;
  source: 'models.lock.json' | 'builtin';
  dtypes: DtypeRun[];
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[eval-quality] ${message}`);
}

function warn(message: string): void {
  console.warn(`[eval-quality] WARN ${message}`);
}

function fail(message: string): never {
  console.error(`[eval-quality] ERROR ${message}`);
  process.exit(1);
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundMetrics(metrics: MetricSet): MetricSet {
  return {
    recallAt1: round(metrics.recallAt1),
    recallAt3: round(metrics.recallAt3),
    recallAt5: round(metrics.recallAt5),
    ndcgAt5: round(metrics.ndcgAt5),
    ndcgAt10: round(metrics.ndcgAt10),
    mrr: round(metrics.mrr),
  };
}

function fmt(value: number | null, digits = 4): string {
  return value === null || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits);
}

function fmtDeltaPp(delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return 'n/a';
  const pp = delta * 100;
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(2)}pp`;
}

function withTrailingSep(dir: string): string {
  return dir.endsWith(path.sep) || dir.endsWith('/') ? dir : `${dir}${path.sep}`;
}

async function fileSha256(file: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 读取已安装包版本号（读 package.json；失败返回 unknown，不影响评测） */
async function readPackageVersion(pkg: string): Promise<string> {
  try {
    const content = await readFile(path.join(REPO_ROOT, 'scripts', 'node_modules', pkg, 'package.json'), 'utf8');
    const parsed = JSON.parse(content) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `SeekVec 检索质量评测（Node CPU）

用法：npx tsx scripts/eval-quality.ts [选项]

选项：
  --data <dir>       评测集目录（默认 <repo>/data/eval）
  --out <dir>        输出目录（默认 <repo>/scripts/.cache/eval-quality；写入 raw.json + summary.md）
  --models <list>    逗号分隔的模型 key（默认 text_zh,text_en）
  --dtypes <list>    逗号分隔的精度（默认 fp32,q8,fp16；fp16 在 CPU 上不可用时自动跳过）
  --batch <n>        embedding 批大小（默认 16）
  --validate-only    只校验数据集，不加载模型
  -h, --help         显示帮助

环境变量：SEEKVEC_LOCAL_MODELS=1|0、SEEKVEC_LOCAL_MODEL_PATH、SEEKVEC_CACHE_DIR、HF_ENDPOINT`;

function parseCli(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    dataDir: path.join(REPO_ROOT, 'data', 'eval'),
    outDir: path.join(REPO_ROOT, 'scripts', '.cache', 'eval-quality'),
    models: BUILTIN_MODELS.map((model) => model.key),
    dtypes: [...ALL_DTYPES],
    batch: 16,
    validateOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) fail(`参数 ${arg} 缺少取值`);
      return value;
    };
    switch (arg) {
      case '--data':
        options.dataDir = path.resolve(process.cwd(), next());
        break;
      case '--out':
        options.outDir = path.resolve(process.cwd(), next());
        break;
      case '--models':
        options.models = next()
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        break;
      case '--dtypes': {
        const raw = next()
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        const invalid = raw.filter((item) => !ALL_DTYPES.includes(item as Dtype));
        if (invalid.length > 0) fail(`未知 dtype：${invalid.join(', ')}（可选 ${ALL_DTYPES.join('/')}）`);
        options.dtypes = raw as Dtype[];
        break;
      }
      case '--batch': {
        const batch = Number.parseInt(next(), 10);
        if (!Number.isInteger(batch) || batch < 1 || batch > 256) fail('--batch 必须是 1-256 的整数');
        options.batch = batch;
        break;
      }
      case '--validate-only':
        options.validateOnly = true;
        break;
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        fail(`未知参数：${arg}\n\n${USAGE}`);
    }
  }
  if (options.models.length === 0) fail('--models 不能为空');
  if (options.dtypes.length === 0) fail('--dtypes 不能为空');
  return options;
}

// ---------------------------------------------------------------------------
// models.lock.json / 本地模型目录
// ---------------------------------------------------------------------------

async function loadModelsLock(): Promise<ModelsLock | null> {
  const lockFile = path.join(REPO_ROOT, 'models.lock.json');
  if (!existsSync(lockFile)) {
    warn('未找到 models.lock.json，revision/体积回退到内置常量（可运行 scripts/fetch-models.mjs 生成）');
    return null;
  }
  try {
    const parsed = JSON.parse(await readFile(lockFile, 'utf8')) as ModelsLock;
    if (!Array.isArray(parsed.models)) throw new Error('缺少 models[] 数组');
    return parsed;
  } catch (error) {
    warn(`models.lock.json 解析失败，回退到内置常量：${toErrorText(error)}`);
    return null;
  }
}

function resolveModels(lock: ModelsLock | null, requested: readonly string[]): LockModel[] {
  const fromLock = new Map((lock?.models ?? []).map((model) => [model.key, model]));
  return requested.map((key) => {
    const locked = fromLock.get(key);
    if (locked) return locked;
    const builtin = BUILTIN_MODELS.find((model) => model.key === key);
    if (!builtin) fail(`未知模型 key：${key}（可选 ${BUILTIN_MODELS.map((model) => model.key).join('/')}）`);
    return builtin;
  });
}

function resolveLocalModelsRoot(): string {
  return process.env.SEEKVEC_LOCAL_MODEL_PATH ?? path.join(REPO_ROOT, 'web', 'public', 'models');
}

/** 本地模型模式：明确指定时按指定；auto 时目录存在则本地优先（避免评测必须联网） */
function resolveLocalMode(localRoot: string): { local: boolean; reason: string } {
  const flag = process.env.SEEKVEC_LOCAL_MODELS;
  if (flag === '1') return { local: true, reason: 'SEEKVEC_LOCAL_MODELS=1（强制本地）' };
  if (flag === '0') return { local: false, reason: 'SEEKVEC_LOCAL_MODELS=0（强制远程/缓存）' };
  const exists = existsSync(localRoot);
  return {
    local: exists,
    reason: exists ? `未指定 SEEKVEC_LOCAL_MODELS，检测到本地模型目录：${localRoot}` : '未指定 SEEKVEC_LOCAL_MODELS 且本地目录不存在，使用远程/缓存',
  };
}

function configureTransformersEnv(local: boolean, localRoot: string): { cacheDir: string; remoteHost: string | null } {
  env.allowLocalModels = local;
  env.allowRemoteModels = !local;
  if (local) env.localModelPath = withTrailingSep(localRoot);
  const cacheDir = process.env.SEEKVEC_CACHE_DIR ?? path.join(REPO_ROOT, 'scripts', '.cache');
  env.cacheDir = cacheDir;
  env.useBrowserCache = false;
  const endpoint = process.env.HF_ENDPOINT;
  const remoteHost = endpoint ? withTrailingSep(endpoint) : null;
  if (remoteHost) env.remoteHost = remoteHost;
  return { cacheDir, remoteHost };
}

function dtypeToFile(dtype: Dtype, lock: ModelsLock | null): string {
  return lock?.dtypeToFile?.[dtype] ?? BUILTIN_DTYPE_FILES[dtype];
}

async function inspectOnnxFile(
  localRoot: string,
  model: LockModel,
  dtype: Dtype,
  lock: ModelsLock | null,
): Promise<DtypeFileMeta> {
  const relPath = dtypeToFile(dtype, lock);
  const absPath = path.join(localRoot, model.id, relPath);
  const locked = model.files.find((file) => file.path === relPath);
  if (!existsSync(absPath)) {
    return {
      relPath,
      absPath,
      exists: false,
      bytes: null,
      sha256: null,
      sha256FromLock: locked?.sha256 ?? null,
      sha256Match: null,
    };
  }
  const bytes = (await stat(absPath)).size;
  const sha256 = await fileSha256(absPath);
  return {
    relPath,
    absPath,
    exists: true,
    bytes,
    sha256,
    sha256FromLock: locked?.sha256 ?? null,
    sha256Match: locked ? locked.sha256 === sha256 : null,
  };
}

// ---------------------------------------------------------------------------
// embedding 与指标
// ---------------------------------------------------------------------------

type Embedder = (texts: string[], options: { pooling: 'mean'; normalize: boolean }) => Promise<unknown>;

interface EmbedResult {
  vectors: number[][];
  ms: number;
}

function tensorToList(output: unknown): number[][] {
  const tensor = output as { tolist?: () => unknown };
  if (typeof tensor.tolist !== 'function') throw new Error('embedding 输出不是 Tensor（缺少 tolist()）');
  const list = tensor.tolist();
  if (!Array.isArray(list)) throw new Error('embedding 输出格式异常');
  return list as number[][];
}

async function embedTexts(
  embedder: Embedder,
  texts: readonly string[],
  batch: number,
  label: string,
): Promise<EmbedResult> {
  const vectors: number[][] = [];
  const started = performance.now();
  for (let offset = 0; offset < texts.length; offset += batch) {
    const slice = texts.slice(offset, offset + batch);
    const output = await embedder(slice as string[], { pooling: 'mean', normalize: true });
    const rows = tensorToList(output);
    if (rows.length !== slice.length) {
      throw new Error(`${label}: 返回 ${rows.length} 条向量，期望 ${slice.length} 条`);
    }
    vectors.push(...rows);
    log(`  ${label} ${Math.min(offset + batch, texts.length)}/${texts.length}`);
  }
  return { vectors, ms: performance.now() - started };
}

function evaluateQuery(
  query: EvalQuery,
  queryVector: readonly number[],
  chunkVectors: readonly number[][],
  chunks: readonly CorpusChunk[],
  chunkIdByKey: ReadonlyMap<string, string>,
): { metrics: QueryMetrics; ranked: Array<{ id: string; source: string; chunkIndex: number; score: number }> } {
  const scores = new Map<string, number>();
  for (let i = 0; i < chunks.length; i++) {
    scores.set(chunks[i].id, cosineSimilarity(queryVector, chunkVectors[i]));
  }
  const rankedIds = rankIdsByScore(scores);

  const relevantSet = new Set<string>();
  const gradedMap = new Map<string, number>();
  for (const entry of query.relevant) {
    const key = chunkKey(entry.source, entry.chunkIndex);
    const id = chunkIdByKey.get(key);
    if (!id) throw new Error(`查询 ${query.qid}: qrels 指向不存在的 chunk ${key}`);
    if (entry.grade >= 1) relevantSet.add(id);
    if (entry.grade > 0) gradedMap.set(id, entry.grade);
  }

  const metrics: QueryMetrics = {
    qid: query.qid,
    category: query.category,
    lang: query.lang,
    recallAt1: recallAtK(rankedIds, relevantSet, K_RECALL[0]),
    recallAt3: recallAtK(rankedIds, relevantSet, K_RECALL[1]),
    recallAt5: recallAtK(rankedIds, relevantSet, K_RECALL[2]),
    ndcgAt5: ndcgAtK(rankedIds, gradedMap, K_NDCG[0]),
    ndcgAt10: ndcgAtK(rankedIds, gradedMap, K_NDCG[1]),
    mrr: mrr(rankedIds, relevantSet),
  };

  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const ranked = rankedIds.slice(0, TOP_N_FOR_AUDIT).map((id) => {
    const chunk = byId.get(id);
    if (!chunk) throw new Error(`内部错误：排序结果包含未知 chunk id ${id}`);
    return { id, source: chunk.source, chunkIndex: chunk.chunkIndex, score: round(scores.get(id) ?? 0, 6) };
  });
  return { metrics, ranked };
}

function aggregateMetrics(rows: readonly QueryMetrics[]): MetricSet {
  if (rows.length === 0) {
    return { recallAt1: 0, recallAt3: 0, recallAt5: 0, ndcgAt5: 0, ndcgAt10: 0, mrr: 0 };
  }
  return {
    recallAt1: mean(rows.map((row) => row.recallAt1)),
    recallAt3: mean(rows.map((row) => row.recallAt3)),
    recallAt5: mean(rows.map((row) => row.recallAt5)),
    ndcgAt5: mean(rows.map((row) => row.ndcgAt5)),
    ndcgAt10: mean(rows.map((row) => row.ndcgAt10)),
    mrr: mean(rows.map((row) => row.mrr)),
  };
}

function groupBy<T extends string>(
  rows: readonly QueryMetrics[],
  keyOf: (row: QueryMetrics) => T,
): Record<T, { n: number; metrics: MetricSet }> {
  const groups = new Map<T, QueryMetrics[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  const out = {} as Record<T, { n: number; metrics: MetricSet }>;
  for (const [key, bucket] of groups) out[key] = { n: bucket.length, metrics: roundMetrics(aggregateMetrics(bucket)) };
  return out;
}

// ---------------------------------------------------------------------------
// Markdown / JSON 输出
// ---------------------------------------------------------------------------

function modelSizeTable(models: readonly ModelRun[]): string {
  const lines = [
    '| 模型 | dtype | onnx 文件 | 体积 (MB) | sha256（前 16 位） | 与 models.lock 一致 |',
    '|---|---|---|---|---|---|',
  ];
  for (const model of models) {
    for (const run of model.dtypes) {
      const meta = run.onnx;
      const size = meta.bytes === null ? '缺失' : (meta.bytes / (1024 * 1024)).toFixed(2);
      const sha = meta.sha256 ? meta.sha256.slice(0, 16) : 'n/a';
      const match = meta.sha256Match === null ? '—' : meta.sha256Match ? '✅' : '❌ 不一致';
      lines.push(`| ${model.key} | ${run.dtype} | ${meta.relPath} | ${size} | ${sha} | ${match} |`);
    }
  }
  return lines.join('\n');
}

function compressionLines(model: ModelRun): string[] {
  const byDtype = new Map(model.dtypes.map((run) => [run.dtype, run]));
  const fp32 = byDtype.get('fp32')?.onnx.bytes ?? null;
  const q8 = byDtype.get('q8')?.onnx.bytes ?? null;
  const fp16 = byDtype.get('fp16')?.onnx.bytes ?? null;
  const lines: string[] = [];
  if (fp32 !== null && q8 !== null) {
    lines.push(
      `- \`${model.key}\` onnx 体积：fp32 ${(fp32 / (1024 * 1024)).toFixed(2)} MB → q8 ${(q8 / (1024 * 1024)).toFixed(2)} MB，**压缩比 fp32/q8 = ${(fp32 / q8).toFixed(2)}×**`,
    );
  }
  if (fp32 !== null && fp16 !== null) {
    lines.push(
      `- \`${model.key}\` onnx 体积：fp32 ${(fp32 / (1024 * 1024)).toFixed(2)} MB → fp16 ${(fp16 / (1024 * 1024)).toFixed(2)} MB，**压缩比 fp32/fp16 = ${(fp32 / fp16).toFixed(2)}×**`,
    );
  }
  return lines;
}

interface GateRow {
  model: string;
  dtype: Dtype;
  deltaRecallAt5: number | null;
  deltaNdcgAt10: number | null;
  pass: boolean | null;
}

function gateRows(models: readonly ModelRun[]): GateRow[] {
  const rows: GateRow[] = [];
  for (const model of models) {
    const baseline = model.dtypes.find((run) => run.dtype === 'fp32' && run.status === 'ok');
    for (const run of model.dtypes) {
      if (run.dtype === 'fp32' || run.status !== 'ok') continue;
      if (!baseline?.metrics || !run.metrics) {
        rows.push({ model: model.key, dtype: run.dtype, deltaRecallAt5: null, deltaNdcgAt10: null, pass: null });
        continue;
      }
      const deltaRecallAt5 = run.metrics.recallAt5 - baseline.metrics.recallAt5;
      const deltaNdcgAt10 = run.metrics.ndcgAt10 - baseline.metrics.ndcgAt10;
      rows.push({
        model: model.key,
        dtype: run.dtype,
        deltaRecallAt5,
        deltaNdcgAt10,
        pass: deltaRecallAt5 >= -GATE.recallAt5MaxDrop && deltaNdcgAt10 >= -GATE.ndcgAt10MaxDrop,
      });
    }
  }
  return rows;
}

function buildMarkdown(input: {
  runId: string;
  generatedAt: string;
  summary: EvalSetSummary;
  environment: Record<string, unknown>;
  models: readonly ModelRun[];
  gates: readonly GateRow[];
  skipped: readonly string[];
}): string {
  const { summary, environment, models, gates } = input;
  const lines: string[] = [];
  lines.push('# SeekVec 检索质量评测（Node CPU · fp32 vs q8/fp16）');
  lines.push('');
  lines.push(`- runId：\`${input.runId}\``);
  lines.push(`- 生成时间：${input.generatedAt}`);
  lines.push(
    `- 评测集：\`data/eval\` · ${summary.documents} 篇文档（zh ${summary.documentsByLang.zh} / en ${summary.documentsByLang.en}）· ${summary.chunks} chunks · ${summary.queries} 条查询（semantic/keyword/paraphrase = ${summary.queriesByCategory.semantic}/${summary.queriesByCategory.keyword}/${summary.queriesByCategory.paraphrase}）`,
  );
  lines.push(
    `- 协议：chunk 级 qrels（0-3 级）· 相关性阈值 rel ≥ 1 · nDCG gain = 2^rel − 1 · macro 平均 · 平局按 chunk id 升序`,
  );
  lines.push(`- 分块：浏览器默认参数 maxLength=${BROWSER_CHUNK_OPTIONS.maxLength} / overlap=${BROWSER_CHUNK_OPTIONS.overlap} / minLength=${BROWSER_CHUNK_OPTIONS.minLength}（复用 web/src/inference/chunk.ts）`);
  lines.push('');

  lines.push('## 环境');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  for (const [key, value] of Object.entries(environment)) {
    lines.push(`| ${key} | ${String(value)} |`);
  }
  lines.push('');

  lines.push('## 模型文件与体积');
  lines.push('');
  lines.push(modelSizeTable(models));
  lines.push('');
  for (const model of models) {
    const comp = compressionLines(model);
    if (comp.length > 0) {
      lines.push(`**${model.key}**（revision \`${model.revision}\`）`);
      lines.push(...comp);
      lines.push('');
    }
  }

  lines.push('## 检索质量');
  lines.push('');
  lines.push('| 模型 | dtype | Recall@1 | Recall@3 | Recall@5 | nDCG@5 | nDCG@10 | MRR | ΔRecall@5 | ΔnDCG@10 | 质量门 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const model of models) {
    for (const run of model.dtypes) {
      if (run.status !== 'ok' || !run.metrics) {
        lines.push(`| ${model.key} | ${run.dtype} | — | — | — | — | — | — | — | — | 跳过 |`);
        continue;
      }
      const gate = gates.find((row) => row.model === model.key && row.dtype === run.dtype);
      const gateText =
        run.dtype === 'fp32'
          ? '基线'
          : gate?.pass === null || gate === undefined
            ? '无基线'
            : gate.pass
              ? '✅ PASS'
              : '❌ FAIL';
      lines.push(
        `| ${model.key} | ${run.dtype} | ${fmt(run.metrics.recallAt1)} | ${fmt(run.metrics.recallAt3)} | ${fmt(run.metrics.recallAt5)} | ${fmt(run.metrics.ndcgAt5)} | ${fmt(run.metrics.ndcgAt10)} | ${fmt(run.metrics.mrr)} | ${fmtDeltaPp(gate?.deltaRecallAt5 ?? null)} | ${fmtDeltaPp(gate?.deltaNdcgAt10 ?? null)} | ${gateText} |`,
      );
    }
  }
  lines.push('');
  lines.push(`质量门（实施契约 §8）：Recall@5 降幅 ≤ ${(GATE.recallAt5MaxDrop * 100).toFixed(0)}pp，nDCG@10 降幅 ≤ ${GATE.ndcgAt10MaxDrop.toFixed(2)}（绝对差）。`);
  lines.push('');

  lines.push('## 分类别结果');
  lines.push('');
  lines.push('| 模型 | dtype | 类别 | n | Recall@5 | nDCG@10 | MRR |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const model of models) {
    for (const run of model.dtypes) {
      if (run.status !== 'ok' || !run.byCategory) continue;
      for (const category of ['semantic', 'keyword', 'paraphrase'] as const) {
        const group = run.byCategory[category];
        if (!group) continue;
        lines.push(
          `| ${model.key} | ${run.dtype} | ${category} | ${group.n} | ${fmt(group.metrics.recallAt5)} | ${fmt(group.metrics.ndcgAt10)} | ${fmt(group.metrics.mrr)} |`,
        );
      }
    }
  }
  lines.push('');

  const langRows: Array<{ model: string; dtype: Dtype; lang: EvalLang; n: number; recallAt5: number; ndcgAt10: number }> = [];
  for (const model of models) {
    for (const run of model.dtypes) {
      if (run.status !== 'ok' || !run.byLang) continue;
      for (const lang of ['zh', 'en'] as const) {
        const group = run.byLang[lang];
        if (!group) continue;
        langRows.push({
          model: model.key,
          dtype: run.dtype,
          lang,
          n: group.n,
          recallAt5: group.metrics.recallAt5,
          ndcgAt10: group.metrics.ndcgAt10,
        });
      }
    }
  }
  if (langRows.length > 0) {
    lines.push('## 分语言结果');
    lines.push('');
    lines.push('| 模型 | dtype | 语言 | n | Recall@5 | nDCG@10 |');
    lines.push('|---|---|---|---|---|---|');
    for (const row of langRows) {
      lines.push(`| ${row.model} | ${row.dtype} | ${row.lang} | ${row.n} | ${fmt(row.recallAt5)} | ${fmt(row.ndcgAt10)} |`);
    }
    lines.push('');
  }

  const allPass = gates.every((row) => row.pass !== false);
  lines.push('## 结论');
  lines.push('');
  const comparableCount = gates.filter((row) => row.pass !== null).length;
  if (comparableCount === 0) {
    lines.push('- 没有可比较的量化结果（缺少 fp32 基线或全部跳过），请检查模型文件与 `--dtypes`。');
  } else if (allPass) {
    lines.push(`- ✅ 质量门全部通过：${comparableCount} 组量化对比的 Recall@5 / nDCG@10 降幅均在阈值内。`);
  } else {
    const failed = gates.filter((row) => row.pass === false);
    lines.push(`- ❌ 质量门未通过：${failed.map((row) => `${row.model}/${row.dtype}`).join('、')}，需分析原因并在技术说明中披露。`);
  }
  if (input.skipped.length > 0) {
    lines.push(`- 跳过项：${input.skipped.join('；')}`);
  }
  lines.push('');
  lines.push('> 本评测为纯向量余弦排序（Node CPU），不含 seekdb 索引近似误差与混合检索；浏览器端到端主口径见 `docs/benchmarks/`。');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const runId = `eval-quality-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const generatedAt = new Date().toISOString();
  const command = `npx tsx scripts/eval-quality.ts ${process.argv.slice(2).join(' ')}`.trim();

  log(`评测集：${options.dataDir}`);
  const dataset = await loadEvalDataset(options.dataDir, { validate: true });
  const summary = summarizeEvalSet(dataset.documents, dataset.chunks, dataset.queries);
  log(
    `数据：${summary.documents} 篇文档（zh ${summary.documentsByLang.zh} / en ${summary.documentsByLang.en}）· ${summary.chunks} chunks · ${summary.queries} 条查询 · ${summary.relevantPairs} 条 chunk 级标注`,
  );

  if (dataset.issues.length > 0) {
    console.error(`[eval-quality] 数据校验失败（${dataset.issues.length} 项）：`);
    for (const issue of dataset.issues) console.error(`  - ${issue}`);
    process.exit(1);
  }
  log('数据校验通过（qrels 与浏览器 chunk 映射一致）');

  if (options.validateOnly) {
    console.log('\n[validate-only] 数据集合法，未加载模型。');
    return;
  }

  const lock = await loadModelsLock();
  const models = resolveModels(lock, options.models);
  const localRoot = resolveLocalModelsRoot();
  const localMode = resolveLocalMode(localRoot);
  const { cacheDir, remoteHost } = configureTransformersEnv(localMode.local, localRoot);
  log(`模型来源：${localMode.reason}`);
  log(`本地模型目录：${path.relative(REPO_ROOT, localRoot) || localRoot}`);
  log(`缓存目录：${cacheDir}${remoteHost ? ` · 远程端点：${remoteHost}` : ''}`);

  const chunkTexts = dataset.chunks.map((chunk) => chunk.text);
  const queryTexts = dataset.queries.map((query) => query.query);
  const chunkIdByKey = new Map(dataset.chunks.map((chunk) => [chunkKey(chunk.source, chunk.chunkIndex), chunk.id]));

  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: (os.cpus()[0]?.model ?? 'unknown').trim(),
    cpuCount: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / (1024 * 1024)),
    device: 'cpu',
    runtime: '@huggingface/transformers',
    runtimeVersion: await readPackageVersion('@huggingface/transformers'),
    onnxruntimeVersion: await readPackageVersion('onnxruntime-node'),
    transformersBackend: 'onnxruntime-node (CPU EP)',
    modelSourceMode: localMode.local ? 'local' : 'remote-or-cache',
    hfEndpoint: remoteHost ?? 'default(huggingface.co)',
  };

  const skipped: string[] = [];
  const modelRuns: ModelRun[] = [];

  for (const model of models) {
    const revision = model.revision ?? 'unknown';
    log(`\n=== 模型 ${model.key}（${model.id} · revision ${revision}）===`);
    const modelRun: ModelRun = {
      key: model.key,
      id: model.id,
      revision,
      dim: model.dim ?? null,
      source: lock?.models.some((item) => item.key === model.key) ? 'models.lock.json' : 'builtin',
      dtypes: [],
    };

    const dtypeRuns: DtypeRun[] = [];
    // fp32 基线优先；其余按用户给定顺序
    const orderedDtypes = [...options.dtypes].sort((a, b) => {
      const rank = (dtype: Dtype): number => (dtype === 'fp32' ? 0 : dtype === 'q8' ? 1 : 2);
      return rank(a) - rank(b);
    });

    for (const dtype of orderedDtypes) {
      const onnx = await inspectOnnxFile(localRoot, model, dtype, lock);
      if (!onnx.exists) {
        const hint = localMode.local
          ? `请运行 \`node scripts/fetch-models.mjs --dtype ${dtype}\` 或检查 SEEKVEC_LOCAL_MODEL_PATH`
          : '本地文件不存在，若不允许联网请先获取模型';
        const message = `缺少模型文件 ${onnx.relPath}：${hint}`;
        warn(`${model.key}/${dtype}: ${message}`);
        skipped.push(`${model.key}/${dtype}（缺少 onnx 文件）`);
        dtypeRuns.push({
          dtype,
          status: 'skipped',
          reason: message,
          onnx,
          embedMs: null,
          metrics: null,
          byCategory: null,
          byLang: null,
          perQuery: null,
          topN: null,
          error: null,
        });
        continue;
      }
      if (onnx.sha256Match === false) {
        warn(`${model.key}/${dtype}: onnx sha256 与 models.lock.json 不一致（文件可能被替换或损坏）`);
      }

      log(`[${model.key}/${dtype}] 加载模型 ${path.basename(onnx.absPath)}（${(onnx.bytes! / (1024 * 1024)).toFixed(2)} MB）...`);
      let embedder: Embedder;
      try {
        const extractor = await pipeline('feature-extraction', model.id, { device: 'cpu', dtype });
        embedder = extractor as unknown as Embedder;
      } catch (error) {
        const message = `模型加载失败：${toErrorText(error)}`;
        warn(`${model.key}/${dtype}: ${message}`);
        skipped.push(`${model.key}/${dtype}（加载失败）`);
        dtypeRuns.push({
          dtype,
          status: 'skipped',
          reason: message,
          onnx,
          embedMs: null,
          metrics: null,
          byCategory: null,
          byLang: null,
          perQuery: null,
          topN: null,
          error: message,
        });
        continue;
      }

      try {
        const corpusEmbed = await embedTexts(embedder, chunkTexts, options.batch, `corpus(${chunkTexts.length} chunks)`);
        const queryEmbed = await embedTexts(embedder, queryTexts, options.batch, `queries(${queryTexts.length})`);
        if (corpusEmbed.vectors.length > 0) {
          log(
            `[${model.key}/${dtype}] 向量维度 ${corpusEmbed.vectors[0].length} · corpus ${(corpusEmbed.ms / 1000).toFixed(1)}s · queries ${(queryEmbed.ms / 1000).toFixed(1)}s`,
          );
        }

        const perQuery: QueryMetrics[] = [];
        const topN: DtypeRun['topN'] = [];
        for (let i = 0; i < dataset.queries.length; i++) {
          const evaluated = evaluateQuery(
            dataset.queries[i],
            queryEmbed.vectors[i],
            corpusEmbed.vectors,
            dataset.chunks,
            chunkIdByKey,
          );
          perQuery.push(evaluated.metrics);
          topN.push({ qid: dataset.queries[i].qid, ranked: evaluated.ranked });
        }
        const metrics = roundMetrics(aggregateMetrics(perQuery));
        dtypeRuns.push({
          dtype,
          status: 'ok',
          reason: null,
          onnx,
          embedMs: { corpus: round(corpusEmbed.ms, 1), queries: round(queryEmbed.ms, 1) },
          metrics,
          byCategory: groupBy(perQuery, (row) => row.category),
          byLang: groupBy(perQuery, (row) => row.lang),
          perQuery: perQuery.map((row) => ({ ...row, recallAt1: round(row.recallAt1), recallAt3: round(row.recallAt3), recallAt5: round(row.recallAt5), ndcgAt5: round(row.ndcgAt5), ndcgAt10: round(row.ndcgAt10), mrr: round(row.mrr) })),
          topN,
          error: null,
        });
        log(
          `[${model.key}/${dtype}] R@1=${fmt(metrics.recallAt1)} R@3=${fmt(metrics.recallAt3)} R@5=${fmt(metrics.recallAt5)} nDCG@5=${fmt(metrics.ndcgAt5)} nDCG@10=${fmt(metrics.ndcgAt10)} MRR=${fmt(metrics.mrr)}`,
        );
      } catch (error) {
        const message = toErrorText(error);
        warn(`${model.key}/${dtype}: 推理/评测失败：${message}`);
        skipped.push(`${model.key}/${dtype}（推理失败：${message}）`);
        dtypeRuns.push({
          dtype,
          status: 'skipped',
          reason: message,
          onnx,
          embedMs: null,
          metrics: null,
          byCategory: null,
          byLang: null,
          perQuery: null,
          topN: null,
          error: message,
        });
      } finally {
        const disposable = embedder as unknown as { dispose?: () => Promise<void> };
        if (typeof disposable.dispose === 'function') {
          try {
            await disposable.dispose();
          } catch {
            // 释放失败不影响结果
          }
        }
      }
    }

    modelRun.dtypes = dtypeRuns;
    modelRuns.push(modelRun);
  }

  const gates = gateRows(modelRuns);
  const evaluated = modelRuns.filter((model) => model.dtypes.some((run) => run.status === 'ok'));
  const markdown = buildMarkdown({ runId, generatedAt, summary, environment, models: modelRuns, gates, skipped });

  const gateFailed = gates.some((row) => row.pass === false);
  const gatePassedCount = gates.filter((row) => row.pass === true).length;
  const overallPass = !gateFailed && gatePassedCount > 0;

  const raw = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    generatedAt,
    command,
    script: 'scripts/eval-quality.ts',
    data: {
      dataDir: path.relative(REPO_ROOT, options.dataDir) || options.dataDir,
      summary,
      documents: dataset.documents.map((doc) => ({ source: doc.source, lang: doc.lang, chars: doc.text.length })),
      chunks: dataset.chunks.length,
      queries: dataset.queries.length,
    },
    environment,
    protocol: {
      task: 'vector retrieval quality（纯向量余弦排序，Node CPU）',
      dataset: 'data/eval（chunk 级 qrels，0-3 级）',
      relevanceThreshold: 1,
      gain: '2^rel - 1',
      discount: 'log2(rank + 1)',
      aggregation: 'macro average（先查询级，再跨查询平均）',
      tieBreak: 'score desc, chunk id asc',
      topNForAudit: TOP_N_FOR_AUDIT,
      chunker: { ...BROWSER_CHUNK_OPTIONS, implementation: 'web/src/inference/chunk.ts chunkText' },
      chunkId: 'web/src/utils/id.ts chunkId（FNV-1a32，source + chunkIndex + text）',
      recallK: [...K_RECALL],
      ndcgK: [...K_NDCG],
      gate: { recallAt5MaxDropPp: GATE.recallAt5MaxDrop * 100, ndcgAt10MaxDrop: GATE.ndcgAt10MaxDrop },
      note: '排序为纯向量余弦，不含 seekdb 索引近似误差与混合检索；浏览器端到端主口径见 scripts/bench-browser.mjs',
    },
    models: modelRuns.map((model) => ({
      key: model.key,
      id: model.id,
      revision: model.revision,
      revisionSource: model.source,
      dim: model.dim,
      dtypes: model.dtypes.map((run) => ({
        dtype: run.dtype,
        status: run.status,
        reason: run.reason,
        onnx: {
          path: run.onnx.relPath,
          bytes: run.onnx.bytes,
          sha256: run.onnx.sha256,
          sha256FromLock: run.onnx.sha256FromLock,
          sha256Match: run.onnx.sha256Match,
        },
        embedMs: run.embedMs,
        metrics: run.metrics,
        byCategory: run.byCategory,
        byLang: run.byLang,
        perQuery: run.perQuery,
        topN: run.topN,
      })),
    })),
    gate: {
      thresholds: { recallAt5MaxDrop: GATE.recallAt5MaxDrop, ndcgAt10MaxDrop: GATE.ndcgAt10MaxDrop },
      rows: gates.map((row) => ({
        model: row.model,
        dtype: row.dtype,
        deltaRecallAt5: row.deltaRecallAt5 === null ? null : round(row.deltaRecallAt5),
        deltaRecallAt5Pp: row.deltaRecallAt5 === null ? null : round(row.deltaRecallAt5 * 100, 2),
        deltaNdcgAt10: row.deltaNdcgAt10 === null ? null : round(row.deltaNdcgAt10),
        pass: row.pass,
      })),
      overallPass,
    },
    skipped,
    counts: { evaluatedModels: evaluated.length, comparedQuantizations: gatePassedCount + (gateFailed ? 1 : 0) },
  };

  await mkdir(options.outDir, { recursive: true });
  const rawFile = path.join(options.outDir, 'raw.json');
  const mdFile = path.join(options.outDir, 'summary.md');
  await writeFile(rawFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  await writeFile(mdFile, markdown, 'utf8');

  console.log(`\n${markdown}`);
  console.log(`[eval-quality] 原始结果：${path.relative(process.cwd(), rawFile) || rawFile}`);
  console.log(`[eval-quality] Markdown：${path.relative(process.cwd(), mdFile) || mdFile}`);

  if (evaluated.length === 0) {
    console.error('[eval-quality] 没有任何模型/dtype 完成评测，请检查模型文件与网络/本地路径配置。');
    process.exit(1);
  }
  if (gateFailed) {
    console.error('[eval-quality] 质量门未通过，见上方表格。');
    process.exit(1);
  }
  if (gatePassedCount === 0) {
    warn('没有可比较的量化组（缺少 fp32 基线），已输出指标但无法判定质量门。');
    process.exit(1);
  }
  log(`完成：${gatePassedCount} 组量化对比全部通过质量门。`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
