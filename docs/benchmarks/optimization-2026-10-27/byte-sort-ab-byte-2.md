# 浏览器基准 · ab-byte-2

- 时间：2026-10-27T16:02:29.133Z
- 页面：http://localhost:5173（?perf=1）
- 驱动模式：`window.__seekvecEval`（契约 perf API）
- 浏览器：Edg/156.0.4314.42（C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe）
- 后端：wasm · dtype=q8 · batch=32
- 冷/热：warm start；计入统计 3 轮（预热 1 轮已丢弃）
- 语料：120 篇；查询：10 条；collection：`bench_ab_byte_2`
- 环境：win32 · 28 核 · deviceMemory=16GB · GPU=未知 · 实测后端=wasm
- 模型：Xenova/bge-small-zh-v1.5 @ 75c43b069aac · dtype=q8 · key=text_zh

## 阶段耗时（ms）

| 阶段 | 轮数 | n | p50 | p95 | mean | p50 IQR |
|---|---|---|---|---|---|---|
| db.search | 3 | 10 | 3.4 | 4.8 | 3.6 | 0.1 |
| doc.chunk | 3 | 120 | 0.0 | 0.0 | 0.0 | 0.0 |
| doc.embed | 3 | 4 | 492.0 | 526.3 | 477.1 | 7.9 |
| doc.read | 3 | 120 | 0.6 | 2.3 | 0.9 | 0.1 |
| doc.write | 3 | 4 | 79.8 | 572.9 | 216.4 | 5.8 |
| index.refresh | 3 | 1 | 606.7 | 606.7 | 606.7 | 100.5 |
| ingest.total | 3 | 1 | 3037.2 | 3037.2 | 3037.2 | 134.3 |
| query.e2e | 3 | 10 | 27.0 | 29.6 | 26.0 | 2.8 |
| query.embed | 3 | 10 | 5.9 | 8.1 | 6.2 | 0.6 |
| query.http | 3 | 10 | 10.2 | 12.8 | 10.6 | 0.9 |

## 导入（每轮）

| run | count | readMs | chunkMs | embedMs | writeMs/upsertMs | refreshMs | cleanupMs | totalMs | wallMs |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 120 | 126.0 | 0.8 | 1874.9 | 857.9 | 606.7 | 0.0 | 2962.3 | 2981.0 |
| 2 | 120 | 112.9 | 0.8 | 1950.5 | 865.5 | 603.6 | 0.0 | 3037.2 | 3054.0 |
| 3 | 120 | 106.9 | 0.6 | 1908.3 | 1107.4 | 804.5 | 0.0 | 3230.9 | 3250.0 |

导入 wall 中位数：3054.0 ms（IQR 134.5 ms）

## 查询（每轮）

| run | 查询数 | e2e p50 (ms) | e2e p95 (ms) | 平均 wall (ms) |
|---|---|---|---|---|
| 1 | 10 | 27.5 | 37.1 | 29.9 |
| 2 | 10 | 22.0 | 28.0 | 26.7 |
| 3 | 10 | 27.0 | 29.6 | 29.5 |

查询 e2e 中位数：27.0 ms（p95 30.0 ms，样本 30）

## 说明

- 每轮先清空 `__seekvecPerf` 事件再执行；预热轮不计入统计（首轮含模型加载）。
- 阶段指标为各轮内 p50 跨轮的中位数；IQR = Q3−Q1，反映轮间波动。
- 原始数据（含全部 perf 事件）见同目录 `raw.json`。
- 生成命令见 raw.json 的 `command` 字段；重跑请使用相同参数与语料。
