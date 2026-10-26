/**
 * data/eval 数据集生成器（确定性、可重复）
 *
 * 用法（仓库根目录）：
 *   npx tsx data/eval/generate.ts
 *
 * 产物：
 *   data/eval/corpus/<zh|en>-NN.md   60 篇自有短文档（zh 40 篇 / en 20 篇，单段落，无标题行）
 *   data/eval/queries.jsonl          60 条查询（semantic / keyword / paraphrase 各 20），带 chunk 级 qrels
 *
 * 标注方式：
 *   人工按「文档」标注相关性等级 grade 0-3，然后由本脚本用**浏览器同款分块逻辑**
 *   （scripts/lib/datasets.ts -> web/src/inference/chunk.ts + web/src/utils/id.ts）
 *   展开成 chunk 级 qrels：
 *     - 文档的第 0 块（主题句所在块）沿用文档级 grade；
 *     - 同一文档的其余块 grade = max(1, grade-1)（同一文档相关，其余块至少弱相关）。
 *   这样 qrels 的 chunkIndex/来源与运行时写入 seekdb 的 chunk 严格一致，且不会因为
 *   长文档被切成多块而误判「同文档的兄弟块不相关」。
 *
 * 为什么提交静态数据还要生成器：
 *   chunk 级 qrels 依赖分块参数；把生成逻辑入库，任何人可重跑并 diff 校验数据未被手改。
 */
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chunkDocument,
  normalizeEvalQueries,
  validateEvalSet,
  type CorpusChunk,
  type EvalCategory,
  type EvalLang,
  type EvalQuery,
} from '../../scripts/lib/datasets';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.join(HERE, 'corpus');
const QUERIES_FILE = path.join(HERE, 'queries.jsonl');

/** 文档级相关性标注：source + grade（0-3） */
type DocRel = readonly [source: string, grade: number];

interface SeedQuery {
  qid: string;
  category: EvalCategory;
  lang: EvalLang;
  query: string;
  keyword?: string;
  /** 文档级标注（脚本展开为 chunk 级 qrels） */
  rel: readonly DocRel[];
}

