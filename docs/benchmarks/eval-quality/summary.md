# SeekVec 检索质量评测（Node CPU · fp32 vs q8/fp16）

- runId：`eval-quality-2026-10-27T17-16-44-871Z`
- 生成时间：2026-10-27T17:16:44.872Z
- 评测集：`data/eval` · 60 篇文档（zh 40 / en 20）· 73 chunks · 60 条查询（semantic/keyword/paraphrase = 20/20/20）
- 协议：chunk 级 qrels（0-3 级）· 相关性阈值 rel ≥ 1 · nDCG gain = 2^rel − 1 · macro 平均 · 平局按 chunk id 升序
- 分块：浏览器默认参数 maxLength=256 / overlap=32 / minLength=10（复用 web/src/inference/chunk.ts）

## 环境

| 项 | 值 |
|---|---|
| node | v24.11.1 |
| platform | win32 |
| arch | x64 |
| cpu | Intel(R) Core(TM) i7-14700HX |
| cpuCount | 28 |
| totalMemMB | 16160 |
| device | cpu |
| runtime | @huggingface/transformers |
| runtimeVersion | 3.8.1 |
| onnxruntimeVersion | 1.21.0 |
| transformersBackend | onnxruntime-node (CPU EP) |
| modelSourceMode | local |
| hfEndpoint | default(huggingface.co) |

## 模型文件与体积

| 模型 | dtype | onnx 文件 | 体积 (MB) | sha256（前 16 位） | 与 models.lock 一致 |
|---|---|---|---|---|---|
| text_zh | fp32 | onnx/model.onnx | 90.46 | 69a0b846f4f116b5 | ✅ |
| text_zh | q8 | onnx/model_quantized.onnx | 22.90 | 15b717c382bcb518 | ✅ |
| text_zh | fp16 | onnx/model_fp16.onnx | 45.30 | 60d0fe5eb8d4e251 | ✅ |
| text_en | fp32 | onnx/model.onnx | 86.20 | 759c3cd2b7fe7e93 | ✅ |
| text_en | q8 | onnx/model_quantized.onnx | 21.91 | afdb6f1a0e45b715 | ✅ |
| text_en | fp16 | onnx/model_fp16.onnx | 43.20 | 2cdb5e58291813b6 | ✅ |

**text_zh**（revision `75c43b069aac4d136ba6bc1122f995fedcfd2781`）
- `text_zh` onnx 体积：fp32 90.46 MB → q8 22.90 MB，**压缩比 fp32/q8 = 3.95×**
- `text_zh` onnx 体积：fp32 90.46 MB → fp16 45.30 MB，**压缩比 fp32/fp16 = 2.00×**

**text_en**（revision `751bff37182d3f1213fa05d7196b954e230abad9`）
- `text_en` onnx 体积：fp32 86.20 MB → q8 21.91 MB，**压缩比 fp32/q8 = 3.93×**
- `text_en` onnx 体积：fp32 86.20 MB → fp16 43.20 MB，**压缩比 fp32/fp16 = 2.00×**

## 检索质量

| 模型 | dtype | Recall@1 | Recall@3 | Recall@5 | nDCG@5 | nDCG@10 | MRR | ΔRecall@5 | ΔnDCG@10 | 质量门 |
|---|---|---|---|---|---|---|---|---|---|---|
| text_zh | fp32 | 0.2324 | 0.4544 | 0.5606 | 0.7151 | 0.7549 | 0.8840 | n/a | n/a | 基线 |
| text_zh | q8 | 0.2360 | 0.4531 | 0.5682 | 0.7165 | 0.7532 | 0.8928 | +0.76pp | -0.17pp | ✅ PASS |
| text_zh | fp16 | 0.2324 | 0.4544 | 0.5606 | 0.7151 | 0.7549 | 0.8840 | +0.00pp | +0.00pp | ✅ PASS |
| text_en | fp32 | 0.1671 | 0.3514 | 0.4429 | 0.5565 | 0.5884 | 0.7188 | n/a | n/a | 基线 |
| text_en | q8 | 0.1796 | 0.3639 | 0.4443 | 0.5557 | 0.5964 | 0.7318 | +0.14pp | +0.80pp | ✅ PASS |
| text_en | fp16 | 0.1671 | 0.3514 | 0.4429 | 0.5565 | 0.5884 | 0.7188 | +0.00pp | +0.00pp | ✅ PASS |

