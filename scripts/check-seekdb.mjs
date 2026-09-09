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

const HOST = process.env.SEEKDB_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SEEKDB_PORT ?? 2881);
const TIMEOUT_MS = 2000;

const INSTALL_GUIDE = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠   SeekDB server 未启动（127.0.0.1:${PORT} 连接失败）

修复步骤（Windows）:
  1. 下载 seekdb 1.3.0 MSI（若未安装）:
     https://github.com/oceanbase/seekdb/releases/download/v1.3.0/seekdb-1.3.0.0-100000092026051510-win64.msi

  2. 以管理员身份运行 PowerShell，安装并启动服务:
     cd "C:\\Program Files\\seekdb\\bin"
     .\\seekdb_manage.ps1 install   # 初始化数据库 + 注册服务
     .\\seekdb_manage.ps1 start     # 启动服务

  3. 验证端口:
     Test-NetConnection 127.0.0.1 -Port ${PORT}

  4. 重新运行 dev:
     npm run dev

Linux/macOS（嵌入式模式）:
  设置 SEEKDB_PATH 环境变量:
     export SEEKDB_PATH=/path/to/seekdb/data
  然后运行 dev。

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
