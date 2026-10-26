/**
 * seekdb 启动检查脚本（跨平台，Node 原生 net.connect）
 *
 * 探 2881 端口，2 秒超时。
 * 失败时打印 MSI 安装指引并以退出码 1 退出。
 *
 * 用法:
 *   node scripts/check-seekdb.mjs
 *
 * 挂到根 package.json predev:
 *   "predev": "node scripts/check-seekdb.mjs"
 */
import net from 'net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './lib/env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// 直接执行 npm run dev 时也能读取根 .env 中的 SEEKDB_HOST/PORT。
loadDotEnv(ROOT);

const HOST = process.env.SEEKDB_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SEEKDB_PORT ?? 2881);
const TIMEOUT_MS = 2000;

const INSTALL_GUIDE = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠   SeekDB server 未就绪（${HOST}:${PORT} 连接失败）

可选方案一：Docker（推荐，Windows 上无需装 MSI）
  docker volume create seekvec_seekdb-data
  docker run -d --name seekvec-seekdb -p 2882:2881 ^
    -v seekvec_seekdb-data:/var/lib/seekdb ^
    -e REPORTER=seekvec-seekdb quay.io/oceanbase/seekdb:latest
  # 注意：卷必须挂到容器内 /var/lib/seekdb，否则数据不持久
  # 然后设置端口后启动：
  $env:SEEKDB_PORT="2882"; npm run dev

可选方案二：Windows MSI 安装（默认 127.0.0.1:2881）
  1. 下载 seekdb 1.3.0+ MSI:
     https://github.com/oceanbase/seekdb/releases
  2. 以管理员身份运行 PowerShell，初始化并启动服务:
     cd "C:\\Program Files\\seekdb\\bin"
     .\\seekdb_manage.ps1 install
     .\\seekdb_manage.ps1 start
  3. 验证端口:
     Test-NetConnection ${HOST} -Port ${PORT}

Linux/macOS（嵌入式模式）:
  export SEEKDB_PATH=/path/to/seekdb/data
  然后运行 dev。

可用环境变量: SEEKDB_HOST / SEEKDB_PORT（默认 127.0.0.1:2881）
详情见 README.md 或 docs/技术说明.md。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

async function checkSeekdb() {
  return new Promise((resolve) => {
    const socket = new net.Socket();

    socket.setTimeout(TIMEOUT_MS);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      resolve(false);
    });

    socket.connect(PORT, HOST);
  });
}

async function main() {
  process.stdout.write(`[check-seekdb] 探 ${HOST}:${PORT} ... `);

  const ok = await checkSeekdb();

  if (ok) {
    console.log('✓ 已就绪');
    process.exit(0);
  } else {
    console.log('✗ 未就绪');
    console.error(INSTALL_GUIDE);
    process.exit(1);
  }
}

main();
