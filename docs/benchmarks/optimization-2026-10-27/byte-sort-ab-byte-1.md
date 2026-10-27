# 浏览器基准 · ab-byte-1

- 时间：2026-10-27T16:02:06.639Z
- 页面：http://localhost:5173（?perf=1）
- 驱动模式：`window.__seekvecEval`（契约 perf API）
- 浏览器：Edg/156.0.4314.42（C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe）
- 后端：wasm · dtype=q8 · batch=32
- 冷/热：warm start；计入统计 3 轮（预热 1 轮已丢弃）
- 语料：120 篇；查询：10 条；collection：`bench_ab_byte_1`
- 环境：win32 · 28 核 · deviceMemory=16GB · GPU=未知 · 实测后端=wasm
- 模型：Xenova/bge-small-zh-v1.5 @ 75c43b069aac · dtype=q8 · key=text_zh

## 阶段耗时（ms）

| 阶段 | 轮数 | n | p50 | p95 | mean | p50 IQR |
|---|---|---|---|---|---|---|
| db.search | 3 | 10 | 3.2 | 5.0 | 3.5 | 0.1 |
| doc.chunk | 3 | 120 | 0.0 | 0.0 | 0.0 | 0.0 |
| doc.embed | 3 | 4 | 508.9 | 536.6 | 492.9 | 17.3 |
| doc.read | 3 | 120 | 0.7 | 3.0 | 1.1 | 0.0 |
| doc.write | 3 | 4 | 75.1 | 597.9 | 220.1 | 16.9 |
| index.refresh | 3 | 1 | 604.5 | 604.5 | 604.5 | 101.3 |
| ingest.total | 3 | 1 | 3006.7 | 3006.7 | 3006.7 | 190.7 |
| query.e2e | 3 | 10 | 26.0 | 28.1 | 24.9 | 0.8 |
| query.embed | 3 | 10 | 6.0 | 6.9 | 5.8 | 0.3 |
| query.http | 3 | 10 | 10.8 | 12.8 | 10.8 | 0.9 |

## 导入（每轮）

| run | count | readMs | chunkMs | embedMs | writeMs/upsertMs | refreshMs | cleanupMs | totalMs | wallMs |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 120 | 136.3 | 0.9 | 2118.0 | 1024.2 | 706.5 | 0.0 | 3386.1 | 3408.0 |
| 2 | 120 | 148.4 | 1.1 | 1971.7 | 774.6 | 503.8 | 0.0 | 3004.8 | 3026.0 |
| 3 | 120 | 127.8 | 0.7 | 1886.4 | 880.3 | 604.5 | 0.0 | 3006.7 | 3031.0 |

导入 wall 中位数：3031.0 ms（IQR 191.0 ms）

## 查询（每轮）

| run | 查询数 | e2e p50 (ms) | e2e p95 (ms) | 平均 wall (ms) |
|---|---|---|---|---|
| 1 | 10 | 26.0 | 32.5 | 29.1 |
| 2 | 10 | 26.0 | 28.0 | 27.5 |
| 3 | 10 | 24.5 | 28.1 | 27.5 |

查询 e2e 中位数：26.0 ms（p95 31.1 ms，样本 30）

## 说明

- 每轮先清空 `__seekvecPerf` 事件再执行；预热轮不计入统计（首轮含模型加载）。
- 阶段指标为各轮内 p50 跨轮的中位数；IQR = Q3−Q1，反映轮间波动。
- 原始数据（含全部 perf 事件）见同目录 `raw.json`。
- 生成命令见 raw.json 的 `command` 字段；重跑请使用相同参数与语料。
