# 基准矩阵汇总 · matrix-2026-10-27

- 时间：2026-10-27T11:54:27.448Z
- 矩阵文件：`docs\benchmarks\matrix.json`
- 顺序：ABBA（正序 + 逆序）；每条 runs=5、warmup=1
- 原始数据：同目录 `matrix-raw.json`；各条目明细见对应子目录的 `raw.json` / `summary.md`

## 关键指标（跨调用中位数；IQR=Q3−Q1）

| 配置 | 后端 | dtype | batch | refresh | cold | 成功/总 | query e2e p50 (ms) | e2e IQR | model.total p50 | ingest.total p50 | query.embed p50 | db.search p50 | ingest wall p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fp32-wasm | wasm | fp32 | 32 | last | warm | 2/2 | 23.0 | 0.0 | — | 2989.1 | 5.2 | 2.7 | 3007.0 |
| q8-wasm | wasm | q8 | 32 | last | warm | 2/2 | 18.0 | 0.0 | — | 2533.9 | 3.9 | 2.7 | 2549.5 |
| fp16-webgpu | webgpu | fp16 | 32 | last | warm | 2/2 | 23.0 | 0.0 | — | 1223.4 | 7.3 | 2.2 | 1240.0 |
| cold-q8-wasm | wasm | q8 | 32 | last | cold | 2/2 | 19.5 | 1.5 | 452.0 | 2601.6 | 4.2 | 2.9 | 3056.5 |

## 说明

- 每格为跨调用次数的中位数；正式报告要求每格 ≥5 次（去掉首轮）并披露 IQR。
- 质量指标（Recall/nDCG）由 `npm run eval:quality` 与浏览器 eval 链路分别产出，本文件只汇总性能。
- 重跑命令与语料固定信息保存在 `matrix-raw.json` 与各子目录 `raw.json`。
