#!/usr/bin/env node
/**
 * 浏览器端基准测试（真实应用链路：Transformers.js 推理 + seekdb 读写 + 前端渲染）
 *
 * 依赖 puppeteer-core（devDep）。用 `?perf=1` 打开页面，优先通过
 * window.__seekvecEval（ingestFiles/search/reset）与 window.__seekvecPerf（summary/snapshot）
 * 驱动导入与查询并采集分阶段耗时；若 perf/eval API 尚未实现，则退回 UI 操作（上传文件 +
 * 输入框检索 + 从界面文案解析耗时），此时输出会标记 mode=ui-fallback。
 *
 * 用法示例：
 *   npm run bench:browser
 *   node scripts/bench-browser.mjs --backend wasm --dtype q8 --runs 5 --warmup 1
 *   node scripts/bench-browser.mjs --backend webgpu --dtype fp16 --cold --out docs/benchmarks/run-001
 *   node scripts/bench-browser.mjs --check     # 环境自检（浏览器路径/页面/语料），不启动基准
 *   node scripts/bench-browser.mjs --smoke     # 冒烟：1 次导入 + 1 条查询，验证链路可用
 *
 * 输出：<out>/raw.json（原始数据）+ <out>/summary.md（汇总表）。失败非零退出。
 * 默认自动清理本次使用的 collection（DELETE /api/collections/:name）；--keep 可保留。
 *
 * 浏览器解析顺序：--browser-path / $BROWSER_PATH → 上次成功缓存 → 常见 Chrome/Edge 安装路径
 * → Playwright 浏览器缓存（%LOCALAPPDATA%/ms-playwright 等）。不写死用户名。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const HELP = `SeekVec · 浏览器基准测试（puppeteer-core）

用法：
  node scripts/bench-browser.mjs [选项]

选项：
  --base-url <url>       页面地址（默认 $SEEKVEC_BASE_URL 或 http://localhost:5173）
  --api-url <url>        清理 collection 用的 API 地址（默认同 --base-url，经 Vite /api 代理）
  --backend <auto|webgpu|wasm>  推理后端（默认 auto，由页面自行探测）
  --dtype <q8|fp16|fp32> 量化精度（默认不传，页面按后端选默认）
  --batch <1..64>        推理批大小（默认不传，页面默认 16）
  --threads <1..16>      WASM 线程数（默认不传，页面按 crossOriginIsolated + hardwareConcurrency 自适应）
  --refresh <last|each>  索引刷新策略（默认不传，页面默认 last）
  --models <auto|remote|local>  模型来源（默认不传）
  --runs <n>             计入统计的正式轮数（默认 5）
  --warmup <n>           预热轮数，不计入统计（默认 1）
  --cold                 每轮开始前清空浏览器缓存/CacheStorage 并重新加载页面（冷启动口径）
  --no-webgpu            模拟 WebGPU 不可用（禁用 GPU/WebGPU），用于验证 auto→WASM 降级路径
  --out <dir>            输出目录（默认 docs/benchmarks/browser-<时间戳>）
  --corpus <path>        语料目录或文件（默认 data/perf/corpus；支持 .md/.txt/.jsonl）
  --queries <file>       查询文件，每行一条（默认 data/perf/queries.txt）
  --collection <name>    本次基准写入/清理的集合名（默认 bench_<时间戳>）
  --profile <dir>        user-data-dir 根目录（默认 scripts/.cache/bench-profile；可设 $SEEKVEC_BENCH_PROFILE）
  --browser-path <exe>   浏览器可执行文件（默认 $BROWSER_PATH 或自动探测）
  --timeout <ms>         单步等待超时（默认 300000，即 5 分钟，覆盖首次模型加载）
  --headful              显示浏览器窗口（默认无头）
  --keep                 保留 collection（默认自动 DELETE 清理）
  --check                只做环境自检（浏览器/页面/语料/查询），不跑基准
  --smoke                冒烟模式：runs=1、warmup=0、最多 3 篇语料 + 1 条查询
  --help, -h             显示帮助

环境变量：SEEKVEC_BASE_URL、BROWSER_PATH、SEEKVEC_BENCH_PROFILE。
`;

const DEFAULT_CORPUS = path.join(ROOT, 'data', 'perf', 'corpus');
const DEFAULT_QUERIES = path.join(ROOT, 'data', 'perf', 'queries.txt');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.SEEKVEC_BASE_URL ?? 'http://localhost:5173',
    apiUrl: null,
    backend: 'auto',
    dtype: null,
    batch: null,
    threads: null,
    refresh: null,
    models: null,
    runs: 5,
    warmup: 1,
    cold: false,
    noWebgpu: false,
    out: null,
    corpus: DEFAULT_CORPUS,
    queries: DEFAULT_QUERIES,
    collection: null,
    profile: process.env.SEEKVEC_BENCH_PROFILE ?? null,
    browserPath: process.env.BROWSER_PATH ?? null,
    timeout: 300_000,
    headful: false,
    keep: false,
    check: false,
    smoke: false,
    help: false,
  };
  let i = 0;
  const next = (name) => {
    if (i + 1 >= argv.length) {
      console.error(`[bench-browser] ${name} 缺少取值（--help 查看用法）`);
      process.exit(2);
    }
    i += 1;
    return argv[i];
  };
  const nextInt = (name) => {
    const raw = next(name);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      console.error(`[bench-browser] ${name} 需要非负整数（收到 ${raw}）`);
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
    else if (arg === '--batch') opts.batch = nextInt(arg);
    else if (arg === '--threads') opts.threads = nextInt(arg);
    else if (arg === '--refresh') opts.refresh = next(arg);
    else if (arg === '--models') opts.models = next(arg);
    else if (arg === '--runs') opts.runs = nextInt(arg);
    else if (arg === '--warmup') opts.warmup = nextInt(arg);
    else if (arg === '--cold') opts.cold = true;
    else if (arg === '--no-webgpu') opts.noWebgpu = true;
    else if (arg === '--out') opts.out = next(arg);
    else if (arg === '--corpus') opts.corpus = path.resolve(next(arg));
    else if (arg === '--queries') opts.queries = path.resolve(next(arg));
    else if (arg === '--collection') opts.collection = next(arg);
    else if (arg === '--profile') opts.profile = path.resolve(next(arg));
    else if (arg === '--browser-path') opts.browserPath = path.resolve(next(arg));
    else if (arg === '--timeout') opts.timeout = nextInt(arg);
    else if (arg === '--headful') opts.headful = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--smoke') opts.smoke = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else {
      console.error(`[bench-browser] 未知参数：${arg}（--help 查看用法）`);
      process.exit(2);
    }
    i += 1;
  }

  if (!['auto', 'webgpu', 'wasm'].includes(opts.backend)) {
    console.error(`[bench-browser] --backend 只能是 auto|webgpu|wasm（收到 ${opts.backend}）`);
    process.exit(2);
  }
  if (opts.dtype && !['q8', 'fp16', 'fp32'].includes(opts.dtype)) {
    console.error(`[bench-browser] --dtype 只能是 q8|fp16|fp32（收到 ${opts.dtype}）`);
    process.exit(2);
  }
  if (opts.refresh && !['last', 'each'].includes(opts.refresh)) {
    console.error(`[bench-browser] --refresh 只能是 last|each（收到 ${opts.refresh}）`);
    process.exit(2);
  }
  if (opts.models && !['auto', 'remote', 'local'].includes(opts.models)) {
    console.error(`[bench-browser] --models 只能是 auto|remote|local（收到 ${opts.models}）`);
    process.exit(2);
  }
  if (opts.batch != null && (opts.batch < 1 || opts.batch > 64)) {
    console.error('[bench-browser] --batch 需在 1..64');
    process.exit(2);
  }
  if (opts.smoke) {
    opts.runs = 1;
    opts.warmup = 0;
  }
  if (opts.runs < 1) {
    console.error('[bench-browser] --runs 至少为 1');
    process.exit(2);
  }
  opts.runs = Math.min(opts.runs, 50);
  opts.warmup = Math.min(opts.warmup, 20);
  opts.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  opts.apiUrl = (opts.apiUrl ?? opts.baseUrl).replace(/\/+$/, '');
  opts.timeout = Math.max(30_000, Math.min(opts.timeout, 30 * 60 * 1000));
  return opts;
}

// ---------------------------------------------------------------------------
// 浏览器路径探测（不写死用户名）
// ---------------------------------------------------------------------------

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
    const chromiumDirs = entries
      .filter((e) => e.isDirectory() && /^chromium-\d+$/.test(e.name))
      .map((e) => ({ name: e.name, version: Number(e.name.split('-')[1]) }))
      .sort((a, b) => b.version - a.version);
    for (const { name } of chromiumDirs) {
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
  const win = process.platform === 'win32';
  const darwin = process.platform === 'darwin';
  if (win) {
    const programDirs = [process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)']].filter(Boolean);
    for (const dir of programDirs) {
      candidates.push(path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (darwin) {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  }
  candidates.push(...playwrightChromiumCandidates());
  return candidates;
}

const BROWSER_CACHE_FILE = path.join(ROOT, 'scripts', '.cache', 'bench-browser.json');
const DEFAULT_PROFILE_ROOT = path.join(ROOT, 'scripts', '.cache', 'bench-profile');

function isExecutableFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 上次成功启动的浏览器路径（多个矩阵条目连续运行时避免反复探测失败的候选） */
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
    // 缓存失败不影响基准
  }
}

