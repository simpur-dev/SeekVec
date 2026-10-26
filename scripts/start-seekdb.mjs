#!/usr/bin/env node
/**
 * seekdb 本地 server 启动/检查脚本（4.1：随应用提供本地 server 启动脚本与连接配置）
 *
 * 行为：
 *   1) 读取根 .env（不存在时从 .env.example 生成）；
 *   2) 若 seekdb 端口已可达：打印连接配置并退出 0（不重复启动）；
 *   3) 否则尝试 `docker compose up -d seekdb`（仓库自带 docker-compose.yml），
 *      等待端口就绪后退出 0；
 *   4) 没有 Docker / 启动失败：打印 MSI 与 Linux/macOS 嵌入式指引，退出 1。
 *
 * 用法：
 *   npm run db:start                 # 启动并等待就绪
 *   npm run db:status                # 只检查（等价 --check）
 *   node scripts/start-seekdb.mjs --check
 *   node scripts/start-seekdb.mjs --no-start   # 只检查，不尝试 docker compose
 *   node scripts/start-seekdb.mjs --timeout 120
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './lib/env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const opts = { check: false, noStart: false, timeoutSec: 90 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--no-start') opts.noStart = true;
    else if (arg === '--timeout') opts.timeoutSec = Number(argv[++i] ?? opts.timeoutSec);
    else if (arg === '-h' || arg === '--help') {
      console.log(
        'SeekVec seekdb 本地 server 启动脚本\n\n' +
          '用法：node scripts/start-seekdb.mjs [--check] [--no-start] [--timeout 秒]\n' +
          '  --check    只检查连接，不启动\n' +
          '  --no-start 检查失败也不尝试 docker compose\n' +
          '  --timeout  等待就绪的秒数（默认 90）\n',
      );
      process.exit(0);
    } else {
      console.error(`[seekdb] 未知参数：${arg}（--help 查看用法）`);
      process.exit(2);
    }
  }
  return opts;
}

function tcpCheck(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (ok, error) => {
      socket.destroy();
      resolve({ ok, error });
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false, 'timeout'));
    socket.on('error', (err) => finish(false, err.code ?? err.message));
    socket.connect(port, host);
  });
}

function dockerAvailable() {
  const r = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 15000 });
  return r.status === 0;
}

async function waitForPort(host, port, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const r = await tcpCheck(host, port);
    if (r.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function printConnection(ctx, extra = '') {
  const password = ctx.password ? '***' : '（空）';
  console.log(`[seekdb] 连接配置：
  SEEKDB_HOST=${ctx.host}
  SEEKDB_PORT=${ctx.port}
  SEEKDB_USER=${ctx.user}
  SEEKDB_PASSWORD=${password}
  SEEKDB_DATABASE=${ctx.database}
  配置文件：${path.join(ROOT, '.env')}（来自 .env.example，可修改）${extra}`);
}

function printFallback() {
  console.error(`
[seekdb] 未能启动本地 server。可选手动方式：

A. Docker（推荐，全平台）
  npm run db:up
  # 或：docker compose up -d seekdb
  然后确认：npm run db:status

B. Windows MSI（管理员 PowerShell）
  cd "C:\\Program Files\\seekdb\\bin"
  .\\seekdb_manage.ps1 install
  .\\seekdb_manage.ps1 start
  然后在 .env 设置 SEEKDB_PORT=2881

C. Linux/macOS 嵌入式（Windows 不支持）
  export SEEKDB_PATH=/path/to/seekdb-data
  然后 npm run dev

详细步骤见 README.md / docs/复现.md。`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // 没有 .env 时从示例生成，保证 compose 端口与应用连接配置一致
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath) && fs.existsSync(path.join(ROOT, '.env.example'))) {
    fs.copyFileSync(path.join(ROOT, '.env.example'), envPath);
    console.log('[seekdb] 未找到 .env，已从 .env.example 生成（本地配置，gitignore）');
  }
  loadDotEnv(ROOT);

  const ctx = {
    host: process.env.SEEKDB_HOST ?? '127.0.0.1',
    port: Number(process.env.SEEKDB_PORT ?? 2881),
    user: process.env.SEEKDB_USER ?? 'root',
    password: process.env.SEEKDB_PASSWORD ?? '',
    database: process.env.SEEKDB_DATABASE ?? 'seekvec',
  };

  console.log(`[seekdb] 目标 ${ctx.host}:${ctx.port}（database=${ctx.database}）`);
  const ready = await tcpCheck(ctx.host, ctx.port);
  if (ready.ok) {
    printConnection(ctx, '\n[seekdb] ✓ 已就绪');
    process.exit(0);
  }

  if (opts.check || opts.noStart) {
    console.error(`[seekdb] ✗ ${ctx.host}:${ctx.port} 不可达（${ready.error ?? 'connect failed'}）`);
    printFallback();
    process.exit(1);
  }

  if (!dockerAvailable()) {
    console.error('[seekdb] ✗ 未检测到 docker compose；无法自动启动。');
    printFallback();
    process.exit(1);
  }

  console.log('[seekdb] 启动 docker compose seekdb ...');
  const start = spawnSync('docker', ['compose', 'up', '-d', 'seekdb'], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 300000,
    env: process.env,
  });
  if (start.status !== 0) {
    console.error('[seekdb] ✗ docker compose 启动失败。');
    printFallback();
    process.exit(1);
  }

  console.log(`[seekdb] 等待 ${ctx.host}:${ctx.port} 就绪（最多 ${opts.timeoutSec}s）...`);
  if (await waitForPort(ctx.host, ctx.port, opts.timeoutSec)) {
    printConnection(ctx, '\n[seekdb] ✓ 本地 server 已启动并就绪');
    process.exit(0);
  }
  console.error(`[seekdb] ✗ ${opts.timeoutSec}s 内未就绪：${ctx.host}:${ctx.port}`);
  printFallback();
  process.exit(1);
}

main().catch((err) => {
  console.error('[seekdb] ✗ 未预期错误：', err);
  process.exit(1);
});
