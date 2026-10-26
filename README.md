# SeekVec

> 端侧量化向量化 + SeekDB 语义检索的迷你知识库 · 2026 OceanBase 数据库大赛参赛项目

## 关键设计

- **端侧推理**：浏览器内用 Transformers.js 跑 int8（q8）量化 ONNX embedding，WebGPU 优先、失败自动降级 WASM，模型加载失败时可一键重试
- **SeekDB 数据层**：seekdb server（Windows MSI 或 Docker）或 seekdb 嵌入式（Linux/macOS），对外暴露薄 HTTP API
- **双集合架构**：文本集合（HNSW + ik 全文）+ 图片集合（v1.1 预留，当前开关关闭）
- **`embeddingFunction: null`**：向量全部由 web 端推理写入，server 不 import 任何 ONNX/embedding 库
- **离线可用**：推理零云端依赖；首次联网下载模型后写入浏览器缓存，也可预置本地模型目录

## 启动前提（三选一）

### 方式 A：Docker 启动 seekdb（Windows 推荐，免装 MSI）

```powershell
# 1) 创建数据卷（必须挂到容器内 /var/lib/seekdb，否则容器重建后数据会丢）
docker volume create seekvec_seekdb-data

# 2) 启动 seekdb server（宿主机用 2882 端口，避免与其他实例冲突）
docker run -d --name seekvec-seekdb -p 2882:2881 `
  -v seekvec_seekdb-data:/var/lib/seekdb `
  -e REPORTER=seekvec-seekdb `
  quay.io/oceanbase/seekdb:latest

# 3) 用 2882 端口启动开发
$env:SEEKDB_PORT="2882"; npm run dev
```

> 镜像也可用 `oceanbase/seekdb`；实测 seekdb-js 1.3.0 与 server 1.4.0 兼容。

### 方式 B：Windows MSI 安装 seekdb server

```powershell
# 1. 下载 MSI：https://github.com/oceanbase/seekdb/releases
# 2. 以管理员身份安装（UAC 点确认）
msiexec /i seekdb-1.3.0.0-win64.msi /qn
# 3. 初始化 + 启动服务
cd "C:\Program Files\seekdb\bin"
.\seekdb_manage.ps1 install   # 首次：初始化数据库 + 注册 Windows 服务
.\seekdb_manage.ps1 start     # 启动服务
# 4. 验证（默认 127.0.0.1:2881）
Test-NetConnection 127.0.0.1 -Port 2881
```

也可以用仓库脚本（自动探测安装路径与 Docker 场景）：`scripts/start-seekdb.ps1`（需管理员）。

### 方式 C：Linux/macOS 嵌入式模式

```bash
export SEEKDB_PATH=/path/to/seekdb/data
```

## 安装与启动

需要 Node 18.17+。**注意**：根目录 `npm install` 只装 concurrently，所有子包依赖用 `install:all`：

```bash
npm run install:all     # 安装 根 + server + web + scripts 依赖
npm run dev             # predev 会先用 SEEKDB_HOST/SEEKDB_PORT 检查 seekdb
```

- 后端 API：[http://localhost:3001](http://localhost:3001)（`GET /api/health`）
- 前端 UI：[http://localhost:5173](http://localhost:5173)

### 其他命令

```bash
npm test          # server + web 单元测试（vitest，无外部依赖）
npm run probe     # seekdb 端到端探针（建库/建集合/upsert/混合检索/清理）
npm run bench     # 量化评测：int8 vs fp32 余弦相似度 + Top-1/Top-5 一致性（不写库）
```

CI：`.github/workflows/ci.yml` 在 push/PR 时安装依赖、构建两端并运行单测。

`bench` 首次需要联网下载模型权重，可指定镜像与缓存目录（避免写入系统盘）：

```bash
# PowerShell
$env:HF_ENDPOINT="https://hf-mirror.com/"
$env:SEEKVEC_CACHE_DIR="E:\path\to\.cache"; npm run bench
```

Node 端没有 WASM 设备，bench 使用 CPU EP；候选集只有 9 条，Recall 指标只作一致性参考。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SEEKDB_HOST` / `SEEKDB_PORT` | `127.0.0.1` / `2881` | seekdb server 地址（Docker 场景常用 2882） |
| `SEEKDB_USER` / `SEEKDB_PASSWORD` / `SEEKDB_DATABASE` | `root` / 空 / `seekvec` | seekdb 连接与库名 |
| `SEEKDB_PATH` | 空 | 设置后走嵌入式模式（仅 Linux/macOS） |
| `PORT` / `CORS_ORIGINS` | `3001` / `http://localhost:5173` | server 端口与 CORS |
| `VITE_HF_ENDPOINT` | 官方 HF | 前端模型下载源（如 `https://hf-mirror.com/`） |
| `VITE_ORT_WASM_PATH` | jsDelivr CDN | ONNX Runtime wasm 资源目录（本地托管时如 `/ort/`） |
| `VITE_LOCAL_MODELS` / `VITE_LOCAL_MODEL_PATH` | 关 / `/models/` | 使用 `web/public/models` 下的本地模型 |

前端变量写在 `web/.env.local`（已 gitignore），不设置时保持官方默认行为。

## 目录结构

```
SeekVec/
├── package.json              # concurrently 调度 server + web；predev 检查 seekdb
├── docs/                     # 赛题 + 架构 + 技术说明
├── server/                   # Node + Express + seekdb-js（server 模式）
│   └── src/
│       ├── db/               # client（含连接自愈）/ schema / collections
│       └── routes/           # collections / documents / search / images / errors
├── web/                      # Vite + React + TS + Transformers.js
│   └── src/
│       ├── inference/        # 模型注册、后端探测、pipeline、分块
│       ├── hooks/            # useEmbedding / useIngest / useSearch / useCollections
│       ├── db/api.ts         # HTTP API client
│       └── components/       # 导入/检索/结果/状态徽标
└── scripts/
    ├── probe-seekdb.mjs      # seekdb 端到端探针（npm run probe）
    ├── check-seekdb.mjs      # predev 检查脚本
    ├── start-seekdb.ps1      # Windows 启动脚本（管理员）
    └── bench.ts              # 量化评测脚本（npm run bench）
```

## 交付物映射

| 赛题要求 | 落点 |
|---|---|
| 可运行的 Web 应用 | `npm run dev` 一条命令拉起两端 |
| 完整源码仓库 | 本仓库全部 |
| 一页技术说明 | [`docs/技术说明.md`](docs/技术说明.md) |

## 版本计划

- **v1（首版提交）**：文本管线，默认 bge-small-zh，支持中英模型切换；导入幂等、错误可重试、刷新后检索可用
- **v1.1（stretch）**：图片集合（CLIP）。CLIP 文本塔需要 AutoProcessor + CLIPTextModelWithProjection，当前由 `IMAGE_PIPELINE_ENABLED=false` 保护，未启用

详细架构见 [`docs/架构.md`](docs/架构.md)，技术说明见 [`docs/技术说明.md`](docs/技术说明.md)。
