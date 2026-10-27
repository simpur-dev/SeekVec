# 浏览器质量评测 · q8-wasm

- 时间：2026-10-27T11:54:56.862Z
- collection：`qeval_q8_wasm_20261027_195456`（已自动清理）
- 请求：backend=`wasm`、dtype=`q8`
- 实际：backend=`wasm`、dtype=`q8`
- 模型：Xenova/bge-small-zh-v1.5 @ 75c43b069aac · text_zh
- 数据：60 篇文档 / 73 chunks / 60 查询（分块与 qrels 来自 data/eval）
- ingest：count=73，times.totalMs=1482.1
- 耗时：3.07s

## 指标（macro 平均，60 条查询）

| Recall@1 | Recall@3 | Recall@5 | nDCG@5 | nDCG@10 | MRR |
|---|---|---|---|---|---|
| 0.2332 | 0.4628 | 0.5744 | 0.7299 | 0.7659 | 0.8894 |

## 分类别（macro）

| category | queries | Recall@5 | nDCG@10 | MRR |
|---|---|---|---|---|
| keyword | 20 | 0.5767 | 0.8333 | 0.9500 |
| paraphrase | 20 | 0.5958 | 0.7654 | 0.8558 |
| semantic | 20 | 0.5508 | 0.6990 | 0.8625 |

## 阶段耗时（ms，p50；来自 window.__seekvecPerf.summary）

| 阶段 | n | p50 | p95 | mean |
|---|---|---|---|---|
| model.download | 1 | 71.8 | 71.8 | 71.8 |
| model.init | 1 | 147.9 | 147.9 | 147.9 |
| model.total | 1 | 219.8 | 219.8 | 219.8 |
| doc.read | 60 | 0.5 | 1.9 | 0.9 |
| doc.chunk | 60 | 0.0 | 0.0 | 0.0 |
| doc.embed | 3 | 298.5 | 301.9 | 232.3 |
| doc.write | 3 | 57.9 | 478.2 | 211.1 |
| index.refresh | 1 | 503.1 | 503.1 | 503.1 |
| ingest.total | 1 | 1482.1 | 1482.1 | 1482.1 |

## 逐查询

