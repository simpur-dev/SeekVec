# 浏览器质量评测 · fp16-webgpu

- 时间：2026-10-27T11:55:00.003Z
- collection：`qeval_fp16_webgpu_20261027_195500`（已自动清理）
- 请求：backend=`webgpu`、dtype=`fp16`
- 实际：backend=`webgpu`、dtype=`fp16`
- 模型：Xenova/bge-small-zh-v1.5 @ 75c43b069aac · text_zh
- 数据：60 篇文档 / 73 chunks / 60 查询（分块与 qrels 来自 data/eval）
- ingest：count=73，times.totalMs=1003.8
- 耗时：2.94s

## 指标（macro 平均，60 条查询）

| Recall@1 | Recall@3 | Recall@5 | nDCG@5 | nDCG@10 | MRR |
|---|---|---|---|---|---|
| 0.2324 | 0.4656 | 0.5642 | 0.7265 | 0.7652 | 0.8868 |

## 分类别（macro）

| category | queries | Recall@5 | nDCG@10 | MRR |
|---|---|---|---|---|
| keyword | 20 | 0.5808 | 0.8374 | 0.9500 |
| paraphrase | 20 | 0.5833 | 0.7679 | 0.8642 |
| semantic | 20 | 0.5283 | 0.6903 | 0.8463 |

## 阶段耗时（ms，p50；来自 window.__seekvecPerf.summary）

| 阶段 | n | p50 | p95 | mean |
|---|---|---|---|---|
| model.download | 1 | 97.1 | 97.1 | 97.1 |
| model.init | 1 | 224.7 | 224.7 | 224.7 |
| model.total | 1 | 321.9 | 321.9 | 321.9 |
| doc.read | 60 | 0.5 | 2.2 | 0.9 |
| doc.chunk | 60 | 0.0 | 0.0 | 0.0 |
| doc.embed | 3 | 59.0 | 106.5 | 64.7 |
| doc.write | 3 | 75.0 | 482.0 | 220.6 |
| index.refresh | 1 | 503.5 | 503.5 | 503.5 |
| ingest.total | 1 | 1003.8 | 1003.8 | 1003.8 |

## 逐查询

