#!/usr/bin/env node
/**
 * dev-docker：用根目录 .env 的 SEEKDB_* 配置启动 `npm run dev`。
 *
 * 典型用途（Docker Compose 把宿主机 2882 映射到容器内 2881）：
 *   Copy-Item .env.example .env      # 首次
 *   npm run db:up                    # 启动 seekdb 容器
 *   npm run dev:docker               # = 本脚本：注入 SEEKDB_PORT=2882 等，然后 npm run dev
 *
 * 行为：
 *   1) 解析根目录 .env（简单 KEY=VALUE；支持 # 注释、export 前缀、引号、行尾注释）；
 *   2) 把键值注入子进程环境（已存在的系统环境变量优先，不覆盖）；
 *   3) 检查 docker compose 中 seekdb 服务是否在运行，未运行则提示 `npm run db:up`；
 *   4) spawn `npm run dev`（stdio 继承），转发 SIGINT/SIGTERM/SIGHUP，子进程退出码原样返回。
 *
 * 用法：
 *   node scripts/dev-docker.mjs [--env <file>] [--no-check] [--dry-run] [--help]
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const HELP = `SeekVec · Docker 模式开发启动器

用法：
  node scripts/dev-docker.mjs [选项]

选项：
  --env <file>   env 文件路径（默认根目录 .env）
  --no-check     跳过 docker compose 服务检查
  --dry-run      只打印解析后的环境变量与将要执行的命令，不启动
  -h, --help     显示帮助

说明：
  - .env 中已存在的系统环境变量不会被覆盖（系统环境变量优先）。
  - 需要 Docker Desktop / docker compose 已安装，seekdb 服务由 npm run db:up 启动。
  - seekdb 容器内端口固定 2881；.env 中 SEEKDB_PORT 指宿主机端口（compose 默认 2882）。
`;

function parseArgs(argv) {
  const opts = { envFile: path.join(ROOT, '.env'), check: true, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--env') opts.envFile = path.resolve(argv[++i] ?? '');
    else if (arg === '--no-check') opts.check = false;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else {
      console.error(`[dev-docker] 未知参数：${arg}（--help 查看用法）`);
      process.exit(2);
    }
  }
  return opts;
}

/**
 * 解析简单 KEY=VALUE 格式的 .env 文件。
 * 支持：空行、# 注释、export 前缀、单/双引号包裹、行尾注释（未加引号时）。
 * @param {string} file
 * @returns {Record<string, string>}
 */
