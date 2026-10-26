# SeekVec

> 端侧量化向量化 + SeekDB 语义检索的迷你知识库 · 2026 OceanBase 数据库大赛参赛项目
>
> 赛道：「seekdb × 阶跃星辰」· 题目《端侧 AI 推理性能优化与 seekdb 混合检索》· 总分 20 · [正式赛题原文](docs/赛题.md)

## 关键设计

- **端侧推理**：浏览器内用 Transformers.js + ONNX Runtime Web 执行 embedding 推理（WASM 用 INT8/q8，WebGPU 用 FP16，可用 `?dtype=` 覆盖），WebGPU 优先、失败自动降级 WASM 且界面明确提示
- **SeekDB 数据层**：seekdb server（Docker / Windows MSI）或嵌入式（Linux/macOS）；向量、原文、元数据全部存 seekdb，向量+全文混合检索（RRF）由库内完成
- **`embeddingFunction: null`**：向量全部由 web 端推理写入，server 不导入任何推理/量化库（`npm run check:compliance` 可审计）
- **端侧零云依赖**：推理不在任何远端发生；模型权重经 `models.lock.json` 固定 revision/sha256 后下载或本地加载
- **可观测与可复现**：`?perf=1` 暴露分阶段计时接口；浏览器基准（冷/热、WebGPU/WASM、batch/refresh 消融）+ 标注评测集质量对比，原始数据随仓库提交

## 快速启动

前置：Node.js ≥ 18.17、npm，以及 Docker（或本机 seekdb server / Linux 嵌入式）。

```bash
# ① 安装根 + server + web + scripts 依赖
npm run install:all

# ② 本地配置（均已被 gitignore；不复制则使用默认值）
cp .env.example .env                              # PowerShell: Copy-Item .env.example .env
cp web/.env.local.example web/.env.local          # 可选：镜像/本地模型/ORT 路径

# ③ 启动 seekdb（Docker，宿主机默认 2882）
npm run db:up
docker compose ps                                 # STATUS=healthy 后继续

# ④ 准备浏览器静态资产（首次需要网络）：ORT wasm + q8/fp16 模型
npm run prepare:assets

# ⑤ 启动应用（读取 .env 注入 SEEKDB_*）
npm run dev:docker
```

- Web UI：<http://localhost:5173>
- API：<http://localhost:3001/api/health>
- 自检：`npm run acceptance`（PASS/FAIL 表，exit 0 表示环境可用）

> 已有 seekdb server（如 Windows MSI 或其它容器）时，把 `.env` 的 `SEEKDB_PORT` 改为实际端口，然后 `npm run dev` 即可。

## 浏览器要求与演示

- 支持 Chrome / Edge / Chromium 等现代浏览器（实测 Chrome 153 / Chromium 引擎）；WebGPU 需要硬件与安全上下文（`localhost`/HTTPS）
- 演示路径：文本检索页 → 拖入 `data/demo/` 示例文档 → 观察「读取/向量化/写入」进度与结果 → 输入查询检索；填「关键字」后检索会走 **seekdb 库内混合检索（RRF）**
- 界面右上角徽标显示当前推理后端（WebGPU / WASM，含降级原因与模型加载耗时）
- 强制后端/精度（用于验收降级路径）：`?backend=wasm`、`?backend=webgpu`、`?dtype=fp16|q8|fp32`（会记住后端选择；可用 `?backend=auto` 清除）
- 性能观测模式：`?perf=1`（暴露 `window.__seekvecPerf` / `window.__seekvecEval`，界面显示向量化/检索/端到端耗时）

## 评测与报告

