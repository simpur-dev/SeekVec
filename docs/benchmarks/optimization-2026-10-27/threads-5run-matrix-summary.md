# 基准矩阵汇总 · ablation-threads-5

- 时间：2026-10-27T16:17:59.732Z
- 矩阵文件：`D:\SeekVec-tools\tmp\ablation-threads-5.json`
- 顺序：ABBA（正序 + 逆序）；每条 runs=5、warmup=1
- 原始数据：同目录 `matrix-raw.json`；各条目明细见对应子目录的 `raw.json` / `summary.md`

## 关键指标（跨调用中位数；IQR=Q3−Q1）

| 配置 | 后端 | dtype | batch | refresh | cold | 成功/总 | query e2e p50 (ms) | e2e IQR | model.total p50 | ingest.total p50 | query.embed p50 | db.search p50 | ingest wall p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| t8 | wasm | q8 | 32 | last | warm | 2/2 | 24.3 | 0.8 | — | 2804.2 | 5.8 | 3.4 | 2827.5 |
| t12 | wasm | q8 | 32 | last | warm | 2/2 | 27.0 | 0.0 | — | 2597.4 | 5.7 | 3.6 | 2617.0 |
| t14 | wasm | q8 | 32 | last | warm | 2/2 | 25.8 | 1.3 | — | 2551.9 | 5.7 | 3.5 | 2571.0 |
| t16 | wasm | q8 | 32 | last | warm | 2/2 | 25.0 | 2.0 | — | 2411.2 | 5.2 | 3.5 | 2435.0 |

## 说明

- 每格为跨调用次数的中位数；正式报告要求每格 ≥5 次（去掉首轮）并披露 IQR。
- 质量指标（Recall/nDCG）由 `npm run eval:quality` 与浏览器 eval 链路分别产出，本文件只汇总性能。
- 重跑命令与语料固定信息保存在 `matrix-raw.json` 与各子目录 `raw.json`。
