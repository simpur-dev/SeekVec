/**
 * data/perf 确定性性能语料生成器
 *
 * 用途：给 `scripts/bench-browser.mjs` / `scripts/bench.ts` 提供**规模可控、完全确定**的
 * 导入与查询语料（只关注吞吐/延迟，不评估检索质量）。语料主题覆盖 seekdb/OceanBase/
 * 向量索引/混合检索/端侧推理/量化/性能评测，使查询能命中不同主题，避免所有结果都为空。
 *
 * 用法（仓库根目录）：
 *   npx tsx data/perf/generate.ts              # 默认 120 篇 → 120 chunks
 *   npx tsx data/perf/generate.ts --docs 50    # 50–400 篇，1 篇 = 1 chunk
 *
 * 产物：
 *   data/perf/corpus/perf-0001.md …           # 单段落、无标题、UTF-8，每篇 ≤ 256 字符 = 1 chunk
 *   data/perf/queries.txt                     # 10 条查询（每行一条；含关键词查询以触发 hybrid）
 *
 * 确定性：不用随机数；文档内容由 (主题, 变体) 查表拼装，编号是唯一变量。重跑逐字节一致。
 */
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkText } from '../../web/src/inference/chunk';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.join(HERE, 'corpus');
const QUERIES_FILE = path.join(HERE, 'queries.txt');

const MIN_DOCS = 50;
const MAX_DOCS = 400;
const DEFAULT_DOCS = 120;

/** 主题：label 用于文档正文；句子池保证同一主题下的变体不同，但整体长度可控 */
const THEMES: ReadonlyArray<{ label: string; sentences: readonly string[] }> = [
  {
    label: 'seekdb 的定位',
    sentences: [
      'seekdb 把关系表、向量索引、全文检索与 JSON 文档放在同一个引擎里，一条 SQL 就能完成过滤与近邻查询。',
      'seekdb 是 AI-native 搜索数据库，应用不需要再维护向量库与业务库两套系统。',
      '端侧应用通过 seekdb-js 访问 seekdb，向量与原文都保存在数据库而不是浏览器内存中。',
    ],
  },
  {
    label: 'OceanBase 的存储',
    sentences: [
      'OceanBase 使用 LSM-tree 组织数据，写入先落内存表再合并为 SSTable，写多读少的负载更稳定。',
      'OceanBase 通过 Paxos 多副本协议提交事务，多数派确认后写入才对查询可见。',
      'OceanBase 兼容 MySQL 语法，迁移业务时通常只需要修改连接串与少量方言。',
    ],
  },
  {
    label: '近似最近邻索引',
    sentences: [
      'HNSW 用多层图结构加速近邻检索，M 与 ef_search 决定召回率、内存占用和查询延迟的平衡。',
      'IVF 索引先用 k-means 分桶，查询只扫描最近的桶，适合数据量大且能接受少量召回损失的业务。',
      '向量索引需要在写入后刷新才能被检索到，批量导入时把刷新合并到最后一次可以显著减少开销。',
    ],
  },
  {
    label: '混合检索',
    sentences: [
      '混合检索把向量近邻结果与全文关键词结果在 seekdb 内部融合排序，兼顾语义召回与精确词命中。',
      'RRF 用 1/(k+rank) 累加两路排名，不需要归一化两路分数就能得到稳定的融合顺序。',
      '全文检索基于 BM25 打分，关键词里的特殊字符需要转义后再进入 query_string。',
    ],
  },
  {
    label: '端侧 embedding 推理',
    sentences: [
      'Transformers.js 在浏览器里通过 ONNX Runtime 执行 embedding 推理，文档与查询都不会离开本机。',
      'Web Worker 让向量化在后台线程运行，主线程仍然可以响应滚动与输入，页面不会卡死。',
      '批处理把多条文本打包成一次前向计算，能提高吞吐，但会拉长单次请求的延迟。',
    ],
  },
  {
    label: '推理后端',
    sentences: [
      '支持 WebGPU 时优先使用 GPU 后端，矩阵运算吞吐明显高于纯 CPU 的 WASM 后端。',
      'WebGPU 不可用或初始化失败时，应用必须自动降级到 WASM 并在界面提示当前实际后端。',
      'WASM 后端启用 SIMD 与多线程可以提升 CPU 推理速度，多线程需要页面处于跨域隔离状态。',
    ],
  },
  {
    label: '模型量化',
    sentences: [
      'INT8 量化把 fp32 权重映射到 8 位整数，模型体积约为原来的四分之一，推理速度通常也更快。',
      'FP16 半精度把权重压缩到 16 位浮点，体积约为 fp32 的一半，在支持半精度的硬件上质量损失很小。',
      '量化压缩比按实际 onnx 文件体积计算：压缩比 = 量化前体积 / 量化后体积。',
    ],
  },
  {
    label: '性能与质量评测',
    sentences: [
      '检索质量常用 Recall@K、nDCG@K 与 MRR 衡量，量化前后必须在同一评测集上对比。',
      '性能测试要区分冷启动与预热后的请求，每格至少重复五次并报告每次的中位数与四分位距。',
      '端到端延迟依次包含模型加载、查询向量化、seekdb 检索与结果渲染，需要分阶段记录。',
    ],
  },
  {
    label: '导入与索引刷新',
    sentences: [
      '导入流程是读取文件、分块、批量 embedding、写入 seekdb、刷新索引，最后统一刷新可减少开销。',
      'chunk id 由来源文件名、块序号与文本哈希得到，重复导入同一文件不会产生重复数据。',
      '写入前必须校验集合维度与模型维度一致，否则检索会报错或返回无意义结果。',
    ],
  },
  {
    label: '模型缓存与加载',
    sentences: [
      '首次访问需要下载模型文件，浏览器 Cache API 会把权重缓存在本地，二次访问直接读取。',
      '模型初始化要创建 ONNX Runtime 会话，冷启动耗时远高于后续查询，测试时应单独报告。',
      '本地打包模型可以免去首次下载，适合离线演示与内网部署。',
    ],
  },
];

