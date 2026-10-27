# 浏览器基准 · opt-auto

- 时间：2026-10-27T11:38:54.339Z
- 页面：http://localhost:5173（?perf=1）
- 驱动模式：`window.__seekvecEval`（契约 perf API）
- 浏览器：Chrome/153.0.8010.12（C:\Users\34928\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe）
- 后端：auto · dtype=页面默认
- 冷/热：warm start；计入统计 3 轮（预热 1 轮已丢弃）
- 语料：120 篇；查询：10 条；collection：`bench_opt_auto`
- 环境：win32 · 28 核 · deviceMemory=16GB · GPU=[object Object] · 实测后端=webgpu
- 模型：Xenova/bge-small-zh-v1.5 @ 75c43b069aac · dtype=fp16 · key=text_zh

## 阶段耗时（ms）

| 阶段 | 轮数 | n | p50 | p95 | mean | p50 IQR |
|---|---|---|---|---|---|---|
| db.search | 3 | 10 | 3.1 | 6.3 | 3.5 | 0.6 |
| doc.chunk | 3 | 120 | 0.0 | 0.0 | 0.0 | 0.0 |
| doc.embed | 3 | 4 | 104.7 | 175.6 | 117.5 | 44.7 |
| doc.read | 3 | 120 | 0.7 | 2.7 | 1.1 | 0.4 |
| doc.write | 3 | 4 | 116.7 | 660.7 | 263.4 | 48.8 |
| index.refresh | 3 | 1 | 706.1 | 706.1 | 706.1 | 55.5 |
| ingest.total | 3 | 1 | 1772.5 | 1772.5 | 1772.5 | 568.1 |
| query.e2e | 3 | 10 | 30.0 | 68.5 | 38.8 | 2.5 |
| query.embed | 3 | 10 | 9.0 | 42.4 | 15.8 | 0.6 |
| query.http | 3 | 10 | 14.6 | 20.0 | 15.1 | 1.0 |

## 导入（每轮）

| run | count | readMs | chunkMs | embedMs | writeMs/upsertMs | refreshMs | cleanupMs | totalMs | wallMs |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 120 | 311.9 | 2.2 | 872.4 | 1318.4 | 718.2 | 0.0 | 2638.9 | 2681.0 |
| 2 | 120 | 114.1 | 0.8 | 337.2 | 938.7 | 607.1 | 0.0 | 1502.7 | 1520.0 |
| 3 | 120 | 128.0 | 0.7 | 469.8 | 1053.4 | 706.1 | 0.0 | 1772.5 | 1794.0 |

导入 wall 中位数：1794.0 ms（IQR 580.5 ms）

## 查询（每轮）

| run | 查询数 | e2e p50 (ms) | e2e p95 (ms) | 平均 wall (ms) |
|---|---|---|---|---|
| 1 | 10 | 33.0 | 68.5 | 41.2 |
| 2 | 10 | 28.0 | 145.2 | 51.2 |
| 3 | 10 | 30.0 | 38.6 | 32.8 |

查询 e2e 中位数：28.5 ms（p95 68.5 ms，样本 30）

## 说明

- 每轮先清空 `__seekvecPerf` 事件再执行；预热轮不计入统计（首轮含模型加载）。
- 阶段指标为各轮内 p50 跨轮的中位数；IQR = Q3−Q1，反映轮间波动。
- 原始数据（含全部 perf 事件）见同目录 `raw.json`。
- 生成命令见 raw.json 的 `command` 字段；重跑请使用相同参数与语料。
