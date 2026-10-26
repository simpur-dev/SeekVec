#!/usr/bin/env node
/**
 * 验收自检（npm run acceptance）：一条命令确认本地部署是否可用。
 *
 * 检查项：
 *   1) Node 版本 ≥ 18.17.0（package.json engines）；
 *   2) server 端口（PORT，默认 3001）TCP 可达；
 *   3) seekdb 端口（SEEKDB_PORT，默认 2881）TCP 可达；
 *   4) GET /api/health：HTTP 200、status ok/degraded、seekdb.reachable（新契约；旧版仅 status）；
 *   5) GET /api/collections：HTTP 200、返回 collections 数组；
 *   6) models.lock.json 校验（可选存在）：结构完整；若本地模型目录存在则核对文件大小；
 *   7) 调用 scripts/check-compliance.mjs：合规自检通过。
 *
 * 输出 PASS/FAIL/WARN 表；任一 FAIL → exit 1。
 *
 * 用法：
 *   node scripts/acceptance.mjs [--base-url http://localhost:3001] [--skip-compliance] [--json]
 *
 * 前置：seekdb（npm run db:up）与 API server（npm run dev / dev:server）已启动。
 * 注意：本脚本只读（GET），不会修改数据库。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LOCK_PATH = path.join(ROOT, 'models.lock.json');
const MODELS_ROOT = path.join(ROOT, 'web', 'public', 'models');
const REQUIRED_NODE = [18, 17, 0];

const rows = [];

/** @param {'PASS'|'WARN'|'FAIL'} status */
function add(status, name, detail) {
  rows.push({ status, name, detail });
}

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.SEEKVEC_API_URL ?? `http://localhost:${process.env.PORT ?? 3001}`,
    skipCompliance: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url') opts.baseUrl = argv[++i] ?? opts.baseUrl;
    else if (arg === '--skip-compliance') opts.skipCompliance = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '-h' || arg === '--help') {
      console.log(`SeekVec 验收自检\n\n用法：node scripts/acceptance.mjs [选项]\n\n选项：\n  --base-url <url>     server API 地址（默认 http://localhost:${process.env.PORT ?? 3001}）\n  --skip-compliance    跳过合规检查\n  --json               以 JSON 输出\n`);
      process.exit(0);
    } else {
      console.error(`[acceptance] 未知参数：${arg}（--help 查看用法）`);
      process.exit(2);
    }
  }
  return opts;
}

function tcpCheck(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok, err) => {
      socket.destroy();
      resolve({ ok, error: err });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, `连接超时（${timeoutMs}ms）`));
    socket.once('error', (err) => done(false, err.message));
    socket.connect(port, host);
  });
}

function compareNodeVersion(current, required) {
  for (let i = 0; i < required.length; i += 1) {
    const c = current[i] ?? 0;
    const r = required[i] ?? 0;
    if (c > r) return 1;
    if (c < r) return -1;
  }
  return 0;
}

async function fetchJson(url, timeoutMs = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // 非 JSON 响应在调用处报告
  }
  return { res, body, text };
}

const IS_HEX64 = /^[a-f0-9]{64}$/;

function checkModelLock() {
  if (!fs.existsSync(LOCK_PATH)) {
    add('WARN', 'models.lock.json', '不存在（可选；联网运行时不需要本地模型）');
    return { lock: null, files: [] };
  }
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  } catch (err) {
    add('FAIL', 'models.lock.json 可解析', err.message);
    return { lock: null, files: [] };
  }
  const problems = [];
  if (lock.schemaVersion !== 1) problems.push(`schemaVersion=${lock.schemaVersion}`);
  if (!Array.isArray(lock.models) || lock.models.length !== 2) problems.push(`models 应为 2 个（实际 ${lock.models?.length ?? 0}）`);
  const files = [];
  for (const model of lock.models ?? []) {
    if (!model.key || !model.id || !model.revision) problems.push(`模型 ${model.key ?? '?'} 缺少 key/id/revision`);
    if (!Array.isArray(model.files) || model.files.length !== 7) problems.push(`${model.key ?? '?'} files 应为 7 个`);
    for (const file of model.files ?? []) {
      if (!file.path || !Number.isFinite(file.size) || !IS_HEX64.test(file.sha256 ?? '')) {
        problems.push(`${model.key ?? '?'}/${file.path ?? '?'} size/sha256 不合法`);
      }
      files.push({ model, file });
    }
  }
  add(
    problems.length === 0 ? 'PASS' : 'FAIL',
    'models.lock.json 结构',
    problems.length === 0
      ? `${lock.models.length} 个模型 / ${files.length} 个文件 / 合计 ${(lock.totalSizeBytes / (1024 * 1024)).toFixed(2)} MB`
      : problems.slice(0, 5).join('; '),
  );

  // 本地模型文件（离线模式所需）：存在则按 lock 的大小校验；不要求全部存在
  let present = 0;
  const missing = [];
  const sizeMismatch = [];
  for (const { model, file } of files) {
    const target = path.join(MODELS_ROOT, model.id, file.path);
    if (!fs.existsSync(target)) {
      missing.push(`${model.key}/${file.path}`);
      continue;
    }
    present += 1;
    const size = fs.statSync(target).size;
    if (size !== file.size) sizeMismatch.push(`${model.key}/${file.path}（${size} ≠ ${file.size}）`);
  }
  if (present === 0) {
    add('WARN', '本地模型文件', `未预置（${missing.length} 个缺失；联网模式可忽略）`);
  } else if (sizeMismatch.length > 0) {
    add('FAIL', '本地模型文件大小', `${sizeMismatch.length} 个大小不符：${sizeMismatch.slice(0, 3).join('; ')}`);
  } else if (missing.length > 0) {
    add('WARN', '本地模型文件', `${present}/${files.length} 个已就绪（缺 ${missing.length} 个：${missing.slice(0, 3).join(', ')}…）`);
  } else {
    add('PASS', '本地模型文件', `${present}/${files.length} 个大小与 lock 一致`);
  }
  return { lock, files };
}

