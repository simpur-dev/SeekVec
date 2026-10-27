# 浏览器基准 · adaptive-default

- 时间：2026-10-27T16:20:09.956Z
- 页面：http://localhost:5173（?perf=1）
- 驱动模式：`window.__seekvecEval`（契约 perf API）
- 浏览器：Edg/156.0.4314.42（C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe）
- 后端：wasm · dtype=q8 · batch=32
- 冷/热：warm start；计入统计 3 轮（预热 1 轮已丢弃）
- 语料：120 篇；查询：10 条；collection：`bench_adaptive_default`
- 环境：win32 · 28 核 · deviceMemory=16GB · GPU=未知 · 实测后端=wasm
- 模型：Xenova/bge-small-zh-v1.5 @ 75c43b069aac · dtype=q8 · key=text_zh
- 生效配置：batch=32 · threads=16 · refresh=last

## 阶段耗时（ms）

| 阶段 | 轮数 | n | p50 | p95 | mean | p50 IQR |
|---|---|---|---|---|---|---|
| db.search | 3 | 10 | 3.4 | 5.6 | 3.9 | 0.2 |
| doc.chunk | 3 | 120 | 0.0 | 0.0 | 0.0 | 0.0 |
| doc.embed | 3 | 4 | 335.7 | 357.6 | 334.7 | 1.7 |
| doc.read | 3 | 120 | 0.7 | 2.3 | 0.9 | 0.1 |
| doc.write | 3 | 4 | 87.6 | 505.0 | 214.9 | 12.0 |
| index.refresh | 3 | 1 | 504.7 | 504.7 | 504.7 | 100.3 |
| ingest.total | 3 | 1 | 2413.1 | 2413.1 | 2413.1 | 107.5 |
| query.e2e | 3 | 10 | 25.0 | 30.2 | 25.3 | 2.5 |
| query.embed | 3 | 10 | 5.4 | 7.3 | 5.4 | 0.2 |
| query.http | 3 | 10 | 10.9 | 14.2 | 11.3 | 0.3 |

## 导入（每轮）

| run | count | readMs | chunkMs | embedMs | writeMs/upsertMs | refreshMs | cleanupMs | totalMs | wallMs |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 120 | 124.5 | 0.8 | 1327.9 | 783.6 | 503.8 | 0.0 | 2339.8 | 2360.0 |
| 2 | 120 | 107.5 | 0.7 | 1363.4 | 980.9 | 704.4 | 0.0 | 2554.8 | 2576.0 |
| 3 | 120 | 106.0 | 0.5 | 1338.9 | 859.4 | 504.7 | 0.0 | 2413.1 | 2440.0 |

导入 wall 中位数：2440.0 ms（IQR 108.0 ms）

## 查询（每轮）

| run | 查询数 | e2e p50 (ms) | e2e p95 (ms) | 平均 wall (ms) |
|---|---|---|---|---|
| 1 | 10 | 27.0 | 30.8 | 28.5 |
| 2 | 10 | 22.0 | 30.2 | 26.4 |
| 3 | 10 | 25.0 | 30.2 | 27.6 |

查询 e2e 中位数：24.5 ms（p95 32.0 ms，样本 30）

## 说明

- 每轮先清空 `__seekvecPerf` 事件再执行；预热轮不计入统计（首轮含模型加载）。
- 阶段指标为各轮内 p50 跨轮的中位数；IQR = Q3−Q1，反映轮间波动。
- 原始数据（含全部 perf 事件）见同目录 `raw.json`。
- 生成命令见 raw.json 的 `command` 字段；重跑请使用相同参数与语料。