/**
 * 收集所有**存在**的候选浏览器（显式路径优先，其次上次成功缓存，最后自动探测）。
 * 不在这里启动，启动失败时由 launchWithFallback 逐个回退（如部分环境下 Edge 启动失败，
 * 可回退到 Playwright 缓存里的 Chromium）。
 */
function existingBrowserCandidates(explicit) {
  const checked = [];
  /** @type {Array<{path:string, source:string}>} */
  const candidates = [];
  const push = (candidatePath, source) => {
    if (!candidatePath) return;
    checked.push(candidatePath);
    if (!isExecutableFile(candidatePath)) return;
    if (candidates.some((c) => c.path === candidatePath)) return;
    candidates.push({ path: candidatePath, source });
  };
  if (explicit) {
    push(explicit, '--browser-path / BROWSER_PATH');
  } else {
    push(readPreferredBrowserPath(), '上次成功（缓存）');
  }
  for (const candidate of browserCandidates()) push(candidate, '自动探测');
  return { candidates, checked };
}

function sanitizeProfileName(browserPath) {
  return path.basename(browserPath).replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * 依次尝试候选浏览器，直到成功启动；返回 {browser, used, errors}。
 * 每个浏览器使用独立的 user-data-dir（默认 scripts/.cache/bench-profile/profile-<浏览器名>），
 * 避免不同浏览器共用 Playwright/Chrome profile 导致的启动崩溃。
 */
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
      // 注意：不要加 --disable-gpu —— WebGPU 后端需要真实 GPU 进程。
      // --no-webgpu 用于验收「WebGPU 不可用」路径，与正常基准互斥。
      ...(opts.noWebgpu ? ['--disable-gpu', '--disable-features=WebGPU,Vulkan'] : []),
      `--disk-cache-dir=${path.join(userDataDir, 'disk-cache')}`,
    ];
    try {
      const browser = await puppeteer.launch({
        executablePath: candidate.path,
        headless: !opts.headful,
        userDataDir,
        args,
        defaultViewport: { width: 1440, height: 1000 },
        protocolTimeout: Math.max(120_000, opts.timeout * 2),
      });
      rememberBrowserPath(candidate.path);
      return { browser, used: candidate, errors, userDataDir, launchArgs: args };
    } catch (err) {
      const message = String(err?.message ?? err).split(/\r?\n/).filter(Boolean)[0]?.slice(0, 200) ?? '未知错误';
      errors.push({ path: candidate.path, error: message });
      console.warn(`[bench-browser] ⚠ 浏览器启动失败，回退下一个候选：${candidate.path}（${message}）`);
    }
  }
  console.error('[bench-browser] ✗ 所有候选浏览器均启动失败：');
  for (const e of errors) console.error(`  - ${e.path}：${e.error}`);
  console.error(
    '  处理建议：设置 BROWSER_PATH 指向可用的 Chrome/Edge/Chromium；\n' +
      '  或安装 Playwright 浏览器缓存（脚本会自动探测 %LOCALAPPDATA%/ms-playwright/chromium-*）；\n' +
      '  注意不要使用 --disable-gpu 运行 WebGPU 基准。',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 语料 / 查询加载
// ---------------------------------------------------------------------------

function walkFiles(dir, predicate) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, predicate));
    else if (predicate(full)) out.push(full);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** @returns {Array<{name:string, content:string}>} */
