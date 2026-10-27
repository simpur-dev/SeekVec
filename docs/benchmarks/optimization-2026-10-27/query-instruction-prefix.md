# SeekVec 检索质量评测（Node CPU · fp32 vs q8/fp16）

- runId：`eval-quality-2026-10-27T15-41-47-087Z`
- 生成时间：2026-10-27T15:41:47.089Z
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
| text_zh | fp32 | 0.2310 | 0.4392 | 0.5536 | 0.6966 | 0.7352 | 0.8925 | n/a | n/a | 基线 |
| text_zh | q8 | 0.2365 | 0.4419 | 0.5260 | 0.6865 | 0.7281 | 0.8968 | -2.76pp | -0.71pp | ❌ FAIL |

质量门（实施契约 §8）：Recall@5 降幅 ≤ 2pp，nDCG@10 降幅 ≤ 0.02（绝对差）。

## 分类别结果

| 模型 | dtype | 类别 | n | Recall@5 | nDCG@10 | MRR |
|---|---|---|---|---|---|---|
| text_zh | fp32 | semantic | 20 | 0.4492 | 0.6430 | 0.8542 |
| text_zh | fp32 | keyword | 20 | 0.6075 | 0.8292 | 0.9750 |
| text_zh | fp32 | paraphrase | 20 | 0.6042 | 0.7334 | 0.8483 |
| text_zh | q8 | semantic | 20 | 0.4346 | 0.6309 | 0.8417 |
| text_zh | q8 | keyword | 20 | 0.5308 | 0.8143 | 1.0000 |
| text_zh | q8 | paraphrase | 20 | 0.6125 | 0.7391 | 0.8486 |

## 分语言结果

| 模型 | dtype | 语言 | n | Recall@5 | nDCG@10 |
|---|---|---|---|---|---|
| text_zh | fp32 | zh | 40 | 0.6208 | 0.7499 |
| text_zh | fp32 | en | 20 | 0.4192 | 0.7058 |
| text_zh | q8 | zh | 40 | 0.5813 | 0.7370 |
| text_zh | q8 | en | 20 | 0.4154 | 0.7104 |

## 结论

- ❌ 质量门未通过：text_zh/q8，需分析原因并在技术说明中披露。

> 本评测为纯向量余弦排序（Node CPU），不含 seekdb 索引近似误差与混合检索；浏览器端到端主口径见 `docs/benchmarks/`。
