#!/usr/bin/env node
/**
 * 浏览器端检索质量评测（真实应用链路，支撑赛题 3.2.3「同一评测集上量化前后质量对比」）
 *
 * 与 Node CPU 版 `scripts/eval-quality.ts` 的区别：
 *   - 本脚本在**真实浏览器应用**里跑：Transformers.js 端侧推理（指定 backend/dtype）
 *     → 前端分块/写入 → server HTTP → seekdb HNSW 向量 / hybrid 混合检索 → 结果回传；
 *   - 质量统计口径与 Node 版一致：chunk 级 qrels（data/eval/queries.jsonl 的 relevant 字段），
 *     复用 `scripts/lib/evalMetrics.ts` 的 recallAtK / ndcgAtK / mrr（macro 平均）。
 *
 * 流程（每组配置一次）：
 *   1) 打开 `?perf=1&backend=<b>&dtype=<d>&collection=<name>` 页面，等 `window.__seekvecEval` 就绪；
 *   2) 用 `__seekvecEval.ingestFiles` 把 `data/eval/corpus` 全部 60 篇导入**独立 collection**
 *      （清理陈旧 id 后，结束时自动 DELETE 清理）；
 *   3) 逐条跑 `data/eval/queries.jsonl` 的 60 条查询：有 keyword 走 hybrid（`search(q, keyword)`），
 *      否则纯向量；每条取前 10 条 hit；
 *   4) hit 的 metadata `{source, chunkIndex}` → chunkKey `source#chunkIndex` → 与 qrels 对齐；
 *   5) 计算 Recall@1/3/5、nDCG@5/10、MRR（macro），并按 category/lang 分组统计；
 *   6) 默认三组：fp32+wasm（baseline）、q8+wasm、fp16+webgpu；每组输出 raw.json + summary.md，
 *      顶层输出对比 summary.md；失败非零退出。
 *
 * 断言（失败 → exit 1）：
 *   - 每组 ingest 写入的 chunk 数必须等于 data/eval 的 chunk 数（73，保证 qrels 映射有效）；
 *   - 每条查询至少 1 条 hit；
 *   - 每条 hit 都有 metadata.source / chunkIndex，且 source 属于评测语料；
 *   - 每条查询的 search mode 与 keyword 预期一致（有 keyword→hybrid，否则 vector）；
 *   - 每条 qrels 的 (source, chunkIndex) 都能解析到语料 chunk；
 *   - 默认三组必须全部产出数据（任何一组失败 → exit 1）。
 *   WebGPU 若被应用自动降级到 WASM：**不静默**——记录实际 backend/reason 并在 summary 标记 fallback，
 *   数据仍计入（--strict-backend 可把它升级为失败）。
 *
 * 用法（仓库根目录）：
 *   npm run eval:quality:browser                                   # 默认三组 → D:\SeekVec-tools\tmp\browser-quality
 *   npm run eval:quality:browser -- --backend wasm --dtype fp32     # 只跑一组
 *   npm run eval:quality:browser -- --out D:\SeekVec-tools\tmp\browser-quality
 *   npm run eval:quality:browser -- --runs 2 --keep                 # 查询重复 2 遍取均值；保留 collection 调试
 *
 * 运行方式：必须经 tsx（npm 脚本已内置；等价 `npx tsx scripts/eval-quality-browser.mjs`）。
 * 原因：scripts/lib/datasets.ts 以 Bundler resolution 省略扩展名 import web/src 的 TS 模块，
 * Node 原生 type stripping 无法解析；不要直接 `node scripts/eval-quality-browser.mjs`。
 *
 * 依赖：puppeteer-core（devDep）、scripts/lib/{datasets,evalMetrics}.ts、web 侧 perf/eval API（?perf=1）。
 * 不写 docs/、不提交；Raw 数据默认输出到工作区外的本地临时目录，由 Lead 决定复制哪些证据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_DATA_DIR = path.join(ROOT, 'data', 'eval');
// 依据 Lead 约定：默认输出到 D 盘本地临时目录（不写 docs/、不入库）
const DEFAULT_OUT = (() => {
  if (process.env.SEEKVEC_BROWSER_QUALITY_OUT) return path.resolve(process.env.SEEKVEC_BROWSER_QUALITY_OUT);
  if (process.platform === 'win32') return 'D:\\SeekVec-tools\\tmp\\browser-quality';
  return path.join(os.tmpdir(), 'seekvec-browser-quality');
})();

const BROWSER_CACHE_FILE = path.join(ROOT, 'scripts', '.cache', 'eval-quality-browser.json');
const DEFAULT_PROFILE_ROOT = path.join(ROOT, 'scripts', '.cache', 'eval-quality-profile');

/** 质量门（实施契约 §8）：Recall@5 降幅 ≤ 2pp，nDCG@10 降幅 ≤ 0.02（绝对差） */
const GATE = { recallAt5MaxDrop: 0.02, ndcgAt10MaxDrop: 0.02 };
const K_RECALL = [1, 3, 5];
const K_NDCG = [5, 10];
const TOP_N = 10; // nDCG@10 需要前 10 条；nResults 上限 50，这里固定 10
const SCHEMA_VERSION = 1;

/** 默认三组：fp32+wasm baseline / q8+wasm / fp16+webgpu */
const DEFAULT_GROUPS = [
  { id: 'fp32-wasm', backend: 'wasm', dtype: 'fp32', baseline: true },
  { id: 'q8-wasm', backend: 'wasm', dtype: 'q8', baseline: false },
  { id: 'fp16-webgpu', backend: 'webgpu', dtype: 'fp16', baseline: false },
];