质量门（实施契约 §8）：Recall@5 降幅 ≤ 2pp，nDCG@10 降幅 ≤ 0.02（绝对差）。

## 分类别结果

| 模型 | dtype | 类别 | n | Recall@5 | nDCG@10 | MRR |
|---|---|---|---|---|---|---|
| text_zh | fp32 | semantic | 20 | 0.5283 | 0.6903 | 0.8463 |
| text_zh | fp32 | keyword | 20 | 0.5700 | 0.8068 | 0.9417 |
| text_zh | fp32 | paraphrase | 20 | 0.5833 | 0.7676 | 0.8642 |
| text_zh | q8 | semantic | 20 | 0.5613 | 0.6987 | 0.8892 |
| text_zh | q8 | keyword | 20 | 0.5517 | 0.8030 | 0.9500 |
| text_zh | q8 | paraphrase | 20 | 0.5917 | 0.7579 | 0.8392 |
| text_zh | fp16 | semantic | 20 | 0.5283 | 0.6903 | 0.8463 |
| text_zh | fp16 | keyword | 20 | 0.5700 | 0.8068 | 0.9417 |
| text_zh | fp16 | paraphrase | 20 | 0.5833 | 0.7676 | 0.8642 |
| text_en | fp32 | semantic | 20 | 0.3754 | 0.5283 | 0.6376 |
| text_en | fp32 | keyword | 20 | 0.5950 | 0.8188 | 0.9750 |
| text_en | fp32 | paraphrase | 20 | 0.3583 | 0.4179 | 0.5436 |
| text_en | q8 | semantic | 20 | 0.3712 | 0.5057 | 0.6086 |
| text_en | q8 | keyword | 20 | 0.6117 | 0.8270 | 1.0000 |
| text_en | q8 | paraphrase | 20 | 0.3500 | 0.4565 | 0.5870 |
| text_en | fp16 | semantic | 20 | 0.3754 | 0.5283 | 0.6376 |
| text_en | fp16 | keyword | 20 | 0.5950 | 0.8188 | 0.9750 |
| text_en | fp16 | paraphrase | 20 | 0.3583 | 0.4179 | 0.5436 |

## 分语言结果

| 模型 | dtype | 语言 | n | Recall@5 | nDCG@10 |
|---|---|---|---|---|---|
| text_zh | fp32 | zh | 40 | 0.6458 | 0.7825 |
| text_zh | fp32 | en | 20 | 0.3900 | 0.6996 |
| text_zh | q8 | zh | 40 | 0.6458 | 0.7802 |
| text_zh | q8 | en | 20 | 0.4129 | 0.6991 |
| text_zh | fp16 | zh | 40 | 0.6458 | 0.7825 |
| text_zh | fp16 | en | 20 | 0.3900 | 0.6996 |
| text_en | fp32 | zh | 40 | 0.3729 | 0.4610 |
| text_en | fp32 | en | 20 | 0.5829 | 0.8431 |
| text_en | q8 | zh | 40 | 0.3729 | 0.4759 |
| text_en | q8 | en | 20 | 0.5871 | 0.8374 |
| text_en | fp16 | zh | 40 | 0.3729 | 0.4610 |
| text_en | fp16 | en | 20 | 0.5829 | 0.8431 |

## 结论

- ✅ 质量门全部通过：4 组量化对比的 Recall@5 / nDCG@10 降幅均在阈值内。

> 本评测为纯向量余弦排序（Node CPU），不含 seekdb 索引近似误差与混合检索；浏览器端到端主口径见 `docs/benchmarks/`。