| qid | category | mode | hits | hits∈qrels | R@5 | nDCG@10 | MRR | e2eMs |
|---|---|---|---|---|---|---|---|---|
| sem-01 | semantic | vector | 10 | 4 | 1.000 | 1.000 | 1.000 | 30.0 |
| sem-02 | semantic | vector | 10 | 3 | 0.333 | 0.861 | 1.000 | 23.0 |
| sem-03 | semantic | vector | 10 | 2 | 0.500 | 0.754 | 1.000 | 22.0 |
| sem-04 | semantic | vector | 10 | 3 | 0.750 | 0.834 | 1.000 | 27.0 |
| sem-05 | semantic | vector | 10 | 3 | 0.750 | 0.731 | 1.000 | 23.0 |
| sem-06 | semantic | vector | 10 | 3 | 0.750 | 0.894 | 1.000 | 23.0 |
| sem-07 | semantic | vector | 10 | 3 | 0.500 | 0.483 | 1.000 | 23.0 |
| sem-08 | semantic | vector | 10 | 3 | 0.750 | 0.892 | 1.000 | 63.0 |
| sem-09 | semantic | vector | 10 | 2 | 0.000 | 0.228 | 0.143 | 26.0 |
| sem-10 | semantic | vector | 10 | 2 | 0.500 | 0.756 | 1.000 | 22.0 |
| sem-11 | semantic | vector | 10 | 2 | 0.667 | 0.790 | 1.000 | 18.0 |
| sem-12 | semantic | vector | 10 | 2 | 0.333 | 0.408 | 0.250 | 18.0 |
| sem-13 | semantic | vector | 10 | 3 | 0.667 | 0.909 | 1.000 | 18.0 |
| sem-14 | semantic | vector | 10 | 4 | 0.250 | 0.783 | 1.000 | 18.0 |
| sem-15 | semantic | vector | 10 | 3 | 0.500 | 0.357 | 1.000 | 18.0 |
| sem-16 | semantic | vector | 10 | 3 | 0.400 | 0.605 | 1.000 | 23.0 |
| sem-17 | semantic | vector | 10 | 5 | 0.500 | 0.806 | 1.000 | 17.0 |
| sem-18 | semantic | vector | 10 | 3 | 0.167 | 0.464 | 0.333 | 18.0 |
| sem-19 | semantic | vector | 10 | 1 | 0.250 | 0.250 | 0.200 | 18.0 |
| sem-20 | semantic | vector | 10 | 4 | 1.000 | 1.000 | 1.000 | 18.0 |
| kw-01 | keyword | hybrid | 10 | 3 | 1.000 | 1.000 | 1.000 | 28.0 |
| kw-02 | keyword | hybrid | 10 | 2 | 0.667 | 0.791 | 1.000 | 23.0 |
| kw-03 | keyword | hybrid | 10 | 2 | 0.667 | 0.905 | 1.000 | 23.0 |
| kw-04 | keyword | hybrid | 10 | 3 | 1.000 | 1.000 | 1.000 | 22.0 |
| kw-05 | keyword | hybrid | 10 | 3 | 0.667 | 0.943 | 1.000 | 18.0 |
| kw-06 | keyword | hybrid | 10 | 3 | 0.667 | 0.916 | 1.000 | 23.0 |
| kw-07 | keyword | hybrid | 10 | 3 | 1.000 | 0.946 | 1.000 | 23.0 |
| kw-08 | keyword | hybrid | 10 | 3 | 1.000 | 0.967 | 1.000 | 18.0 |
| kw-09 | keyword | hybrid | 10 | 2 | 0.667 | 0.856 | 1.000 | 18.0 |
| kw-10 | keyword | hybrid | 10 | 2 | 0.333 | 0.504 | 0.500 | 18.0 |
| kw-11 | keyword | hybrid | 10 | 1 | 0.333 | 0.674 | 1.000 | 18.0 |
| kw-12 | keyword | hybrid | 10 | 2 | 0.333 | 0.781 | 1.000 | 24.0 |
| kw-13 | keyword | hybrid | 10 | 3 | 0.667 | 0.905 | 1.000 | 18.0 |
| kw-14 | keyword | hybrid | 10 | 3 | 0.750 | 0.618 | 0.500 | 23.0 |
| kw-15 | keyword | hybrid | 10 | 3 | 0.250 | 0.893 | 1.000 | 23.0 |
| kw-16 | keyword | hybrid | 10 | 3 | 0.250 | 0.837 | 1.000 | 18.0 |
| kw-17 | keyword | hybrid | 10 | 4 | 0.333 | 0.820 | 1.000 | 18.0 |
| kw-18 | keyword | hybrid | 10 | 4 | 0.500 | 0.886 | 1.000 | 18.0 |
| kw-19 | keyword | hybrid | 10 | 3 | 0.333 | 0.762 | 1.000 | 20.0 |
| kw-20 | keyword | hybrid | 10 | 3 | 0.200 | 0.746 | 1.000 | 18.0 |
| pp-01 | paraphrase | vector | 10 | 3 | 1.000 | 0.972 | 1.000 | 18.0 |
| pp-02 | paraphrase | vector | 10 | 2 | 0.333 | 0.846 | 1.000 | 18.0 |
| pp-03 | paraphrase | vector | 10 | 2 | 0.667 | 0.812 | 1.000 | 18.0 |
| pp-04 | paraphrase | vector | 10 | 1 | 0.333 | 0.053 | 0.333 | 18.0 |
| pp-05 | paraphrase | vector | 10 | 2 | 0.667 | 0.790 | 1.000 | 18.0 |
| pp-06 | paraphrase | vector | 10 | 2 | 0.667 | 0.947 | 1.000 | 18.0 |
| pp-07 | paraphrase | vector | 10 | 3 | 0.667 | 0.668 | 0.500 | 18.0 |
| pp-08 | paraphrase | vector | 10 | 3 | 1.000 | 0.993 | 1.000 | 18.0 |
| pp-09 | paraphrase | vector | 10 | 2 | 0.667 | 0.883 | 1.000 | 19.0 |
| pp-10 | paraphrase | vector | 10 | 3 | 1.000 | 0.936 | 1.000 | 17.0 |
| pp-11 | paraphrase | vector | 10 | 3 | 0.667 | 0.982 | 1.000 | 18.0 |
| pp-12 | paraphrase | vector | 10 | 1 | 0.333 | 0.321 | 0.250 | 31.0 |
| pp-13 | paraphrase | vector | 10 | 3 | 1.000 | 0.993 | 1.000 | 14.0 |
| pp-14 | paraphrase | vector | 10 | 2 | 0.667 | 0.798 | 1.000 | 18.0 |
| pp-15 | paraphrase | vector | 10 | 2 | 0.250 | 0.323 | 0.200 | 18.0 |
| pp-16 | paraphrase | vector | 10 | 2 | 0.250 | 0.821 | 1.000 | 17.0 |
| pp-17 | paraphrase | vector | 10 | 3 | 0.500 | 0.942 | 1.000 | 18.0 |
| pp-18 | paraphrase | vector | 10 | 2 | 0.500 | 0.905 | 1.000 | 18.0 |
| pp-19 | paraphrase | vector | 10 | 1 | 0.167 | 0.605 | 1.000 | 18.0 |
| pp-20 | paraphrase | vector | 10 | 2 | 0.333 | 0.769 | 1.000 | 18.0 |

## 断言

- PASS · ingest chunk 数与评测集一致：写入 73，期望 73（浏览器分块需与 qrels 映射一致）
- PASS · 可读取实际 backend/dtype：backend=webgpu，dtype=fp16
- PASS · 每条查询都有结果：60 条查询均有 hit
- PASS · hit metadata 可映射（source/chunkIndex 完整）：全部 hit 均含 source + chunkIndex
- PASS · hit source 均属于评测语料：60 篇语料内
- PASS · search mode 与 keyword 预期一致：keyword→hybrid，无 keyword→vector
- PASS · qrels 均可解析到语料 chunk：229 条 qrels 全部可解析