const HELP = `SeekVec · 浏览器端检索质量评测（真实应用链路，量化前后对比）

用法：
  npm run eval:quality:browser [选项]
  （内部经 tsx 运行 scripts/eval-quality-browser.mjs；直接 node 无法解析 scripts/lib 的 TS 依赖）

选项：
  --base-url <url>        页面地址（默认 $SEEKVEC_BASE_URL 或 http://localhost:5173）
  --api-url <url>         清理 collection 的 API 地址（默认同 --base-url，经 Vite /api 代理）
  --backend <auto|webgpu|wasm>  只跑指定后端的一组（与 --dtype 组合；默认跑三组）
  --dtype <q8|fp16|fp32>  只跑指定精度的一组（与 --backend 组合；默认跑三组）
  --data <dir>            评测集目录（默认 <repo>/data/eval：corpus/ + queries.jsonl）
  --out <dir>             输出目录（默认 D:\\SeekVec-tools\\tmp\\browser-quality，或 $SEEKVEC_BROWSER_QUALITY_OUT）
  --runs <n>              每组查询评测重复次数（默认 1；结果取跨 run 均值）
  --top-n <n>             每次 search 请求的结果数（默认 10，至少 10 才够 nDCG@10）
  --collection-prefix <s> collection 名前缀（默认 qeval）
  --timeout <ms>          单步等待超时（默认 300000，覆盖首次模型加载）
  --profile <dir>         user-data-dir 根目录（默认 scripts/.cache/eval-quality-profile）
  --browser-path <exe>    浏览器可执行文件（默认 $BROWSER_PATH 或自动探测 Chrome/Edge/Playwright 缓存）
  --headful               显示浏览器窗口（默认无头）
  --keep                  保留 collection（默认自动 DELETE 清理）
  --strict-backend        强制要求实际 backend 等于请求值（WebGPU 降级则失败）
  --strict-gate           质量门不通过时也以非零退出（默认只报告并退出 0）
  -h, --help              显示帮助

环境变量：SEEKVEC_BASE_URL、BROWSER_PATH、SEEKVEC_BROWSER_QUALITY_OUT。

输出：
  <out>/summary.md                 三组对比表 + 质量门 + 断言/降级/风险
  <out>/raw.json                   汇总原始数据（各组配置/实际 backend/dtype/耗时/断言）
  <out>/<group-id>/raw.json        单组原始数据（含每条查询命中与指标）
  <out>/<group-id>/summary.md      单组明细表（逐查询）
`;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.SEEKVEC_BASE_URL ?? 'http://localhost:5173',
    apiUrl: null,
    backend: null,
    dtype: null,
    data: DEFAULT_DATA_DIR,
    out: DEFAULT_OUT,
    runs: 1,
    topN: TOP_N,
    collectionPrefix: 'qeval',
    timeout: 300_000,
    profile: process.env.SEEKVEC_BENCH_PROFILE ?? DEFAULT_PROFILE_ROOT,
    browserPath: process.env.BROWSER_PATH ?? null,
    headful: false,
    keep: false,
    strictBackend: false,
    strictGate: false,
    help: false,
  };
  let i = 0;
  const next = (name) => {
    if (i + 1 >= argv.length) {
      console.error(`[eval-quality-browser] ${name} 缺少取值（--help 查看用法）`);
      process.exit(2);
    }
    i += 1;
    return argv[i];
  };
  const nextInt = (name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const raw = next(name);
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      console.error(`[eval-quality-browser] ${name} 需要 ${min}..${max} 的整数（收到 ${raw}）`);
      process.exit(2);
    }
    return value;
  };
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--base-url') opts.baseUrl = next(arg);
    else if (arg === '--api-url') opts.apiUrl = next(arg);
    else if (arg === '--backend') opts.backend = next(arg);
    else if (arg === '--dtype') opts.dtype = next(arg);
    else if (arg === '--data') opts.data = path.resolve(next(arg));
    else if (arg === '--out') opts.out = path.resolve(next(arg));
    else if (arg === '--runs') opts.runs = nextInt(arg, { min: 1, max: 20 });
    else if (arg === '--top-n') opts.topN = nextInt(arg, { min: K_NDCG[K_NDCG.length - 1], max: 50 });
    else if (arg === '--collection-prefix') opts.collectionPrefix = next(arg);
    else if (arg === '--timeout') opts.timeout = nextInt(arg, { min: 30_000, max: 30 * 60 * 1000 });
    else if (arg === '--profile') opts.profile = path.resolve(next(arg));
    else if (arg === '--browser-path') opts.browserPath = path.resolve(next(arg));
    else if (arg === '--headful') opts.headful = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--strict-backend') opts.strictBackend = true;
    else if (arg === '--strict-gate') opts.strictGate = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else {
      console.error(`[eval-quality-browser] 未知参数：${arg}（--help 查看用法）`);
      process.exit(2);
    }
    i += 1;
  }

  if (opts.backend && !['auto', 'webgpu', 'wasm'].includes(opts.backend)) {
    console.error(`[eval-quality-browser] --backend 只能是 auto|webgpu|wasm（收到 ${opts.backend}）`);
    process.exit(2);
  }
  if (opts.dtype && !['q8', 'fp16', 'fp32'].includes(opts.dtype)) {
    console.error(`[eval-quality-browser] --dtype 只能是 q8|fp16|fp32（收到 ${opts.dtype}）`);
    process.exit(2);
  }
  opts.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  opts.apiUrl = (opts.apiUrl ?? opts.baseUrl).replace(/\/+$/, '');
  opts.out = path.resolve(opts.out);

  // 组选择：显式指定 backend/dtype 时只跑一组；否则默认三组
  if (opts.backend || opts.dtype) {
    const backend = opts.backend ?? 'wasm';
    const dtype = opts.dtype ?? (backend === 'webgpu' ? 'fp16' : 'q8');
    opts.groups = [{ id: `${dtype}-${backend}`, backend, dtype, baseline: true }];
  } else {
    opts.groups = DEFAULT_GROUPS.map((group) => ({ ...group }));
  }
  return opts;
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function timestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** seekdb 集合名约束：只允许字母/数字/下划线，长度 1..64 */
function sanitizeCollectionName(name) {
  const sanitized = String(name ?? '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '').slice(0, 64);
  return sanitized || `qeval_${Date.now()}`;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmt(value, digits = 4) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function fmtPct(value, digits = 2) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '—';
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 给页面内异步操作加超时保护（page.evaluate 本身不受 opts.timeout 约束） */
function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs ?? 5000) });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // 调用方按 text 判断
  }
  return { status: res.status, ok: res.ok, body, text };
}

