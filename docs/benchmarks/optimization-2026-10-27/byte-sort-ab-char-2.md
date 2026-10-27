# 浏览器基准 · ab-char-2

- 时间：2026-10-27T16:02:47.364Z
- 页面：http://localhost:5173（?perf=1）
- 驱动模式：`window.__seekvecEval`（契约 perf API）
- 浏览器：Edg/156.0.4314.42（C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe）
- 后端：wasm · dtype=q8 · batch=32
- 冷/热：warm start；计入统计 3 轮（预热 1 轮已丢弃）
- 语料：120 篇；查询：10 条；collection：`bench_ab_char_2`
- 环境：win32 · 28 核 · deviceMemory=16GB · GPU=未知 · 实测后端=wasm
- 模型：Xenova/bge-small-zh-v1.5 @ 75c43b069aac · dtype=q8 · key=text_zh

## 阶段耗时（ms）

| 阶段 | 轮数 | n | p50 | p95 | mean | p50 IQR |
|---|---|---|---|---|---|---|
| db.search | 3 | 10 | 3.3 | 5.7 | 3.8 | 0.2 |
| doc.chunk | 3 | 120 | 0.0 | 0.0 | 0.0 | 0.0 |
| doc.embed | 3 | 4 | 541.8 | 558.2 | 515.2 | 19.3 |
| doc.read | 3 | 120 | 0.6 | 2.1 | 0.9 | 0.1 |
| doc.write | 3 | 4 | 85.2 | 486.6 | 192.6 | 13.1 |
| index.refresh | 3 | 1 | 504.3 | 504.3 | 504.3 | 0.3 |
| ingest.total | 3 | 1 | 3036.9 | 3036.9 | 3036.9 | 17.3 |
| query.e2e | 3 | 10 | 22.0 | 29.1 | 24.3 | 2.5 |
| query.embed | 3 | 10 | 5.5 | 7.3 | 5.5 | 1.0 |
| query.http | 3 | 10 | 10.2 | 14.5 | 11.0 | 0.4 |

## 导入（每轮）

| run | count | readMs | chunkMs | embedMs | writeMs/upsertMs | refreshMs | cleanupMs | totalMs | wallMs |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 120 | 114.1 | 0.7 | 2060.8 | 770.5 | 504.0 | 0.0 | 3046.4 | 3066.0 |
| 2 | 120 | 102.8 | 0.8 | 1996.7 | 812.1 | 504.3 | 0.0 | 3011.9 | 3029.0 |
| 3 | 120 | 107.8 | 0.5 | 2063.8 | 769.0 | 504.6 | 0.0 | 3036.9 | 3056.0 |

导入 wall 中位数：3056.0 ms（IQR 18.5 ms）

## 查询（每轮）

| run | 查询数 | e2e p50 (ms) | e2e p95 (ms) | 平均 wall (ms) |
|---|---|---|---|---|
| 1 | 10 | 22.0 | 29.1 | 26.8 |
| 2 | 10 | 27.0 | 30.8 | 28.5 |
| 3 | 10 | 22.0 | 28.0 | 26.7 |

查询 e2e 中位数：22.0 ms（p95 29.1 ms，样本 30）

## 说明

- 每轮先清空 `__seekvecPerf` 事件再执行；预热轮不计入统计（首轮含模型加载）。
- 阶段指标为各轮内 p50 跨轮的中位数；IQR = Q3−Q1，反映轮间波动。
- 原始数据（含全部 perf 事件）见同目录 `raw.json`。
- 生成命令见 raw.json 的 `command` 字段；重跑请使用相同参数与语料。
