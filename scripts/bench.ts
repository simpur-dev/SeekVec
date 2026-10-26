/**
 * SeekVec 量化评测脚本（Node CPU，不写数据库，可离线运行）
 *
 * 两类输出：
 *   1) 模型体积：扫描本地模型目录（`web/public/models` 或 `SEEKVEC_LOCAL_MODEL_PATH`），
 *      统计目录总体积、逐文件体积与 sha256，并计算压缩比（fp32/q8、fp32/fp16）；
 *      若仓库根存在 `models.lock.json`，逐文件比对 sha256（不一致会明确报错）。
 *   2) 量化一致性：同一批文本上 fp32 与 q8 / fp16 的 embedding 余弦相似度、
 *      Top-1 一致率与 Top-5 重合率（回答「量化后语义是否还稳定」）。
 *
 * 运行（仓库根目录）：`npm run bench` 或 `npx tsx scripts/bench.ts [--out <file.json>]`
 *
 * 模型来源：
 *   默认优先本地模型目录（存在即离线运行，allowRemoteModels=false）；
 *   `SEEKVEC_LOCAL_MODELS=0` 强制远程/缓存下载；
 *   `SEEKVEC_LOCAL_MODEL_PATH` 指定本地模型根目录；
 *   `SEEKVEC_CACHE_DIR` 远程缓存目录；`HF_ENDPOINT` 指定镜像（如 https://hf-mirror.com/）。
 *
 * 缺模型文件时**不会静默**：打印缺失文件并提示运行 `node scripts/fetch-models.mjs --dtype ...`。
 * 注意：本脚本只评测 v1 文本管线；v1.1 图片管线（CLIP）的评测留作后续。
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, env } from '@huggingface/transformers';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_VERSION = 1;

type Dtype = 'fp32' | 'fp16' | 'q8';
const DTYPE_ORDER: readonly Dtype[] = ['fp32', 'q8', 'fp16'];

const BUILTIN_DTYPE_FILES: Readonly<Record<Dtype, string>> = {
  q8: 'onnx/model_quantized.onnx',
  fp16: 'onnx/model_fp16.onnx',
  fp32: 'onnx/model.onnx',
};

const MODELS: ReadonlyArray<{ key: string; id: string; revision: string }> = [
  { key: 'text_en', id: 'Xenova/all-MiniLM-L6-v2', revision: '751bff37182d3f1213fa05d7196b954e230abad9' },
  { key: 'text_zh', id: 'Xenova/bge-small-zh-v1.5', revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781' },
];

/** 一致性评测用的小语料（同时含中英文；不用于质量指标，只比较量化前后 embedding/排序是否稳定） */
const CORPUS: readonly string[] = [
  'SeekDB 是一款 AI-native 搜索数据库，融合关系、向量、文本、JSON、GIS 于单一引擎。',
  'Hybrid search combines vector similarity with full-text keyword matching.',
  '混合检索通过 RRF（Reciprocal Rank Fusion）在库内合并全文与向量结果。',
  'Transformers.js allows running HuggingFace models directly in the browser.',
  'WebGPU 比 WASM 快很多，但需要硬件支持与浏览器开启。',
  'ONNX Runtime Web 是微软的跨平台推理引擎，支持 WebGPU 与 WASM 后端。',
  '量化 int8 将 fp32 权重映射到 8 位整数，体积约为原来的 1/4，质量损失通常很小。',
  'HNSW 是常见的近似最近邻索引，适合百万级向量的高效检索。',
  'BM25 是基于词频与文档长度的经典全文打分函数。',
  'SeekDB 支持嵌入式部署与 client/server 部署两种模式。',
];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(message);
}

function warn(message: string): void {
  // 与表格输出走同一流，避免 stdout/stderr 交错导致日志顺序错乱（退出码仍然表达失败）
  log(`[bench] WARN ${message}`);
}

