# data/eval · SeekVec 检索质量评测集

本目录是 SeekVec 的**自有**检索质量评测集，用于回答技术说明里的核心问题：
同一批语料、同一套分块与排序逻辑下，**量化（q8 / fp16）相对 fp32 的检索质量变化有多大**，
以及不同模型（中文 bge-small-zh-v1.5 / 英文 all-MiniLM-L6-v2）的质量差异。

> 用途：`npm run eval:quality`（Node CPU，Transformers.js）的离线质量回归，结果可直接支撑
> 赛题 3.2.2「对比模型体积」、3.2.3「检查检索质量」两条验收要求。浏览器主口径（实际应用链路）
> 由 `scripts/bench-browser.mjs` 在 `data/perf` 上测量，二者场景不同、互不替代。

## 1. 规模与文件结构

```
data/eval/
├── corpus/            # 60 篇单段落 Markdown 文档（文件名即 source）
│   ├── zh-01.md … zh-40.md   中文 40 篇，每篇 40–120 个中文字
│   └── en-01.md … en-20.md   英文 20 篇，每篇 40–120 个英文词
├── queries.jsonl      # 60 条查询 + chunk 级 qrels（每行一个 JSON 对象）
├── generate.ts        # 确定性生成/校验脚本（文档级标注 → chunk 级 qrels）
└── README.md
```

实测规模（`npx tsx data/eval/generate.ts` 输出）：

| 项 | 数值 |
|---|---|
| 文档 | 60（zh 40 / en 20） |
| 分块（浏览器默认参数） | 73 块（47 篇 1 块，13 篇英文 2 块） |
| 查询 | 60（semantic / keyword / paraphrase 各 20；zh 40 / en 20） |
| chunk 级相关标注 | 229 条 |

主题覆盖（中文 10 簇 × 4 篇、英文 5 簇 × 4 篇，保证每个查询都有 ≥3 篇相关文档）：
seekdb 定位与部署、OceanBase 存储/复制/兼容性、向量相似度与距离度量、HNSW/IVF 近似检索、
混合检索（BM25/RRF/全文转义）、端侧推理（Transformers.js/ONNX Runtime Web/Worker/缓存）、
推理后端（WebGPU/WASM/降级）、INT8/FP16 量化与压缩比、质量指标（Recall/nDCG/MRR/qrels）、
导入链路（分块/chunk id/刷新/维度校验）。

## 2. 文件格式

### corpus/*.md
- UTF-8 纯文本，**单段落、无标题行、无空行**（避免标题被切成独立 chunk，保证 chunk 映射稳定）；
- 文件名（含扩展名）就是 `source`，与浏览器 `File.name`、seekdb metadata 里的 `source` 完全一致；
- 文档长度：中文按中文字符计 40–120，英文按单词计 40–120。

### queries.jsonl
```jsonc
{
  "qid": "kw-01",                  // 唯一 ID：sem-/kw-/pp- 前缀区分三类
  "category": "keyword",           // semantic | keyword | paraphrase（契约字段之外的统计用字段）
  "lang": "zh",                    // zh | en（契约字段之外的统计用字段）
  "query": "HNSW 的 ef_search 调大以后召回和延迟怎么变化？",
  "keyword": "HNSW",               // 仅 keyword 类必填，且必须出现在 grade=3 的 chunk 文本中
  "relevant": [                    // chunk 级 qrels；未列出的 (source, chunkIndex) 一律视为 grade=0
    { "source": "zh-15.md", "chunkIndex": 0, "grade": 3 },
    { "source": "zh-13.md", "chunkIndex": 0, "grade": 2 },
    { "source": "zh-14.md", "chunkIndex": 0, "grade": 2 }
  ]
}
```

三类查询的定义：

| 类别 | 数量 | 定义 | 例子 |
|---|---|---|---|
| `semantic` | 20 | 用自然语言描述检索意图，不刻意包含文档原词，考察语义召回 | 「模型文件太大，有什么办法把它变小？」 |
| `keyword` | 20 | 显式包含一个技术关键词（`keyword` 字段），考察字面命中与向量召回的结合 | 「`HNSW` 的 ef_search 调大以后召回和延迟怎么变化？」 |
| `paraphrase` | 20 | 对某篇文档的核心陈述做同义改写，考察同义语义匹配 | 「用 8 位整数保存权重能把模型缩小到四分之一吗？」 |

每条查询均满足：**≥3 个不同的相关 source（rel≥1）**、**≥1 条 rel=3**；paraphrase 类的
grade-3 chunk 即被改写文档的原文，semantic/keyword 类的 grade-3 chunk 直接回答该查询。

## 3. 分块与 ID 一致性（关键口径）

qrels 是 **chunk 级**的，因此必须与运行时写入 seekdb 的 chunk 严格对齐。本目录不复制分块逻辑，
而是复用 web 端实现：