function loadCorpus(corpusPath) {
  if (!fs.existsSync(corpusPath)) {
    console.error(
      `[bench-browser] ✗ 语料不存在：${corpusPath}\n` +
        '  默认期望 data/perf/corpus/（由 data/eval 工作流生成）；也可用 --corpus 指定目录或文件。',
    );
    process.exit(1);
  }
  const stat = fs.statSync(corpusPath);
  const paths = stat.isDirectory()
    ? walkFiles(corpusPath, (p) => /\.(md|txt|jsonl)$/i.test(p)).filter((p) => !path.basename(p).startsWith('queries'))
    : [corpusPath];

  const docs = [];
  for (const file of paths) {
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, 'utf8');
    if (/\.jsonl$/i.test(file)) {
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i += 1) {
        let obj;
        try {
          obj = JSON.parse(lines[i]);
        } catch {
          console.warn(`[bench-browser] ⚠ ${rel}:${i + 1} 不是合法 JSONL，已跳过`);
          continue;
        }
        const content = obj.content ?? obj.text ?? obj.body ?? obj.doc;
        if (typeof content !== 'string' || content.trim().length === 0) continue;
        const name = String(obj.source ?? obj.id ?? `${path.basename(file, '.jsonl')}-${i}`);
        docs.push({ name: name.endsWith('.md') ? name : `${name}.md`, content });
      }
    } else {
      if (text.trim().length === 0) continue;
      docs.push({ name: rel.replace(/\\/g, '/'), content: text });
    }
  }
  if (docs.length === 0) {
    console.error(`[bench-browser] ✗ 语料目录中没有可用文档：${corpusPath}`);
    process.exit(1);
  }
  return docs;
}

/** @returns {string[]} */
function loadQueries(queriesPath) {
  if (!fs.existsSync(queriesPath)) {
    console.error(
      `[bench-browser] ✗ 查询文件不存在：${queriesPath}\n` +
        '  默认期望 data/perf/queries.txt（每行一条）；也可用 --queries 指定。',
    );
    process.exit(1);
  }
  const lines = fs
    .readFileSync(queriesPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length === 0) {
    console.error(`[bench-browser] ✗ 查询文件为空：${queriesPath}`);
    process.exit(1);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

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
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmt(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function timestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** seekdb 集合名约束：^[A-Za-z0-9_-]{1,64}$（server 校验只允许字母/数字/下划线；统一转下划线） */
function sanitizeCollectionName(name, fallback) {
  const raw = String(name ?? '').trim();
  const sanitized = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '').slice(0, 64);
  const result = sanitized || fallback;
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs ?? 5000) });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // 保留 text 供调用方判断
  }
  return { status: res.status, ok: res.ok, body, text };
}

// ---------------------------------------------------------------------------
// Perf summary 归一化
// 兼容契约形状 { schemaVersion, runId, count, phases: { [phase]: {n,p50,p95,mean} } }，
// 以及 {phases:[...]} / 数组 / 直接 map 等变体。
// ---------------------------------------------------------------------------

function normalizePhaseSummary(raw) {
  const out = {};
  const takePhase = (phase, value) => {
    if (!phase || !value || typeof value !== 'object') return;
    const p50 = value.p50 ?? value.median;
    if (!Number.isFinite(p50)) return;
    out[phase] = {
      n: Number.isFinite(value.n) ? value.n : Number.isFinite(value.count) ? value.count : undefined,
      p50,
      p95: Number.isFinite(value.p95) ? value.p95 : undefined,
      mean: Number.isFinite(value.mean) ? value.mean : undefined,
    };
  };
  const takeItem = (item) => {
    if (!item || typeof item !== 'object') return;
    takePhase(item.phase ?? item.name ?? item.key, item);
  };
  if (Array.isArray(raw)) raw.forEach(takeItem);
  else if (Array.isArray(raw?.phases)) raw.phases.forEach(takeItem);
  else if (raw && typeof raw === 'object') {
    // 契约形状：phases 是 { [phase]: PhaseSummary } 映射
    if (raw.phases && typeof raw.phases === 'object' && !Array.isArray(raw.phases)) {
      for (const [phase, value] of Object.entries(raw.phases)) takePhase(phase, value);
      if (Object.keys(out).length > 0) return out;
    }
    for (const [phase, value] of Object.entries(raw)) {
      if (value && typeof value === 'object') takePhase(phase, value);
    }
  }
  return out;
}

/** 兜底：summary() 形状未知或为空时，直接从快照事件聚合（与契约口径一致） */
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
      p50: round(quantile(values, 0.5)),
      p95: round(quantile(values, 0.95)),
      mean: round(values.reduce((a, b) => a + b, 0) / values.length),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 页面驱动
// ---------------------------------------------------------------------------

