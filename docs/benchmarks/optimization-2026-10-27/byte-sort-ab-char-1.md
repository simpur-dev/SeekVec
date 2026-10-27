# 浏览器基准 · ab-char-1

- 时间：2026-10-27T16:01:47.927Z
- 页面：http://localhost:5173（?perf=1）
- 驱动模式：`window.__seekvecEval`（契约 perf API）
- 浏览器：Edg/156.0.4314.42（C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe）
- 后端：wasm · dtype=q8 · batch=32
- 冷/热：warm start；计入统计 3 轮（预热 1 轮已丢弃）
- 语料：120 篇；查询：10 条；collection：`bench_ab_char_1`
- 环境：win32 · 28 核 · deviceMemory=16GB · GPU=未知 · 实测后端=wasm
- 模型：Xenova/bge-small-zh-v1.5 @ 75c43b069aac · dtype=q8 · key=text_zh

## 阶段耗时（ms）

| 阶段 | 轮数 | n | p50 | p95 | mean | p50 IQR |
|---|---|---|---|---|---|---|
| db.search | 3 | 10 | 3.4 | 6.4 | 3.8 | 0.2 |
| doc.chunk | 3 | 120 | 0.0 | 0.0 | 0.0 | 0.0 |
| doc.embed | 3 | 4 | 528.6 | 586.7 | 513.8 | 19.2 |
| doc.read | 3 | 120 | 0.7 | 2.3 | 0.9 | 0.1 |
| doc.write | 3 | 4 | 92.8 | 493.2 | 203.1 | 6.9 |
| index.refresh | 3 | 1 | 505.7 | 505.7 | 505.7 | 50.0 |
| ingest.total | 3 | 1 | 3133.6 | 3133.6 | 3133.6 | 86.1 |
| query.e2e | 3 | 10 | 27.0 | 32.6 | 26.4 | 2.5 |
| query.embed | 3 | 10 | 5.8 | 10.3 | 6.8 | 1.0 |
| query.http | 3 | 10 | 10.6 | 13.8 | 11.2 | 1.2 |

## 导入（每轮）

| run | count | readMs | chunkMs | embedMs | writeMs/upsertMs | refreshMs | cleanupMs | totalMs | wallMs |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 120 | 124.6 | 0.9 | 2148.6 | 812.3 | 504.0 | 0.0 | 3189.8 | 3211.0 |
| 2 | 120 | 112.8 | 0.8 | 1998.4 | 919.9 | 604.1 | 0.0 | 3133.6 | 3150.0 |
| 3 | 120 | 100.6 | 0.6 | 2055.1 | 760.2 | 505.7 | 0.0 | 3017.6 | 3036.0 |

导入 wall 中位数：3150.0 ms（IQR 87.5 ms）

## 查询（每轮）

| run | 查询数 | e2e p50 (ms) | e2e p95 (ms) | 平均 wall (ms) |
|---|---|---|---|---|
| 1 | 10 | 27.0 | 36.3 | 29.5 |
| 2 | 10 | 22.5 | 29.6 | 27.0 |
| 3 | 10 | 27.5 | 32.6 | 29.6 |

查询 e2e 中位数：27.0 ms（p95 32.6 ms，样本 30）

## 说明

- 每轮先清空 `__seekvecPerf` 事件再执行；预热轮不计入统计（首轮含模型加载）。
- 阶段指标为各轮内 p50 跨轮的中位数；IQR = Q3−Q1，反映轮间波动。
- 原始数据（含全部 perf 事件）见同目录 `raw.json`。
- 生成命令见 raw.json 的 `command` 字段；重跑请使用相同参数与语料。
