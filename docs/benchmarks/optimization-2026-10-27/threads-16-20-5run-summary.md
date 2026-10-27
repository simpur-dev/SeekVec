# 基准矩阵汇总 · threads-16-20

- 时间：2026-10-27T17:02:41.568Z
- 矩阵文件：`D:\SeekVec-tools\tmp\threads-16-20.json`
- 顺序：ABBA（正序 + 逆序）；每条 runs=5、warmup=1
- 原始数据：同目录 `matrix-raw.json`；各条目明细见对应子目录的 `raw.json` / `summary.md`

## 关键指标（跨调用中位数；IQR=Q3−Q1）

| 配置 | 后端 | dtype | batch | refresh | cold | 成功/总 | query e2e p50 (ms) | e2e IQR | model.total p50 | ingest.total p50 | query.embed p50 | db.search p50 | ingest wall p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| t16 | wasm | q8 | 32 | last | warm | 2/2 | 27.0 | 0.0 | — | 2347.6 | 5.5 | 3.5 | 2369.5 |
| t20 | wasm | q8 | 32 | last | warm | 2/2 | 27.0 | 0.0 | — | 2396.0 | 5.6 | 3.5 | 2425.5 |

## 说明

- 每格为跨调用次数的中位数；正式报告要求每格 ≥5 次（去掉首轮）并披露 IQR。
- 质量指标（Recall/nDCG）由 `npm run eval:quality` 与浏览器 eval 链路分别产出，本文件只汇总性能。
- 重跑命令与语料固定信息保存在 `matrix-raw.json` 与各子目录 `raw.json`。
