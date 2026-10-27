#!/usr/bin/env node
/**
 * 基准矩阵执行器：按 docs/benchmarks/matrix.json 的顺序跑 ABBA，聚合中位数/IQR。
 *
 * 每个矩阵条目调用一次 scripts/bench-browser.mjs（同一浏览器、同一语料与查询），
 * 输出目录：<out>/<seq>-<configId>/（各自包含 raw.json 与 summary.md）。
 * ABBA：默认先按矩阵顺序跑一遍，再逆序跑一遍，抵消设备/热漂移；可 --no-abba 关闭。
 *
 * 用法：
 *   node scripts/bench-matrix.mjs                           # 读取 docs/benchmarks/matrix.json
 *   node scripts/bench-matrix.mjs --dry-run                 # 只打印将执行的命令
 *   node scripts/bench-matrix.mjs --only fp32-wasm,q8-wasm  # 只跑指定配置
 *   node scripts/bench-matrix.mjs --no-abba --runs 3
 *
 * 失败：任一调用失败会继续跑其余条目，最终非零退出并列出失败条目。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_MATRIX = path.join(ROOT, 'docs', 'benchmarks', 'matrix.json');
const BENCH_SCRIPT = path.join(HERE, 'bench-browser.mjs');

const HELP = `SeekVec · 基准矩阵执行器（ABBA）

用法：
  node scripts/bench-matrix.mjs [选项]

选项：
  --matrix <file>   矩阵定义（默认 docs/benchmarks/matrix.json）
  --out <dir>       输出目录（默认 docs/benchmarks/matrix-<时间戳>）
  --only <ids>      只跑指定 id，逗号分隔（如 fp32-wasm,q8-wasm）
  --runs <n>        覆盖所有条目的正式轮数
  --no-abba         关闭 ABBA 双向顺序（只按矩阵顺序跑一遍）
  --headful         传给 bench-browser（显示浏览器窗口）
  --keep            保留各条目 collection（默认自动清理）
  --dry-run         只打印计划执行的命令，不真正运行
  --help, -h        显示帮助

matrix.json 结构（示例见 docs/benchmarks/README.md）：
{
  "schemaVersion": 1,
  "abba": true,
  "runs": 5,
  "warmup": 1,
  "timeoutMs": 300000,
  "corpus": "data/perf/corpus",
  "queries": "data/perf/queries.txt",
  "configs": [
    { "id": "fp32-wasm", "backend": "wasm", "dtype": "fp32", "batch": 16, "refresh": "last", "cold": false }
  ]
}
`;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function iqr(values) {
  if (values.length === 0) return null;
  return quantile(values, 0.75) - quantile(values, 0.25);
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function fmt(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function parseArgs(argv) {
  const opts = {
    matrix: DEFAULT_MATRIX,
    out: null,
    only: null,
    runs: null,
    abba: null,
    headful: false,
    keep: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--matrix') opts.matrix = path.resolve(argv[++i] ?? '');
    else if (arg === '--out') opts.out = path.resolve(argv[++i] ?? '');
    else if (arg === '--only') opts.only = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--runs') opts.runs = Number(argv[++i] ?? '');
    else if (arg === '--no-abba') opts.abba = false;
    else if (arg === '--headful') opts.headful = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else {
      console.error(`[bench-matrix] 未知参数：${arg}（--help 查看用法）`);
      process.exit(2);
    }
  }
  if (opts.runs != null && (!Number.isFinite(opts.runs) || opts.runs < 1)) {
    console.error('[bench-matrix] --runs 需要 ≥1');
    process.exit(2);
  }
  return opts;
}

function loadMatrix(file) {
  if (!fs.existsSync(file)) {
    console.error(
      `[bench-matrix] ✗ 矩阵文件不存在：${file}\n` +
        '  请先创建 docs/benchmarks/matrix.json（结构示例见 docs/benchmarks/README.md）。',
    );
    process.exit(1);
  }
  let matrix;
  try {
    matrix = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[bench-matrix] ✗ 解析矩阵文件失败：${err.message}`);
    process.exit(1);
  }
  const configs = matrix.configs ?? matrix.runs ?? matrix.matrix ?? matrix.order;
  if (!Array.isArray(configs) || configs.length === 0) {
    console.error('[bench-matrix] ✗ 矩阵缺少 configs 数组');
    process.exit(1);
  }
  const seen = new Set();
  for (const [index, cfg] of configs.entries()) {
    if (!cfg || typeof cfg !== 'object') {
      console.error(`[bench-matrix] ✗ configs[${index}] 不是对象`);
      process.exit(1);
    }
    cfg.id = String(cfg.id ?? `cfg-${index + 1}`);
    if (seen.has(cfg.id)) {
      console.error(`[bench-matrix] ✗ 重复的配置 id：${cfg.id}`);
      process.exit(1);
    }
    seen.add(cfg.id);
    if (!['auto', 'webgpu', 'wasm'].includes(cfg.backend ?? 'auto')) {
      console.error(`[bench-matrix] ✗ ${cfg.id}: backend 只能是 auto|webgpu|wasm`);
      process.exit(1);
    }
    if (cfg.dtype && !['q8', 'fp16', 'fp32'].includes(cfg.dtype)) {
      console.error(`[bench-matrix] ✗ ${cfg.id}: dtype 只能是 q8|fp16|fp32`);
      process.exit(1);
    }
  }
  return { ...matrix, configs };
}

/** 生成 ABBA 执行顺序：[A,B,C] → [A,B,C,C,B,A] */
function buildSequence(configs, abba) {
  if (!abba) return configs.map((cfg) => ({ cfg, leg: 'forward' }));
  return [
    ...configs.map((cfg) => ({ cfg, leg: 'forward' })),
    ...[...configs].reverse().map((cfg) => ({ cfg, leg: 'reverse' })),
  ];
}

