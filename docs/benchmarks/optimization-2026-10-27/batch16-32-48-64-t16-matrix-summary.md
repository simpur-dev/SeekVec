# 基准矩阵汇总 · batch-t16

- 时间：2026-10-27T16:48:15.982Z
- 矩阵文件：`D:\SeekVec-tools\tmp\batch-t16.json`
- 顺序：ABBA（正序 + 逆序）；每条 runs=3、warmup=1
- 原始数据：同目录 `matrix-raw.json`；各条目明细见对应子目录的 `raw.json` / `summary.md`

## 关键指标（跨调用中位数；IQR=Q3−Q1）

| 配置 | 后端 | dtype | batch | refresh | cold | 成功/总 | query e2e p50 (ms) | e2e IQR | model.total p50 | ingest.total p50 | query.embed p50 | db.search p50 | ingest wall p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| b16-t16 | wasm | q8 | 16 | last | warm | 2/2 | 27.0 | 0.0 | — | 2484.2 | 5.3 | 3.6 | 2509.0 |
| b32-t16 | wasm | q8 | 32 | last | warm | 2/2 | 26.5 | 0.5 | — | 2530.9 | 5.3 | 3.5 | 2559.0 |
| b48-t16 | wasm | q8 | 48 | last | warm | 2/2 | 27.0 | 0.0 | — | 2469.8 | 5.6 | 3.6 | 2487.5 |
| b64-t16 | wasm | q8 | 64 | last | warm | 2/2 | 27.0 | 0.0 | — | 2453.6 | 5.8 | 3.5 | 2481.0 |

## 说明

- 每格为跨调用次数的中位数；正式报告要求每格 ≥5 次（去掉首轮）并披露 IQR。
- 质量指标（Recall/nDCG）由 `npm run eval:quality` 与浏览器 eval 链路分别产出，本文件只汇总性能。
- 重跑命令与语料固定信息保存在 `matrix-raw.json` 与各子目录 `raw.json`。