function buildPageUrl(opts) {
  const url = new URL(opts.baseUrl);
  const params = url.searchParams;
  params.set('perf', '1');
  if (opts.backend) params.set('backend', opts.backend);
  if (opts.dtype) params.set('dtype', opts.dtype);
  if (opts.batch != null) params.set('batch', String(opts.batch));
  if (opts.threads != null) params.set('threads', String(opts.threads));
  if (opts.refresh) params.set('refresh', opts.refresh);
  if (opts.models) params.set('models', opts.models);
  params.set('collection', opts.collection);
  return url.toString();
}

async function waitForAppReady(page, timeout) {
  await page.waitForFunction(
    () => {
      const w = /** @type {any} */ (window);
      const hasPerf = !!(w.__seekvecPerf && typeof w.__seekvecPerf.snapshot === 'function');
      const hasEval = !!(w.__seekvecEval && typeof w.__seekvecEval.ingestFiles === 'function');
      const hasFileInput = !!document.querySelector('input[type="file"]');
      return (hasPerf && hasEval) || hasFileInput || document.body.innerText.includes('模型加载');
    },
    { timeout, polling: 500 },
  );
  return page.evaluate(() => {
    const w = /** @type {any} */ (window);
    return {
      perf: !!(w.__seekvecPerf && typeof w.__seekvecPerf.snapshot === 'function'),
      eval: !!(w.__seekvecEval && typeof w.__seekvecEval.ingestFiles === 'function'),
      fileInput: !!document.querySelector('input[type="file"]'),
    };
  });
}

/** 等待 UI 侧模型加载完成（导入按钮可用） */
async function waitForUiModelReady(page, timeout) {
  await page.waitForFunction(
    () => {
      const input = /** @type {HTMLInputElement|null} */ (document.querySelector('input[type="file"]'));
      if (input && !input.disabled) return true;
      return [...document.querySelectorAll('button')].some(
        (b) => !/** @type {HTMLButtonElement} */ (b).disabled && /选择文件|导入|选择/.test(b.textContent ?? ''),
      );
    },
    { timeout, polling: 1000 },
  );
}

async function clearBrowserState(page) {
  try {
    const client = await page.createCDPSession();
    await client.send('Network.clearBrowserCache');
    await client.detach();
  } catch {
    // 某些构建不支持 CDP 调用，忽略
  }
  await page.evaluate(async () => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // ignore
    }
    try {
      if (typeof caches !== 'undefined') {
        for (const key of await caches.keys()) await caches.delete(key);
      }
    } catch {
      // ignore
    }
  });
}

async function gotoPage(page, url, timeout) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
}

async function deleteCollection(apiUrl, collectionName) {
  const url = `${apiUrl}/api/collections/${encodeURIComponent(collectionName)}`;
  try {
    const { status } = await fetchJson(url, { method: 'DELETE', timeoutMs: 10000 });
    if (status === 200 || status === 204 || status === 404) {
      return { ok: true, status };
    }
    return { ok: false, status, error: `HTTP ${status}` };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// 单轮执行：eval API 模式
// ---------------------------------------------------------------------------

async function runEvalRound(page, opts, round) {
  if (round.index > 0 || opts.cold) {
    const cleanup = await deleteCollection(opts.apiUrl, opts.collection);
    if (!cleanup.ok) console.warn(`[bench-browser] ⚠ 清理旧 collection 失败：${cleanup.error ?? cleanup.status}`);
  }
  if (opts.cold) {
    await clearBrowserState(page);
    await gotoPage(page, round.url, opts.timeout);
    await waitForAppReady(page, opts.timeout);
    await waitForUiModelReady(page, opts.timeout).catch(() => {});
  }
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__seekvecPerf?.clear?.();
  });
  const startedAt = Date.now();

  // 1) 导入语料（触发 embedding + seekdb 写入）
  const ingest = await page.evaluate(
    async ({ files, collection }) => {
      const w = /** @type {any} */ (window);
      const fileObjects = files.map(
        (f) => new File([f.content], f.name, { type: f.name.endsWith('.md') ? 'text/markdown' : 'text/plain' }),
      );
      const result = await w.__seekvecEval.ingestFiles(fileObjects, collection);
      return result;
    },
    { files: round.corpus, collection: opts.collection },
  );
  const ingestEnd = Date.now();

  // 2) 逐条查询（向量检索 + 直达渲染）
  const queries = [];
  for (const query of round.queries) {
    const queryStartedAt = Date.now();
    const result = await page.evaluate(
      async ({ q }) => {
        const w = /** @type {any} */ (window);
        const res = await w.__seekvecEval.search(q, undefined, 5);
        return {
          e2eMs: res?.e2eMs,
          count: Array.isArray(res?.results) ? res.results.length : res?.count,
          mode: res?.mode,
          latencyMs: res?.latencyMs,
          embeddingMs: res?.embeddingMs,
          httpMs: res?.httpMs,
          dbMs: res?.dbMs,
        };
      },
      { q: query },
    );
    queries.push({ query, wallMs: Date.now() - queryStartedAt, ...result });
  }
  const endedAt = Date.now();

  // 3) 读取 perf 快照与 summary
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

  const ingestTimes = ingest?.times ?? ingest?.timings ?? {};
  const summaryFromApi = normalizePhaseSummary(perf?.summary);
  const summaryFromEvents = summarizeEvents(perf?.snapshot?.events);
  const summary = Object.keys(summaryFromApi).length > 0 ? summaryFromApi : summaryFromEvents;
  return {
    index: round.index,
    warm: round.index >= opts.warmup,
    cold: opts.cold,
    startedAt: new Date(startedAt).toISOString(),
    wallMs: endedAt - startedAt,
    ingest: {
      count: ingest?.count,
      mode: ingest?.mode,
      refreshed: ingest?.refreshed,
      times: ingestTimes,
      wallMs: ingestEnd - startedAt,
    },
    queries,
    perf: {
      summary,
      summarySource: Object.keys(summaryFromApi).length > 0 ? 'api' : 'events',
      summaryRaw: perf?.summary ?? null,
      snapshot: perf?.snapshot ?? null,
    },
    errors: perf?.error ? [perf.error] : [],
  };
}

