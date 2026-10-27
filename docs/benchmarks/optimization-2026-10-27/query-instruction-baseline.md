# SeekVec 检索质量评测（Node CPU · fp32 vs q8/fp16）

- runId：`eval-quality-2026-10-27T15-41-42-298Z`
- 生成时间：2026-10-27T15:41:42.300Z
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

**text_zh**（revision `75c43b069aac4d136ba6bc1122f995fedcfd2781`）
- `text_zh` onnx 体积：fp32 90.46 MB → q8 22.90 MB，**压缩比 fp32/q8 = 3.95×**

## 检索质量

| 模型 | dtype | Recall@1 | Recall@3 | Recall@5 | nDCG@5 | nDCG@10 | MRR | ΔRecall@5 | ΔnDCG@10 | 质量门 |
|---|---|---|---|---|---|---|---|---|---|---|
| text_zh | fp32 | 0.2324 | 0.4544 | 0.5606 | 0.7151 | 0.7549 | 0.8840 | n/a | n/a | 基线 |
| text_zh | q8 | 0.2360 | 0.4531 | 0.5682 | 0.7165 | 0.7532 | 0.8928 | +0.76pp | -0.17pp | ✅ PASS |

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

## 分语言结果

| 模型 | dtype | 语言 | n | Recall@5 | nDCG@10 |
|---|---|---|---|---|---|
| text_zh | fp32 | zh | 40 | 0.6458 | 0.7825 |
| text_zh | fp32 | en | 20 | 0.3900 | 0.6996 |
| text_zh | q8 | zh | 40 | 0.6458 | 0.7802 |
| text_zh | q8 | en | 20 | 0.4129 | 0.6991 |

## 结论

- ✅ 质量门全部通过：1 组量化对比的 Recall@5 / nDCG@10 降幅均在阈值内。

> 本评测为纯向量余弦排序（Node CPU），不含 seekdb 索引近似误差与混合检索；浏览器端到端主口径见 `docs/benchmarks/`。
