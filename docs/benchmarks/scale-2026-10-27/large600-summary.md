# 浏览器基准 · large600

- 时间：2026-10-27T16:37:56.334Z
- 页面：http://localhost:5173（?perf=1）
- 驱动模式：`window.__seekvecEval`（契约 perf API）
- 浏览器：Edg/156.0.4314.42（C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe）
- 后端：wasm · dtype=q8 · batch=32
- 冷/热：warm start；计入统计 3 轮（预热 1 轮已丢弃）
- 语料：600 篇；查询：10 条；collection：`bench_large600`
- 环境：win32 · 28 核 · deviceMemory=16GB · GPU=未知 · 实测后端=wasm
- 模型：Xenova/bge-small-zh-v1.5 @ 75c43b069aac · dtype=q8 · key=text_zh
- 生效配置：batch=32 · threads=16 · refresh=last

## 阶段耗时（ms）

| 阶段 | 轮数 | n | p50 | p95 | mean | p50 IQR |
|---|---|---|---|---|---|---|
| db.search | 3 | 10 | 3.6 | 5.6 | 4.0 | 0.1 |
| doc.chunk | 3 | 600 | 0.0 | 0.0 | 0.0 | 0.0 |
| doc.embed | 3 | 19 | 363.0 | 388.2 | 356.8 | 13.2 |
| doc.read | 3 | 600 | 0.6 | 1.8 | 0.8 | 0.0 |
| doc.write | 3 | 19 | 63.8 | 173.3 | 103.0 | 2.8 |
| index.refresh | 3 | 1 | 703.8 | 703.8 | 703.8 | 150.3 |
| ingest.total | 3 | 1 | 9145.7 | 9145.7 | 9145.7 | 367.1 |
| query.e2e | 3 | 10 | 27.0 | 31.3 | 25.8 | 0.5 |
| query.embed | 3 | 10 | 4.9 | 7.5 | 5.5 | 0.2 |
| query.http | 3 | 10 | 11.4 | 13.9 | 11.6 | 0.2 |

## 导入（每轮）

| run | count | readMs | chunkMs | embedMs | writeMs/upsertMs | refreshMs | cleanupMs | totalMs | wallMs |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 600 | 479.1 | 2.8 | 7189.6 | 1956.5 | 804.4 | 0.0 | 9762.3 | 9842.0 |
| 2 | 600 | 467.6 | 2.5 | 6779.0 | 1774.1 | 503.8 | 0.0 | 9145.6 | 9233.0 |
| 3 | 600 | 445.8 | 2.5 | 6481.0 | 1972.4 | 703.8 | 0.0 | 9028.1 | 9131.0 |

导入 wall 中位数：9233.0 ms（IQR 355.5 ms）

## 查询（每轮）

| run | 查询数 | e2e p50 (ms) | e2e p95 (ms) | 平均 wall (ms) |
|---|---|---|---|---|
| 1 | 10 | 27.5 | 30.2 | 28.2 |
| 2 | 10 | 26.5 | 33.5 | 29.4 |
| 3 | 10 | 27.0 | 31.3 | 28.8 |

查询 e2e 中位数：27.0 ms（p95 33.1 ms，样本 30）

## 说明

- 每轮先清空 `__seekvecPerf` 事件再执行；预热轮不计入统计（首轮含模型加载）。
- 阶段指标为各轮内 p50 跨轮的中位数；IQR = Q3−Q1，反映轮间波动。
- 原始数据（含全部 perf 事件）见同目录 `raw.json`。
- 生成命令见 raw.json 的 `command` 字段；重跑请使用相同参数与语料。