// ---------------------------------------------------------------------------
// 单轮执行：UI 兜底模式（__seekvecEval 不存在时）
// ---------------------------------------------------------------------------

async function runUiRound(page, opts, round, corpusTempDir) {
  if (round.index > 0 || opts.cold) {
    await deleteCollection(opts.apiUrl, opts.collection);
  }
  if (opts.cold) {
    await clearBrowserState(page);
    await gotoPage(page, round.url, opts.timeout);
  }
  await waitForUiModelReady(page, opts.timeout);

  // 把语料拼成一个临时 markdown 文件上传（UI 通常一次导入一个文件）
  const combinedPath = path.join(corpusTempDir, `bench-corpus-r${round.index}.md`);
  const combined = round.corpus.map((f) => `# ${f.name}\n\n${f.content}`).join('\n\n---\n\n');
  fs.writeFileSync(combinedPath, combined, 'utf8');

  const startedAt = Date.now();
  const input = await page.$('input[type="file"]');
  if (!input) throw new Error('UI 兜底失败：找不到文件上传输入框');
  await input.uploadFile(combinedPath);
  await page.waitForFunction(
    () => /完成|成功|导入/.test(document.body.innerText) && !/模型加载中/.test(document.body.innerText),
    { timeout: opts.timeout, polling: 500 },
  );
  const ingestEnd = Date.now();
  const ingestSnippet = await page.evaluate(() => {
    const m = document.body.innerText.match(/(?:完成|成功|导入)[^\n]{0,120}/);
    return (m?.[0] ?? '').replace(/\s+/g, ' ').trim();
  });

  const queries = [];
  for (const query of round.queries) {
    const queryInput = await page.$('input[placeholder*="查询"]');
    if (!queryInput) throw new Error('UI 兜底失败：找不到查询输入框');
    await queryInput.click({ clickCount: 3 });
    await page.keyboard.press('Control+A');
    await queryInput.type(query);
    const queryStartedAt = Date.now();
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => /条结果|暂无结果|未找到/.test(document.body.innerText),
      { timeout: opts.timeout, polling: 300 },
    );
    // 等待渲染稳定（双 rAF 后一帧）
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const text = await page.evaluate(() => document.body.innerText);
    const latency = text.match(/(\d+)\s*条结果\s*[·•]\s*(\d+)\s*ms/);
    queries.push({
      query,
      wallMs: Date.now() - queryStartedAt,
      count: latency ? Number(latency[1]) : undefined,
      e2eMs: latency ? Number(latency[2]) : undefined,
      uiOnly: true,
    });
  }
  return {
    index: round.index,
    warm: round.index >= opts.warmup,
    cold: opts.cold,
    startedAt: new Date(startedAt).toISOString(),
    wallMs: Date.now() - startedAt,
    ingest: { wallMs: ingestEnd - startedAt, uiSnippet: ingestSnippet },
    queries,
    perf: { summary: {}, snapshot: null },
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// 聚合 + 输出
// ---------------------------------------------------------------------------

function aggregate(measuredRuns) {
  const phases = new Set();
  for (const run of measuredRuns) for (const phase of Object.keys(run.perf.summary)) phases.add(phase);
  const phaseRows = [];
  for (const phase of [...phases].sort()) {
    const p50s = measuredRuns.map((r) => r.perf.summary[phase]?.p50).filter(Number.isFinite);
    const p95s = measuredRuns.map((r) => r.perf.summary[phase]?.p95).filter(Number.isFinite);
    const means = measuredRuns.map((r) => r.perf.summary[phase]?.mean).filter(Number.isFinite);
    const ns = measuredRuns.map((r) => r.perf.summary[phase]?.n).filter(Number.isFinite);
    if (p50s.length === 0) continue;
    phaseRows.push({
      phase,
      runs: p50s.length,
      n: ns.length ? Math.round(ns.reduce((a, b) => a + b, 0) / ns.length) : null,
      p50: round(median(p50s)),
      p50Iqr: round(iqr(p50s)),
      p95: round(median(p95s)),
      mean: round(median(means)),
    });
  }

  const e2eValues = measuredRuns.flatMap((r) => r.queries.map((q) => q.e2eMs)).filter(Number.isFinite);
  const queryRows = measuredRuns.map((r) => {
    const e2e = r.queries.map((q) => q.e2eMs).filter(Number.isFinite);
    return {
      index: r.index,
      count: r.queries.length,
      e2eP50: round(median(e2e)),
      e2eP95: round(quantile(e2e, 0.95)),
      wallMean: round(r.queries.reduce((sum, q) => sum + (q.wallMs ?? 0), 0) / Math.max(1, r.queries.length)),
    };
  });
  const ingestRows = measuredRuns.map((r) => {
    const t = r.ingest?.times ?? {};
    return {
      index: r.index,
      count: r.ingest?.count,
      // 契约字段 upsertMs；web eval API 返回更细的 writeMs/embedMs 等，做兼容
      upsertMs: round(t.upsertMs ?? t.writeMs),
      readMs: round(t.readMs),
      chunkMs: round(t.chunkMs),
      embedMs: round(t.embedMs),
      writeMs: round(t.writeMs),
      refreshMs: round(t.refreshMs),
      cleanupMs: round(t.cleanupMs),
      totalMs: round(t.totalMs),
      wallMs: round(r.ingest?.wallMs),
    };
  });
  const ingestTotals = ingestRows.map((r) => r.wallMs).filter(Number.isFinite);
  return {
    runs: measuredRuns.length,
    summarySource: measuredRuns.every((r) => r.perf.summarySource === 'api') ? 'api' : 'events',
    phases: phaseRows,
    ingest: {
      rows: ingestRows,
      wallP50: round(median(ingestTotals)),
      wallP50Iqr: round(iqr(ingestTotals)),
    },
    query: {
      rows: queryRows,
      e2eP50: round(median(e2eValues)),
      e2eP95: round(quantile(e2eValues, 0.95)),
      e2eCount: e2eValues.length,
    },
  };
}

function buildSummaryMarkdown({ opts, browserInfo, env, corpus, queries, runs, aggregateResult, outPath, mode }) {
  const lines = [];
  lines.push(`# 浏览器基准 · ${path.basename(outPath)}`);
  lines.push('');
  lines.push(`- 时间：${new Date().toISOString()}`);
  lines.push(`- 页面：${opts.baseUrl}（?perf=1）`);
  lines.push(`- 驱动模式：${mode === 'eval' ? '`window.__seekvecEval`（契约 perf API）' : 'UI 兜底（perf API 未实现）'}`);
  lines.push(`- 浏览器：${browserInfo.browserVersion ?? '未知'}（${browserInfo.executablePath}）`);
  lines.push(`- 后端：${opts.backend}${opts.dtype ? ` · dtype=${opts.dtype}` : ' · dtype=页面默认'}${opts.batch != null ? ` · batch=${opts.batch}` : ''}${opts.threads != null ? ` · threads=${opts.threads}` : ''}${opts.refresh ? ` · refresh=${opts.refresh}` : ''}`);
  lines.push(`- 冷/热：${opts.cold ? 'cold（每轮清缓存重载）' : 'warm start'}；计入统计 ${runs.measured.length} 轮（预热 ${runs.warmup.length} 轮已丢弃）`);
  lines.push(`- 语料：${corpus.length} 篇；查询：${queries.length} 条；collection：\`${opts.collection}\``);
  if (env) {
    lines.push(
      `- 环境：${env.platform ?? '?'} · ${env.hardwareConcurrency ?? '?'} 核 · deviceMemory=${env.deviceMemory ?? '?'}GB · GPU=${env.gpuAdapter ?? '未知'} · 实测后端=${env.backend ?? '?'}${env.backendReason ? `（${env.backendReason}）` : ''}`,
    );
    if (env.model) lines.push(`- 模型：${env.model.id ?? '?'} @ ${String(env.model.revision ?? '').slice(0, 12)} · dtype=${env.model.dtype ?? '?'} · key=${env.model.key ?? '?'}`);
    if (env.effectiveConfig) lines.push(`- 生效配置：batch=${env.effectiveConfig.batch ?? '?'} · threads=${env.effectiveConfig.threads ?? '?'} · refresh=${env.effectiveConfig.refresh ?? '?'}`);
  }
  lines.push('');
  if (mode === 'eval') {
    lines.push('## 阶段耗时（ms）');
    lines.push('');
    lines.push('| 阶段 | 轮数 | n | p50 | p95 | mean | p50 IQR |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const row of aggregateResult.phases) {
      lines.push(`| ${row.phase} | ${row.runs} | ${row.n ?? '—'} | ${fmt(row.p50)} | ${fmt(row.p95)} | ${fmt(row.mean)} | ${fmt(row.p50Iqr)} |`);
    }
    if (aggregateResult.phases.length === 0) lines.push('| （无 perf 事件） | — | — | — | — | — | — |');
    lines.push('');
    lines.push('## 导入（每轮）');
    lines.push('');
    lines.push('| run | count | readMs | chunkMs | embedMs | writeMs/upsertMs | refreshMs | cleanupMs | totalMs | wallMs |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const row of aggregateResult.ingest.rows) {
      lines.push(
        `| ${row.index} | ${row.count ?? '—'} | ${fmt(row.readMs)} | ${fmt(row.chunkMs)} | ${fmt(row.embedMs)} | ${fmt(row.upsertMs)} | ` +
          `${fmt(row.refreshMs)} | ${fmt(row.cleanupMs)} | ${fmt(row.totalMs)} | ${fmt(row.wallMs)} |`,
      );
    }
    lines.push(`\n导入 wall 中位数：${fmt(aggregateResult.ingest.wallP50)} ms（IQR ${fmt(aggregateResult.ingest.wallP50Iqr)} ms）`);
    lines.push('');
  }
  lines.push('## 查询（每轮）');
  lines.push('');
  lines.push('| run | 查询数 | e2e p50 (ms) | e2e p95 (ms) | 平均 wall (ms) |');
  lines.push('|---|---|---|---|---|');
  for (const row of aggregateResult.query.rows) {
    lines.push(`| ${row.index} | ${row.count} | ${fmt(row.e2eP50)} | ${fmt(row.e2eP95)} | ${fmt(row.wallMean)} |`);
  }
  lines.push('');
  lines.push(`查询 e2e 中位数：${fmt(aggregateResult.query.e2eP50)} ms（p95 ${fmt(aggregateResult.query.e2eP95)} ms，样本 ${aggregateResult.query.e2eCount}）`);
  lines.push('');
  lines.push('## 说明');
  lines.push('');
  lines.push('- 每轮先清空 `__seekvecPerf` 事件再执行；预热轮不计入统计（首轮含模型加载）。');
  lines.push('- 阶段指标为各轮内 p50 跨轮的中位数；IQR = Q3−Q1，反映轮间波动。');
  if (mode === 'eval' && aggregateResult.summarySource === 'events') {
    lines.push('- 阶段数据来源：`summary()` 形状未识别，已直接从 snapshot 事件聚合（统计口径一致）。');
  }
  lines.push('- 原始数据（含全部 perf 事件）见同目录 `raw.json`。');
  lines.push('- 生成命令见 raw.json 的 `command` 字段；重跑请使用相同参数与语料。');
  if (mode !== 'eval') {
    lines.push('- ⚠ 当前为 UI 兜底模式：仅能解析界面显示的端到端耗时，缺少分阶段 perf 数据；以 eval 模式数据为准。');
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const runId = `browser-${opts.backend}${opts.dtype ? `-${opts.dtype}` : ''}-${timestamp()}`;
  const outDir = path.resolve(opts.out ?? path.join(ROOT, 'docs', 'benchmarks', runId));
  const requestedCollection = opts.collection ?? `bench_${timestamp().replace(/[-:]/g, '')}`;
  opts.collection = sanitizeCollectionName(requestedCollection, `bench_${Date.now()}`);
  if (opts.collection !== requestedCollection) {
    console.warn(`[bench-browser] ⚠ collection 名 ${requestedCollection} 不符合 seekdb 约束，已规范化为 ${opts.collection}`);
  }

  console.log('[bench-browser] SeekVec 浏览器基准');
  console.log(`  base-url   : ${opts.baseUrl}`);
  console.log(`  backend    : ${opts.backend}${opts.dtype ? ` · dtype=${opts.dtype}` : ''}`);
  console.log(`  runs/warmup: ${opts.runs} / ${opts.warmup}${opts.cold ? ' （cold）' : ''}`);
  console.log(`  collection : ${opts.collection}`);
  console.log(`  out        : ${path.relative(ROOT, outDir) || outDir}`);

  // 浏览器候选（实际启动在 --check / 正式基准时进行，失败会自动回退下一个候选）
  const { candidates, checked } = existingBrowserCandidates(opts.browserPath);
  if (candidates.length === 0) {
    console.error(
      '[bench-browser] ✗ 未找到可用的 Chrome/Edge/Chromium。\n' +
        '  安装 Chrome，或设置 BROWSER_PATH 指向可执行文件，例如：\n' +
        '    $env:BROWSER_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"\n' +
        `  已检查 ${checked.length} 个路径：\n    ${checked.join('\n    ')}`,
    );
    process.exit(1);
  }
  console.log(`  浏览器候选 : ${candidates.length} 个（首个：${candidates[0].path}）`);

  // 语料 / 查询
  const corpusAll = loadCorpus(opts.corpus);
  const queriesAll = loadQueries(opts.queries);
  const maxCorpus = opts.smoke ? 3 : corpusAll.length;
  const maxQueries = opts.smoke ? 1 : queriesAll.length;
  const corpus = corpusAll.slice(0, maxCorpus);
  const queries = queriesAll.slice(0, maxQueries);
  console.log(`  语料       : ${corpus.length} 篇（共 ${corpusAll.length}）`);
  console.log(`  查询       : ${queries.length} 条（共 ${queriesAll.length}）`);

  // dev server 可达性（经页面地址）
  let serverReachable = false;
  try {
    const { ok } = await fetchJson(`${opts.baseUrl}/`, { timeoutMs: 8000 });
    serverReachable = ok;
  } catch (err) {
    console.error(`\n[bench-browser] ✗ 页面不可达：${opts.baseUrl}（${err.message}）\n  请先启动 dev server：npm run dev（或 npm run dev:web）。`);
  }
  if (!serverReachable) process.exit(1);

  // --check：只做环境自检（含一次真实浏览器启动，验证候选可用）
  if (opts.check) {
    console.log('\n[bench-browser] --check 环境自检');
    console.log('  PASS 页面可达');
    console.log(`  PASS 语料可读（${corpusAll.length} 篇）`);
    console.log(`  PASS 查询可读（${queriesAll.length} 条）`);
    console.log(`  PASS 输出目录（将写入 ${path.relative(ROOT, outDir) || outDir}）`);
    const { default: puppeteerForCheck } = await import('puppeteer-core');
    const probe = await launchWithFallback(puppeteerForCheck, candidates, { ...opts, headful: false });
    const version = await probe.browser.version();
    await probe.browser.close();
    console.log(`  PASS 浏览器启动成功：${probe.used.path}`);
    console.log(`       版本 ${version}；user-data-dir ${probe.userDataDir}`);
    if (probe.errors.length > 0) {
      console.log(`  WARN 有 ${probe.errors.length} 个候选启动失败（已回退）：`);
      for (const e of probe.errors) console.log(`       - ${e.path}：${e.error}`);
    }
    console.log('\n[bench-browser] ✓ --check PASS（去掉 --check 运行正式基准）');
    return;
  }

  const { default: puppeteer } = await import('puppeteer-core');
  console.log('[bench-browser] 启动浏览器 ...');
  const launched = await launchWithFallback(puppeteer, candidates, opts);
  const usedBrowser = launched.used;
  const puppeteerBrowser = launched.browser;
  console.log(`[bench-browser] 浏览器：${usedBrowser.path}（${usedBrowser.source}）`);
  if (launched.errors.length > 0) {
    console.log(`[bench-browser] 已回退 ${launched.errors.length} 个启动失败的候选：${launched.errors.map((e) => path.basename(e.path)).join(', ')}`);
  }

  const consoleLogs = [];
  const pageErrors = [];
  const requestFailures = [];
  let mode = 'ui';
  let page = null;

  try {
    page = await puppeteerBrowser.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') consoleLogs.push(`[console.${msg.type()}] ${msg.text()}`.slice(0, 400));
    });
    page.on('pageerror', (err) => pageErrors.push(String(err.message ?? err).slice(0, 400)));
    page.on('requestfailed', (req) => {
      const failure = req.failure()?.errorText ?? '';
      if (!/net::ERR_ABORTED/.test(failure)) requestFailures.push(`${req.url().slice(0, 160)} ${failure}`.slice(0, 220));
    });

    const pageUrl = buildPageUrl(opts);
    console.log(`[bench-browser] 打开 ${pageUrl}`);
    await gotoPage(page, pageUrl, opts.timeout);
    const caps = await waitForAppReady(page, opts.timeout);
    mode = caps.perf && caps.eval ? 'eval' : 'ui';
    console.log(`[bench-browser] 驱动模式：${mode === 'eval' ? 'perf/eval API' : 'UI 兜底（未检测到 window.__seekvecEval）'}`);

    // UI 兜底模式需要先把模型加载完
    if (mode === 'ui') {
      console.log('[bench-browser] 等待模型加载完成（UI）...');
      await waitForUiModelReady(page, opts.timeout);
    }

    const browserVersion = await puppeteerBrowser.version();
    console.log(`[bench-browser] 浏览器版本：${browserVersion}`);

    // 语料临时目录（UI 兜底上传用）
    fs.mkdirSync(outDir, { recursive: true });
    const corpusTempDir = path.join(outDir, '_corpus-tmp');
    fs.mkdirSync(corpusTempDir, { recursive: true });

    const totalRounds = opts.warmup + opts.runs;
    const runs = [];
    for (let index = 0; index < totalRounds; index += 1) {
      const round = { index, url: pageUrl, corpus, queries };
      const isWarmup = index < opts.warmup;
      console.log(`[bench-browser] 轮次 ${index + 1}/${totalRounds}${isWarmup ? '（预热）' : ''} ...`);
      const started = Date.now();
      const result = mode === 'eval' ? await runEvalRound(page, opts, round) : await runUiRound(page, opts, round, corpusTempDir);
      result.durationMs = Date.now() - started;
      runs.push(result);
      const queryStats = result.queries.map((q) => q.e2eMs).filter(Number.isFinite);
      console.log(
        `  完成 ${result.durationMs}ms · ingest count=${result.ingest?.count ?? '?'} · e2e p50=${fmt(median(queryStats))}ms`,
      );
    }

    // 聚合（仅正式轮）
    const measured = runs.filter((r) => r.warm);
    const aggregateResult = aggregate(measured);

    // 环境信息（优先取第一轮 snapshot.env）
    const firstSnapshot = runs.find((r) => r.perf?.snapshot)?.perf.snapshot ?? null;
    const env = firstSnapshot?.env ?? null;
    const perfEnv = env
      ? {
          ua: env.ua,
          platform: env.platform ?? process.platform,
          hardwareConcurrency: env.hardwareConcurrency,
          deviceMemory: env.deviceMemory,
          gpuAdapter: env.gpuAdapter,
          backend: env.backend,
          backendReason: env.backendReason,
          model: env.model,
          effectiveConfig: firstSnapshot?.config ?? null,
        }
      : null;

    const command = ['node', 'scripts/bench-browser.mjs', ...process.argv.slice(2)].join(' ');
    const raw = {
      schemaVersion: 1,
      tool: 'scripts/bench-browser.mjs',
      runId,
      generatedAt: new Date().toISOString(),
      command,
      mode,
      config: {
        baseUrl: opts.baseUrl,
        apiUrl: opts.apiUrl,
        backend: opts.backend,
        dtype: opts.dtype,
        batch: opts.batch,
        refresh: opts.refresh,
        models: opts.models,
        runs: opts.runs,
        warmup: opts.warmup,
        cold: opts.cold,
        out: path.relative(ROOT, outDir) || outDir,
        corpus: path.relative(ROOT, path.resolve(opts.corpus)),
        queries: path.relative(ROOT, path.resolve(opts.queries)),
        collection: opts.collection,
        timeoutMs: opts.timeout,
      },
      browser: { executablePath: usedBrowser.path, source: usedBrowser.source, userDataDir: launched.userDataDir, version: browserVersion },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpus: os.cpus().length,
        totalMemMB: Math.round(os.totalmem() / (1024 * 1024)),
        hostname: os.hostname(),
      },
      page: { perfEnv },
      config: {
        backend: opts.backend,
        dtype: opts.dtype,
        batch: opts.batch,
        threads: opts.threads,
        refresh: opts.refresh,
        cold: opts.cold,
        noWebgpu: opts.noWebgpu,
      },
      corpus: { count: corpus.length, totalChars: corpus.reduce((sum, d) => sum + d.content.length, 0), names: corpus.map((d) => d.name) },
      queries,
      runs,
      aggregate: aggregateResult,
      diagnostics: {
        consoleErrors: consoleLogs.slice(-80),
        pageErrors: pageErrors.slice(-40),
        requestFailures: requestFailures.slice(-40),
      },
    };

    fs.writeFileSync(path.join(outDir, 'raw.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    const summaryMd = buildSummaryMarkdown({
      opts,
      browserInfo: { browserVersion, executablePath: usedBrowser.path },
      env: perfEnv,
      corpus,
      queries,
      runs: { measured, warmup: runs.filter((r) => !r.warm) },
      aggregateResult,
      outPath: outDir,
      mode,
    });
    fs.writeFileSync(path.join(outDir, 'summary.md'), summaryMd, 'utf8');
    console.log(`\n[bench-browser] ✓ 已写入：`);
    console.log(`  ${path.join(path.relative(ROOT, outDir) || outDir, 'raw.json')}`);
    console.log(`  ${path.join(path.relative(ROOT, outDir) || outDir, 'summary.md')}`);

    // 清理
    if (!opts.keep) {
      const cleanup = await deleteCollection(opts.apiUrl, opts.collection);
      if (cleanup.ok) console.log(`[bench-browser] ✓ 已清理 collection：${opts.collection}（HTTP ${cleanup.status}）`);
      else console.warn(`[bench-browser] ⚠ collection 清理失败：${opts.collection}（${cleanup.error ?? cleanup.status}）；请手动 DELETE /api/collections/${opts.collection}`);
    } else {
      console.log(`[bench-browser] --keep：保留 collection ${opts.collection}`);
    }

    if (pageErrors.length > 0) {
      console.warn(`[bench-browser] ⚠ 页面运行中出现 ${pageErrors.length} 个 JS 错误（见 raw.json diagnostics）；基准数据仍已输出。`);
    }

    if (mode === 'ui') {
      console.log('\n[bench-browser] ⚠ UI 兜底模式：缺少 window.__seekvecEval / __seekvecPerf，仅有端到端耗时。');
      console.log('  perf API 实现后（web 工作流）重跑可获得分阶段数据。');
    }
    console.log('\n[bench-browser] ✓ 基准完成');
  } finally {
    await puppeteerBrowser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('\n[bench-browser] ✗ 基准失败：', err?.stack ?? err);
  process.exit(1);
});


