# data/perf · 确定性性能测试语料

本目录是 SeekVec **性能测试专用**的确定性语料：只用于测量导入吞吐、索引刷新、查询延迟与端到端
延迟，**不用于检索质量评测**（质量评测见 `data/eval/`，两者不要混用指标）。

## 1. 当前规模

| 项 | 数值 |
|---|---|
| 文档 | 120 篇（`perf-0001.md` … `perf-0120.md`） |
| chunk | **120 个**（每篇单段落且 ≤ 256 字符 → 浏览器默认分块后恰好 1 chunk） |
| 查询 | 10 条（`queries.txt`，每行一条） |
| 覆盖主题 | seekdb 定位、OceanBase 存储、ANN 索引（HNSW/IVF）、混合检索（BM25/RRF）、端侧推理、WebGPU/WASM、INT8/FP16 量化、性能评测、导入与刷新、模型缓存 |
| 生成方式 | `data/perf/generate.ts`（无随机数、无时间戳，重跑逐字节一致） |

## 2. 文件格式

- `corpus/perf-NNNN.md`：UTF-8 单段落纯文本（无标题行、无空行），文件编号从 0001 连续递增；
  每篇内容带唯一编号 `P0001` 等，保证文本互不相同、embedding 不退化；
- `queries.txt`：UTF-8 文本，每行一条查询（10 行，无空行），供 `scripts/bench-browser.mjs`
  的 `--queries` 使用。查询包含技术关键词（如 `HNSW`、`WebGPU`、`INT8`、`混合检索`），
  以便同时触发 seekdb 的向量与全文（hybrid）路径，测出两路检索的真实延迟。

## 3. 重新生成 / 调整规模

```bash
# 仓库根目录（scripts 依赖已安装，用 scripts 内的 tsx）
npx tsx data/perf/generate.ts              # 默认 120 篇 → 120 chunks
npx tsx data/perf/generate.ts --docs 300   # 50–400 篇，1 篇 = 1 chunk
```

- `--docs` 合法范围 **50–400**（对应 50–400 chunks）；脚本会校验「每篇恰好 1 chunk」与
  「总 chunk 数在 50–400」，不满足直接失败；
- 生成后 `data/perf/corpus/` 会整体覆盖（先删除多余旧文件再写入），因此重跑结果确定；
- 性能数据记录时必须注明语料规模（文档数/chunk 数）；不同规模的延迟不可直接比较。

## 4. 浏览器基准怎么用

```bash
python -m http.server 5173 --directory web/dist   # 仅示例
# 实际用 scripts/bench-browser.mjs（tooling 提供）：
node scripts/bench-browser.mjs --corpus data/perf/corpus --queries data/perf/queries.txt ...
```

- `bench-browser.mjs` 默认读取 `data/perf/corpus` 与 `data/perf/queries.txt`；
- 导入 120 篇 ≈ 120 chunks，适合测量 batch（1/8/16）与 refresh（each/last）的差异；
- 若需更大规模（如 400 chunks 的索引刷新开销），用 `--docs 400` 重新生成后重跑，
  并在报告中同步更新语料规模。

## 5. 许可与说明

- 语料为项目自行生成的合成文本（synthetic），不包含任何第三方版权内容；
- 文档内容只用于让不同主题的向量有区分度，不构成技术事实承诺；
- 可随仓库自由使用、修改与再生成。
