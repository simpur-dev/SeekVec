# 第三方组件与许可声明（THIRD_PARTY_NOTICES）

SeekVec 参赛项目（2026 OceanBase 数据库大赛 ·「seekdb × 阶跃星辰」赛道）。

- 本仓库自有代码、脚本、自建语料（`data/**`）与文档：版权归项目团队，作为大赛提交物提供；未另行声明开源许可。
- 模型权重**不随仓库分发**：仓库只保存固定 revision 与 sha256 的锁文件（`models.lock.json`），由脚本按锁从 Hugging Face 下载。
  下载与使用须同时遵守下述模型许可。
- 以下列表覆盖直接使用的主要第三方资产；其余 npm 依赖以各自包内 `LICENSE` 为准。

## 1. 模型（ONNX 权重与分词器）

| 资产 | 上游模型 | 许可 | 说明 |
|---|---|---|---|
| `Xenova/bge-small-zh-v1.5` | `BAAI/bge-small-zh-v1.5` | **MIT** | 中文/中英 embedding，512 维；Xenova 提供的 ONNX（含 q8/fp16/fp32）社区转换版。锁 revision：`75c43b069aac4d136ba6bc1122f995fedcfd2781` |
| `Xenova/all-MiniLM-L6-v2` | `sentence-transformers/all-MiniLM-L6-v2` | **Apache-2.0** | 英文 embedding，384 维；Xenova 提供的 ONNX 转换版。锁 revision：`751bff37182d3f1213fa05d7196b954e230abad9` |

- 上游来源：
  - BAAI/bge-small-zh-v1.5：<https://huggingface.co/BAAI/bge-small-zh-v1.5>
  - sentence-transformers/all-MiniLM-L6-v2：<https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2>
- 实际使用的 ONNX 再分发仓库：
  - <https://huggingface.co/Xenova/bge-small-zh-v1.5>
  - <https://huggingface.co/Xenova/all-MiniLM-L6-v2>
- 每个文件的 sha256 与字节数见 `models.lock.json`；下载脚本为 `scripts/fetch-models.mjs`。
- 学术引用（如报告引用模型，建议注明）：
  - BGE：Jianlv Chen et al. *BGE M3-Embedding: Multi-Lingual, Multi-Functionality, Multi-Granularity Text Embeddings Through Self-Knowledge Distillation*, 2024.
  - MiniLM：Nils Reimers, Iryna Gurevych. *Sentence-BERT: Sentence Embeddings using Siamese BERT-Networks*, EMNLP 2019.

## 2. seekdb

| 资产 | 许可 | 说明 |
|---|---|---|
| OceanBase seekdb（server） | **Apache-2.0** | 本项目的向量/全文/Fusion 数据层。源码：<https://github.com/oceanbase/seekdb> |
| `quay.io/oceanbase/seekdb` 容器镜像 | Apache-2.0（镜像内基础组件另有其许可） | 实测版本 seekdb 1.4.0，digest `sha256:4db4961869d554313520d6081fca29265ba6da6db7313311bd8acbed771a956b`；`docker-compose.yml` 使用 `latest` 并支持 `SEEKDB_IMAGE` pin |
| `seekdb` npm 客户端（seekdb-js） | Apache-2.0 | 版本 `1.3.0`，server 端唯一数据库依赖 |

## 3. 端侧推理运行时（浏览器）

| 资产 | 许可 | 说明 |
|---|---|---|
| `@huggingface/transformers`（Transformers.js） | **Apache-2.0** | 浏览器内 ONNX 推理与 tokenizer；仅 web 端依赖，server 禁止引入 |
| `onnxruntime-web`（ONNX Runtime Web） | **MIT** | Transformers.js 的推理后端；wasm 资源由 `npm run prepare:assets` 同源托管到 `web/public/ort/`，不入库 |

> 赛题合规约束：所有 embedding 推理在用户浏览器内完成；server 不导入任何 onnx/transformers/default-embed 依赖（可执行 `npm run check:compliance` 验证）。

## 4. 应用与工具链依赖

| 组件 | 许可 | 用途 |
|---|---|---|
| React / React DOM | MIT | 前端 UI |
| Vite | MIT | 前端构建与 dev server |
| Tailwind CSS | MIT | 样式 |
| zustand | MIT | 前端状态管理 |
| Express | MIT | HTTP API |
| cors | MIT | CORS 中间件 |
| concurrently | MIT | 根级并行启动 server+web |
| tsx | MIT | TS 脚本运行 |
| TypeScript | Apache-2.0 | 类型检查/构建 |
| vitest | MIT | 单元测试 |
| puppeteer-core | Apache-2.0 | 浏览器基准测试（驱动本机 Chrome/Edge/Chromium） |

## 5. 数据与素材

- `data/eval/**` 与 `data/perf/**` 语料由项目团队自行编写，许可随项目提交物；未使用第三方版权文本。
- 仓库不包含第三方图片、字体或图标资源；界面使用系统字体与自带 SVG。
- 基准报告中的浏览器/硬件信息为实测环境描述，不含第三方内容。

## 6. 许可与合规说明

1. 模型按上游许可（MIT / Apache-2.0）使用；如报告或页面展示模型名称，保留上述归属说明。
2. seekdb 以 Apache-2.0 使用；Docker 部署方式见 `docker-compose.yml` 与 `docs/复现.md`。
3. 本项目对第三方组件的使用不构成对其商标的授权；"OceanBase"、"seekdb"、"Hugging Face"、"ONNX Runtime" 等名称归各自权利人所有。

---

_最后更新：2026-10（镜像 digest 与模型 revision 变更时请同步更新本文件与 `docker-compose.yml`。）_
