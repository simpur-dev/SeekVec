# 基准矩阵汇总 · matrix-2026-10-26

- 时间：2026-10-26T03:50:15.755Z
- 矩阵文件：`docs\benchmarks\matrix.json`
- 顺序：ABBA（正序 + 逆序）；每条 runs=5、warmup=1
- 原始数据：同目录 `matrix-raw.json`；各条目明细见对应子目录的 `raw.json` / `summary.md`

## 关键指标（跨调用中位数；IQR=Q3−Q1）

| 配置 | 后端 | dtype | batch | refresh | cold | 成功/总 | query e2e p50 (ms) | e2e IQR | model.total p50 | ingest.total p50 | query.embed p50 | db.search p50 | ingest wall p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fp32-wasm | wasm | fp32 | 16 | last | warm | 2/2 | 32.5 | 0.5 | — | 9705.2 | 12.0 | 2.4 | 9729.5 |
| q8-wasm | wasm | q8 | 16 | last | warm | 2/2 | 30.0 | 2.0 | — | 7206.3 | 9.1 | 2.6 | 7236.5 |
| fp16-webgpu | webgpu | fp16 | 16 | last | warm | 2/2 | 36.3 | 0.8 | — | 3430.0 | 13.3 | 2.6 | 3470.5 |
| q8-wasm-batch1 | wasm | q8 | 1 | last | warm | 2/2 | 28.0 | 0.0 | — | 9274.0 | 8.6 | 2.2 | 9304.0 |
| q8-wasm-refresh-each | wasm | q8 | 16 | each | warm | 2/2 | 30.0 | 2.0 | — | 11466.3 | 8.9 | 2.5 | 11490.0 |
| cold-q8-wasm | wasm | q8 | 16 | last | cold | 2/2 | 28.0 | 0.0 | 712.3 | 7062.1 | 8.6 | 2.4 | 7771.0 |

## 说明

- 每格为跨调用次数的中位数；正式报告要求每格 ≥5 次（去掉首轮）并披露 IQR。
- 质量指标（Recall/nDCG）由 `npm run eval:quality` 与浏览器 eval 链路分别产出，本文件只汇总性能。
- 重跑命令与语料固定信息保存在 `matrix-raw.json` 与各子目录 `raw.json`。
