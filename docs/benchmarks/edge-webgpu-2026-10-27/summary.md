# 浏览器基准 · edge-webgpu-2026-10-27

- 时间：2026-10-27T14:26:35.845Z
- 页面：http://localhost:5173（?perf=1）
- 驱动模式：`window.__seekvecEval`（契约 perf API）
- 浏览器：Edg/156.0.4314.42（C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe）
- 后端：webgpu · dtype=fp16
- 冷/热：warm start；计入统计 1 轮（预热 0 轮已丢弃）
- 语料：120 篇；查询：10 条；collection：`bench_edge_webgpu`
- 环境：win32 · 28 核 · deviceMemory=16GB · GPU=[object Object] · 实测后端=webgpu
- 模型：Xenova/bge-small-zh-v1.5 @ 75c43b069aac · dtype=fp16 · key=text_zh

## 阶段耗时（ms）

| 阶段 | 轮数 | n | p50 | p95 | mean | p50 IQR |
|---|---|---|---|---|---|---|
| db.search | 1 | 10 | 2.8 | 4.2 | 3.0 | 0.0 |
| doc.chunk | 1 | 120 | 0.0 | 0.0 | 0.0 | 0.0 |
| doc.embed | 1 | 4 | 79.8 | 331.9 | 150.0 | 0.0 |
| doc.read | 1 | 120 | 0.7 | 3.3 | 1.2 | 0.0 |
| doc.write | 1 | 4 | 70.4 | 563.1 | 211.6 | 0.0 |
| index.refresh | 1 | 1 | 603.0 | 603.0 | 603.0 | 0.0 |
| ingest.total | 1 | 1 | 1703.4 | 1703.4 | 1703.4 | 0.0 |
| model.download | 1 | 1 | 108.6 | 108.6 | 108.6 | 0.0 |
| model.init | 1 | 1 | 556.9 | 556.9 | 556.9 | 0.0 |
| model.total | 1 | 1 | 665.6 | 665.6 | 665.6 | 0.0 |
| query.e2e | 1 | 10 | 23.0 | 34.6 | 25.3 | 0.0 |
| query.embed | 1 | 10 | 9.1 | 17.2 | 10.2 | 0.0 |
| query.http | 1 | 10 | 8.7 | 10.2 | 8.8 | 0.0 |

## 导入（每轮）

| run | count | readMs | chunkMs | embedMs | writeMs/upsertMs | refreshMs | cleanupMs | totalMs | wallMs |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 120 | 147.2 | 1.3 | 599.9 | 846.6 | 603.0 | 0.0 | 1703.4 | 2493.0 |

导入 wall 中位数：2493.0 ms（IQR 0.0 ms）

## 查询（每轮）

| run | 查询数 | e2e p50 (ms) | e2e p95 (ms) | 平均 wall (ms) |
|---|---|---|---|---|
| 0 | 10 | 23.0 | 34.6 | 27.9 |

查询 e2e 中位数：23.0 ms（p95 34.6 ms，样本 10）

## 说明

- 每轮先清空 `__seekvecPerf` 事件再执行；预热轮不计入统计（首轮含模型加载）。
- 阶段指标为各轮内 p50 跨轮的中位数；IQR = Q3−Q1，反映轮间波动。
- 原始数据（含全部 perf 事件）见同目录 `raw.json`。
- 生成命令见 raw.json 的 `command` 字段；重跑请使用相同参数与语料。
