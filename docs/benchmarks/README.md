# 性能与质量基准数据

> 本目录保存**可复现的原始数据**（随仓库提交）与汇总说明；最终解读见 [`docs/性能与质量报告.md`](../性能与质量报告.md)。
> 主口径是真实应用链路：浏览器 Transformers.js 端侧推理 → HTTP → seekdb 检索 → 渲染。Node 端 `eval:quality` 只做质量回归，不产生浏览器性能数字。

## 1. 目录内容

| 路径 | 内容 |
|---|---|
| `matrix.json` | 最终性能主矩阵定义（FP32/INT8/FP16/冷启动；batch=32、WASM threads=8；ABBA + 5 轮 + 1 预热） |
| `matrix-2026-10-27/` | **最终主矩阵**：4 配置 × ABBA × 5 轮；`matrix-summary.md`、`matrix-raw.json`、`phase-aggregate.{md,json}`、`NN-<config>/` |
| `matrix-2026-10-26/` | 优化前基线（历史数据，用于 before/after 对比） |
| `fallback-2026-10-27/` | **WebGPU 不可用验证**：Edge 156 禁用 GPU/WebGPU 后 auto→WASM；raw/summary + 徽标截图/UI 文本 |
| `edge-webgpu-2026-10-27/` | Edge 156 WebGPU/fp16 兼容冒烟：raw/summary + 徽标截图 |
| `optimization-2026-10-27/` | 深度优化证据：batch/threads 严格消融、增量导入（reimport-result.json）、陈旧块刷新合并 e2e、token-padding 模拟与 UTF-8 字节排序 A/B、写入/embedding 流水线 A/B、查询指令 A/B |
| `eval-quality/` | Node 质量回归（fp32/q8/fp16；60 文档/73 chunks/60 查询/229 qrels）：`raw.json`、`summary.md` |
| `quality-browser/` | 浏览器实际链路质量（fp32+WASM / q8+WASM / fp16+WebGPU）：三组 `raw.json`+`summary.md`、汇总 `raw.json`+`summary.md` |

## 2. 观测接口与运行协议

浏览器页面加 `?perf=1` 后暴露（仅该模式，平时不产生事件）：

- `window.__seekvecPerf.snapshot()/summary()/clear()`：分阶段事件（`model.download`、`model.init`、`model.total`、`doc.read`、`doc.chunk`、`doc.embed`、`doc.write`、`index.refresh`、`ingest.total`、`query.embed`、`db.search`、`query.http`、`query.e2e`），环形缓冲 2000 条；summary 输出 n/p50/p95/mean。
- `window.__seekvecEval.ingestFiles(files, collection)` / `search(query, keyword?, nResults?)` / `reset()`：脚本化真实导入与检索（复用应用 runtime 与 API）。

每轮流程：清空 perf 事件 → 导入全部语料 → 逐条执行查询 → 读取 summary/snapshot。预热轮不计入统计；正式轮逐轮独立记录。查询端到端在结果渲染后（双 rAF）打点。

## 3. 常用命令

> 复现 fp32 基线或完整矩阵前，先补齐 fp32 权重：`node scripts/fetch-models.mjs --dtype all`（默认 `prepare:assets` 只有 q8/fp16）。

```bash
# 前置：dev server（5173）与 seekdb 运行；data/perf 语料已生成；npm run prepare:assets 已执行
npm run bench:browser -- --backend wasm --dtype q8 --batch 32 --threads 8 --refresh last --runs 5 --warmup 1
npm run bench:browser -- --backend webgpu --dtype fp16 --batch 32 --cold
npm run bench:browser -- --backend auto --no-webgpu   # 模拟 WebGPU 不可用，验证 auto→WASM 降级与界面提示
npm run bench:browser -- --check          # 环境自检：浏览器/页面/语料，不跑基准
npm run bench:browser -- --smoke          # 冒烟：1 次导入 + 1 条查询

npm run bench:matrix                      # 读 docs/benchmarks/matrix.json，ABBA 跑完整矩阵
npm run bench:matrix -- --dry-run         # 只打印计划
npm run bench:matrix -- --only fp32-wasm,q8-wasm
npm run bench:matrix -- --out docs/benchmarks/matrix-YYYY-MM-DD

npm run eval:quality                      # Node 质量回归
npm run eval:quality -- --out docs/benchmarks/eval-quality
npm run eval:quality:browser -- --out docs/benchmarks/quality-browser
```

