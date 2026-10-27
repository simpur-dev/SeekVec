# 浏览器基准 · fallback-2026-10-27

- 时间：2026-10-27T14:26:17.902Z
- 页面：http://localhost:5173（?perf=1）
- 驱动模式：`window.__seekvecEval`（契约 perf API）
- 浏览器：Edg/156.0.4314.42（C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe）
- 后端：auto · dtype=页面默认
- 冷/热：warm start；计入统计 3 轮（预热 1 轮已丢弃）
- 语料：120 篇；查询：10 条；collection：`bench_fallback_no_webgpu`
- 环境：win32 · 28 核 · deviceMemory=16GB · GPU=未知 · 实测后端=wasm（未获取到 WebGPU 适配器，已降级 WASM）
- 模型：Xenova/bge-small-zh-v1.5 @ 75c43b069aac · dtype=q8 · key=text_zh

## 阶段耗时（ms）

| 阶段 | 轮数 | n | p50 | p95 | mean | p50 IQR |
|---|---|---|---|---|---|---|
| db.search | 3 | 10 | 2.6 | 4.5 | 2.9 | 0.2 |
| doc.chunk | 3 | 120 | 0.0 | 0.0 | 0.0 | 0.0 |
| doc.embed | 3 | 4 | 406.0 | 427.6 | 387.5 | 21.7 |
| doc.read | 3 | 120 | 0.4 | 0.8 | 0.5 | 0.0 |
| doc.write | 3 | 4 | 74.0 | 479.9 | 187.8 | 12.1 |
| index.refresh | 3 | 1 | 503.0 | 503.0 | 503.0 | 50.9 |
| ingest.total | 3 | 1 | 2422.7 | 2422.7 | 2422.7 | 246.0 |
| query.e2e | 3 | 10 | 32.0 | 35.8 | 32.5 | 0.0 |
| query.embed | 3 | 10 | 3.9 | 4.9 | 4.0 | 0.1 |
| query.http | 3 | 10 | 8.2 | 9.9 | 8.3 | 0.3 |

## 导入（每轮）

| run | count | readMs | chunkMs | embedMs | writeMs/upsertMs | refreshMs | cleanupMs | totalMs | wallMs |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 120 | 61.8 | 0.5 | 1685.0 | 1090.5 | 604.4 | 0.0 | 2913.2 | 2930.0 |
| 2 | 120 | 61.9 | 0.6 | 1550.1 | 719.9 | 503.0 | 0.0 | 2422.7 | 2438.0 |
| 3 | 120 | 52.8 | 0.4 | 1529.9 | 751.1 | 502.6 | 0.0 | 2421.3 | 2436.0 |

导入 wall 中位数：2438.0 ms（IQR 247.0 ms）

## 查询（每轮）

| run | 查询数 | e2e p50 (ms) | e2e p95 (ms) | 平均 wall (ms) |
|---|---|---|---|---|
| 1 | 10 | 32.0 | 38.5 | 34.6 |
| 2 | 10 | 32.0 | 35.8 | 33.9 |
| 3 | 10 | 32.0 | 32.5 | 33.6 |

查询 e2e 中位数：32.0 ms（p95 35.8 ms，样本 30）

## 说明

- 每轮先清空 `__seekvecPerf` 事件再执行；预热轮不计入统计（首轮含模型加载）。
- 阶段指标为各轮内 p50 跨轮的中位数；IQR = Q3−Q1，反映轮间波动。
- 原始数据（含全部 perf 事件）见同目录 `raw.json`。
- 生成命令见 raw.json 的 `command` 字段；重跑请使用相同参数与语料。