function runCompliance() {
  const script = path.join(HERE, 'check-compliance.mjs');
  // 验收自检使用严格模式：server/src 注释中出现禁用 token 也视为 FAIL（最终审计口径）
  const result = spawnSync(process.execPath, [script, '--strict'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  if (result.error) {
    add('FAIL', '合规检查', `无法执行：${result.error.message}`);
    return;
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  const tail = output.split(/\r?\n/).slice(-2).join(' | ');
  add(result.status === 0 ? 'PASS' : 'FAIL', '合规检查（check-compliance --strict）', result.status === 0 ? '推理仅在 web 端，server 无推理依赖/字样（含注释）' : `exit ${result.status}：${tail}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // 1) Node 版本
  const nodeVersion = process.versions.node.split('.').map((n) => Number(n));
  const cmp = compareNodeVersion(nodeVersion, REQUIRED_NODE);
  add(cmp >= 0 ? 'PASS' : 'FAIL', 'Node 版本', `v${process.versions.node}（要求 ≥ v${REQUIRED_NODE.join('.')}）`);

  // 2) 端口
  const serverPort = Number(process.env.PORT ?? 3001);
  const seekdbPort = Number(process.env.SEEKDB_PORT ?? 2881);
  const serverHost = new URL(opts.baseUrl).hostname;
  const serverCheck = await tcpCheck(serverHost, serverPort);
  add(serverCheck.ok ? 'PASS' : 'FAIL', `server 端口 ${serverHost}:${serverPort}`, serverCheck.ok ? 'TCP 可达' : `${serverCheck.error}（先执行 npm run dev）`);
  const seekdbHost = process.env.SEEKDB_HOST ?? '127.0.0.1';
  const seekdbCheck = await tcpCheck(seekdbHost, seekdbPort);
  add(seekdbCheck.ok ? 'PASS' : 'FAIL', `seekdb 端口 ${seekdbHost}:${seekdbPort}`, seekdbCheck.ok ? 'TCP 可达' : `${seekdbCheck.error}（先执行 npm run db:up）`);

  // 3) /api/health（带重试，容忍 server 刚启动/tsx watch 重启）
  let health = null;
  let healthError = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { res, body, text } = await fetchJson(`${opts.baseUrl}/api/health`);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}：${text.slice(0, 120)}`);
      health = body;
      break;
    } catch (err) {
      healthError = err.message;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  if (!health) {
    add('FAIL', 'GET /api/health', healthError || '无响应');
  } else {
    const statusOk = health.status === 'ok' || health.status === 'degraded';
    const seekdb = health.seekdb;
    if (!statusOk) {
      add('FAIL', 'GET /api/health', `status=${JSON.stringify(health.status)}（期望 ok/degraded）`);
    } else if (seekdb && seekdb.reachable === false) {
      add('FAIL', 'GET /api/health', `status=${health.status}，seekdb.reachable=false`);
    } else if (seekdb) {
      add('PASS', 'GET /api/health', `status=${health.status}，seekdb reachable=${seekdb.reachable}，version=${seekdb.version ?? '?'}`);
    } else {
      add('PASS', 'GET /api/health（旧版形状）', `status=${health.status}（契约增强字段 seekdb 尚未提供）`);
    }
  }

  // 4) /api/collections
  try {
    const { res, body, text } = await fetchJson(`${opts.baseUrl}/api/collections`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}：${text.slice(0, 120)}`);
    const list = Array.isArray(body?.collections) ? body.collections : Array.isArray(body) ? body : null;
    if (!list) throw new Error('响应中没有 collections 数组');
    add('PASS', 'GET /api/collections', `HTTP 200，${list.length} 个集合：${list.map((c) => c.name).slice(0, 5).join(', ') || '（空）'}`);
  } catch (err) {
    add('FAIL', 'GET /api/collections', err.message);
  }

  // 5) models.lock.json（可选）
  checkModelLock();

  // 6) 合规检查
  if (opts.skipCompliance) {
    add('WARN', '合规检查（check-compliance）', '已通过 --skip-compliance 跳过');
  } else {
    runCompliance();
  }

  // ---- 输出 ----
  const failed = rows.filter((r) => r.status === 'FAIL');
  const warned = rows.filter((r) => r.status === 'WARN');
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, baseUrl: opts.baseUrl, rows }, null, 2)}\n`);
  } else {
    console.log(`SeekVec 验收自检 · API ${opts.baseUrl}\n`);
    for (const row of rows) {
      console.log(`[${row.status}] ${row.name}`);
      console.log(`        ${row.detail}`);
    }
    console.log(
      `\n${failed.length === 0 ? 'ACCEPTANCE PASS' : 'ACCEPTANCE FAIL'}（PASS ${rows.length - failed.length - warned.length}，WARN ${warned.length}，FAIL ${failed.length}）`,
    );
    if (failed.length > 0) {
      console.log('未通过项：');
      for (const row of failed) console.log(`  - ${row.name}：${row.detail}`);
    }
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[acceptance] ✗ 未预期错误：', err);
  process.exit(1);
});