const DOCS: ReadonlyArray<{ source: string; text: string }> = [
  // ---------------------------------------------------------------- 中文 40 篇（10 个主题簇 × 4）
  {
    source: 'zh-01.md',
    text: 'seekdb 是 AI-native 搜索数据库，在同一个引擎里融合关系型表、向量索引、全文检索与 JSON 文档，让应用不必再拼接多个数据库组件。',
  },
  {
    source: 'zh-02.md',
    text: 'seekdb 支持嵌入式与本地 server 两种部署方式：嵌入式无需独立进程，server 模式通过 MySQL 协议对外提供服务，两种方式共用同一套 SQL 与索引接口。',
  },
  {
    source: 'zh-03.md',
    text: 'seekdb-js 客户端让 Node 或浏览器端可以直接发起 SQL 与向量检索请求，不需要额外引入 ORM 或驱动层，客户端会自动处理连接、重试与结果解析。',
  },
  {
    source: 'zh-04.md',
    text: '与专用向量库不同，seekdb 把向量索引和关系型事务放在同一引擎，一条 SQL 就能完成元数据过滤加向量近邻查询。',
  },
  {
    source: 'zh-05.md',
    text: 'OceanBase 使用 LSM-tree 作为存储引擎，写入先进入内存表再合并成 SSTable，因此写吞吐高、读放大可控，这种结构让大写入量的日志类负载表现稳定。',
  },
  {
    source: 'zh-06.md',
    text: 'OceanBase 通过 Paxos 多副本协议保证一致性，只有多数派副本确认写入成功后数据才可见，可容忍少数派故障，副本之间通过日志同步，故障切换由选举完成。',
  },
  {
    source: 'zh-07.md',
    text: 'OceanBase 兼容 MySQL 协议与语法，业务迁移成本低，同时提供分布式事务和全局一致性读取能力，因此现有 MySQL 应用通常只需修改连接串即可迁移。',
  },
  {
    source: 'zh-08.md',
    text: 'OceanBase 把 embedding 列当作普通列存储，并为其建立 HNSW 或 IVF 索引，支持 <-> 与 <#> 等向量距离算子，查询时数据库会把距离算子下推到向量索引执行。',
  },
  {
    source: 'zh-09.md',
    text: '余弦相似度衡量两个向量方向的夹角，数值越大说明语义越接近，是文本 embedding 检索最常用的相似度，实际使用前一般会对 embedding 做归一化处理。',
  },
  {
    source: 'zh-10.md',
    text: '内积相似度在向量完成 L2 归一化后与余弦相似度等价，所以很多检索系统会先归一化向量再计算内积。',
  },
  {
    source: 'zh-11.md',
    text: '欧氏距离衡量向量空间中的直线距离，数值越小越相似；建库与查询必须使用同一种距离度量，否则排序会错乱。',
  },
  {
    source: 'zh-12.md',
    text: '文本 embedding 通常是 384 或 512 维浮点数组：维度过低会损失语义，过高则显著增加存储与检索开销，选型时要同时考虑模型训练维度与检索延迟预算。',
  },
  {
    source: 'zh-13.md',
    text: 'HNSW 用多层可导航小世界图实现近似最近邻检索，查询复杂度接近对数级，适合低延迟的在线检索场景。',
  },
  {
    source: 'zh-14.md',
    text: 'HNSW 的 M 参数控制图中每个节点的连边数量，M 越大召回越高，但内存占用与索引构建时间也随之增加，索引构建完成后再调整 M 需要重建整个索引。',
  },
  {
    source: 'zh-15.md',
    text: 'HNSW 的 ef_search 参数决定检索时候选队列的宽度，ef 越大召回越高、延迟越高，需要按场景权衡，在线服务常用较小的 ef 换取稳定的响应时间。',
  },
  {
    source: 'zh-16.md',
    text: 'IVF 索引先用 k-means 把向量聚成若干桶，查询时只扫描距离最近的几个桶，适合海量数据但存在边界召回损失。',
  },
  {
    source: 'zh-17.md',
    text: '混合检索同时执行向量近邻与全文关键词两路查询，再由数据库内部融合排序，兼顾语义相关与精确词匹配。',
  },
  {
    source: 'zh-18.md',
    text: 'BM25 根据词频、逆文档频率和文档长度计算全文相关性，对短文档上的精确关键词命中尤其有效，查询侧还需要配置合适的中文分词器。',
  },
  {
    source: 'zh-19.md',
    text: 'RRF 倒数排名融合把两路结果的 1/(k+rank) 累加，无需归一化分数就能合并向量与全文排名，k 常取 60，该做法在多个检索系统里被广泛使用。',
  },
  {
    source: 'zh-20.md',
    text: 'Lucene query_string 里 + - && || ! ( ) { } [ ] ^ " ~ * ? : \\ / 等字符有特殊含义，拼入关键词前必须转义。关键词来自用户输入时尤其危险，转义后再拼接可以避免查询解析失败或注入意外条件。',
  },
  {
    source: 'zh-21.md',
    text: 'Transformers.js 让 Hugging Face 模型借助 ONNX Runtime 直接跑在浏览器里，不需要任何后端服务就能完成推理，模型权重通常以 ONNX 格式分发，由运行时加载执行。',
  },
  {
    source: 'zh-22.md',
    text: 'ONNX Runtime Web 提供 WASM 与 WebGPU 两类执行后端，同一份 ONNX 模型可以在不同浏览器环境下运行，切换后端只需改运行时参数，模型文件可以复用。',
  },
  {
    source: 'zh-23.md',
    text: '浏览器的 Cache API 可以缓存模型文件，第二次访问直接从本地存储读取权重，避免重复下载数百 MB 文件，首次下载仍受网络影响，本地打包可以进一步加速。',
  },
  {
    source: 'zh-24.md',
    text: 'Web Worker 把 embedding 推理放到后台线程执行，主线程保持可交互，避免长任务导致页面卡顿，耗时任务结束后再把结果回传给主线程渲染。',
  },
  {
    source: 'zh-25.md',
    text: 'WebGPU 直接调用显卡执行矩阵运算，embedding 吞吐通常明显高于 WASM，但需要浏览器与硬件同时支持，驱动需要较新的浏览器版本，旧设备会自动回退。',
  },
  {
    source: 'zh-26.md',
    text: 'WASM 后端兼容性最好，配合 SIMD 与多线程可以提升 CPU 推理速度，但会受线程数与跨域隔离限制，启用多线程需要页面处于跨域隔离状态。',
  },
  {
    source: 'zh-27.md',
    text: '当 WebGPU 不可用或初始化失败时，应用应自动降级到 WASM，并在界面上明确显示当前实际使用的后端，用户也能从徽标上看到降级原因。',
  },
  {
    source: 'zh-28.md',
    text: '通过特性检测判断 navigator.gpu 是否存在，就能在加载模型之前决定使用 WebGPU 还是 WASM 后端，检测结果还可以写入本地配置，避免每次刷新重新探测。',
  },
  {
    source: 'zh-29.md',
    text: 'INT8 量化把 fp32 权重映射成 8 位整数并保存缩放因子，模型体积约为原来的四分之一，推理通常也更快，推理框架会按量化参数反量化后计算，误差通常可以接受。',
  },
  {
    source: 'zh-30.md',
    text: 'FP16 半精度用 16 位浮点存储权重，模型体积约为 fp32 的一半，在支持半精度的硬件上精度损失很小，并非所有推理后端都支持半精度运算，需要实际测试。',
  },
  {
    source: 'zh-31.md',
    text: '量化压缩比等于量化前模型体积除以量化后体积；按同一口径统计 onnx 文件的实际字节数，结果才准确。',
  },
  {
    source: 'zh-32.md',
    text: '量化可能带来轻微检索质量下降，需要在同一评测集上对比量化前后的 Recall@K、nDCG@K 等指标，评测集、查询集和后端配置都必须保持一致。',
  },
  {
    source: 'zh-33.md',
    text: 'Recall@K 表示前 K 个结果中命中的相关文档占全部相关文档的比例，衡量检索的查全能力，它不关心相关结果出现在第几位，只看有没有被召回。',
  },
  {
    source: 'zh-34.md',
    text: 'nDCG@K 按位置折损累加相关性增益，gain 常取 2^rel−1，能同时反映排序位置与相关等级，理想排序的 DCG 作为分母，把指标归一化到 0 到 1 之间。',
  },
  {
    source: 'zh-35.md',
    text: 'MRR 是第一个相关结果排名的倒数，强调最相关的结果是否排在前面，适合问答式检索评测，它只关注第一个命中，对后续结果不敏感。',
  },
  {
    source: 'zh-36.md',
    text: 'qrels 是查询与文档的相关性标注；评测按 chunk 粒度标注 0 到 3 级，未标注的条目按不相关处理，标注时要区分直接回答、强相关与弱相关三个档次。',
  },
  {
    source: 'zh-37.md',
    text: '文档导入流程依次是读取文件、分块、批量 embedding、写入 seekdb 和刷新索引；最后一批写完后统一刷新可减少开销。',
  },
  {
    source: 'zh-38.md',
    text: '分块按双换行切分段落，单段超过 256 字符时用 32 字符重叠的滑窗继续切，短于 10 字符的块会被过滤，分块参数变了，chunk id 和 qrels 也需要重新生成。',
  },
  {
    source: 'zh-39.md',
    text: 'chunk id 由来源文件名、块序号和块文本做 FNV-1a 哈希得到，同样内容重复导入 id 不变，因此支持幂等 upsert，这让重复导入、断点续传和增量更新都能安全重试。',
  },
  {
    source: 'zh-40.md',
    text: '写入前要校验集合维度与模型是否匹配；维度不一致时检索会报错或返回无意义结果，只能重建集合。',
  },
  // ---------------------------------------------------------------- 英文 20 篇（5 个主题簇 × 4）
  {
    source: 'en-01.md',
    text: 'seekdb is an AI-native search database that keeps relational rows, JSON documents, full-text indexes and vector indexes inside one engine. A single SQL statement can therefore filter metadata and rank vectors without joining several separate systems. Transactions, backups and access control stay consistent as well.',
  },
  {
    source: 'en-02.md',
    text: 'OceanBase uses a shared-nothing distributed architecture with Paxos replication. A write becomes visible only after a majority of replicas persist it, so the cluster survives the failure of a minority of servers without losing acknowledged data. Replicas are spread across availability zones.',
  },
  {
    source: 'en-03.md',
    text: 'seekdb can run embedded inside an application or as a local server. The embedded mode needs no separate process, while the server mode speaks the MySQL protocol and ships with a seekdb-js client for Node and browser callers. It supports both deployment styles.',
  },
  {
    source: 'en-04.md',
    text: 'Unlike a dedicated vector database, seekdb stores embeddings as ordinary columns next to business data. Transactional writes, metadata joins and vector search therefore share one consistency model, one backup path and one permission system. No cross-system synchronization is required at all.',
  },
  {
    source: 'en-05.md',
    text: 'HNSW builds a multi-layer navigable small-world graph. Greedy search starts at the top layer and descends toward the closest neighbors, so query cost grows roughly logarithmically with collection size instead of scanning every vector. It is popular for low-latency online retrieval.',
  },
  {
    source: 'en-06.md',
    text: 'The HNSW M parameter sets how many graph edges each node keeps. A larger M raises recall and improves navigation quality, but it also increases memory usage and the time needed to build the index. Tuning M is therefore a memory-quality trade-off.',
  },
  {
    source: 'en-07.md',
    text: 'The HNSW ef_search parameter controls how wide the candidate queue is during a query. Raising ef_search improves recall at the cost of latency, so services usually tune it per collection to meet a latency budget. A fixed default rarely fits every workload.',
  },
  {
    source: 'en-08.md',
    text: 'An IVF index clusters vectors with k-means and stores the bucket centroids. A query scans only the nearest buckets, which keeps search cheap on large collections, but vectors sitting on bucket boundaries can be missed. More buckets reduce that risk.',
  },
  {
    source: 'en-09.md',
    text: "Transformers.js runs Hugging Face embedding models inside the browser through ONNX Runtime, so documents and queries are encoded locally and never leave the user's device. Model files can be served from the same origin or cached after the first visit, which keeps repeat sessions fast.",
  },
  {
    source: 'en-10.md',
    text: 'ONNX Runtime Web ships two execution backends: WASM for broad compatibility and WebGPU for GPU acceleration. The same exported ONNX graph can run on either backend, so applications can pick the fastest backend the browser offers. No model conversion is needed per backend.',
  },
  {
    source: 'en-11.md',
    text: 'A Web Worker keeps embedding inference off the main thread. The page stays responsive while long batches are encoded, and progress messages let the interface show which document is currently being processed. Encoded results are posted back to the page as transferable buffers without blocking rendering.',
  },
  {
    source: 'en-12.md',
    text: 'When WebGPU is missing or fails to initialize, a web application should fall back to the WASM backend and tell the user which backend is actually active. Silently reporting WebGPU while running on CPU misleads benchmark results. A visible badge avoids that confusion.',
  },
  {
    source: 'en-13.md',
    text: 'INT8 quantization maps fp32 weights to 8-bit integers with per-channel scales. The quantized ONNX file is about a quarter of the original size, and integer math is usually faster on CPUs while keeping retrieval quality close. It is the default choice for WASM.',
  },
  {
    source: 'en-14.md',
    text: 'FP16 half precision stores weights in 16-bit floats. The file is roughly half the fp32 size, and on hardware with native half-precision support the embedding quality loss is usually too small to measure. It is a natural fit for WebGPU.',
  },
  {
    source: 'en-15.md',
    text: 'Compression ratio equals the original model size divided by the quantized size. Measuring it consistently means hashing and summing the actual ONNX files, not trusting the sizes printed in a model card. The ratio should be reported per model file.',
  },
  {
    source: 'en-16.md',
    text: 'Quantization can slightly reduce retrieval quality, so the same evaluation set must be scored before and after conversion. Recall@K and nDCG@K changes are reported together with the size reduction. An explicit quality gate protects users from unacceptable trade-offs and makes the comparison auditable.',
  },
  {
    source: 'en-17.md',
    text: 'Hybrid search combines a vector nearest-neighbor query with a full-text keyword query. seekdb fuses the two ranked lists inside the database engine, so results mix semantic matches with exact term matches instead of relying on one signal alone. Both paths expose their own timing.',
  },
  {
    source: 'en-18.md',
    text: 'Full-text ranking in seekdb uses BM25, which scores a document from term frequency, inverse document frequency and document length. Keyword queries also need careful escaping of Lucene query_string operators such as quotes, wildcards and colons. Unescaped input can break the whole query.',
  },
  {
    source: 'en-19.md',
    text: 'Recall@K counts what share of the judged relevant chunks appear in the top K results, ignoring their order. nDCG@K adds position discounting and graded gains, so a grade-3 hit near the top contributes more than a grade-1 hit lower down.',
  },
  {
    source: 'en-20.md',
    text: 'MRR averages the reciprocal rank of the first relevant result across queries, which rewards systems that place one strong hit at the very top. A fair benchmark also reports the median of at least five runs after discarding the first warm-up.',
  },
];

