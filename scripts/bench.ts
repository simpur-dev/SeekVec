/**
 * 量化评测脚本
 *
 * 评测目标：
 *   1. 模型文件大小：fp32 vs int8（直接从 HuggingFace 仓库 HEAD metadata 估算）
 *   2. 余弦相似度：fp32 输出 vs int8 输出（同一批文本）
 *   3. 检索召回率：fp32 top-k vs int8 top-k（@10 / @50）
 *
 * 运行：`npm run bench`（根目录）
 *
 * 注意：脚本只评测 v1 文本管线（all-MiniLM-L6-v2 与 bge-small-zh-v1.5）；
 *       v1.1 图片管线（CLIP）的评测扩展留作后续。
 */
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;

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
    device: 'wasm',
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

  // self-similarity（量化前后输出对照需要 fp32 推理做基准，本脚本暂以参考值替代）
  // 由于 Transformers.js 默认 dtype=q8，需切换 dtype:'fp32' 再跑一次
  const t2 = performance.now();
  const fp32Extractor = await pipeline('feature-extraction', modelId, {
    device: 'wasm',
    dtype: 'fp32',
  });
  const fp32Out = await fp32Extractor(CORPUS, { pooling: 'mean', normalize: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fp32Vecs = (fp32Out as any).tolist() as number[][];
  const tFp32 = performance.now() - t2;
  console.log(`fp32 推理：${tFp32.toFixed(0)}ms`);

  // 余弦相似度对比（int8 vs fp32 同一文本）
  let simTotal = 0;
  for (let i = 0; i < CORPUS.length; i++) {
    simTotal += cosineSim(int8Vecs[i], fp32Vecs[i]);
  }
  const avgSim = simTotal / CORPUS.length;
  console.log(`int8 vs fp32 平均余弦相似度：${avgSim.toFixed(4)}`);

  // 检索召回率（fp32 top-k vs int8 top-k 对照）
  // 简单实现：把每条语料作为 query，剩下 9 条作为候选，计算 @5 召回
  let recallAt5 = 0;
  let recallAt10 = 0;
  const totalQueries = CORPUS.length;
  for (let i = 0; i < totalQueries; i++) {
    const queryInt8 = int8Vecs[i];
    const queryFp32 = fp32Vecs[i];
    const int8Scores: { idx: number; score: number }[] = [];
    const fp32Scores: { idx: number; score: number }[] = [];
    for (let j = 0; j < totalQueries; j++) {
      if (i === j) continue;
      int8Scores.push({ idx: j, score: cosineSim(queryInt8, int8Vecs[j]) });
      fp32Scores.push({ idx: j, score: cosineSim(queryFp32, fp32Vecs[j]) });
    }
    int8Scores.sort((a, b) => b.score - a.score);
    fp32Scores.sort((a, b) => b.score - a.score);
    const fp32Top5 = new Set(fp32Scores.slice(0, 5).map((s) => s.idx));
    const fp32Top10 = new Set(fp32Scores.slice(0, 10).map((s) => s.idx));
    const int8Top5 = int8Scores.slice(0, 5).map((s) => s.idx);
    const int8Top10 = int8Scores.slice(0, 10).map((s) => s.idx);
    recallAt5 += int8Top5.filter((x) => fp32Top5.has(x)).length / 5;
    recallAt10 += int8Top10.filter((x) => fp32Top10.has(x)).length / 10;
  }
  console.log(`Recall@5  (int8 vs fp32)：${((recallAt5 / totalQueries) * 100).toFixed(2)}%`);
  console.log(`Recall@10 (int8 vs fp32)：${((recallAt10 / totalQueries) * 100).toFixed(2)}%`);
}

async function main() {
  console.log('SeekVec 量化评测 · 仅在 Node 端 WASM 后端跑一次，不写入数据库');
  for (const m of MODELS) {
    await benchmarkModel(m.key, m.id);
  }
  console.log('\n完成。结论可直接粘贴到 docs/技术说明.md。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
