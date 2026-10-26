/**
 * 量化评测脚本（Node 端，不写数据库）
 *
 * 评测目标：
 *   1. 余弦相似度：fp32 输出 vs int8(q8) 输出（同一批文本）
 *   2. 检索一致性：fp32 top-k vs int8 top-k（Recall@1/@3/@5）
 *
 * 运行：`npm run bench`（根目录）
 *
 * 网络/缓存（本机常需要）：
 * - HF_ENDPOINT=https://hf-mirror.com/   模型下载镜像（默认官方 huggingface.co）
 * - SEEKVEC_CACHE_DIR=<dir>              模型缓存目录（默认 ./scripts/.cache，避免写 C 盘）
 * - SEEKVEC_LOCAL_MODELS=1               使用 web/public/models 下的本地模型
 *
 * 注意：脚本只评测 v1 文本管线（all-MiniLM-L6-v2 与 bge-small-zh-v1.5）；
 *       v1.1 图片管线（CLIP）的评测扩展留作后续。
 */
import { pipeline, env } from '@huggingface/transformers';
import path from 'node:path';

// Node 下使用 CPU EP（transformers.js v3 的 device 取值是 cpu/gpu，'wasm' 只用于浏览器）
env.allowLocalModels = process.env.SEEKVEC_LOCAL_MODELS === '1';
env.localModelPath =
  process.env.SEEKVEC_LOCAL_MODEL_PATH ?? `${path.resolve(process.cwd(), '../web/public/models')}/`;
env.useBrowserCache = false;
env.cacheDir = process.env.SEEKVEC_CACHE_DIR ?? path.join(process.cwd(), '.cache');
if (process.env.HF_ENDPOINT) {
  env.remoteHost = process.env.HF_ENDPOINT.endsWith('/')
    ? process.env.HF_ENDPOINT
    : `${process.env.HF_ENDPOINT}/`;
}

const CORPUS = [
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

const MODELS = [
  { key: 'text_en', id: 'Xenova/all-MiniLM-L6-v2' },
  { key: 'text_zh', id: 'Xenova/bge-small-zh-v1.5' },
];

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function benchmarkModel(modelKey: string, modelId: string) {
  console.log(`\n=== ${modelKey} : ${modelId} ===`);
  const t0 = performance.now();
  const extractor = await pipeline('feature-extraction', modelId, {
    device: 'cpu',
    dtype: 'q8',
  });
  const tLoad = performance.now() - t0;
  console.log(`加载耗时：${tLoad.toFixed(0)}ms`);

  // int8 embedding
  const t1 = performance.now();
  const int8Out = await extractor(CORPUS, { pooling: 'mean', normalize: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const int8Vecs = (int8Out as any).tolist() as number[][];
  const tInt8 = performance.now() - t1;
  console.log(`int8 推理：${tInt8.toFixed(0)}ms · ${int8Vecs.length} 条 · ${int8Vecs[0].length}d`);

  // fp32 基准
  const t2 = performance.now();
  const fp32Extractor = await pipeline('feature-extraction', modelId, {
    device: 'cpu',
    dtype: 'fp32',
  });
  const fp32Out = await fp32Extractor(CORPUS, { pooling: 'mean', normalize: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fp32Vecs = (fp32Out as any).tolist() as number[][];
  const tFp32 = performance.now() - t2;
  console.log(`fp32 加载+推理：${tFp32.toFixed(0)}ms`);

  // 余弦相似度对比（int8 vs fp32 同一文本）
  let simTotal = 0;
  for (let i = 0; i < CORPUS.length; i++) {
    simTotal += cosineSim(int8Vecs[i], fp32Vecs[i]);
  }
  const avgSim = simTotal / CORPUS.length;
  console.log(`int8 vs fp32 平均余弦相似度：${avgSim.toFixed(4)}`);

  // 检索一致性（留一法：每条语料作为 query，其余 9 条作为候选）
  // Top-1 一致率 = int8 与 fp32 第一名完全相同的 query 占比
  // Top-5 重合率 = 两者 top-5 交集的平均占比（候选只有 9 条，不再统计 @10）
  const candidateCount = CORPUS.length - 1;
  let top1Same = 0;
  let top5Overlap = 0;
  for (let i = 0; i < CORPUS.length; i++) {
    const int8Scores: { idx: number; score: number }[] = [];
    const fp32Scores: { idx: number; score: number }[] = [];
    for (let j = 0; j < CORPUS.length; j++) {
      if (i === j) continue;
      int8Scores.push({ idx: j, score: cosineSim(int8Vecs[i], int8Vecs[j]) });
      fp32Scores.push({ idx: j, score: cosineSim(fp32Vecs[i], fp32Vecs[j]) });
    }
    int8Scores.sort((a, b) => b.score - a.score);
    fp32Scores.sort((a, b) => b.score - a.score);
    if (int8Scores[0]?.idx === fp32Scores[0]?.idx) top1Same += 1;
    const fp32Top5 = new Set(fp32Scores.slice(0, 5).map((s) => s.idx));
    const overlap = int8Scores.slice(0, 5).filter((s) => fp32Top5.has(s.idx)).length;
    top5Overlap += overlap / Math.min(5, candidateCount);
  }
  console.log(`Top-1 一致率 (int8 vs fp32)：${((top1Same / CORPUS.length) * 100).toFixed(2)}%`);
  console.log(
    `Top-5 重合率 (int8 vs fp32, ${candidateCount} 候选)：${((top5Overlap / CORPUS.length) * 100).toFixed(2)}%`,
  );
}

async function main() {
  console.log('SeekVec 量化评测 · Node CPU 后端，只读模型、不写数据库');
  console.log(`缓存目录：${env.cacheDir}`);
  for (const m of MODELS) {
    await benchmarkModel(m.key, m.id);
  }
  console.log('\n完成。结论可粘贴到 docs/技术说明.md（注意候选集只有 9 条，Recall@k 仅作一致性参考）。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