const QUERIES: readonly SeedQuery[] = [
  // ================================================================ semantic（语义查询，20：zh 13 / en 7）
  {
    qid: 'sem-01',
    category: 'semantic',
    lang: 'zh',
    query: 'seekdb 和传统数据库有什么不同？',
    rel: [
      ['zh-01.md', 3],
      ['zh-04.md', 3],
      ['zh-02.md', 2],
      ['zh-03.md', 1],
    ],
  },
  {
    qid: 'sem-02',
    category: 'semantic',
    lang: 'zh',
    query: 'OceanBase 如何保证数据安全可靠？',
    rel: [
      ['zh-06.md', 3],
      ['zh-05.md', 2],
      ['zh-07.md', 2],
    ],
  },
  {
    qid: 'sem-03',
    category: 'semantic',
    lang: 'zh',
    query: '怎么判断两段文本在语义上有多接近？',
    rel: [
      ['zh-09.md', 3],
      ['zh-10.md', 2],
      ['zh-11.md', 2],
      ['zh-12.md', 1],
    ],
  },
  {
    qid: 'sem-04',
    category: 'semantic',
    lang: 'zh',
    query: '向量索引的参数会怎样影响召回和延迟？',
    rel: [
      ['zh-14.md', 3],
      ['zh-15.md', 3],
      ['zh-13.md', 2],
      ['zh-16.md', 1],
    ],
  },
  {
    qid: 'sem-05',
    category: 'semantic',
    lang: 'zh',
    query: '怎样同时利用关键词和语义来提升搜索效果？',
    rel: [
      ['zh-17.md', 3],
      ['zh-18.md', 2],
      ['zh-19.md', 2],
      ['zh-20.md', 1],
    ],
  },
  {
    qid: 'sem-06',
    category: 'semantic',
    lang: 'zh',
    query: '浏览器里直接运行 AI 模型需要哪些组件？',
    rel: [
      ['zh-21.md', 3],
      ['zh-22.md', 3],
      ['zh-23.md', 2],
      ['zh-24.md', 2],
    ],
  },
  {
    qid: 'sem-07',
    category: 'semantic',
    lang: 'zh',
    query: '电脑显卡不支持时检索功能还能用吗？',
    rel: [
      ['zh-27.md', 3],
      ['zh-26.md', 2],
      ['zh-28.md', 2],
      ['zh-25.md', 1],
    ],
  },
  {
    qid: 'sem-08',
    category: 'semantic',
    lang: 'zh',
    query: '模型文件太大，有什么办法把它变小？',
    rel: [
      ['zh-29.md', 3],
      ['zh-30.md', 3],
      ['zh-31.md', 2],
      ['zh-32.md', 1],
    ],
  },
  {
    qid: 'sem-09',
    category: 'semantic',
    lang: 'zh',
    query: '怎样客观衡量一个检索系统的质量？',
    rel: [
      ['zh-33.md', 3],
      ['zh-34.md', 3],
      ['zh-35.md', 2],
      ['zh-36.md', 2],
    ],
  },
  {
    qid: 'sem-10',
    category: 'semantic',
    lang: 'zh',
    query: '文档从导入到能被检索经历了哪些步骤？',
    rel: [
      ['zh-37.md', 3],
      ['zh-38.md', 2],
      ['zh-39.md', 1],
      ['zh-40.md', 1],
    ],
  },
  {
    qid: 'sem-11',
    category: 'semantic',
    lang: 'zh',
    query: '为什么重复导入同一批文件不会产生重复数据？',
    rel: [
      ['zh-39.md', 3],
      ['zh-37.md', 2],
      ['zh-38.md', 1],
    ],
  },
  {
    qid: 'sem-12',
    category: 'semantic',
    lang: 'zh',
    query: 'embedding 向量的维度该选多大比较合适？',
    rel: [
      ['zh-12.md', 3],
      ['zh-11.md', 1],
      ['zh-16.md', 1],
    ],
  },
  {
    qid: 'sem-13',
    category: 'semantic',
    lang: 'zh',
    query: '怎么避免页面在长文本向量化时卡死？',
    rel: [
      ['zh-24.md', 3],
      ['zh-21.md', 2],
      ['zh-26.md', 1],
    ],
  },
  {
    qid: 'sem-14',
    category: 'semantic',
    lang: 'en',
    query: 'What makes seekdb different from a dedicated vector database?',
    rel: [
      ['en-01.md', 3],
      ['en-04.md', 3],
      ['en-03.md', 2],
      ['en-02.md', 1],
    ],
  },
  {
    qid: 'sem-15',
    category: 'semantic',
    lang: 'en',
    query: 'How does OceanBase keep data safe when a server fails?',
    rel: [
      ['en-02.md', 3],
      ['en-04.md', 2],
      ['en-01.md', 1],
    ],
  },
  {
    qid: 'sem-16',
    category: 'semantic',
    lang: 'en',
    query: 'What are the trade-offs of graph-based nearest neighbor indexes?',
    rel: [
      ['en-05.md', 3],
      ['en-07.md', 3],
      ['en-06.md', 2],
      ['en-08.md', 1],
    ],
  },
  {
    qid: 'sem-17',
    category: 'semantic',
    lang: 'en',
    query: 'How can a website run embedding models without a backend server?',
    rel: [
      ['en-09.md', 3],
      ['en-10.md', 2],
      ['en-11.md', 1],
    ],
  },
  {
    qid: 'sem-18',
    category: 'semantic',
    lang: 'en',
    query: 'Why does a quantized model load faster in the browser?',
    rel: [
      ['en-13.md', 3],
      ['en-15.md', 3],
      ['en-14.md', 2],
      ['en-16.md', 1],
    ],
  },
  {
    qid: 'sem-19',
    category: 'semantic',
    lang: 'en',
    query: 'How should benchmark runs be summarized for a fair comparison?',
    rel: [
      ['en-20.md', 3],
      ['en-15.md', 2],
      ['en-16.md', 2],
    ],
  },
  {
    qid: 'sem-20',
    category: 'semantic',
    lang: 'en',
    query: 'Which metric punishes putting the best answer lower in the result list?',
    rel: [
      ['en-19.md', 3],
      ['en-20.md', 3],
      ['en-16.md', 1],
    ],
  },
  // ================================================================ keyword（必含关键词，20：zh 13 / en 7）
  {
    qid: 'kw-01',
    category: 'keyword',
    lang: 'zh',
    query: 'HNSW 的 ef_search 调大以后召回和延迟怎么变化？',
    keyword: 'HNSW',
    rel: [
      ['zh-15.md', 3],
      ['zh-13.md', 2],
      ['zh-14.md', 2],
    ],
  },
  {
    qid: 'kw-02',
    category: 'keyword',
    lang: 'zh',
    query: 'BM25 打分公式考虑了哪些因素？',
    keyword: 'BM25',
    rel: [
      ['zh-18.md', 3],
      ['zh-17.md', 2],
      ['zh-19.md', 1],
    ],
  },
  {
    qid: 'kw-03',
    category: 'keyword',
    lang: 'zh',
    query: 'RRF 是怎么把两路排名合并的？',
    keyword: 'RRF',
    rel: [
      ['zh-19.md', 3],
      ['zh-17.md', 2],
      ['zh-18.md', 1],
    ],
  },
  {
    qid: 'kw-04',
    category: 'keyword',
    lang: 'zh',
    query: 'WebGPU 初始化失败时应用会怎样处理？',
    keyword: 'WebGPU',
    rel: [
      ['zh-27.md', 3],
      ['zh-28.md', 2],
      ['zh-25.md', 2],
    ],
  },
  {
    qid: 'kw-05',
    category: 'keyword',
    lang: 'zh',
    query: 'INT8 量化之后模型体积大约变成多少？',
    keyword: 'INT8',
    rel: [
      ['zh-29.md', 3],
      ['zh-31.md', 2],
      ['zh-30.md', 1],
    ],
  },
  {
    qid: 'kw-06',
    category: 'keyword',
    lang: 'zh',
    query: 'FP16 的精度损失对检索质量影响大吗？',
    keyword: 'FP16',
    rel: [
      ['zh-30.md', 3],
      ['zh-32.md', 2],
      ['zh-29.md', 1],
    ],
  },
  {
    qid: 'kw-07',
    category: 'keyword',
    lang: 'zh',
    query: 'Paxos 多副本协议怎样确认写入成功？',
    keyword: 'Paxos',
    rel: [
      ['zh-06.md', 3],
      ['zh-05.md', 2],
      ['zh-07.md', 1],
    ],
  },
  {
    qid: 'kw-08',
    category: 'keyword',
    lang: 'zh',
    query: 'seekdb 里一条 SQL 能同时做元数据过滤和向量近邻吗？',
    keyword: 'SQL',
    rel: [
      ['zh-04.md', 3],
      ['zh-03.md', 2],
      ['zh-01.md', 2],
    ],
  },
  {
    qid: 'kw-09',
    category: 'keyword',
    lang: 'zh',
    query: 'chunk id 是如何保证幂等导入的？',
    keyword: 'chunk id',
    rel: [
      ['zh-39.md', 3],
      ['zh-38.md', 2],
      ['zh-37.md', 2],
    ],
  },
  {
    qid: 'kw-10',
    category: 'keyword',
    lang: 'zh',
    query: 'Recall@K 衡量的是查全能力吗？',
    keyword: 'Recall@K',
    rel: [
      ['zh-33.md', 3],
      ['zh-34.md', 2],
      ['zh-36.md', 1],
    ],
  },
  {
    qid: 'kw-11',
    category: 'keyword',
    lang: 'zh',
    query: 'nDCG@K 的 gain 为什么取 2 的 rel 次方减一？',
    keyword: 'nDCG@K',
    rel: [
      ['zh-34.md', 3],
      ['zh-33.md', 2],
      ['zh-35.md', 2],
    ],
  },
  {
    qid: 'kw-12',
    category: 'keyword',
    lang: 'zh',
    query: 'query_string 里哪些特殊字符必须转义？',
    keyword: 'query_string',
    rel: [
      ['zh-20.md', 3],
      ['zh-17.md', 2],
      ['zh-18.md', 1],
    ],
  },
  {
    qid: 'kw-13',
    category: 'keyword',
    lang: 'zh',
    query: 'Web Worker 能给主线程带来什么好处？',
    keyword: 'Web Worker',
    rel: [
      ['zh-24.md', 3],
      ['zh-21.md', 2],
      ['zh-22.md', 1],
    ],
  },
  {
    qid: 'kw-14',
    category: 'keyword',
    lang: 'en',
    query: 'What does the HNSW ef_search parameter change?',
    keyword: 'HNSW',
    rel: [
      ['en-07.md', 3],
      ['en-05.md', 2],
      ['en-06.md', 2],
    ],
  },
  {
    qid: 'kw-15',
    category: 'keyword',
    lang: 'en',
    query: 'How does nDCG combine position and relevance grades?',
    keyword: 'nDCG',
    rel: [
      ['en-19.md', 3],
      ['en-16.md', 1],
      ['en-20.md', 1],
    ],
  },
  {
    qid: 'kw-16',
    category: 'keyword',
    lang: 'en',
    query: 'When is MRR preferred over recall at a fixed K?',
    keyword: 'MRR',
    rel: [
      ['en-20.md', 3],
      ['en-19.md', 2],
      ['en-16.md', 1],
    ],
  },
  {
    qid: 'kw-17',
    category: 'keyword',
    lang: 'en',
    query: 'When does a browser fall back from WebGPU to WASM?',
    keyword: 'WebGPU',
    rel: [
      ['en-12.md', 3],
      ['en-10.md', 2],
      ['en-09.md', 1],
    ],
  },
  {
    qid: 'kw-18',
    category: 'keyword',
    lang: 'en',
    query: 'How much smaller is the INT8 model file than fp32?',
    keyword: 'INT8',
    rel: [
      ['en-13.md', 3],
      ['en-15.md', 2],
      ['en-14.md', 2],
    ],
  },
  {
    qid: 'kw-19',
    category: 'keyword',
    lang: 'en',
    query: 'How does Paxos replication protect acknowledged writes?',
    keyword: 'Paxos',
    rel: [
      ['en-02.md', 3],
      ['en-04.md', 2],
      ['en-01.md', 1],
    ],
  },
  {
    qid: 'kw-20',
    category: 'keyword',
    lang: 'en',
    query: 'What fields does BM25 use to score a document?',
    keyword: 'BM25',
    rel: [
      ['en-18.md', 3],
      ['en-17.md', 2],
      ['en-19.md', 1],
    ],
  },
  // ================================================================ paraphrase（同义改写，20：zh 14 / en 6）
  {
    qid: 'pp-01',
    category: 'paraphrase',
    lang: 'zh',
    query: '用 8 位整数保存权重能把模型缩小到四分之一吗？',
    rel: [
      ['zh-29.md', 3],
      ['zh-31.md', 2],
      ['zh-30.md', 1],
    ],
  },
  {
    qid: 'pp-02',
    category: 'paraphrase',
    lang: 'zh',
    query: '多层图结构为什么能做到接近对数级的近邻查找？',
    rel: [
      ['zh-13.md', 3],
      ['zh-14.md', 2],
      ['zh-15.md', 1],
    ],
  },
  {
    qid: 'pp-03',
    category: 'paraphrase',
    lang: 'zh',
    query: '把向量化计算放到后台线程能不能解决界面卡顿？',
    rel: [
      ['zh-24.md', 3],
      ['zh-21.md', 2],
      ['zh-26.md', 1],
    ],
  },
  {
    qid: 'pp-04',
    category: 'paraphrase',
    lang: 'zh',
    query: '显卡接口不可用时页面会自动切换执行路径吗？',
    rel: [
      ['zh-27.md', 3],
      ['zh-28.md', 2],
      ['zh-25.md', 1],
    ],
  },
  {
    qid: 'pp-05',
    category: 'paraphrase',
    lang: 'zh',
    query: '把语义召回和字面匹配两路结果合并排序可行吗？',
    rel: [
      ['zh-17.md', 3],
      ['zh-19.md', 2],
      ['zh-18.md', 1],
    ],
  },
  {
    qid: 'pp-06',
    category: 'paraphrase',
    lang: 'zh',
    query: '多数副本确认之后才算写入成功是怎么实现的？',
    rel: [
      ['zh-06.md', 3],
      ['zh-05.md', 2],
      ['zh-07.md', 1],
    ],
  },
  {
    qid: 'pp-07',
    category: 'paraphrase',
    lang: 'zh',
    query: '同样的内容重新导入为什么不会出现重复条目？',
    rel: [
      ['zh-39.md', 3],
      ['zh-37.md', 2],
      ['zh-38.md', 1],
    ],
  },
  {
    qid: 'pp-08',
    category: 'paraphrase',
    lang: 'zh',
    query: '模型权重能不能存在浏览器本地，避免每次重新下载？',
    rel: [
      ['zh-23.md', 3],
      ['zh-21.md', 2],
      ['zh-22.md', 1],
    ],
  },
  {
    qid: 'pp-09',
    category: 'paraphrase',
    lang: 'zh',
    query: '把两路排名按倒数累加就能融合出最终顺序吗？',
    rel: [
      ['zh-19.md', 3],
      ['zh-17.md', 2],
      ['zh-18.md', 1],
    ],
  },
  {
    qid: 'pp-10',
    category: 'paraphrase',
    lang: 'zh',
    query: '既要考虑排名位置又要放大高相关等级的打分方式是什么？',
    rel: [
      ['zh-34.md', 3],
      ['zh-33.md', 2],
      ['zh-35.md', 1],
    ],
  },
  {
    qid: 'pp-11',
    category: 'paraphrase',
    lang: 'zh',
    query: 'seekdb 有没有不用单独启动进程的运行方式？',
    rel: [
      ['zh-02.md', 3],
      ['zh-03.md', 2],
      ['zh-01.md', 1],
    ],
  },
  {
    qid: 'pp-12',
    category: 'paraphrase',
    lang: 'zh',
    query: '从原始文件到可以被检索，中间要经过哪些阶段？',
    rel: [
      ['zh-37.md', 3],
      ['zh-38.md', 2],
      ['zh-39.md', 1],
    ],
  },
  {
    qid: 'pp-13',
    category: 'paraphrase',
    lang: 'zh',
    query: '用 16 位浮点保存参数能让体积减半吗？',
    rel: [
      ['zh-30.md', 3],
      ['zh-29.md', 2],
      ['zh-31.md', 1],
    ],
  },
  {
    qid: 'pp-14',
    category: 'paraphrase',
    lang: 'zh',
    query: '搜索时扩大候选队列会提高命中率但变慢吗？',
    rel: [
      ['zh-15.md', 3],
      ['zh-13.md', 2],
      ['zh-14.md', 1],
    ],
  },
  {
    qid: 'pp-15',
    category: 'paraphrase',
    lang: 'en',
    query: 'How do databases find similar vectors without scanning every row?',
    rel: [
      ['en-05.md', 3],
      ['en-08.md', 2],
      ['en-06.md', 1],
    ],
  },
  {
    qid: 'pp-16',
    category: 'paraphrase',
    lang: 'en',
    query: 'Why does half precision keep embedding quality almost unchanged?',
    rel: [
      ['en-14.md', 3],
      ['en-13.md', 2],
      ['en-15.md', 1],
    ],
  },
  {
    qid: 'pp-17',
    category: 'paraphrase',
    lang: 'en',
    query: 'What is the average of reciprocal positions of the first correct hits?',
    rel: [
      ['en-20.md', 3],
      ['en-19.md', 2],
      ['en-16.md', 1],
    ],
  },
  {
    qid: 'pp-18',
    category: 'paraphrase',
    lang: 'en',
    query: 'How can ranking quality be scored when chunks carry relevance grades?',
    rel: [
      ['en-19.md', 3],
      ['en-20.md', 2],
      ['en-16.md', 1],
    ],
  },
  {
    qid: 'pp-19',
    category: 'paraphrase',
    lang: 'en',
    query: "Why should a downloaded model be cached on the user's machine?",
    rel: [
      ['en-09.md', 3],
      ['en-12.md', 2],
      ['en-10.md', 1],
    ],
  },
  {
    qid: 'pp-20',
    category: 'paraphrase',
    lang: 'en',
    query: 'What keeps replicated data safe when one server crashes?',
    rel: [
      ['en-02.md', 3],
      ['en-04.md', 2],
      ['en-03.md', 1],
    ],
  },
];