function readInvocationResult(outDir) {
  const rawPath = path.join(outDir, 'raw.json');
  if (!fs.existsSync(rawPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
    const measured = (raw.runs ?? []).filter((r) => r.warm);
    const phases = raw.aggregate?.phases ?? [];
    const phaseP50 = Object.fromEntries(phases.map((p) => [p.phase, p.p50]));
    return {
      ok: true,
      mode: raw.mode,
      measuredRuns: measured.length,
      phases: phaseP50,
      phaseDetails: phases,
      ingestWallP50: raw.aggregate?.ingest?.wallP50 ?? null,
      queryE2eP50: raw.aggregate?.query?.e2eP50 ?? null,
      queryE2eP95: raw.aggregate?.query?.e2eP95 ?? null,
      pageErrorCount: raw.diagnostics?.pageErrors?.length ?? 0,
    };
  } catch (err) {
    return { ok: false, error: `raw.json 解析失败：${err.message}` };
  }
}

function runBench(cfg, seqIndex, leg, opts, matrix, outDir, collection) {
  const args = [BENCH_SCRIPT, '--backend', cfg.backend ?? 'auto'];
  if (cfg.dtype) args.push('--dtype', cfg.dtype);
  if (cfg.batch != null) args.push('--batch', String(cfg.batch));
  if (cfg.threads != null) args.push('--threads', String(cfg.threads));
  if (cfg.refresh) args.push('--refresh', cfg.refresh);
  if (cfg.models) args.push('--models', cfg.models);
  if (cfg.cold) args.push('--cold');
  const runs = opts.runs ?? cfg.runs ?? matrix.runs ?? 5;
  const warmup = cfg.warmup ?? matrix.warmup ?? 1;
  args.push('--runs', String(runs), '--warmup', String(warmup));
  args.push('--collection', collection);
  args.push('--out', path.join(outDir, `${String(seqIndex + 1).padStart(2, '0')}-${cfg.id}`));
  args.push('--collection', collection);
  if (matrix.corpus) args.push('--corpus', path.resolve(ROOT, matrix.corpus));
  if (matrix.queries) args.push('--queries', path.resolve(ROOT, matrix.queries));
  if (matrix.timeoutMs) args.push('--timeout', String(matrix.timeoutMs));
  if (matrix.profile) args.push('--profile', path.resolve(ROOT, matrix.profile));
  if (opts.headful) args.push('--headful');
  if (opts.keep) args.push('--keep');
  return args;
}

function spawnBench(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', windowsHide: false });
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('exit', (code, signal) => resolve({ ok: code === 0, code, signal }));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const matrix = loadMatrix(opts.matrix);
  const abba = opts.abba ?? matrix.abba ?? true;
  const outDir = opts.out ?? path.join(ROOT, 'docs', 'benchmarks', `matrix-${timestamp()}`);
  const runStamp = timestamp();

  let configs = matrix.configs;
  if (opts.only && opts.only.length > 0) {
    configs = configs.filter((cfg) => opts.only.includes(cfg.id));
    if (configs.length === 0) {
      console.error(`[bench-matrix] ✗ --only 未匹配任何配置（可用：${matrix.configs.map((c) => c.id).join(', ')}）`);
      process.exit(1);
    }
  }

  const sequence = buildSequence(configs, abba);
  console.log('[bench-matrix] SeekVec 基准矩阵');
  console.log(`  矩阵文件 : ${path.relative(ROOT, opts.matrix) || opts.matrix}`);
  console.log(`  配置     : ${configs.map((c) => c.id).join(', ')}`);
  console.log(`  执行顺序 : ${sequence.map((s) => `${s.cfg.id}(${s.leg === 'forward' ? '→' : '←'})`).join(' ')}`);
  console.log(`  ABBA     : ${abba ? '开' : '关'}`);
  console.log(`  输出目录 : ${path.relative(ROOT, outDir) || outDir}`);
  console.log(`  每条轮数 : runs=${opts.runs ?? matrix.runs ?? 5} warmup=${matrix.warmup ?? 1}（条目可用字段覆盖）`);
  if (opts.dryRun) console.log('\n[bench-matrix] --dry-run：以下命令将依次执行：');

  fs.mkdirSync(outDir, { recursive: true });

  const executions = [];
  for (const [seqIndex, { cfg, leg }] of sequence.entries()) {
    // seekdb 集合名约束：只允许字母/数字/下划线（长度 ≤64）
    const collection = `bench_matrix_${runStamp}_${cfg.id}_${seqIndex + 1}`
      .replace(/[^A-Za-z0-9_]/g, '_')
      .slice(0, 64);
    const invocationOut = path.join(outDir, `${String(seqIndex + 1).padStart(2, '0')}-${cfg.id}`);
    const args = runBench(cfg, seqIndex, leg, opts, matrix, outDir, collection);
    // 覆盖 collection（runBench 里已用传入值）
    if (opts.dryRun) {
      console.log(`\n  # ${cfg.id} (${leg})`);
      console.log(`  node ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);
      continue;
    }

    console.log(`\n[bench-matrix] ▶ ${seqIndex + 1}/${sequence.length} · ${cfg.id}（${leg}）`);
    const startedAt = Date.now();
    const result = await spawnBench(args);
    const durationMs = Date.now() - startedAt;
    const parsed = readInvocationResult(invocationOut);
    executions.push({
      seq: seqIndex + 1,
      leg,
      configId: cfg.id,
      config: cfg,
      collection,
      out: path.relative(ROOT, invocationOut),
      ok: result.ok && Boolean(parsed?.ok),
      exitCode: result.code,
      signal: result.signal,
      durationMs,
      result: parsed,
    });
    if (!result.ok) console.warn(`[bench-matrix] ⚠ ${cfg.id}（${leg}）执行失败：exit ${result.code ?? result.signal}`);
    else console.log(`[bench-matrix] ✓ ${cfg.id} 完成（${Math.round(durationMs / 1000)}s）`);
  }

  if (opts.dryRun) {
    console.log(`\n[bench-matrix] ✓ dry-run 完成，共 ${sequence.length} 次调用（未执行）。`);
    return;
  }

  // 聚合：每个 config 的所有成功调用
  const aggregated = configs.map((cfg) => {
    const invocations = executions.filter((e) => e.configId === cfg.id && e.ok && e.result);
    const phaseNames = new Set();
    for (const inv of invocations) for (const name of Object.keys(inv.result.phases ?? {})) phaseNames.add(name);
    const phases = [...phaseNames].sort().map((phase) => {
      const values = invocations.map((inv) => inv.result.phases[phase]).filter(Number.isFinite);
      return { phase, invocations: values.length, p50: round(median(values)), p50Iqr: round(iqr(values)) };
    });
    const e2e = invocations.map((inv) => inv.result.queryE2eP50).filter(Number.isFinite);
    const ingest = invocations.map((inv) => inv.result.ingestWallP50).filter(Number.isFinite);
    return {
      config: cfg,
      invocations: invocations.length,
      failedInvocations: executions.filter((e) => e.configId === cfg.id && !e.ok).length,
      phases,
      queryE2eP50: round(median(e2e)),
      queryE2eP50Iqr: round(iqr(e2e)),
      queryE2eP95: round(median(invocations.map((inv) => inv.result.queryE2eP95).filter(Number.isFinite))),
      ingestWallP50: round(median(ingest)),
      ingestWallP50Iqr: round(iqr(ingest)),
      pageErrorTotal: invocations.reduce((sum, inv) => sum + (inv.result.pageErrorCount ?? 0), 0),
    };
  });

  const failed = executions.filter((e) => !e.ok);
  const matrixRaw = {
    schemaVersion: 1,
    tool: 'scripts/bench-matrix.mjs',
    generatedAt: new Date().toISOString(),
    matrixFile: path.relative(ROOT, opts.matrix),
    abba,
    out: path.relative(ROOT, outDir),
    sequence: sequence.map(({ cfg, leg }, index) => ({ seq: index + 1, configId: cfg.id, leg })),
    executions,
    aggregate: aggregated,
  };
  fs.writeFileSync(path.join(outDir, 'matrix-raw.json'), `${JSON.stringify(matrixRaw, null, 2)}\n`, 'utf8');

  const lines = [];
  lines.push(`# 基准矩阵汇总 · ${path.basename(outDir)}`);
  lines.push('');
  lines.push(`- 时间：${new Date().toISOString()}`);
  lines.push(`- 矩阵文件：\`${path.relative(ROOT, opts.matrix)}\``);
  lines.push(`- 顺序：${abba ? 'ABBA（正序 + 逆序）' : '单遍历'}；每条 runs=${opts.runs ?? matrix.runs ?? 5}、warmup=${matrix.warmup ?? 1}`);
  lines.push(`- 原始数据：同目录 \`matrix-raw.json\`；各条目明细见对应子目录的 \`raw.json\` / \`summary.md\``);
  lines.push('');
  lines.push('## 关键指标（跨调用中位数；IQR=Q3−Q1）');
  lines.push('');
  lines.push('| 配置 | 后端 | dtype | batch | refresh | cold | 成功/总 | query e2e p50 (ms) | e2e IQR | model.total p50 | ingest.total p50 | query.embed p50 | db.search p50 | ingest wall p50 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const agg of aggregated) {
    const phase = (name) => {
      const found = agg.phases.find((p) => p.phase === name);
      return found ? fmt(found.p50) : '—';
    };
    const cfg = agg.config;
    lines.push(
      `| ${cfg.id} | ${cfg.backend ?? 'auto'} | ${cfg.dtype ?? '默认'} | ${cfg.batch ?? '默认'} | ${cfg.refresh ?? '默认'} | ${cfg.cold ? 'cold' : 'warm'} | ` +
        `${agg.invocations}/${agg.invocations + agg.failedInvocations} | ${fmt(agg.queryE2eP50)} | ${fmt(agg.queryE2eP50Iqr)} | ` +
        `${phase('model.total')} | ${phase('ingest.total')} | ${phase('query.embed')} | ${phase('db.search')} | ${fmt(agg.ingestWallP50)} |`,
    );
  }
  lines.push('');
  if (failed.length > 0) {
    lines.push(`## ⚠ 失败条目（${failed.length}）`);
    lines.push('');
    for (const f of failed) lines.push(`- 第 ${f.seq} 次 · ${f.configId}（${f.leg}）：exit ${f.exitCode ?? f.signal}；见 \`${f.out}\``);
    lines.push('');
  }
  lines.push('## 说明');
  lines.push('');
  lines.push('- 每格为跨调用次数的中位数；正式报告要求每格 ≥5 次（去掉首轮）并披露 IQR。');
  lines.push('- 质量指标（Recall/nDCG）由 `npm run eval:quality` 与浏览器 eval 链路分别产出，本文件只汇总性能。');
  lines.push('- 重跑命令与语料固定信息保存在 `matrix-raw.json` 与各子目录 `raw.json`。');
  lines.push('');
  fs.writeFileSync(path.join(outDir, 'matrix-summary.md'), lines.join('\n'), 'utf8');

  console.log(`\n[bench-matrix] ✓ 汇总写入：`);
  console.log(`  ${path.relative(ROOT, path.join(outDir, 'matrix-raw.json'))}`);
  console.log(`  ${path.relative(ROOT, path.join(outDir, 'matrix-summary.md'))}`);
  console.log(`\n[bench-matrix] 完成：${executions.length - failed.length}/${executions.length} 次调用成功`);

  if (failed.length > 0) {
    console.error(`[bench-matrix] ✗ ${failed.length} 次调用失败：${failed.map((f) => `${f.configId}(${f.leg})`).join(', ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[bench-matrix] ✗ 未预期错误：', err?.stack ?? err);
  process.exit(1);
});