function parseEnvFile(file) {
  const out = {};
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2) {
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      // 未加引号：去掉行尾注释（# 之前至少一个空白）
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

function isComposeServiceRunning() {
  // `docker compose ps --status running -q seekdb`：运行中输出容器 ID，未运行输出空
  const result = spawnSync('docker', ['compose', 'ps', '--status', 'running', '-q', 'seekdb'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  if (result.error) return { running: false, reason: `docker 不可用：${result.error.message}` };
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(0, 3).join(' | ');
    return { running: false, reason: `docker compose ps 失败（exit ${result.status}）：${detail}` };
  }
  const ids = (result.stdout || '').trim();
  return { running: ids.length > 0, reason: ids ? '' : 'seekdb 服务未运行' };
}

/** TCP 探测 seekdb 端口（兼容非 compose 方式启动的 seekdb / Windows MSI 场景） */
function tcpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const env = { ...process.env };

  if (fs.existsSync(opts.envFile)) {
    let parsed;
    try {
      parsed = parseEnvFile(opts.envFile);
    } catch (err) {
      console.error(`[dev-docker] ✗ 解析 ${opts.envFile} 失败：${err.message}`);
      process.exit(1);
    }
    const applied = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined) {
        env[key] = value;
        applied.push(key);
      }
    }
    console.log(
      `[dev-docker] 已读取 ${path.relative(ROOT, opts.envFile) || opts.envFile}` +
        (applied.length ? `（注入 ${applied.length} 个变量：${applied.join(', ')}）` : '（无新增变量）'),
    );
  } else {
    console.log(
      `[dev-docker] 未找到 ${path.relative(ROOT, opts.envFile) || opts.envFile}，使用现有环境变量。\n` +
        '            首次使用：Copy-Item .env.example .env（PowerShell）',
    );
  }

  // 关键连接参数回显，便于排查"连错库"问题
  console.log(
    `[dev-docker] seekdb → ${env.SEEKDB_HOST ?? '127.0.0.1'}:${env.SEEKDB_PORT ?? '2881'}` +
      `（库 ${env.SEEKDB_DATABASE ?? 'seekvec'}，用户 ${env.SEEKDB_USER ?? 'root'}）`,
  );

  if (opts.check) {
    const { running, reason } = isComposeServiceRunning();
    if (running) {
      console.log('[dev-docker] ✓ docker compose 服务 seekdb 运行中');
    } else {
      // compose 服务未注册时，再按端口探一次：兼容 docker run 手工容器 / Windows MSI / 远程 seekdb
      const host = env.SEEKDB_HOST ?? '127.0.0.1';
      const port = Number(env.SEEKDB_PORT ?? 2881);
      const reachable = await tcpProbe(host, port);
      if (reachable) {
        console.log(`[dev-docker] ✓ seekdb ${host}:${port} TCP 可达（非 compose 管理，跳过 compose 检查）`);
      } else {
        console.warn(
          `\n[dev-docker] ⚠ ${reason}，且 ${host}:${port} 不可达\n` +
            '            请先启动 seekdb 容器：\n' +
            '              npm run db:up          # docker compose up -d seekdb\n' +
            '              docker compose ps       # 确认状态为 healthy\n' +
            '            然后重新运行 npm run dev:docker；若使用非 compose 的 seekdb（如 Windows MSI），\n' +
            '            可加 --no-check 跳过本检查，或直接用 npm run dev。\n',
        );
      }
    }
  }

  // --dry-run：打印将注入的关键变量与命令，不启动子进程（冒烟/CI 可用）
  if (opts.dryRun) {
    const keys = [
      'SEEKDB_HOST',
      'SEEKDB_PORT',
      'SEEKDB_USER',
      'SEEKDB_PASSWORD',
      'SEEKDB_DATABASE',
      'SEEKDB_QUERY_TIMEOUT_MS',
      'SEEKDB_IMAGE',
      'SEEKDB_PATH',
      'PORT',
      'CORS_ORIGINS',
      'HF_ENDPOINT',
      'SEEKVEC_CACHE_DIR',
      'SEEKVEC_BASE_URL',
      'BROWSER_PATH',
    ];
    console.log('\n[dev-docker] --dry-run：将注入以下变量并执行 `npm run dev`');
    for (const key of keys) {
      if (env[key] !== undefined && env[key] !== '') {
        const value = key === 'SEEKDB_PASSWORD' ? (env[key] ? '***' : '（空）') : env[key];
        console.log(`  ${key}=${value}`);
      }
    }
    console.log(`  cwd=${ROOT}`);
    console.log('  command=npm run dev');
    console.log('\n[dev-docker] ✓ dry-run 完成（未启动任何进程）。');
    return;
  }

  console.log('[dev-docker] 启动 npm run dev ...\n');

  // Windows 下 npm 是 .cmd 包装脚本，直接 spawn 'npm.cmd' 会 EINVAL；
  // 用 cmd.exe 执行命令（不用 shell:true，避免 Node 的 args 拼接弃用告警）。
  const child =
    process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run dev'], {
          cwd: ROOT,
          env,
          stdio: 'inherit',
          windowsHide: false,
        })
      : spawn('npm', ['run', 'dev'], {
          cwd: ROOT,
          env,
          stdio: 'inherit',
          windowsHide: false,
        });

  let stopping = false;
  const forward = (signal) => {
    if (stopping) return;
    stopping = true;
    try {
      child.kill(signal);
    } catch {
      // 子进程可能已退出
    }
    // 兜底：3s 内未退出则强制结束本进程
    setTimeout(() => process.exit(1), 3000).unref();
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => forward(sig));
  }

  child.on('error', (err) => {
    console.error(`[dev-docker] ✗ 无法启动 npm run dev：${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) console.log(`[dev-docker] 子进程被信号 ${signal} 终止`);
    process.exit(code ?? 1);
  });
}

main().catch((err) => {
  console.error('[dev-docker] ✗ 未预期错误：', err);
  process.exit(1);
});