function fail(message: string): never {
  console.error(`[bench] ERROR ${message}`);
  process.exit(1);
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function round(value: number, digits = 6): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function withTrailingSep(dir: string): string {
  return dir.endsWith(path.sep) || dir.endsWith('/') ? dir : `${dir}${path.sep}`;
}

/**
 * 统一用 POSIX 分隔符的相对路径（models.lock.json 里也是这种写法），
 * 避免 Windows 的 `onnx\model.onnx` 与 lock 里的 `onnx/model.onnx` 匹配不上。
 */
function relPath(from: string, to: string): string {
  const relative = path.relative(from, to);
  if (relative === '') return '.';
  return relative.split(path.sep).join('/');
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

async function readPackageVersion(pkg: string): Promise<string> {
  try {
    const content = await readFile(path.join(REPO_ROOT, 'scripts', 'node_modules', pkg, 'package.json'), 'utf8');
    const parsed = JSON.parse(content) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function cosineSim(a: readonly number[], b: readonly number[]): number {
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
// models.lock.json（可选，用于 sha256/体积比对）
// ---------------------------------------------------------------------------

interface LockFileEntry {
  path: string;
  size: number;
  sha256: string;
}

interface LockModel {
  key: string;
  id: string;
  revision?: string;
  files?: LockFileEntry[];
}

interface ModelsLock {
  dtypeToFile?: Partial<Record<Dtype, string>>;
  models: LockModel[];
}

async function loadModelsLock(): Promise<ModelsLock | null> {
  const lockFile = path.join(REPO_ROOT, 'models.lock.json');
  if (!existsSync(lockFile)) {
    warn('未找到 models.lock.json，跳过 lock 比对（可运行 `node scripts/fetch-models.mjs` 生成）');
    return null;
  }
  try {
    const parsed = JSON.parse(await readFile(lockFile, 'utf8')) as ModelsLock;
    if (!Array.isArray(parsed.models)) throw new Error('缺少 models[] 数组');
    return parsed;
  } catch (error) {
    warn(`models.lock.json 解析失败，跳过 lock 比对：${toErrorText(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  outFile: string | null;
  models: string[];
}

const USAGE = `SeekVec 量化评测（Node CPU，体积 + 一致性）

用法：npx tsx scripts/bench.ts [选项]

选项：
  --out <file.json>   把原始结果写成 JSON（可选）
  --models <list>     逗号分隔的模型 key（默认 text_en,text_zh）
  -h, --help          显示帮助

环境变量：SEEKVEC_LOCAL_MODELS=1|0、SEEKVEC_LOCAL_MODEL_PATH、SEEKVEC_CACHE_DIR、HF_ENDPOINT`;

function parseCli(argv: readonly string[]): CliOptions {
  const options: CliOptions = { outFile: null, models: MODELS.map((model) => model.key) };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) fail(`参数 ${arg} 缺少取值`);
      return value;
    };
    switch (arg) {
      case '--out':
        options.outFile = path.resolve(process.cwd(), next());
        break;
      case '--models':
        options.models = next()
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
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
  return options;
}

// ---------------------------------------------------------------------------
// 模型目录与体积
// ---------------------------------------------------------------------------

interface DirFileStat {
  relPath: string;
  bytes: number;
  sha256: string;
}

interface ModelVolume {
  key: string;
  id: string;
  revision: string;
  dir: string;
  exists: boolean;
  totalBytes: number;
  files: DirFileStat[];
  /** dtype -> 权重文件信息（不存在则为 null） */
  weights: Record<Dtype, { relPath: string; bytes: number; sha256: string; exists: boolean } | null>;
  compression: {
    fp32OverQ8: number | null;
    fp32OverFp16: number | null;
  };
  lock: {
    found: boolean;
    filesCompared: number;
    mismatches: Array<{ path: string; expected: string; actual: string }>;
  };
}

async function listFilesRecursive(rootDir: string): Promise<DirFileStat[]> {
  const out: DirFileStat[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const bytes = (await stat(abs)).size;
        const sha256 = await fileSha256(abs);
        out.push({ relPath: relPath(rootDir, abs), bytes, sha256 });
      }
    }
  };
  await walk(rootDir);
  return out;
}

function dtypeToFile(dtype: Dtype, lock: ModelsLock | null): string {
  return lock?.dtypeToFile?.[dtype] ?? BUILTIN_DTYPE_FILES[dtype];
}

async function inspectModelVolume(
  model: { key: string; id: string; revision: string },
  localRoot: string,
  lock: ModelsLock | null,
): Promise<ModelVolume> {
  const dir = path.join(localRoot, model.id);
  const volume: ModelVolume = {
    key: model.key,
    id: model.id,
    revision: lock?.models.find((item) => item.id === model.id)?.revision ?? model.revision,
    dir,
    exists: existsSync(dir),
    totalBytes: 0,
    files: [],
    weights: { fp32: null, q8: null, fp16: null },
    compression: { fp32OverQ8: null, fp32OverFp16: null },
    lock: { found: false, filesCompared: 0, mismatches: [] },
  };
  if (!volume.exists) return volume;

  volume.files = await listFilesRecursive(dir);
  volume.totalBytes = volume.files.reduce((sum, file) => sum + file.bytes, 0);
  for (const dtype of DTYPE_ORDER) {
    const wanted = dtypeToFile(dtype, lock);
    const file = volume.files.find((item) => item.relPath === wanted);
    volume.weights[dtype] = file
      ? { relPath: file.relPath, bytes: file.bytes, sha256: file.sha256, exists: true }
      : { relPath: wanted, bytes: 0, sha256: '', exists: false };
  }
  const fp32 = volume.weights.fp32;
  const q8 = volume.weights.q8;
  const fp16 = volume.weights.fp16;
  if (fp32?.exists && q8?.exists) volume.compression.fp32OverQ8 = round(fp32.bytes / q8.bytes, 3);
  if (fp32?.exists && fp16?.exists) volume.compression.fp32OverFp16 = round(fp32.bytes / fp16.bytes, 3);

  const lockedModel = lock?.models.find((item) => item.id === model.id);
  if (lockedModel?.files) {
    volume.lock.found = true;
    for (const lockedFile of lockedModel.files) {
      const actual = volume.files.find((file) => file.relPath === lockedFile.path);
      if (!actual) continue;
      volume.lock.filesCompared += 1;
      if (actual.sha256 !== lockedFile.sha256) {
        volume.lock.mismatches.push({ path: lockedFile.path, expected: lockedFile.sha256, actual: actual.sha256 });
      }
    }
  }
  return volume;
}

function printVolume(volume: ModelVolume): void {
  console.log(`\n=== 模型体积 · ${volume.key} (${volume.id}) ===`);
  if (!volume.exists) {
    log(`[bench] ERROR 模型目录不存在：${volume.dir}`);
    log('[bench] 提示：运行 `node scripts/fetch-models.mjs --dtype q8,fp16,fp32` 或设置 SEEKVEC_LOCAL_MODEL_PATH。');
    return;
  }
  console.log(`目录：${relPath(REPO_ROOT, volume.dir)} · revision ${volume.revision}`);
  console.log(`目录总体积：${mb(volume.totalBytes)} MB（${volume.files.length} 个文件）`);
  console.log('');
  console.log('| 文件 | 体积 (MB) | sha256（前 16 位） |');
  console.log('|---|---|---|');
  for (const file of volume.files) {
    console.log(`| ${file.relPath} | ${mb(file.bytes)} | ${file.sha256.slice(0, 16)} |`);
  }
  console.log('');
  const fp32 = volume.weights.fp32;
  const q8 = volume.weights.q8;
  const fp16 = volume.weights.fp16;
  if (fp32?.exists) console.log(`- fp32 权重：${fp32.relPath} · ${mb(fp32.bytes)} MB`);
  else log(`- [bench] ERROR 缺少 fp32 权重 ${fp32?.relPath ?? 'onnx/model.onnx'}（提示：node scripts/fetch-models.mjs --dtype fp32）`);
  if (q8?.exists) console.log(`- q8 权重：${q8.relPath} · ${mb(q8.bytes)} MB`);
  else log(`- [bench] ERROR 缺少 q8 权重 ${q8?.relPath ?? 'onnx/model_quantized.onnx'}（提示：node scripts/fetch-models.mjs --dtype q8）`);
  if (fp16?.exists) console.log(`- fp16 权重：${fp16.relPath} · ${mb(fp16.bytes)} MB`);
  else console.log('- fp16 权重：缺失（可选；`node scripts/fetch-models.mjs --dtype fp16` 可补齐）');
  if (volume.compression.fp32OverQ8 !== null) {
    console.log(`- **压缩比 fp32/q8 = ${volume.compression.fp32OverQ8.toFixed(2)}×**（按 onnx 权重实际体积）`);
  }
  if (volume.compression.fp32OverFp16 !== null) {
    console.log(`- **压缩比 fp32/fp16 = ${volume.compression.fp32OverFp16.toFixed(2)}×**（按 onnx 权重实际体积）`);
  }
  if (volume.lock.found) {
    if (volume.lock.mismatches.length === 0) {
      console.log(`- models.lock.json sha256 比对：✅ ${volume.lock.filesCompared} 个文件全部一致`);
    } else {
      console.error(`- models.lock.json sha256 比对：❌ ${volume.lock.mismatches.length} 个文件不一致`);
      for (const mismatch of volume.lock.mismatches) {
        console.error(`    - ${mismatch.path}: 期望 ${mismatch.expected.slice(0, 16)}… 实际 ${mismatch.actual.slice(0, 16)}…`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 一致性评测
// ---------------------------------------------------------------------------

type Embedder = (texts: string[], options: { pooling: 'mean'; normalize: boolean }) => Promise<unknown>;

function tensorToList(output: unknown): number[][] {
  const tensor = output as { tolist?: () => unknown };
  if (typeof tensor.tolist !== 'function') throw new Error('embedding 输出不是 Tensor（缺少 tolist()）');
  const list = tensor.tolist();
  if (!Array.isArray(list)) throw new Error('embedding 输出格式异常');
  return list as number[][];
}

async function embedCorpus(embedder: Embedder): Promise<{ vectors: number[][]; ms: number }> {
  const started = performance.now();
  const output = await embedder([...CORPUS], { pooling: 'mean', normalize: true });
  const vectors = tensorToList(output);
  if (vectors.length !== CORPUS.length) {
    throw new Error(`返回 ${vectors.length} 条向量，期望 ${CORPUS.length} 条`);
  }
  return { vectors, ms: performance.now() - started };
}

interface ConsistencyResult {
  baseline: Dtype;
  dtype: Dtype;
  avgCosine: number;
  minCosine: number;
  top1SameRate: number;
  top5OverlapRate: number;
  candidateCount: number;
  embedMs: { baseline: number; dtype: number };
}

function compareEmbeddings(
  baselineVectors: readonly number[][],
  otherVectors: readonly number[][],
  baselineDtype: Dtype,
  otherDtype: Dtype,
  embedMs: { baseline: number; dtype: number },
): ConsistencyResult {
  let simTotal = 0;
  let simMin = Number.POSITIVE_INFINITY;
  for (let i = 0; i < CORPUS.length; i++) {
    const sim = cosineSim(baselineVectors[i], otherVectors[i]);
    simTotal += sim;
    simMin = Math.min(simMin, sim);
  }
  const candidateCount = CORPUS.length - 1;
  let top1Same = 0;
  let top5Overlap = 0;
  for (let i = 0; i < CORPUS.length; i++) {
    const baselineScores: Array<{ idx: number; score: number }> = [];
    const otherScores: Array<{ idx: number; score: number }> = [];
    for (let j = 0; j < CORPUS.length; j++) {
      if (i === j) continue;
      baselineScores.push({ idx: j, score: cosineSim(baselineVectors[i], baselineVectors[j]) });
      otherScores.push({ idx: j, score: cosineSim(otherVectors[i], otherVectors[j]) });
    }
    const byScore = (a: { score: number; idx: number }, b: { score: number; idx: number }): number =>
      b.score !== a.score ? b.score - a.score : a.idx - b.idx;
    baselineScores.sort(byScore);
    otherScores.sort(byScore);
    if (baselineScores[0]?.idx === otherScores[0]?.idx) top1Same += 1;
    const baselineTop5 = new Set(baselineScores.slice(0, 5).map((item) => item.idx));
    const overlap = otherScores.slice(0, 5).filter((item) => baselineTop5.has(item.idx)).length;
    top5Overlap += overlap / Math.min(5, candidateCount);
  }
  return {
    baseline: baselineDtype,
    dtype: otherDtype,
    avgCosine: round(simTotal / CORPUS.length),
    minCosine: round(simMin),
    top1SameRate: round(top1Same / CORPUS.length),
    top5OverlapRate: round(top5Overlap / CORPUS.length),
    candidateCount,
    embedMs: { baseline: round(embedMs.baseline, 1), dtype: round(embedMs.dtype, 1) },
  };
}

function printConsistency(modelKey: string, modelId: string, result: ConsistencyResult): void {
  const label = result.dtype === 'q8' ? 'int8(q8)' : result.dtype;
  console.log(`\n=== ${modelKey} : ${modelId} · ${label} vs fp32 一致性 ===`);
  console.log(`加载+推理：fp32 ${result.embedMs.baseline.toFixed(0)}ms · ${result.dtype} ${result.embedMs.dtype.toFixed(0)}ms（${CORPUS.length} 条文本）`);
  console.log(`${label} vs fp32 平均余弦相似度：${result.avgCosine.toFixed(4)}（最低 ${result.minCosine.toFixed(4)}）`);
  console.log(`Top-1 一致率 (${label} vs fp32)：${(result.top1SameRate * 100).toFixed(2)}%`);
  console.log(
    `Top-5 重合率 (${label} vs fp32, ${result.candidateCount} 候选)：${(result.top5OverlapRate * 100).toFixed(2)}%`,
  );
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const generatedAt = new Date().toISOString();
  const command = `npx tsx scripts/bench.ts ${process.argv.slice(2).join(' ')}`.trim();
  console.log('SeekVec 量化评测 · Node CPU 后端，只读模型、不写数据库');
  console.log(`仓库根目录：${REPO_ROOT}`);

  const lock = await loadModelsLock();
  const localRoot = process.env.SEEKVEC_LOCAL_MODEL_PATH ?? path.join(REPO_ROOT, 'web', 'public', 'models');
  const localFlag = process.env.SEEKVEC_LOCAL_MODELS;
  const useLocal = localFlag === '0' ? false : localFlag === '1' ? true : existsSync(localRoot);
  env.allowLocalModels = useLocal;
  env.allowRemoteModels = !useLocal;
  if (useLocal) env.localModelPath = withTrailingSep(localRoot);
  const cacheDir = process.env.SEEKVEC_CACHE_DIR ?? path.join(REPO_ROOT, 'scripts', '.cache');
  env.cacheDir = cacheDir;
  env.useBrowserCache = false;
  const endpoint = process.env.HF_ENDPOINT;
  if (endpoint) env.remoteHost = withTrailingSep(endpoint);
  console.log(`模型来源：${useLocal ? `本地 ${relPath(REPO_ROOT, localRoot)}（离线，不访问网络）` : '远程下载 / 本地缓存'}`);
  console.log(`缓存目录：${cacheDir}`);

  const selectedModels = MODELS.filter((model) => options.models.includes(model.key));
  if (selectedModels.length === 0) fail(`未知模型 key：${options.models.join(', ')}（可选 ${MODELS.map((model) => model.key).join('/')}）`);

  // 1) 体积 + sha256 + 压缩比
  const volumes: ModelVolume[] = [];
  for (const model of selectedModels) {
    const volume = await inspectModelVolume(model, localRoot, lock);
    volumes.push(volume);
    printVolume(volume);
  }

  // 2) 一致性（fp32 为基线，q8 / fp16 分别对比）
  const consistency: Array<{ model: string; id: string; results: ConsistencyResult[] }> = [];
  for (const model of selectedModels) {
    const volume = volumes.find((item) => item.key === model.key);
    if (!volume?.exists) {
      warn(`${model.key}: 跳过一致性评测（模型目录缺失）`);
      continue;
    }
    const fp32 = volume.weights.fp32;
    const q8 = volume.weights.q8;
    if (!fp32?.exists) {
      log(`[bench] ERROR ${model.key}: 缺少 fp32 权重 ${fp32?.relPath ?? 'onnx/model.onnx'}，无法计算一致性基线`);
      log('[bench] 提示：运行 `node scripts/fetch-models.mjs --dtype fp32` 补齐模型文件。');
      continue;
    }
    if (!q8?.exists) {
      log(`[bench] ERROR ${model.key}: 缺少 q8 权重 ${q8?.relPath ?? 'onnx/model_quantized.onnx'}，无法计算量化一致性`);
      log('[bench] 提示：运行 `node scripts/fetch-models.mjs --dtype q8` 补齐模型文件。');
      continue;
    }

    console.log(`\n=== ${model.key} : ${model.id} ===`);
    const loaded: Partial<Record<Dtype, { vectors: number[][]; ms: number }>> = {};
    for (const dtype of DTYPE_ORDER) {
      const weights = volume.weights[dtype];
      if (!weights?.exists) {
        if (dtype === 'fp16') console.log('fp16 权重缺失，跳过 fp16 一致性对比（可运行 fetch-models --dtype fp16 补齐）');
        continue;
      }
      const started = performance.now();
      let extractor: Embedder | null = null;
      try {
        extractor = (await pipeline('feature-extraction', model.id, { device: 'cpu', dtype })) as unknown as Embedder;
        const loadMs = performance.now() - started;
        const embedded = await embedCorpus(extractor);
        loaded[dtype] = embedded;
        console.log(`加载 ${dtype}：${loadMs.toFixed(0)}ms · 推理：${embedded.ms.toFixed(0)}ms · ${embedded.vectors[0]?.length ?? 0}d`);
      } catch (error) {
        warn(`${model.key}/${dtype} 推理失败，跳过该精度：${toErrorText(error)}`);
      } finally {
        const disposable = extractor as unknown as { dispose?: () => Promise<void> } | null;
        if (disposable && typeof disposable.dispose === 'function') {
          try {
            await disposable.dispose();
          } catch {
            // 释放失败不影响结果
          }
        }
      }
    }
    const baseline = loaded.fp32;
    if (!baseline) {
      console.error(`[bench] ERROR ${model.key}: fp32 推理失败，无法建立一致性基线`);
      continue;
    }
    const results: ConsistencyResult[] = [];
    for (const dtype of ['q8', 'fp16'] as const) {
      const other = loaded[dtype];
      if (!other) continue;
      const result = compareEmbeddings(baseline.vectors, other.vectors, 'fp32', dtype, {
        baseline: baseline.ms,
        dtype: other.ms,
      });
      results.push(result);
      printConsistency(model.key, model.id, result);
    }
    consistency.push({ model: model.key, id: model.id, results });
  }

  if (consistency.length === 0) {
    console.error('\n[bench] 没有任何模型完成一致性评测。请检查模型文件（fetch-models）与本地路径配置。');
    process.exit(1);
  }

  // 3) 可选 JSON 输出（模型体积 + 一致性原始数据）
  if (options.outFile) {
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt,
      command,
      script: 'scripts/bench.ts',
      environment: {
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
        modelSource: useLocal ? 'local' : 'remote-or-cache',
        localModelPath: useLocal ? relPath(REPO_ROOT, localRoot) : null,
        hfEndpoint: endpoint ?? 'default(huggingface.co)',
      },
      metrics: {
        corpusSize: CORPUS.length,
        candidateCount: CORPUS.length - 1,
        cosine: '同一文本 fp32 向量与量化向量的余弦相似度',
        top1SameRate: '留一法：量化与 fp32 检索 Top-1 相同的查询占比',
        top5OverlapRate: '留一法：Top-5 集合交集的平均占比',
      },
      models: selectedModels.map((model) => {
        const volume = volumes.find((item) => item.key === model.key);
        const consistencyResult = consistency.find((item) => item.model === model.key);
        return {
          key: model.key,
          id: model.id,
          revision: volume?.revision ?? model.revision,
          volume: volume
            ? {
                dir: relPath(REPO_ROOT, volume.dir),
                exists: volume.exists,
                totalBytes: volume.totalBytes,
                files: volume.files,
                weights: volume.weights,
                compression: volume.compression,
                lock: volume.lock,
              }
            : null,
          consistency: consistencyResult?.results ?? [],
        };
      }),
    };
    await mkdir(path.dirname(options.outFile), { recursive: true });
    await writeFile(options.outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`\n原始结果已写入：${relPath(process.cwd(), options.outFile)}`);
  }

  console.log('\n完成。体积/压缩比与一致性结果可粘贴到 docs/技术说明.md；');
  console.log('更完整的检索质量指标请用 `npm run eval:quality`（data/eval，fp32 vs q8/fp16 的 Recall/nDCG/MRR）。');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
