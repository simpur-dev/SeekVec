# SeekVec

> 端侧量化向量化 + SeekDB 语义检索的迷你知识库 · 2026 OceanBase 数据库大赛参赛项目

## 关键设计

- **端侧推理**：浏览器内用 Transformers.js 跑 int8 量化 ONNX embedding，WebGPU 优先、WASM 降级
- **SeekDB 数据层**：seekdb server 1.3.0（Windows MSI 安装）或 seekdb 嵌入式（Linux/macOS），对外暴露薄 HTTP API
- **双集合架构**（v1.1）：文本集合（HNSW + ik 全文）+ 图片集合（仅 HNSW）；`embeddingFunction: null`，向量全由 web 端推理写入
- **零云依赖**：所有 embedding 计算在浏览器内完成，server 仅做存储与检索（赛题规则 1 合规）

## 启动前提

**Windows（必须）**：先安装 seekdb server 1.3.0，再启动 dev。

```powershell
# 1. 下载 MSI
# https://github.com/oceanbase/seekdb/releases/download/v1.3.0/seekdb-1.3.0.0-100000092026051510-win64.msi

# 2. 以管理员身份安装（UAC 点确认）
msiexec /i seekdb-1.3.0.0-win64.msi /qn

# 或用内置脚本初始化 + 注册服务
cd "C:\Program Files\seekdb\bin"
.\seekdb_manage.ps1 install   # 首次：初始化数据库 + 注册 Windows 服务
.\seekdb_manage.ps1 start     # 启动服务

# 3. 验证
Test-NetConnection 127.0.0.1 -Port 2881  # 应返回 TcpTestSucceeded: True
```

**Linux/macOS（嵌入式模式）**：设置环境变量即可，无需装 MSI。

```bash
export SEEKDB_PATH=/path/to/seekdb/data
```

## 启动

需要 Node 18.17+，先在根目录一次性安装所有子包依赖：

```bash
npm install
```

启动开发（同时拉起 server 与 web，`predev` 会先检查 seekdb 是否就绪）：

```bash
npm run dev
```

- 后端 API：[http://localhost:3001](http://localhost:3001)
- 前端 UI：[http://localhost:5173](http://localhost:5173)

## 目录结构

```
SeekVec/
├── package.json              # concurrently 调度 server + web；predev 检查 seekdb
├── docs/                     # 赛题 + 架构 + 技术说明
├── server/                   # Node + Express + seekdb-js（server 模式）
├── web/                      # Vite + React + TS + Transformers.js
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

- **v1（首版提交）**：仅文本管线，默认 bge-small-zh，支持中英双语切换
- **v1.1（stretch）**：加图片集合（CLIP），文本→图片检索

详细架构见 [`docs/架构.md`](docs/架构.md)，技术说明见 [`docs/技术说明.md`](docs/技术说明.md)。