/** 10 条查询：覆盖各主题，部分带关键词以触发 seekdb 混合检索（keyword 路径） */
const QUERIES: readonly string[] = [
  '向量索引参数如何影响检索延迟与召回率',
  '混合检索如何把向量与全文两路结果融合排序',
  '批量 embedding 的吞吐量如何随 batch size 变化',
  'WebGPU 与 WASM 后端的推理速度差异',
  'INT8 量化后模型体积与压缩比',
  '端侧模型首次加载与预热后的耗时对比',
  '索引刷新对文档导入总耗时的影响',
  '中文分词器对全文检索结果的影响',
  '量化前后 Recall@K 与 nDCG@K 的质量变化',
  'seekdb 混合检索的端到端延迟',
];

interface Args {
  docs: number;
}

function parseArgs(argv: readonly string[]): Args {
  let docs = DEFAULT_DOCS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--docs') {
      const raw = argv[++i];
      if (!raw) throw new Error('--docs 需要一个整数参数');
      docs = Number.parseInt(raw, 10);
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法：npx tsx data/perf/generate.ts [--docs 50..400]');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!Number.isInteger(docs) || docs < MIN_DOCS || docs > MAX_DOCS) {
    throw new Error(`--docs 必须在 ${MIN_DOCS}-${MAX_DOCS} 之间，实际 ${docs}`);
  }
  return { docs };
}

/** 第 i 篇文档：主题 = i % 主题数，变体轮换句子池，编号保证文本唯一 */
function buildDocText(index: number): string {
  const theme = THEMES[index % THEMES.length];
  const variant = Math.floor(index / THEMES.length);
  const first = theme.sentences[variant % theme.sentences.length];
  const second = theme.sentences[(variant + 1) % theme.sentences.length];
  const third = theme.sentences[(variant + 2) % theme.sentences.length];
  const fresh = first === second ? `${second}` : second;
  const marker = `本文档编号 P${String(index + 1).padStart(4, '0')}，用于导入吞吐与检索延迟的重复测量。`;
  return `${marker}${theme.label}：${first}${fresh === third ? '' : third}`;
}

function pad(index: number): string {
  return String(index + 1).padStart(4, '0');
}

async function main(): Promise<void> {
  const { docs } = parseArgs(process.argv.slice(2));
  await mkdir(CORPUS_DIR, { recursive: true });

  // 清理上一轮生成的旧文件（缩小 --docs 时避免残留，保证「语料规模 = --docs」）
  const expectedFiles = new Set(Array.from({ length: docs }, (_item, index) => `perf-${pad(index)}.md`));
  for (const name of await readdir(CORPUS_DIR)) {
    if (/^perf-\d+\.md$/i.test(name) && !expectedFiles.has(name)) {
      await unlink(path.join(CORPUS_DIR, name));
    }
  }

  const problems: string[] = [];
  const written: string[] = [];
  let totalChunks = 0;
  for (let i = 0; i < docs; i++) {
    const text = buildDocText(i);
    const chunks = chunkText(text);
    if (chunks.length !== 1) {
      problems.push(`第 ${i + 1} 篇被切成 ${chunks.length} 块（要求 1 篇 = 1 chunk）`);
    }
    totalChunks += chunks.length;
    const file = `perf-${pad(i)}.md`;
    written.push(file);
    await writeFile(path.join(CORPUS_DIR, file), `${text}\n`, 'utf8');
  }

  await writeFile(QUERIES_FILE, `${QUERIES.join('\n')}\n`, 'utf8');

  if (totalChunks < 50 || totalChunks > 400) {
    problems.push(`chunk 总数 ${totalChunks} 超出 50-400`);
  }
  console.log(`[perf-data] 文档：${docs} 篇（1 篇 = 1 chunk）`);
  console.log(`[perf-data] chunks：${totalChunks}（要求 50-400）`);
  console.log(`[perf-data] 查询：${QUERIES.length} 条 → ${QUERIES_FILE}`);
  console.log(`[perf-data] 语料：${CORPUS_DIR}\\perf-0001.md … perf-${pad(docs - 1)}.md`);

  if (problems.length > 0) {
    console.error(`\n[perf-data] 校验失败（${problems.length} 项）：`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('[perf-data] 生成完成，确定性内容可直接入库复现。');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