| qid | category | mode | hits | hits∈qrels | R@5 | nDCG@10 | MRR | e2eMs |
|---|---|---|---|---|---|---|---|---|
| sem-01 | semantic | vector | 10 | 4 | 1.000 | 1.000 | 1.000 | 23.0 |
| sem-02 | semantic | vector | 10 | 3 | 0.667 | 0.876 | 1.000 | 18.0 |
| sem-03 | semantic | vector | 10 | 2 | 0.500 | 0.754 | 1.000 | 18.0 |
| sem-04 | semantic | vector | 10 | 3 | 0.750 | 0.834 | 1.000 | 18.0 |
| sem-05 | semantic | vector | 10 | 3 | 0.500 | 0.718 | 1.000 | 18.0 |
| sem-06 | semantic | vector | 10 | 3 | 0.750 | 0.894 | 1.000 | 18.0 |
| sem-07 | semantic | vector | 10 | 3 | 0.500 | 0.498 | 1.000 | 18.0 |
| sem-08 | semantic | vector | 10 | 3 | 0.750 | 0.892 | 1.000 | 18.0 |
| sem-09 | semantic | vector | 10 | 2 | 0.000 | 0.237 | 0.167 | 18.0 |
| sem-10 | semantic | vector | 10 | 2 | 0.500 | 0.752 | 1.000 | 18.0 |
| sem-11 | semantic | vector | 10 | 2 | 0.667 | 0.790 | 1.000 | 13.0 |
| sem-12 | semantic | vector | 10 | 2 | 0.333 | 0.410 | 0.250 | 18.0 |
| sem-13 | semantic | vector | 10 | 2 | 0.667 | 0.812 | 1.000 | 18.0 |
| sem-14 | semantic | vector | 10 | 4 | 0.250 | 0.780 | 1.000 | 19.0 |
| sem-15 | semantic | vector | 10 | 3 | 0.500 | 0.351 | 1.000 | 18.0 |
| sem-16 | semantic | vector | 10 | 3 | 0.600 | 0.432 | 0.500 | 18.0 |
| sem-17 | semantic | vector | 10 | 5 | 0.500 | 0.806 | 1.000 | 18.0 |
| sem-18 | semantic | vector | 10 | 3 | 0.333 | 0.496 | 0.333 | 18.0 |
| sem-19 | semantic | vector | 10 | 1 | 0.250 | 0.647 | 1.000 | 18.0 |
| sem-20 | semantic | vector | 10 | 4 | 1.000 | 1.000 | 1.000 | 18.0 |
| kw-01 | keyword | hybrid | 10 | 3 | 1.000 | 1.000 | 1.000 | 18.0 |
| kw-02 | keyword | hybrid | 10 | 2 | 0.667 | 0.798 | 1.000 | 19.0 |
| kw-03 | keyword | hybrid | 10 | 2 | 0.667 | 0.905 | 1.000 | 19.0 |
| kw-04 | keyword | hybrid | 10 | 3 | 1.000 | 1.000 | 1.000 | 18.0 |
| kw-05 | keyword | hybrid | 10 | 3 | 0.667 | 0.943 | 1.000 | 19.0 |
| kw-06 | keyword | hybrid | 10 | 3 | 0.667 | 0.914 | 1.000 | 18.0 |
| kw-07 | keyword | hybrid | 10 | 3 | 0.667 | 0.912 | 1.000 | 19.0 |
| kw-08 | keyword | hybrid | 10 | 3 | 1.000 | 0.967 | 1.000 | 19.0 |
| kw-09 | keyword | hybrid | 10 | 2 | 0.667 | 0.856 | 1.000 | 18.0 |
| kw-10 | keyword | hybrid | 10 | 2 | 0.333 | 0.501 | 0.500 | 18.0 |
| kw-11 | keyword | hybrid | 10 | 1 | 0.333 | 0.674 | 1.000 | 19.0 |
| kw-12 | keyword | hybrid | 10 | 2 | 0.333 | 0.777 | 1.000 | 18.0 |
| kw-13 | keyword | hybrid | 10 | 3 | 0.667 | 0.905 | 1.000 | 18.0 |
| kw-14 | keyword | hybrid | 10 | 3 | 0.750 | 0.618 | 0.500 | 18.0 |
| kw-15 | keyword | hybrid | 10 | 2 | 0.250 | 0.857 | 1.000 | 18.0 |
| kw-16 | keyword | hybrid | 10 | 3 | 0.500 | 0.861 | 1.000 | 18.0 |
| kw-17 | keyword | hybrid | 10 | 3 | 0.333 | 0.795 | 1.000 | 19.0 |
| kw-18 | keyword | hybrid | 10 | 4 | 0.500 | 0.883 | 1.000 | 18.0 |
| kw-19 | keyword | hybrid | 10 | 3 | 0.333 | 0.762 | 1.000 | 19.0 |
| kw-20 | keyword | hybrid | 10 | 3 | 0.200 | 0.740 | 1.000 | 18.0 |
| pp-01 | paraphrase | vector | 10 | 3 | 1.000 | 0.972 | 1.000 | 18.0 |
| pp-02 | paraphrase | vector | 10 | 2 | 0.333 | 0.846 | 1.000 | 19.0 |
| pp-03 | paraphrase | vector | 10 | 2 | 0.667 | 0.812 | 1.000 | 18.0 |
| pp-04 | paraphrase | vector | 10 | 1 | 0.333 | 0.046 | 0.250 | 18.0 |
| pp-05 | paraphrase | vector | 10 | 2 | 0.667 | 0.790 | 1.000 | 13.0 |
| pp-06 | paraphrase | vector | 10 | 2 | 0.667 | 0.947 | 1.000 | 18.0 |
| pp-07 | paraphrase | vector | 10 | 3 | 0.667 | 0.668 | 0.500 | 18.0 |
| pp-08 | paraphrase | vector | 10 | 3 | 1.000 | 0.993 | 1.000 | 18.0 |
| pp-09 | paraphrase | vector | 10 | 2 | 0.667 | 0.883 | 1.000 | 18.0 |
| pp-10 | paraphrase | vector | 10 | 3 | 1.000 | 0.936 | 1.000 | 18.0 |
| pp-11 | paraphrase | vector | 10 | 3 | 1.000 | 0.988 | 1.000 | 18.0 |
| pp-12 | paraphrase | vector | 10 | 1 | 0.000 | 0.265 | 0.167 | 18.0 |
| pp-13 | paraphrase | vector | 10 | 3 | 1.000 | 0.993 | 1.000 | 18.0 |
| pp-14 | paraphrase | vector | 10 | 2 | 0.667 | 0.798 | 1.000 | 18.0 |
| pp-15 | paraphrase | vector | 10 | 2 | 0.250 | 0.323 | 0.200 | 19.0 |
| pp-16 | paraphrase | vector | 10 | 2 | 0.500 | 0.831 | 1.000 | 18.0 |
| pp-17 | paraphrase | vector | 10 | 3 | 0.500 | 0.942 | 1.000 | 18.0 |
| pp-18 | paraphrase | vector | 10 | 3 | 0.500 | 0.936 | 1.000 | 18.0 |
| pp-19 | paraphrase | vector | 10 | 1 | 0.167 | 0.605 | 1.000 | 18.0 |
| pp-20 | paraphrase | vector | 10 | 2 | 0.333 | 0.735 | 1.000 | 18.0 |

## 断言

- PASS · ingest chunk 数与评测集一致：写入 73，期望 73（浏览器分块需与 qrels 映射一致）
- PASS · 可读取实际 backend/dtype：backend=wasm，dtype=q8
- PASS · 每条查询都有结果：60 条查询均有 hit
- PASS · hit metadata 可映射（source/chunkIndex 完整）：全部 hit 均含 source + chunkIndex
- PASS · hit source 均属于评测语料：60 篇语料内
- PASS · search mode 与 keyword 预期一致：keyword→hybrid，无 keyword→vector
- PASS · qrels 均可解析到语料 chunk：229 条 qrels 全部可解析