- 分块：`web/src/inference/chunk.ts` 的 `chunkText`，**浏览器默认参数** `maxLength=256`、
  `overlap=32`、`minLength=10`（`useIngest` 调用时不传参）；按双换行分段，长段用重叠滑窗切分；
- ID：`web/src/utils/id.ts` 的 `chunkId(source, chunkIndex, text)`，FNV-1a 32 位哈希，
  同一内容重复导入得到同一 id（幂等 upsert）；
- `scripts/lib/datasets.ts` 直接 `import` 上述两个模块生成 chunk 映射，`scripts/tests/datasets.test.ts`
  会断言「加载器的 chunk 文本/id 与直接调用 web 函数完全一致」；
- 因此 `chunkIndex` 与浏览器一致；13 篇英文文档超过 256 字符被切成 2 块，标注时第 0 块沿用
  文档级 grade，兄弟块 grade 取 `max(1, grade-1)`（同一文档相关，其余块至少弱相关），
  避免把同文档的剩余内容误判为不相关而虚低量化指标。

**修改分块参数 = 修改 chunk 映射**：必须重新运行 `generate.ts` 并 review qrels diff，
否则指标不可比。`eval-quality` 启动时会校验 qrels 能否解析到真实 chunk，不一致直接失败。

## 4. 标注口径（与 `scripts/lib/evalMetrics.ts` 一致）

- 相关性等级 0–3：
  - 3 = 直接回答/语义等价（高相关）；
  - 2 = 强相关（同主题、部分信息）；
  - 1 = 弱相关（主题相邻、可提供背景）；
  - 0 = 不相关；**未标注项按 0 处理**（pooled judgment，标注集只覆盖每个查询的相关簇）。
- 相关判定：**rel ≥ 1 视为相关**（Recall 与 MRR 的相关集合）。
- Recall@K = 前 K 名命中的相关 chunk 数 / 相关 chunk 总数；K∈{1,3,5}。
- nDCG@K：`gain = 2^rel − 1`，`discount = log2(rank+1)`，IDCG 为相关等级降序的理想排序；K∈{5,10}。
- MRR = 第一条相关结果排名的倒数，查询级取平均。
- 聚合口径：**macro average**（先按查询算指标，再对 60 条查询取平均）；同时按 category 输出分类别均值。
- 平局：分数相同时按 chunk id 字典序升序打破平局，保证结果可复现。
- 未标注 chunk 参与排序但 gain=0（会占据排名、影响 nDCG 折损），这是检索评测的标准处理。

## 5. 生成与校验

```bash
# 仓库根目录；scripts 依赖安装后可用 scripts 内的 tsx
npx tsx data/eval/generate.ts          # 重新生成 corpus + queries.jsonl，并做结构校验
npx tsx scripts/eval-quality.ts --validate-only   # 只校验数据（不加载模型）
```

`generate.ts` 是确定性的（无时间戳、无随机数），重跑应得到逐字节相同的数据；
它同时校验：文档数/语言比例、40–120 长度约束、查询三类各 20、每条查询的标注覆盖要求、
qrels 与 chunk 映射一致性、keyword 是否出现在 grade-3 chunk 中。

## 6. 许可与来源

- 全部 60 篇文档、60 条查询与相关性标注均为本项目**原创**（self-authored），不含第三方版权文本；
  参考的公开技术事实（HNSW/BM25/nDCG 等）属通用知识，文档均为重新表述。
- 标注为人工标注：先按「文档」打 0–3 级，再由脚本展开为 chunk 级；**未使用任何模型输出或
  云端 API 生成标注**，避免与评测对象循环自证。
- 本评测集随 SeekVec 仓库一同发布，可用于复现本项目的结果；如需单独引用请注明来源。

## 7. 已知限制

- 规模较小（60 查询）：单条查询的 ±1 个名次变化会带来约 1–2pp 的指标跳动，结论应结合
  原始 JSON 与分类别结果看，不要只看单个数字；
- 单一标注人，无标注一致性（Kappa）统计；
- fp16 在 Node CPU 上由 ONNX Runtime 上采样为 fp32 计算，实测排序与 fp32 完全一致；
  该结果只近似反映「fp16 权重舍入」对质量的影响，浏览器 WebGPU 上 fp16 的实际质量以
  `docs/benchmarks/` 的浏览器实测为准；
- 评测对象是「chunk 级向量检索排序」：`eval-quality` 用纯向量余弦排序（Node CPU 复现量化差异），
  不包含 seekdb 的混合检索与索引近似误差——这两部分由浏览器端 `bench-browser` 与
  `docs/benchmarks/` 的连接实测覆盖。

## 8. 质量门（引用实施契约 §8）

对每个模型、每种量化 dtype 与 fp32 基线比较（同一评测集、同一分块、同一排序规则）：

- Recall@5 降幅 ≤ **2pp**；
- nDCG@10 降幅 ≤ **0.02**。

超阈值必须分析并披露原因。`scripts/eval-quality.ts` 会输出 Δ 值与 PASS/FAIL 判定。