| 内容 | 命令 / 证据 |
|---|---|
| 量化前后质量（标注集 Recall/nDCG/MRR） | `npm run eval:quality` → [`docs/技术说明.md`](docs/技术说明.md)；原始数据 [`docs/benchmarks/eval-quality/`](docs/benchmarks/eval-quality/) |
| 浏览器端质量（真实应用链路） | `npm run eval:quality:browser` → [`docs/benchmarks/quality-browser/`](docs/benchmarks/quality-browser/) |
| 分阶段性能 + 冷/热 + 后端对比 | `npm run bench:matrix`（或 `npm run bench:browser -- ...`）→ [`docs/benchmarks/`](docs/benchmarks/) |
| 综合报告（官方 3.2 表格） | [`docs/性能与质量报告.md`](docs/性能与质量报告.md) |
| 验收自检（3.1/3.2/4.1–4.3） | [`docs/验收自检.md`](docs/验收自检.md) |
| 从零复现 | [`docs/复现.md`](docs/复现.md) |
| 模型与量化说明 | [`docs/模型与量化.md`](docs/模型与量化.md) |

## 常用命令

```bash
npm run dev            # 直接启动 server + web（需 SEEKDB_* 已设置）
npm run dev:docker     # 读取根 .env 注入 seekdb 配置后启动
npm run db:up/db:down  # docker compose 启动/停止 seekdb（保留数据卷）
npm run prepare:assets # 下载/校验模型 + 复制 ORT wasm（同源 /ort/）
npm run probe          # seekdb 端到端探针（建库/集合/upsert/混合检索/清理）
npm run bench          # 模型体积/压缩比 + q8/fp16 vs fp32 一致性（Node CPU，离线可用）
npm run eval:quality   # 标注集检索质量（fp32/q8/fp16）
npm run bench:browser  # 单组浏览器基准（分阶段计时；--check/--smoke/--headful 等）
npm run bench:matrix   # ABBA 矩阵：后端/精度/batch/refresh/cold 对比
npm test               # server + web + scripts 单测（224 项，无外部依赖）
npm run build          # 构建 server + web
npm run acceptance     # 环境/API/模型/合规自检
npm run check:compliance  # 赛题合规检查（server 不含推理依赖、web 端侧推理）
```

## 环境变量

### 根 `.env`（server / Docker / Node 脚本）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SEEKDB_HOST` / `SEEKDB_PORT` | `127.0.0.1` / `2881` | seekdb server 地址（Docker 示例用 2882）|
| `SEEKDB_USER` / `SEEKDB_PASSWORD` / `SEEKDB_DATABASE` | `root` / 空 / `seekvec` | 连接与库名 |
| `SEEKDB_PATH` | 空 | 嵌入式模式（仅 Linux/macOS）|
| `SEEKDB_QUERY_TIMEOUT_MS` | `30000` | SQL 查询超时 |
| `PORT` / `CORS_ORIGINS` | `3001` / `http://localhost:5173` | server 端口与 CORS |
| `SEEKDB_IMAGE` | `quay.io/oceanbase/seekdb:latest` | compose 镜像（可 pin digest）|
| `SEEKVEC_CACHE_DIR` / `HF_ENDPOINT` | `./scripts/.cache` / 官方 HF | Node 脚本缓存与模型源 |
| `BROWSER_PATH` / `SEEKVEC_BASE_URL` | 自动探测 / `http://localhost:5173` | 浏览器基准 |

### `web/.env.local`（Vite 构建期）

| 变量 | 默认 | 说明 |
|---|---|---|
| `VITE_HF_ENDPOINT` | 官方 HF | 模型下载源（如 `https://hf-mirror.com/`）|
| `VITE_ORT_WASM_PATH` | `/ort/` | ORT wasm 资源路径（同源，`prepare:assets` 生成）|
| `VITE_LOCAL_MODELS` / `VITE_LOCAL_MODEL_PATH` | 关 / `/models/` | 使用 `web/public/models` 本地模型目录 |

完整注释见 [`.env.example`](.env.example) 与 [`web/.env.local.example`](web/.env.local.example)。

## 正式赛题对齐