产物：`browser-<backend>-<dtype>-<时间戳>/{raw.json,summary.md}`；矩阵输出 `matrix-<时间戳>/{matrix-raw.json,matrix-summary.md,NN-<config>/...}`。
浏览器探测顺序：`--browser-path` / `$BROWSER_PATH` → 上次成功缓存 → 常见 Chrome/Edge → Playwright 缓存；不写死用户名。profile 在 `scripts/.cache/bench-profile/`（gitignore）。

## 4. 矩阵定义（`matrix.json`）

```jsonc
{
  "schemaVersion": 1,
  "abba": true,              // 正序 + 逆序各一次，抵消热漂移
  "runs": 5,                 // 每格正式轮（丢弃首次/预热）
  "warmup": 1,
  "timeoutMs": 300000,
  "corpus": "data/perf/corpus",
  "queries": "data/perf/queries.txt",
  "configs": [
    { "id": "fp32-wasm", "backend": "wasm", "dtype": "fp32", "batch": 16, "refresh": "last", "cold": false },
    { "id": "q8-wasm", "backend": "wasm", "dtype": "q8", "batch": 16, "refresh": "last", "cold": false },
    { "id": "fp16-webgpu", "backend": "webgpu", "dtype": "fp16", "batch": 16, "refresh": "last", "cold": false },
    { "id": "q8-wasm-batch1", "backend": "wasm", "dtype": "q8", "batch": 1, "refresh": "last", "cold": false },
    { "id": "q8-wasm-refresh-each", "backend": "wasm", "dtype": "q8", "batch": 16, "refresh": "each", "cold": false },
    { "id": "cold-q8-wasm", "backend": "wasm", "dtype": "q8", "batch": 16, "refresh": "last", "cold": true }
  ]
}
```

无 WebGPU 的机器：用 `--only` 过滤掉 `fp16-webgpu`。`raw.json` 会记录实际 backend；WebGPU 不可用时脚本标记 fallback，不会静默当作 WebGPU。

## 5. 统计与质量门

- 每格 ≥5 个正式轮（丢弃预热），报告**中位数 + IQR**；矩阵 ABBA 双向，聚合跨调用中位数。
- 阶段值：各轮内 p50 → 跨轮取中位数；IQR = Q3−Q1，反映轮间波动。
- 质量门（Lead 判定，报告已披露）：
  - q8/fp16 相对 fp32：**Recall@5 降幅 ≤2 个百分点**、**nDCG@10 降幅 ≤0.02**；
  - 超门必须分析原因，不得删数据或改口径。
- 质量指标两套口径：Node 精确余弦（`eval-quality`）与浏览器真实链路（`quality-browser`，含 seekdb HNSW/hybrid RRF）；两套互补，不混算。

## 6. 注意事项

- 基准前关闭其它占 GPU/CPU 的重负载任务；同一台机器、同一浏览器版本内比较；不要加 `--disable-gpu`（WebGPU 需要真实 GPU 进程）。
- 冷启动：`--cold` 每轮清空 user-data-dir/CacheStorage 并重载页面；本环境模型来自本地静态目录，model.download 代表本地加载（公网下载另计）。
- 每次基准自动 `DELETE /api/collections/<collection>` 清理；`--keep` 保留现场。
- 原始数据提交入库；模型权重、浏览器 profile、`scripts/.cache/` 不入库。
- 2026-10-26 矩阵环境/口径/全部数字见[性能与质量报告](../性能与质量报告.md)。