function countCjk(text: string): number {
  let n = 0;
  for (const ch of text) if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)) n += 1;
  return n;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** 把文档级标注展开成 chunk 级 qrels（第 0 块沿用 grade，其余块 max(1, grade-1)） */
function expandQrels(seed: SeedQuery, chunksBySource: Map<string, CorpusChunk[]>): EvalQuery['relevant'] {
  const relevant: EvalQuery['relevant'] = [];
  for (const [source, grade] of seed.rel) {
    const chunks = chunksBySource.get(source);
    if (!chunks || chunks.length === 0) {
      throw new Error(`${seed.qid}: 标注引用了不存在的文档 ${source}`);
    }
    for (const chunk of chunks) {
      const chunkGrade = chunk.chunkIndex === 0 ? grade : Math.max(1, grade - 1);
      if (chunkGrade > 0) relevant.push({ source, chunkIndex: chunk.chunkIndex, grade: chunkGrade });
    }
  }
  return relevant;
}

async function main(): Promise<void> {
  const problems: string[] = [];

  // 1) 数据规模与长度约束
  const zhDocs = DOCS.filter((doc) => doc.source.startsWith('zh-'));
  const enDocs = DOCS.filter((doc) => doc.source.startsWith('en-'));
  if (DOCS.length !== 60 || zhDocs.length !== 40 || enDocs.length !== 20) {
    problems.push(`文档数应为 60（zh 40 / en 20），实际 ${DOCS.length}（zh ${zhDocs.length} / en ${enDocs.length}）`);
  }
  for (const doc of DOCS) {
    if (doc.source.startsWith('zh-')) {
      const chars = countCjk(doc.text);
      if (chars < 40 || chars > 120) problems.push(`${doc.source}: 中文字数 ${chars} 超出 40-120`);
    } else if (doc.source.startsWith('en-')) {
      const words = countWords(doc.text);
      if (words < 40 || words > 120) problems.push(`${doc.source}: 英文词数 ${words} 超出 40-120`);
    } else {
      problems.push(`${doc.source}: 文件名需以 zh- / en- 开头`);
    }
  }
  if (new Set(DOCS.map((doc) => doc.source)).size !== DOCS.length) problems.push('文档 source 有重复');
  if (new Set(QUERIES.map((query) => query.qid)).size !== QUERIES.length) problems.push('查询 qid 有重复');

  // 2) 查询三类各 20
  const categoryCount: Record<EvalCategory, number> = { semantic: 0, keyword: 0, paraphrase: 0 };
  for (const query of QUERIES) categoryCount[query.category] += 1;
  for (const [category, count] of Object.entries(categoryCount)) {
    if (count !== 20) problems.push(`查询类别 ${category} 应为 20 条，实际 ${count}`);
  }

  // 3) 写语料并分块（真实浏览器分块逻辑），同时建立 source -> chunks 映射
  await mkdir(CORPUS_DIR, { recursive: true });
  const expectedSources = new Set(DOCS.map((doc) => doc.source));
  for (const name of await readdir(CORPUS_DIR)) {
    if (/\.(md|txt)$/i.test(name) && !expectedSources.has(name)) {
      await unlink(path.join(CORPUS_DIR, name));
    }
  }
  const chunksBySource = new Map<string, CorpusChunk[]>();
  const allChunks: CorpusChunk[] = [];
  for (const doc of DOCS) {
    const chunks = chunkDocument(doc.source, doc.text);
    if (chunks.length === 0) problems.push(`${doc.source}: 分块结果为空`);
    chunksBySource.set(doc.source, chunks);
    allChunks.push(...chunks);
    await writeFile(path.join(CORPUS_DIR, doc.source), `${doc.text.trim()}\n`, 'utf8');
  }

  // 4) 展开 chunk 级 qrels 并输出 queries.jsonl
  const queries = normalizeEvalQueries(
    QUERIES.map((seed) => {
      const row: Record<string, unknown> = {
        qid: seed.qid,
        category: seed.category,
        lang: seed.lang,
        query: seed.query,
        relevant: expandQrels(seed, chunksBySource),
      };
      if (seed.keyword) row.keyword = seed.keyword;
      return row;
    }),
    'queries.jsonl',
  );
  const lines = queries.map((query) => JSON.stringify(query));
  await writeFile(QUERIES_FILE, `${lines.join('\n')}\n`, 'utf8');

  // 5) 结构校验（与 eval-quality 使用的是同一个校验函数）
  problems.push(...validateEvalSet(queries, allChunks));

  // 6) 统计输出
  const chunkCounts = new Map<number, number>();
  for (const chunks of chunksBySource.values()) {
    chunkCounts.set(chunks.length, (chunkCounts.get(chunks.length) ?? 0) + 1);
  }
  const summary = [...chunkCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([count, docs]) => `${count} 块 × ${docs} 篇`)
    .join('，');
  const relevantPairs = queries.reduce((sum, query) => sum + query.relevant.length, 0);
  console.log('[eval-data] 文档：60 篇（zh 40 / en 20）');
  console.log(`[eval-data] 分块：${allChunks.length} 块（${summary}）`);
  console.log(`[eval-data] 查询：${queries.length} 条（semantic/keyword/paraphrase = 20/20/20）`);
  console.log(`[eval-data] chunk 级相关标注：${relevantPairs} 条`);
  console.log(`[eval-data] 输出：${CORPUS_DIR}、${QUERIES_FILE}`);

  if (problems.length > 0) {
    console.error(`\n[eval-data] 校验失败（${problems.length} 项）：`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('[eval-data] 校验通过：chunk 级 qrels 与浏览器分块/ID 规则一致。');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