| 验收项（3.1） | 状态 | 证据 |
|---|---|---|
| 完整流程 / 本地推理 | ✅ | 浏览器 e2e；`npm run check:compliance`；[架构 §4–5](docs/架构.md) |
| 模型量化：来源/版本/体积/压缩比/质量变化 | ✅ | [`docs/模型与量化.md`](docs/模型与量化.md)；`docs/benchmarks/eval-quality/` |
| 后端与降级（WebGPU→WASM + 提示） | ✅ | `?backend=` 强制开关、徽标；[性能与质量报告](docs/性能与质量报告.md) |
| seekdb 数据层（库内混合检索、索引刷新） | ✅ | 集合 schema/API、`hybridSearch`、维护接口；[架构 §5](docs/架构.md) |
| 状态与刷新（增量导入、集合/会话状态） | ✅ | 幂等 upsert、陈旧块清理、activeCollection、刷新回填 |
| 可复现性 | ✅ | Docker compose + `dev:docker` + `prepare:assets` + `acceptance`；[复现.md](docs/复现.md) |
| 性能与质量测试（3.2 六项） | ✅ | 分阶段/冷热/中位数/原始数据/双后端/标注集质量；[性能与质量报告](docs/性能与质量报告.md) |

提交材料映射：4.1 可运行应用（本 README + `dev:docker`）；4.2 完整源码（本仓库 + 模型锁/数据/脚本）；4.3 一页技术说明（[`docs/技术说明.md`](docs/技术说明.md)）。

## 目录结构（主要部分）

```
SeekVec/
├── docker-compose.yml        # seekdb 服务（数据卷 /var/lib/seekdb）
├── models.lock.json          # 模型 revision/文件/sha256 锁
├── data/
│   ├── demo/                 # UI 演示语料
│   ├── eval/                 # 标注评测集（60 文档/73 chunks/60 查询/229 qrels）
│   └── perf/                 # 性能语料与查询（确定性生成）
├── docs/                     # 赛题/架构/技术说明/模型与量化/性能报告/复现/验收自检
│   └── benchmarks/           # 原始数据 + 汇总（eval-quality、browser、matrix、quality-browser）
├── scripts/                  # fetch/bench/eval/acceptance/compliance/dev-docker
├── server/src/
│   ├── app.ts / index.ts     # 应用工厂 + 启动
│   ├── db/                   # client（连接自愈）/ schema / collections
│   ├── routes/               # collections/documents/search/images/health + validation
│   └── util/                 # timing / asyncMutex / lucene 转义
└── web/src/
    ├── config/runtimeConfig.ts   # ?backend/?dtype/?batch/?refresh/?perf...
    ├── inference/               # models/backend/pipeline/runtime
    ├── perf/                    # metrics + evalApi（?perf=1）
    ├── ingest/ search/          # 导入/检索核心（与 React 解耦）
    ├── hooks/                   # useEmbedding/useIngest/useSearch/useCollections
    └── components/              # 导入/检索/结果/后端徽标
```

## 测试与 CI

- `npm test`：224 项（server 113 / web 69 / scripts 42），纯 Node，无需 seekdb/浏览器/网络
- `npm run check:compliance`：6 项合规检查（server 无推理依赖/代码字样、web 端侧推理等）
- GitHub Actions（`.github/workflows/ci.yml`）：install → build → 单测 → scripts 类型 → 合规；**不**依赖 seekdb/浏览器（基准与集成手工执行，步骤见复现文档）

## 版本计划

- **v1（首版提交）**：文本知识库、中英模型切换、INT8/FP16/FP32、WebGPU→WASM、幂等导入与索引刷新、可观测与评测链路
- **v1.1（stretch）**：图片管线（CLIP）。Schema/接口/模型注册已预留；CLIP 文本塔需 `AutoProcessor + CLIPTextModelWithProjection`，当前 `IMAGE_PIPELINE_ENABLED=false`

详细架构见 [`docs/架构.md`](docs/架构.md)，技术说明见 [`docs/技术说明.md`](docs/技术说明.md)，复现见 [`docs/复现.md`](docs/复现.md)。
