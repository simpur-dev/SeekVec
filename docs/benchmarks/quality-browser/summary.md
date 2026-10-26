# 浏览器端检索质量评测（量化前后对比）

- 时间：2026-10-26T03:37:25.240Z
- 页面：http://localhost:5173（真实应用链路：端侧推理 → 前端分块写入 → server → seekdb 检索）
- 浏览器：Chrome/153.0.8010.12（C:\Users\34928\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe）
- 评测集：60 篇 / 73 chunks / 60 查询 / 229 条 qrels（data/eval）
- 运行参数：runs=1、topN=10、timeout=300000ms

## 组概览

| 组 | 请求 backend/dtype | 实际 backend/dtype | 模型 | ingest chunks | 耗时 (s) | 状态 |
|---|---|---|---|---|---|---|
| fp32-wasm | wasm/fp32 | wasm/fp32 | Xenova/bge-small-zh-v1.5 @75c43b06 | 73 | 5.9 | PASS |
| q8-wasm | wasm/q8 | wasm/q8 | Xenova/bge-small-zh-v1.5 @75c43b06 | 73 | 6.7 | PASS |
| fp16-webgpu | webgpu/fp16 | webgpu/fp16 | Xenova/bge-small-zh-v1.5 @75c43b06 | 73 | 6.6 | PASS |

## 指标对比（macro 平均，60 条查询）

| 组 | backend/dtype | Recall@1 | Recall@3 | Recall@5 | nDCG@5 | nDCG@10 | MRR |
|---|---|---|---|---|---|---|---|
| fp32-wasm | wasm/fp32 | 0.2324 | 0.4656 | 0.5642 | 0.7265 | 0.7651 | 0.8868 |
| q8-wasm | wasm/q8 | 0.2365 | 0.4544 | 0.5592 | 0.7267 | 0.7619 | 0.8992 |
| fp16-webgpu | webgpu/fp16 | 0.2324 | 0.4656 | 0.5642 | 0.7265 | 0.7652 | 0.8868 |

## 相对 baseline 的变化与质量门

质量门（契约 §8）：Recall@5 降幅 ≤ 2pp（0.02 绝对差），nDCG@10 降幅 ≤ 0.02。

| 组 | ΔRecall@5 (pp) | ΔnDCG@10 | Recall@5 gate | nDCG@10 gate | 结论 |
|---|---|---|---|---|---|
| fp32-wasm | — | — | — | — | baseline |
| q8-wasm | -0.50 | -0.0032 | PASS | PASS | PASS |
| fp16-webgpu | 0.00 | 0.0001 | PASS | PASS | PASS |

## 分组指标（分类别 / 语言）

### fp32-wasm

| 维度 | 组 | queries | Recall@5 | nDCG@10 | MRR |
|---|---|---|---|---|---|
| category | keyword | 20 | 0.5808 | 0.8374 | 0.9500 |
| category | paraphrase | 20 | 0.5833 | 0.7676 | 0.8642 |
| category | semantic | 20 | 0.5283 | 0.6903 | 0.8463 |
| lang | en | 20 | 0.3842 | 0.7092 | 0.8617 |
| lang | zh | 40 | 0.6542 | 0.7930 | 0.8994 |

### q8-wasm

| 维度 | 组 | queries | Recall@5 | nDCG@10 | MRR |
|---|---|---|---|---|---|
| category | keyword | 20 | 0.5642 | 0.8298 | 0.9500 |
| category | paraphrase | 20 | 0.5750 | 0.7655 | 0.8600 |
| category | semantic | 20 | 0.5383 | 0.6904 | 0.8875 |
| lang | en | 20 | 0.3942 | 0.7147 | 0.9017 |
| lang | zh | 40 | 0.6417 | 0.7855 | 0.8979 |

### fp16-webgpu

| 维度 | 组 | queries | Recall@5 | nDCG@10 | MRR |
|---|---|---|---|---|---|
| category | keyword | 20 | 0.5808 | 0.8374 | 0.9500 |
| category | paraphrase | 20 | 0.5833 | 0.7679 | 0.8642 |
| category | semantic | 20 | 0.5283 | 0.6903 | 0.8463 |
| lang | en | 20 | 0.3842 | 0.7096 | 0.8617 |
| lang | zh | 40 | 0.6542 | 0.7930 | 0.8994 |

## 断言与映射完整性

| 组 | 断言 | 映射 |
|---|---|---|
| fp32-wasm | PASS 7/7 | hits 600/600、qrels 229/229、mode {"vector":40,"hybrid":20} |
| q8-wasm | PASS 7/7 | hits 600/600、qrels 229/229、mode {"vector":40,"hybrid":20} |
| fp16-webgpu | PASS 7/7 | hits 600/600、qrels 229/229、mode {"vector":40,"hybrid":20} |

## 结论 / 风险

- 三组数据：3/3 成功。
- 断言：全部通过。
- 质量门：通过（无超标项）。
- 原始数据：`raw.json`（本目录）与 `<group-id>/raw.json`（逐查询命中/指标）；本文件由 scripts/eval-quality-browser.mjs 生成。
- 口径：真实应用链路（含浏览器分块、seekdb HNSW 近似检索与 hybrid 检索），与 Node CPU 纯排序口径（scripts/eval-quality.ts）互补、不可直接混用。
