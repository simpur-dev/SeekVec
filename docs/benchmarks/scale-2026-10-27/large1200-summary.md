# 浏览器基准 · large1200

- 时间：2026-10-27T16:38:46.669Z
- 页面：http://localhost:5173（?perf=1）
- 驱动模式：`window.__seekvecEval`（契约 perf API）
- 浏览器：Edg/156.0.4314.42（C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe）
- 后端：wasm · dtype=q8 · batch=32
- 冷/热：warm start；计入统计 1 轮（预热 1 轮已丢弃）
- 语料：1200 篇；查询：10 条；collection：`bench_large1200`
- 环境：win32 · 28 核 · deviceMemory=16GB · GPU=未知 · 实测后端=wasm
- 模型：Xenova/bge-small-zh-v1.5 @ 75c43b069aac · dtype=q8 · key=text_zh
- 生效配置：batch=32 · threads=16 · refresh=last

## 阶段耗时（ms）

| 阶段 | 轮数 | n | p50 | p95 | mean | p50 IQR |
|---|---|---|---|---|---|---|
| db.search | 1 | 10 | 3.5 | 4.8 | 3.6 | 0.0 |
| doc.chunk | 1 | 941 | 0.0 | 0.0 | 0.0 | 0.0 |
| doc.embed | 1 | 38 | 347.8 | 428.7 | 354.5 | 0.0 |
| doc.read | 1 | 941 | 0.6 | 1.8 | 0.7 | 0.0 |
| doc.write | 1 | 38 | 58.4 | 88.1 | 74.5 | 0.0 |
| index.refresh | 1 | 1 | 604.3 | 604.3 | 604.3 | 0.0 |
| ingest.total | 1 | 1 | 17368.0 | 17368.0 | 17368.0 | 0.0 |
| query.e2e | 1 | 10 | 22.0 | 31.3 | 24.3 | 0.0 |
| query.embed | 1 | 10 | 5.2 | 9.1 | 5.6 | 0.0 |
| query.http | 1 | 10 | 10.5 | 12.9 | 10.9 | 0.0 |

## 导入（每轮）

| run | count | readMs | chunkMs | embedMs | writeMs/upsertMs | refreshMs | cleanupMs | totalMs | wallMs |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1200 | 921.2 | 5.2 | 13469.3 | 2830.6 | 604.3 | 0.0 | 17368.0 | 17530.0 |

导入 wall 中位数：17530.0 ms（IQR 0.0 ms）

## 查询（每轮）

| run | 查询数 | e2e p50 (ms) | e2e p95 (ms) | 平均 wall (ms) |
|---|---|---|---|---|
| 1 | 10 | 22.0 | 31.3 | 26.8 |

查询 e2e 中位数：22.0 ms（p95 31.3 ms，样本 10）

## 说明

- 每轮先清空 `__seekvecPerf` 事件再执行；预热轮不计入统计（首轮含模型加载）。
- 阶段指标为各轮内 p50 跨轮的中位数；IQR = Q3−Q1，反映轮间波动。
- 原始数据（含全部 perf 事件）见同目录 `raw.json`。
- 生成命令见 raw.json 的 `command` 字段；重跑请使用相同参数与语料。