async function deleteCollection(apiUrl, collectionName) {
  const url = `${apiUrl}/api/collections/${encodeURIComponent(collectionName)}`;
  try {
    const { status } = await fetchJson(url, { method: 'DELETE', timeoutMs: 15000 });
    if (status === 200 || status === 204 || status === 404) return { ok: true, status };
    return { ok: false, status, error: `HTTP ${status}` };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// 浏览器探测 / 启动（与 bench-browser 相近的实现，本脚本独立维护，不改 bench-browser）
// ---------------------------------------------------------------------------

function isExecutableFile(file) {
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function readPreferredBrowserPath() {
  try {
    const data = JSON.parse(fs.readFileSync(BROWSER_CACHE_FILE, 'utf8'));
    return typeof data.path === 'string' && isExecutableFile(data.path) ? data.path : null;
  } catch {
    return null;
  }
}

function rememberBrowserPath(browserPath) {
  try {
    fs.mkdirSync(path.dirname(BROWSER_CACHE_FILE), { recursive: true });
    fs.writeFileSync(BROWSER_CACHE_FILE, `${JSON.stringify({ path: browserPath, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  } catch {
    // 缓存失败不影响评测
  }
}

function playwrightChromiumCandidates() {
  const roots = [];
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'));
  } else {
    roots.push(path.join(os.homedir(), '.cache', 'ms-playwright'));
  }
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirs = entries
      .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
      .map((entry) => ({ name: entry.name, version: Number(entry.name.split('-')[1]) }))
      .sort((a, b) => b.version - a.version);
    for (const { name } of dirs) {
      const dir = path.join(root, name);
      candidates.push(
        path.join(dir, 'chrome-win64', 'chrome.exe'),
        path.join(dir, 'chrome-win', 'chrome.exe'),
        path.join(dir, 'chrome-linux', 'chrome'),
        path.join(dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      );
    }
  }
  return candidates;
}

function browserCandidates() {
  const candidates = [];
  if (process.platform === 'win32') {
    for (const dir of [process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      candidates.push(path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }
  candidates.push(...playwrightChromiumCandidates());
  return candidates;
}

function existingBrowserCandidates(explicit) {
  const checked = [];
  const candidates = [];
  const push = (candidatePath, source) => {
    if (!candidatePath) return;
    checked.push(candidatePath);
    if (!isExecutableFile(candidatePath)) return;
    if (candidates.some((candidate) => candidate.path === candidatePath)) return;
    candidates.push({ path: candidatePath, source });
  };
  if (explicit) push(explicit, '--browser-path / BROWSER_PATH');
  else push(readPreferredBrowserPath(), '上次成功（缓存）');
  for (const candidate of browserCandidates()) push(candidate, '自动探测');
  return { candidates, checked };
}

function sanitizeProfileName(browserPath) {
  return path.basename(browserPath).replace(/[^A-Za-z0-9._-]/g, '_');
}

async function launchWithFallback(puppeteer, candidates, opts) {
  const profileRoot = opts.profile ?? DEFAULT_PROFILE_ROOT;
  const errors = [];
  for (const candidate of candidates) {
    const userDataDir = path.join(profileRoot, `profile-${sanitizeProfileName(candidate.path)}`);
    fs.mkdirSync(userDataDir, { recursive: true });
    const args = [
      '--no-sandbox',
      '--no-first-run',
      '--disable-dev-shm-usage',
      '--mute-audio',
      // 不要加 --disable-gpu：WebGPU 组需要真实 GPU 进程
      `--disk-cache-dir=${path.join(userDataDir, 'disk-cache')}`,
    ];
    try {
      const browser = await puppeteer.launch({
        executablePath: candidate.path,
        headless: !opts.headful,
        userDataDir,
        args,
        defaultViewport: { width: 1440, height: 1000 },
        protocolTimeout: Math.max(180_000, opts.timeout * 2),
      });
      rememberBrowserPath(candidate.path);
      return { browser, used: candidate, errors, userDataDir };
    } catch (err) {
      const message = String(err?.message ?? err).split(/\r?\n/).filter(Boolean)[0]?.slice(0, 200) ?? '未知错误';
      errors.push({ path: candidate.path, error: message });
      console.warn(`[eval-quality-browser] ⚠ 浏览器启动失败，回退下一个候选：${candidate.path}（${message}）`);
    }
  }
  console.error('[eval-quality-browser] ✗ 所有候选浏览器均启动失败：');
  for (const error of errors) console.error(`  - ${error.path}：${error.error}`);
  console.error('  处理建议：设置 BROWSER_PATH 指向可用 Chrome/Edge/Chromium，或安装 Playwright 浏览器缓存。');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Perf summary 归一化（与 bench-browser 相同口径；仅用于报告阶段耗时）
// ---------------------------------------------------------------------------

function normalizePhaseSummary(raw) {
  const out = {};
  const take = (phase, value) => {
    if (!phase || !value || typeof value !== 'object') return;
    const p50 = value.p50 ?? value.median;
    if (!Number.isFinite(p50)) return;
    out[phase] = {
      n: Number.isFinite(value.n) ? value.n : undefined,
      p50,
      p95: Number.isFinite(value.p95) ? value.p95 : undefined,
      mean: Number.isFinite(value.mean) ? value.mean : undefined,
    };
  };
  if (Array.isArray(raw)) {
    for (const item of raw) if (item && typeof item === 'object') take(item.phase ?? item.name, item);
  } else if (Array.isArray(raw?.phases)) {
    for (const item of raw.phases) if (item && typeof item === 'object') take(item.phase ?? item.name, item);
  } else if (raw && typeof raw === 'object') {
    if (raw.phases && typeof raw.phases === 'object' && !Array.isArray(raw.phases)) {
      for (const [phase, value] of Object.entries(raw.phases)) take(phase, value);
      if (Object.keys(out).length > 0) return out;
    }
    for (const [phase, value] of Object.entries(raw)) take(phase, value);
  }
  return out;
}

function summarizeEvents(events) {
  const byPhase = new Map();
  for (const event of events ?? []) {
    if (!event?.phase || !Number.isFinite(event.ms)) continue;
    const values = byPhase.get(event.phase) ?? [];
    values.push(event.ms);
    byPhase.set(event.phase, values);
  }
  const out = {};
  for (const [phase, values] of byPhase) {
    out[phase] = {
      n: values.length,
      p50: round(median(values)),
      mean: round(mean(values)),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 页面封装
// ---------------------------------------------------------------------------

function buildPageUrl(opts, group) {
  const url = new URL(opts.baseUrl);
  url.searchParams.set('perf', '1');
  if (group.backend) url.searchParams.set('backend', group.backend);
  if (group.dtype) url.searchParams.set('dtype', group.dtype);
  url.searchParams.set('collection', group.collection);
  return url.toString();
}

async function waitForEvalApi(page, timeout) {
  await page.waitForFunction(
    () => {
      const w = /** @type {any} */ (window);
      return !!(w.__seekvecPerf && typeof w.__seekvecPerf.snapshot === 'function') &&
        !!(w.__seekvecEval && typeof w.__seekvecEval.ingestFiles === 'function' &&
          typeof w.__seekvecEval.search === 'function');
    },
    { timeout, polling: 500 },
  );
}

function rankHits(hits, mode) {
  const keyed = hits.map((hit, order) => ({ ...hit, order }));
  keyed.sort((a, b) => {
    if (mode === 'hybrid') {
      const diff = (Number.isFinite(b.score) ? b.score : -Infinity) - (Number.isFinite(a.score) ? a.score : -Infinity);
      if (diff !== 0 && Number.isFinite(diff)) return diff;
    } else {
      const diff = (Number.isFinite(a.distance) ? a.distance : Infinity) - (Number.isFinite(b.distance) ? b.distance : Infinity);
      if (diff !== 0 && Number.isFinite(diff)) return diff;
    }
    return a.order - b.order;
  });
  return keyed;
}

// ---------------------------------------------------------------------------
// 单组评测
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx {puppeteer, browser, opts, libs, dataset, corpusFiles, chunkUniverse, corpusSources}
 * @param {object} group
 */
async function runGroup(ctx, group) {
  const { opts, libs, dataset, corpusFiles, chunkUniverse, corpusSources } = ctx;
  const { chunkKey } = libs.datasets;
  const pageErrors = [];
  const consoleErrors = [];
  const assertions = [];
  const startTime = Date.now();
  const collection = sanitizeCollectionName(`${opts.collectionPrefix}_${group.id}_${timestamp()}`);
  group.collection = collection;

  const assert = (ok, name, detail) => {
    assertions.push({ ok: Boolean(ok), name, detail });
  };

  const page = await ctx.browser.newPage();
  page.on('pageerror', (err) => pageErrors.push(String(err.message ?? err).slice(0, 400)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`[console.error] ${msg.text()}`.slice(0, 400));
  });

  const result = {
    groupId: group.id,
    requested: { backend: group.backend, dtype: group.dtype, baseline: Boolean(group.baseline) },
    collection,
    ok: false,
    assertions,
    pageErrors,
    consoleErrors,
    startedAt: new Date(startTime).toISOString(),
  };

  try {
    await deleteCollection(opts.apiUrl, collection);
    const pageUrl = buildPageUrl(opts, group);
    console.log(`\n[eval-quality-browser] ▶ ${group.id} → ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
    await waitForEvalApi(page, opts.timeout);
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__seekvecPerf?.clear?.();
    });

    // 1) 导入语料（触发模型加载 + 端侧向量化 + 写 seekdb）
    console.log(`  导入 ${corpusFiles.length} 篇 → collection ${collection} ...`);
    const ingest = await withTimeout(
      page.evaluate(
        async ({ files, collectionName }) => {
          const w = /** @type {any} */ (window);
          const fileObjects = files.map((file) => new File([file.content], file.name, { type: 'text/markdown' }));
          /** @type {any} */
          const outcome = await w.__seekvecEval.ingestFiles(fileObjects, collectionName);
          return outcome;
        },
        { files: corpusFiles, collectionName: collection },
      ),
      Math.max(120_000, opts.timeout),
      'ingestFiles',
    );
    console.log(`  导入完成：count=${ingest?.count}，times.totalMs=${round(ingest?.times?.totalMs)}`);

    // 2) 读取实际环境（backend/dtype/model）+ 阶段耗时
    const perf = await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      try {
        return {
          snapshot: w.__seekvecPerf?.snapshot?.() ?? null,
          summary: w.__seekvecPerf?.summary?.() ?? null,
        };
      } catch (err) {
        return { error: String(err) };
      }
    });
    const env = perf?.snapshot?.env ?? null;
    const phasesApi = normalizePhaseSummary(perf?.summary);
    const phases = Object.keys(phasesApi).length > 0 ? phasesApi : summarizeEvents(perf?.snapshot?.events);
    const actualBackend = env?.backend ?? null;
    const actualDtype = env?.model?.dtype ?? null;
    const fallback = Boolean(group.backend && group.backend !== 'auto' && actualBackend && actualBackend !== group.backend);
    const dtypeMismatch = Boolean(group.dtype && actualDtype && actualDtype !== group.dtype);

    result.actual = {
      backend: actualBackend,
      dtype: actualDtype,
      backendReason: env?.backendReason ?? null,
      model: env?.model ?? null,
      gpuAdapter: env?.gpuAdapter ?? null,
      fallback,
      dtypeMismatch,
    };
    result.ingest = { count: ingest?.count ?? null, times: ingest?.times ?? null };
    result.phases = phases;
    result.perfEnv = env;

    // 3) 断言：ingest chunk 数 = 数据集 chunk 数（qrels 映射有效性的前提）
    assert(
      ingest?.count === dataset.chunks.length,
      'ingest chunk 数与评测集一致',
      `写入 ${ingest?.count}，期望 ${dataset.chunks.length}（浏览器分块需与 qrels 映射一致）`,
    );
    if (fallback) {
      assert(
        !opts.strictBackend,
        '强制后端未被降级',
        `请求 ${group.backend}，实际 ${actualBackend}${env?.backendReason ? `（${env.backendReason}）` : ''}${opts.strictBackend ? '；--strict-backend 视为失败' : '；已标记 fallback，数据仍计入'}`,
      );
    }
    if (dtypeMismatch) {
      assert(false, '实际 dtype 与请求一致', `请求 ${group.dtype}，实际 ${actualDtype}`);
    }
    assert(
      actualBackend !== null && actualDtype !== null,
      '可读取实际 backend/dtype',
      `backend=${actualBackend ?? '未知'}，dtype=${actualDtype ?? '未知'}`,
    );

    // 4) 逐查询评测（--runs 次）
    const queryRows = [];
    const runSummaries = [];
    for (let run = 0; run < opts.runs; run += 1) {
      const rowsThisRun = [];
      for (const query of dataset.queries) {
        const expectedMode = query.keyword ? 'hybrid' : 'vector';
        const response = await withTimeout(
          page.evaluate(
            async ({ q, keyword, nResults }) => {
              const w = /** @type {any} */ (window);
              /** @type {any} */
              const res = await w.__seekvecEval.search(q, keyword ?? undefined, nResults);
              const hits = (res?.hits ?? []).map((hit) => ({
                id: hit?.id ?? null,
                source: hit?.metadata?.source ?? null,
                chunkIndex: typeof hit?.metadata?.chunkIndex === 'number' ? hit.metadata.chunkIndex : null,
                distance: typeof hit?.distance === 'number' ? hit.distance : null,
                score: typeof hit?.score === 'number' ? hit.score : null,
              }));
              return {
                hits,
                mode: res?.mode ?? null,
                metric: res?.metric ?? null,
                latencyMs: res?.latencyMs ?? null,
                embeddingMs: res?.embeddingMs ?? null,
                httpMs: res?.httpMs ?? null,
                dbMs: res?.dbMs ?? null,
                e2eMs: res?.e2eMs ?? null,
                notice: res?.notice ?? null,
              };
            },
            { q: query.query, keyword: query.keyword ?? null, nResults: opts.topN },
          ),
          Math.max(60_000, Math.floor(opts.timeout / 2)),
          `search(${query.qid})`,
        );

        const ranked = rankHits(response.hits, response.mode ?? expectedMode);
        const rankedKeys = [];
        const invalidHits = [];
        for (const hit of ranked) {
          if (typeof hit.source !== 'string' || hit.source === '' || !Number.isInteger(hit.chunkIndex)) {
            invalidHits.push(hit.id ?? '(no id)');
            continue;
          }
          rankedKeys.push(chunkKey(hit.source, hit.chunkIndex));
        }
        const relevantSet = new Set(
          query.relevant.filter((entry) => entry.grade >= 1).map((entry) => chunkKey(entry.source, entry.chunkIndex)),
        );
        const gradedMap = Object.fromEntries(
          query.relevant.filter((entry) => entry.grade > 0).map((entry) => [chunkKey(entry.source, entry.chunkIndex), entry.grade]),
        );
        const metrics = {
          recallAt1: libs.metrics.recallAtK(rankedKeys, relevantSet, 1),
          recallAt3: libs.metrics.recallAtK(rankedKeys, relevantSet, 3),
          recallAt5: libs.metrics.recallAtK(rankedKeys, relevantSet, 5),
          ndcgAt5: libs.metrics.ndcgAtK(rankedKeys, gradedMap, 5),
          ndcgAt10: libs.metrics.ndcgAtK(rankedKeys, gradedMap, 10),
          mrr: libs.metrics.mrr(rankedKeys, relevantSet),
        };

        // 断言：查询有结果 / hit metadata 完整可映射 / mode 与 keyword 预期一致
        const row = {
          qid: query.qid,
          category: query.category,
          lang: query.lang,
          query: query.query,
          keyword: query.keyword ?? null,
          expectedMode,
          mode: response.mode,
          metric: response.metric,
          hits: rankedKeys.length,
          hitsInQrels: rankedKeys.filter((key) => key in gradedMap).length,
          relevantCount: relevantSet.size,
          invalidHits: invalidHits.length,
          notice: response.notice ?? null,
          latencyMs: response.latencyMs,
          embeddingMs: response.embeddingMs,
          httpMs: response.httpMs,
          dbMs: response.dbMs,
          e2eMs: response.e2eMs,
          ...metrics,
          // 审计用：排序后的命中（source#chunkIndex + 分数），供 raw.json 复核
          topHits: ranked.slice(0, opts.topN).map((hit) => ({
            key: typeof hit.source === 'string' && Number.isInteger(hit.chunkIndex) ? chunkKey(hit.source, hit.chunkIndex) : null,
            id: hit.id,
            distance: hit.distance,
            score: hit.score,
          })),
          hitKeys: rankedKeys,
        };
        row.assertions = {
          hasHits: ranked.length > 0,
          metadataValid: invalidHits.length === 0,
          hitSourceKnown: ranked.every((hit) => hit.source === null || corpusSources.has(hit.source)),
          modeMatches: response.mode === expectedMode,
        };
        rowsThisRun.push(row);
      }
      runSummaries.push({ run, metrics: aggregateMetrics(rowsThisRun) });
      queryRows.push({ run, rows: rowsThisRun });
    }

    // 合并多 run（逐查询取均值，再 macro）
    const mergedRows = mergeRuns(queryRows, dataset.queries);
    const metrics = aggregateMetrics(mergedRows);

    // 汇总断言
    const noHitQueries = mergedRows.filter((row) => row.hits === 0).map((row) => row.qid);
    const invalidMetaQueries = mergedRows.filter((row) => row.invalidHits > 0).map((row) => row.qid);
    const unknownSourceQueries = mergedRows.filter((row) => !row.assertions.hitSourceKnown).map((row) => row.qid);
    const modeMismatches = mergedRows.filter((row) => !row.assertions.modeMatches).map((row) => `${row.qid}(${row.mode ?? '?'})`);
    const qrelKeyMisses = [];
    for (const query of dataset.queries) {
      for (const entry of query.relevant) {
        if (!chunkUniverse.has(chunkKey(entry.source, entry.chunkIndex))) {
          qrelKeyMisses.push(`${query.qid}:${chunkKey(entry.source, entry.chunkIndex)}`);
        }
      }
    }
    assert(noHitQueries.length === 0, '每条查询都有结果', noHitQueries.length === 0 ? `${mergedRows.length} 条查询均有 hit` : `无结果查询：${noHitQueries.slice(0, 8).join(', ')}`);
    assert(invalidMetaQueries.length === 0, 'hit metadata 可映射（source/chunkIndex 完整）', invalidMetaQueries.length === 0 ? '全部 hit 均含 source + chunkIndex' : `缺失查询：${invalidMetaQueries.slice(0, 8).join(', ')}`);
    assert(unknownSourceQueries.length === 0, 'hit source 均属于评测语料', unknownSourceQueries.length === 0 ? `${dataset.documents.length} 篇语料内` : `越界查询：${unknownSourceQueries.slice(0, 8).join(', ')}`);
    assert(modeMismatches.length === 0, 'search mode 与 keyword 预期一致', modeMismatches.length === 0 ? 'keyword→hybrid，无 keyword→vector' : `不一致：${modeMismatches.slice(0, 8).join(', ')}`);
    assert(qrelKeyMisses.length === 0, 'qrels 均可解析到语料 chunk', qrelKeyMisses.length === 0 ? `${dataset.queries.reduce((sum, q) => sum + q.relevant.length, 0)} 条 qrels 全部可解析` : `未解析：${qrelKeyMisses.slice(0, 8).join(', ')}`);

    // 映射覆盖统计（诊断）
    const allHitKeys = mergedRows.flatMap((row) => row.hitKeys ?? []);
    const hitKeyInChunkUniverse = allHitKeys.filter((key) => chunkUniverse.has(key)).length;
    result.mapping = {
      hitsTotal: allHitKeys.length,
      hitsResolvable: hitKeyInChunkUniverse,
      queries: mergedRows.length,
      qrelEntries: dataset.queries.reduce((sum, query) => sum + query.relevant.length, 0),
      qrelResolvable: dataset.queries.reduce((sum, query) => sum + query.relevant.length, 0) - qrelKeyMisses.length,
      modeCounts: countBy(mergedRows.map((row) => row.mode)),
      hitsInQrels: mergedRows.reduce((sum, row) => sum + row.hitsInQrels, 0),
    };

    result.metrics = metrics;
    result.metricsByCategory = groupMetricsBy(mergedRows, (row) => row.category);
    result.metricsByLang = groupMetricsBy(mergedRows, (row) => row.lang);
    result.queryRows = mergedRows.map(stripHitKeys);
    result.runs = runSummaries;
    result.durationMs = Date.now() - startTime;
    result.actualDurationMs = result.durationMs;
    result.ok = true;
    console.log(
      `  ✓ ${group.id} 完成：Recall@5=${fmt(metrics.recallAt5)} nDCG@10=${fmt(metrics.ndcgAt10)} MRR=${fmt(metrics.mrr)}` +
        `（${(result.durationMs / 1000).toFixed(1)}s，backend=${actualBackend} dtype=${actualDtype}${fallback ? '，fallback' : ''}）`,
    );
  } catch (err) {
    result.ok = false;
    result.error = String(err?.stack ?? err);
    console.error(`  ✗ ${group.id} 失败：${err?.message ?? err}`);
    assert(false, '组执行完成', `异常：${err?.message ?? err}`);
  } finally {
    if (!opts.keep) {
      const cleanup = await deleteCollection(opts.apiUrl, collection);
      result.cleanup = cleanup;
      if (cleanup.ok) console.log(`  已清理 collection ${collection}（HTTP ${cleanup.status}）`);
      else console.warn(`  ⚠ collection 清理失败：${collection}（${cleanup.error ?? cleanup.status}）`);
    } else {
      result.cleanup = { ok: true, kept: true };
      console.log(`  --keep：保留 collection ${collection}`);
    }
    await page.close().catch(() => {});
  }
  return result;
}

function stripHitKeys(row) {
  const { hitKeys, ...rest } = row;
  return rest;
}

function countBy(values) {
  const out = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function aggregateMetrics(rows) {
  const pick = (key) => rows.map((row) => row[key]).filter(Number.isFinite);
  return {
    queries: rows.length,
    recallAt1: round(mean(pick('recallAt1'))),
    recallAt3: round(mean(pick('recallAt3'))),
    recallAt5: round(mean(pick('recallAt5'))),
    ndcgAt5: round(mean(pick('ndcgAt5'))),
    ndcgAt10: round(mean(pick('ndcgAt10'))),
    mrr: round(mean(pick('mrr'))),
  };
}

function groupMetricsBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(keyFn(row));
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const out = {};
  for (const [key, items] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out[key] = aggregateMetrics(items);
  }
  return out;
}

/** 多 run 合并：逐查询对指标取均值（排序/命中数以最后一次 run 为准） */
function mergeRuns(queryRows, queries) {
  const byQid = new Map();
  for (const { run, rows } of queryRows) {
    for (const row of rows) {
      const list = byQid.get(row.qid) ?? [];
      list.push({ run, row });
      byQid.set(row.qid, list);
    }
  }
  return queries.map((query) => {
    const entries = byQid.get(query.qid) ?? [];
    const last = entries[entries.length - 1]?.row ?? {};
    const merged = { ...last };
    for (const key of ['recallAt1', 'recallAt3', 'recallAt5', 'ndcgAt5', 'ndcgAt10', 'mrr']) {
      const values = entries.map((entry) => entry.row[key]).filter(Number.isFinite);
      merged[key] = mean(values);
    }
    merged.hits = last.hits ?? 0;
    merged.invalidHits = last.invalidHits ?? 0;
    merged.assertions = last.assertions ?? { hasHits: false, metadataValid: false, hitSourceKnown: false, modeMatches: false };
    return merged;
  });
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function groupSummaryMarkdown(group) {
  const lines = [];
  lines.push(`# 浏览器质量评测 · ${group.groupId}`);
  lines.push('');
  lines.push(`- 时间：${group.startedAt}`);
  lines.push(`- collection：\`${group.collection}\`${group.cleanup?.kept ? '（--keep 保留）' : '（已自动清理）'}`);
  lines.push(`- 请求：backend=\`${group.requested.backend}\`、dtype=\`${group.requested.dtype}\``);
  lines.push(
    `- 实际：backend=\`${group.actual?.backend ?? '?'}\`、dtype=\`${group.actual?.dtype ?? '?'}\`` +
      (group.actual?.backendReason ? `（reason: ${group.actual.backendReason}）` : '') +
      (group.actual?.fallback ? ' ⚠ **发生降级 fallback**' : ''),
  );
  if (group.actual?.model) {
    lines.push(`- 模型：${group.actual.model.id ?? '?'} @ ${String(group.actual.model.revision ?? '').slice(0, 12)} · ${group.actual.model.key ?? '?'}`);
  }
  lines.push(`- 数据：60 篇文档 / 73 chunks / 60 查询（分块与 qrels 来自 data/eval）`);
  lines.push(`- ingest：count=${group.ingest?.count ?? '?'}，times.totalMs=${fmt(group.ingest?.times?.totalMs, 1)}`);
  lines.push(`- 耗时：${((group.durationMs ?? 0) / 1000).toFixed(2)}s`);
  lines.push('');
  const metrics = group.metrics ?? {};
  lines.push('## 指标（macro 平均，60 条查询）');
  lines.push('');
  lines.push('| Recall@1 | Recall@3 | Recall@5 | nDCG@5 | nDCG@10 | MRR |');
  lines.push('|---|---|---|---|---|---|');
  lines.push(`| ${fmt(metrics.recallAt1)} | ${fmt(metrics.recallAt3)} | ${fmt(metrics.recallAt5)} | ${fmt(metrics.ndcgAt5)} | ${fmt(metrics.ndcgAt10)} | ${fmt(metrics.mrr)} |`);
  lines.push('');
  if (group.metricsByCategory) {
    lines.push('## 分类别（macro）');
    lines.push('');
    lines.push('| category | queries | Recall@5 | nDCG@10 | MRR |');
    lines.push('|---|---|---|---|---|');
    for (const [key, value] of Object.entries(group.metricsByCategory)) {
      lines.push(`| ${key} | ${value.queries} | ${fmt(value.recallAt5)} | ${fmt(value.ndcgAt10)} | ${fmt(value.mrr)} |`);
    }
    lines.push('');
  }
  lines.push('## 阶段耗时（ms，p50；来自 window.__seekvecPerf.summary）');
  lines.push('');
  lines.push('| 阶段 | n | p50 | p95 | mean |');
  lines.push('|---|---|---|---|---|');
  for (const [phase, value] of Object.entries(group.phases ?? {})) {
    lines.push(`| ${phase} | ${value.n ?? '—'} | ${fmt(value.p50, 1)} | ${fmt(value.p95, 1)} | ${fmt(value.mean, 1)} |`);
  }
  lines.push('');
  lines.push('## 逐查询');
  lines.push('');
  lines.push('| qid | category | mode | hits | hits∈qrels | R@5 | nDCG@10 | MRR | e2eMs |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const row of group.queryRows ?? []) {
    lines.push(
      `| ${row.qid} | ${row.category} | ${row.mode ?? '?'} | ${row.hits} | ${row.hitsInQrels} | ${fmt(row.recallAt5, 3)} | ` +
        `${fmt(row.ndcgAt10, 3)} | ${fmt(row.mrr, 3)} | ${fmt(row.e2eMs, 1)} |`,
    );
  }
  lines.push('');
  lines.push('## 断言');
  lines.push('');
  for (const assertion of group.assertions ?? []) {
    lines.push(`- ${assertion.ok ? 'PASS' : 'FAIL'} · ${assertion.name}：${assertion.detail}`);
  }
  if (group.error) {
    lines.push('');
    lines.push('## 失败原因');
    lines.push('');
    lines.push('```');
    lines.push(group.error);
    lines.push('```');
  }
  lines.push('');
  return lines.join('\n');
}

function topSummaryMarkdown({ opts, run, browserInfo, datasetSummary }) {
  const lines = [];
  lines.push('# 浏览器端检索质量评测（量化前后对比）');
  lines.push('');
  lines.push(`- 时间：${run.generatedAt}`);
  lines.push(`- 页面：${opts.baseUrl}（真实应用链路：端侧推理 → 前端分块写入 → server → seekdb 检索）`);
  lines.push(`- 浏览器：${browserInfo.browserVersion ?? '未知'}（${browserInfo.executablePath}）`);
  lines.push(`- 评测集：${datasetSummary.documents} 篇 / ${datasetSummary.chunks} chunks / ${datasetSummary.queries} 查询 / ${datasetSummary.relevantPairs} 条 qrels（data/eval）`);
  lines.push(`- 运行参数：runs=${opts.runs}、topN=${opts.topN}、timeout=${opts.timeout}ms`);
  lines.push('');
  lines.push('## 组概览');
  lines.push('');
  lines.push('| 组 | 请求 backend/dtype | 实际 backend/dtype | 模型 | ingest chunks | 耗时 (s) | 状态 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const group of run.groups) {
    const requested = `${group.requested.backend}/${group.requested.dtype}`;
    const actual = `${group.actual?.backend ?? '?'}/${group.actual?.dtype ?? '?'}${group.actual?.fallback ? ' ⚠fallback' : ''}`;
    const status = group.ok ? (group.assertions.every((assertion) => assertion.ok) ? 'PASS' : 'ASSERT-FAIL') : 'FAIL';
    lines.push(
      `| ${group.groupId} | ${requested} | ${actual} | ${group.actual?.model?.id ?? '?'} @${String(group.actual?.model?.revision ?? '').slice(0, 8)} | ` +
        `${group.ingest?.count ?? '—'} | ${((group.durationMs ?? 0) / 1000).toFixed(1)} | ${status} |`,
    );
  }
  lines.push('');
  lines.push('## 指标对比（macro 平均，60 条查询）');
  lines.push('');
  lines.push('| 组 | backend/dtype | Recall@1 | Recall@3 | Recall@5 | nDCG@5 | nDCG@10 | MRR |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const group of run.groups) {
    const metrics = group.metrics ?? {};
    lines.push(
      `| ${group.groupId} | ${group.actual?.backend ?? '?'}/${group.actual?.dtype ?? '?'} | ${fmt(metrics.recallAt1)} | ${fmt(metrics.recallAt3)} | ` +
        `${fmt(metrics.recallAt5)} | ${fmt(metrics.ndcgAt5)} | ${fmt(metrics.ndcgAt10)} | ${fmt(metrics.mrr)} |`,
    );
  }
  lines.push('');
  lines.push('## 相对 baseline 的变化与质量门');
  lines.push('');
  lines.push('质量门（契约 §8）：Recall@5 降幅 ≤ 2pp（0.02 绝对差），nDCG@10 降幅 ≤ 0.02。');
  lines.push('');
  lines.push('| 组 | ΔRecall@5 (pp) | ΔnDCG@10 | Recall@5 gate | nDCG@10 gate | 结论 |');
  lines.push('|---|---|---|---|---|---|');
  for (const row of run.gateRows) {
    lines.push(
      `| ${row.groupId} | ${row.deltaRecallAt5Pp === null ? '—' : (row.deltaRecallAt5Pp * 100).toFixed(2)} | ` +
        `${fmt(row.deltaNdcgAt10, 4)} | ${row.recallGate === null ? '—' : row.recallGate ? 'PASS' : 'FAIL'} | ` +
        `${row.ndcgGate === null ? '—' : row.ndcgGate ? 'PASS' : 'FAIL'} | ${row.verdict} |`,
    );
  }
  lines.push('');
  lines.push('## 分组指标（分类别 / 语言）');
  lines.push('');
  for (const group of run.groups) {
    if (!group.metricsByCategory) continue;
    lines.push(`### ${group.groupId}`);
    lines.push('');
    lines.push('| 维度 | 组 | queries | Recall@5 | nDCG@10 | MRR |');
    lines.push('|---|---|---|---|---|---|');
    for (const [key, value] of Object.entries(group.metricsByCategory)) {
      lines.push(`| category | ${key} | ${value.queries} | ${fmt(value.recallAt5)} | ${fmt(value.ndcgAt10)} | ${fmt(value.mrr)} |`);
    }
    for (const [key, value] of Object.entries(group.metricsByLang ?? {})) {
      lines.push(`| lang | ${key} | ${value.queries} | ${fmt(value.recallAt5)} | ${fmt(value.ndcgAt10)} | ${fmt(value.mrr)} |`);
    }
    lines.push('');
  }
  lines.push('## 断言与映射完整性');
  lines.push('');
  lines.push('| 组 | 断言 | 映射 |');
  lines.push('|---|---|---|');
  for (const group of run.groups) {
    const failed = (group.assertions ?? []).filter((assertion) => !assertion.ok);
    const assertionText = group.assertions?.length ? (failed.length === 0 ? `PASS ${group.assertions.length}/${group.assertions.length}` : `FAIL ${failed.length}/${group.assertions.length}`) : '—';
    const mapping = group.mapping
      ? `hits ${group.mapping.hitsResolvable}/${group.mapping.hitsTotal}、qrels ${group.mapping.qrelResolvable}/${group.mapping.qrelEntries}、mode ${JSON.stringify(group.mapping.modeCounts)}`
      : '—';
    lines.push(`| ${group.groupId} | ${assertionText} | ${mapping} |`);
  }
  lines.push('');
  const allFailed = run.groups.filter((group) => !group.ok);
  const assertionFailed = run.groups.filter((group) => group.ok && (group.assertions ?? []).some((assertion) => !assertion.ok));
  const fallbackGroups = run.groups.filter((group) => group.actual?.fallback);
  lines.push('## 结论 / 风险');
  lines.push('');
  lines.push(`- 三组数据：${run.groups.length - allFailed.length}/${run.groups.length} 成功${allFailed.length ? `（失败：${allFailed.map((group) => group.groupId).join(', ')}）` : ''}。`);
  lines.push(`- 断言：${assertionFailed.length === 0 ? '全部通过' : `有 ${assertionFailed.length} 组存在断言失败：${assertionFailed.map((group) => group.groupId).join(', ')}`}。`);
  if (fallbackGroups.length > 0) {
    lines.push(`- ⚠ 后端降级：${fallbackGroups.map((group) => `${group.groupId} 请求 ${group.requested.backend} → 实际 ${group.actual.backend}${group.actual.backendReason ? `（${group.actual.backendReason}）` : ''}`).join('；')}。`);
  }
  const gateFailed = run.gateRows.filter((row) => row.recallGate === false || row.ndcgGate === false);
  lines.push(`- 质量门：${gateFailed.length === 0 ? '通过（无超标项）' : `未通过：${gateFailed.map((row) => row.groupId).join(', ')}（需在报告中分析并披露）`}。`);
  lines.push('- 原始数据：`raw.json`（本目录）与 `<group-id>/raw.json`（逐查询命中/指标）；本文件由 scripts/eval-quality-browser.mjs 生成。');
  lines.push('- 口径：真实应用链路（含浏览器分块、seekdb HNSW 近似检索与 hybrid 检索），与 Node CPU 纯排序口径（scripts/eval-quality.ts）互补、不可直接混用。');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function loadLibs() {
  try {
    const datasets = await import(new URL('./lib/datasets.ts', import.meta.url).href);
    const metrics = await import(new URL('./lib/evalMetrics.ts', import.meta.url).href);
    return { datasets, metrics };
  } catch (err) {
    console.error(`[eval-quality-browser] ✗ 无法加载 scripts/lib/*.ts（当前运行方式不支持 TS 依赖）`);
    console.error('  请使用 npm 脚本（内部 tsx）：npm run eval:quality:browser -- <参数>');
    console.error('  或直接：npx tsx scripts/eval-quality-browser.mjs -- <参数>');
    console.error(`  原始错误：${err?.message ?? err}`);
    process.exit(2);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  const libs = await loadLibs();

  // 数据集（Node 侧解析 + 校验；chunkText/chunkId 与浏览器一致，保证 qrels 映射）
  const dataset = await libs.datasets.loadEvalDataset(opts.data);
  if (dataset.issues.length > 0) {
    console.error(`[eval-quality-browser] ✗ data/eval 数据集校验失败（${dataset.issues.length} 项）：`);
    for (const issue of dataset.issues.slice(0, 20)) console.error(`  - ${issue}`);
    process.exit(1);
  }
  const datasetSummary = libs.datasets.summarizeEvalSet(dataset.documents, dataset.chunks, dataset.queries);
  const chunkUniverse = new Set(dataset.chunks.map((chunk) => libs.datasets.chunkKey(chunk.source, chunk.chunkIndex)));
  const corpusSources = new Set(dataset.documents.map((doc) => doc.source));
  const corpusFiles = dataset.documents.map((doc) => ({ name: doc.source, content: doc.text }));

  console.log('[eval-quality-browser] SeekVec 浏览器端检索质量评测');
  console.log(`  评测集：${datasetSummary.documents} 篇 / ${datasetSummary.chunks} chunks / ${datasetSummary.queries} 查询 / ${datasetSummary.relevantPairs} qrels`);
  console.log(`  页面：${opts.baseUrl}`);
  console.log(`  输出：${opts.out}`);
  console.log(`  组：${opts.groups.map((group) => `${group.id}(${group.backend}/${group.dtype})`).join(', ')}`);

  // 页面可达性
  try {
    const { ok, status } = await fetchJson(`${opts.baseUrl}/`, { timeoutMs: 10000 });
    if (!ok) throw new Error(`HTTP ${status}`);
  } catch (err) {
    console.error(`[eval-quality-browser] ✗ 页面不可达：${opts.baseUrl}（${err.message}）\n  请先启动 dev server（npm run dev:docker）。`);
    process.exit(1);
  }

  const { candidates, checked } = existingBrowserCandidates(opts.browserPath);
  if (candidates.length === 0) {
    console.error('[eval-quality-browser] ✗ 未找到可用浏览器（Chrome/Edge/Chromium）。\n  已检查：');
    for (const candidate of checked) console.error(`  - ${candidate}`);
    console.error('  可设置 BROWSER_PATH 指向可执行文件。');
    process.exit(1);
  }

  const { default: puppeteer } = await import('puppeteer-core');
  const launched = await launchWithFallback(puppeteer, candidates, opts);
  const browserInfo = {
    executablePath: launched.used.path,
    source: launched.used.source,
    userDataDir: launched.userDataDir,
    browserVersion: await launched.browser.version(),
  };
  console.log(`  浏览器：${browserInfo.executablePath}（${browserInfo.source}，${browserInfo.browserVersion}）`);
  if (launched.errors.length > 0) {
    console.log(`  已回退 ${launched.errors.length} 个启动失败的候选：${launched.errors.map((error) => path.basename(error.path)).join(', ')}`);
  }

  const ctx = { puppeteer, browser: launched.browser, opts, libs, dataset, corpusFiles, chunkUniverse, corpusSources };
  const groups = [];
  try {
    for (const group of opts.groups) {
      groups.push(await runGroup(ctx, group));
    }
  } finally {
    await launched.browser.close().catch(() => {});
  }

  // 质量门：相对 baseline（默认第一组）比较
  const baseline = groups.find((group) => group.requested.baseline && group.ok) ?? groups.find((group) => group.ok) ?? null;
  const gateRows = groups.map((group) => {
    const metrics = group.metrics;
    if (!group.ok || !metrics) {
      return { groupId: group.groupId, deltaRecallAt5Pp: null, deltaNdcgAt10: null, recallGate: null, ndcgGate: null, verdict: '无数据' };
    }
    if (!baseline || baseline.groupId === group.groupId || !baseline.metrics) {
      return { groupId: group.groupId, deltaRecallAt5Pp: null, deltaNdcgAt10: null, recallGate: null, ndcgGate: null, verdict: group.groupId === baseline?.groupId ? 'baseline' : '—' };
    }
    const deltaRecallAt5 = group.metrics.recallAt5 - baseline.metrics.recallAt5;
    const deltaNdcgAt10 = group.metrics.ndcgAt10 - baseline.metrics.ndcgAt10;
    const recallGate = deltaRecallAt5 >= -GATE.recallAt5MaxDrop;
    const ndcgGate = deltaNdcgAt10 >= -GATE.ndcgAt10MaxDrop;
    return {
      groupId: group.groupId,
      deltaRecallAt5Pp: round(deltaRecallAt5),
      deltaNdcgAt10: round(deltaNdcgAt10),
      recallGate,
      ndcgGate,
      verdict: recallGate && ndcgGate ? 'PASS' : '需分析披露',
    };
  });

  const run = {
    schemaVersion: SCHEMA_VERSION,
    tool: 'scripts/eval-quality-browser.mjs',
    generatedAt: new Date().toISOString(),
    command: ['node', 'scripts/eval-quality-browser.mjs', ...process.argv.slice(2)].join(' '),
    config: {
      baseUrl: opts.baseUrl,
      apiUrl: opts.apiUrl,
      data: path.relative(ROOT, opts.data),
      out: opts.out,
      runs: opts.runs,
      topN: opts.topN,
      groups: opts.groups.map((group) => ({ id: group.id, backend: group.backend, dtype: group.dtype, baseline: Boolean(group.baseline) })),
      gate: GATE,
    },
    browser: browserInfo,
    dataset: datasetSummary,
    groups,
    gateRows,
  };

  // ---- 输出 ----
  fs.mkdirSync(opts.out, { recursive: true });
  for (const group of groups) {
    const dir = path.join(opts.out, group.groupId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'raw.json'), `${JSON.stringify(group, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'summary.md'), groupSummaryMarkdown(group), 'utf8');
  }
  fs.writeFileSync(path.join(opts.out, 'raw.json'), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(opts.out, 'summary.md'), topSummaryMarkdown({ opts, run, browserInfo, datasetSummary }), 'utf8');

  console.log(`\n[eval-quality-browser] ✓ 输出：`);
  console.log(`  ${path.join(opts.out, 'summary.md')}`);
  console.log(`  ${path.join(opts.out, 'raw.json')}`);
  for (const group of groups) console.log(`  ${path.join(opts.out, group.groupId, 'summary.md')} ${group.ok ? '' : '（FAIL）'}`);

  // ---- 退出码 ----
  const failedGroups = groups.filter((group) => !group.ok);
  const failedAssertions = groups.filter((group) => group.ok && (group.assertions ?? []).some((assertion) => !assertion.ok));
  const missingGroups = groups.length !== opts.groups.length;
  const gateFailed = gateRows.some((row) => row.recallGate === false || row.ndcgGate === false);

  if (failedGroups.length > 0 || failedAssertions.length > 0 || missingGroups) {
    console.error(
      `\n[eval-quality-browser] ✗ 失败：组失败 ${failedGroups.length}，断言失败 ${failedAssertions.length}，缺失组 ${missingGroups ? '是' : '否'}`,
    );
    for (const group of [...failedGroups, ...failedAssertions]) {
      const details = (group.assertions ?? []).filter((assertion) => !assertion.ok).map((assertion) => `${assertion.name}：${assertion.detail}`);
      if (details.length > 0) console.error(`  - ${group.groupId}: ${details.join(' | ')}`);
      if (group.error) console.error(`  - ${group.groupId}: ${group.error.split('\n')[0]}`);
    }
    process.exit(1);
  }
  if (gateFailed && opts.strictGate) {
    console.error('[eval-quality-browser] ✗ --strict-gate：质量门未通过');
    process.exit(1);
  }
  if (gateFailed) {
    console.warn('\n[eval-quality-browser] ⚠ 质量门未通过（已在 summary.md 报告；加 --strict-gate 可令其非零退出）');
  }
  console.log('\n[eval-quality-browser] ✓ 完成');
}

main().catch((err) => {
  console.error('[eval-quality-browser] ✗ 未预期错误：', err?.stack ?? err);
  process.exit(1);
});
