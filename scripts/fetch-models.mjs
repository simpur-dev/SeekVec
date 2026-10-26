#!/usr/bin/env node
/**
 * 模型资产准备 / 校验脚本（可复现的模型锁定）
 *
 * 功能：
 *   1) 读取（不存在则生成）仓库根目录 models.lock.json：两个 embedding 模型的固定
 *      revision、文件清单、大小与 sha256；
 *   2) 把所需文件下载到目标目录（默认 web/public/models，web 以 /models/ 同源提供），
 *      默认 q8 量化 ONNX；支持 fp16 / fp32 / 混合 dtype；
 *   3) 下载前优先校验本地已有文件：大小 + sha256 匹配即跳过下载；
 *   4) 下载后按 sha256 强校验，任何一个文件不符即失败（非零退出）。
 *
 * 用法：
 *   node scripts/fetch-models.mjs                          # q8 → web/public/models
 *   node scripts/fetch-models.mjs --dtype q8,fp16          # prepare:assets 用（q8 + fp16）
 *   node scripts/fetch-models.mjs --dtype all              # q8 + fp16 + fp32
 *   node scripts/fetch-models.mjs --verify                 # 只校验本地文件，不联网
 *   node scripts/fetch-models.mjs --lock-only              # 只生成/刷新 models.lock.json
 *
 * 网络：
 *   --endpoint 默认取 HF_ENDPOINT；未设置时用官方 https://huggingface.co/
 *   国内网络可用镜像：HF_ENDPOINT=https://hf-mirror.com/ 或 --endpoint https://hf-mirror.com/
 *
 * 本地运行资产约定放工作区/D 盘（web/public/models 可指向本地目录的目录联接），不入库。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const DEFAULT_LOCK = path.join(ROOT, 'models.lock.json');
const DEFAULT_OUT = path.join(ROOT, 'web', 'public', 'models');
const DEFAULT_ENDPOINT = 'https://huggingface.co/';
const LOCK_SCHEMA_VERSION = 1;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

/** dtype → 相对模型目录的 ONNX 文件名 */
const DTYPE_FILES = {
  q8: 'onnx/model_quantized.onnx',
  fp16: 'onnx/model_fp16.onnx',
  fp32: 'onnx/model.onnx',
};
/** --dtype 别名 */
const DTYPE_ALIASES = {
  both: ['q8', 'fp16'],
  all: ['q8', 'fp16', 'fp32'],
  quantized: ['q8'],
  int8: ['q8'],
};

/** 每个模型固定要带的非 ONNX 文件（Transformers.js 加载所需） */
const BASE_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
];

/**
 * 内置锁定清单（与实测资产 / HuggingFace LFS 元数据一致）。
 * 仅当 models.lock.json 不存在或损坏时使用；正常运行时以 models.lock.json 为准。
 */
const BUILTIN_MODELS = [
  {
    key: 'text_zh',
    id: 'Xenova/bge-small-zh-v1.5',
    revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781',
    dim: 512,
    license: 'MIT (BAAI/bge-small-zh-v1.5)',
    files: [
      { path: 'config.json', size: 716, sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f' },
      { path: 'tokenizer.json', size: 439125, sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26' },
      { path: 'tokenizer_config.json', size: 367, sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a' },
      { path: 'special_tokens_map.json', size: 125, sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3' },
      {
        path: 'onnx/model_quantized.onnx',
        size: 24010842,
        sha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc',
      },
      {
        path: 'onnx/model_fp16.onnx',
        size: 47497427,
        sha256: '60d0fe5eb8d4e251d4b24dff010a2625c10a013503f0d09f625e8a9b0311315f',
      },
      {
        path: 'onnx/model.onnx',
        size: 94851877,
        sha256: '69a0b846f4f116b5e6aabf9546ea6754d02264f3211a13a1bd69b31b8040749a',
      },
    ],
  },
  {
    key: 'text_en',
    id: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    dim: 384,
    license: 'Apache-2.0 (sentence-transformers/all-MiniLM-L6-v2)',
    files: [
      { path: 'config.json', size: 650, sha256: '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7' },
      { path: 'tokenizer.json', size: 711661, sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0' },
      { path: 'tokenizer_config.json', size: 366, sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3' },
      { path: 'special_tokens_map.json', size: 125, sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3' },
      {
        path: 'onnx/model_quantized.onnx',
        size: 22972370,
        sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
      },
      {
        path: 'onnx/model_fp16.onnx',
        size: 45297825,
        sha256: '2cdb5e58291813b6d6e248ed69010100246821a367fa17b1b81ae9483744533d',
      },
      {
        path: 'onnx/model.onnx',
        size: 90387606,
        sha256: '759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e',
      },
    ],
  },
];

const HELP = `SeekVec · 模型资产准备/校验（models.lock.json）

用法：
  node scripts/fetch-models.mjs [选项]

选项：
  --dtype <q8|fp16|fp32|both|all>[,<...>]  准备哪些 ONNX 精度（默认 q8）
                                           both = q8+fp16；all = q8+fp16+fp32
  --out <dir>          模型根目录（默认 web/public/models）
  --endpoint <url>     下载源（默认 HF_ENDPOINT 或 https://huggingface.co/）
  --model <key|all>    只处理指定模型：text_zh | text_en | all（默认 all）
  --verify             只校验本地文件（大小+sha256），缺失/不符即非零退出；不联网
  --lock-only          只生成/刷新 models.lock.json，不下载
  --lock <file>        lock 文件路径（默认仓库根 models.lock.json）
  --force              即使本地 sha256 匹配也重新下载
  --help, -h           显示帮助

示例：
  npm run prepare:assets                          # = fetch-ort + fetch-models --dtype q8,fp16
  HF_ENDPOINT=https://hf-mirror.com/ node scripts/fetch-models.mjs --dtype all
  node scripts/fetch-models.mjs --verify          # 断网环境校验本地模型完整性
`;

function parseArgs(argv) {
  const opts = {
    dtypes: ['q8'],
    out: DEFAULT_OUT,
    endpoint: null,
    models: 'all',
    verify: false,
    lockOnly: false,
    lockPath: DEFAULT_LOCK,
    force: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dtype') opts.dtypes = parseDtypes(argv[++i] ?? '');
    else if (arg === '--out') opts.out = path.resolve(argv[++i] ?? '');
    else if (arg === '--endpoint') opts.endpoint = argv[++i] ?? '';
    else if (arg === '--model') opts.models = argv[++i] ?? 'all';
    else if (arg === '--verify') opts.verify = true;
    else if (arg === '--lock-only') opts.lockOnly = true;
    else if (arg === '--lock') opts.lockPath = path.resolve(argv[++i] ?? '');
    else if (arg === '--force') opts.force = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else {
      console.error(`[fetch-models] 未知参数：${arg}（--help 查看用法）`);
      process.exit(2);
    }
  }
  return opts;
}

function parseDtypes(raw) {
  const parts = String(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) {
    console.error('[fetch-models] --dtype 不能为空（可选 q8|fp16|fp32|both|all）');
    process.exit(2);
  }
  const out = [];
  for (const part of parts) {
    const values = DTYPE_ALIASES[part] ?? [part];
    for (const v of values) {
      if (!DTYPE_FILES[v]) {
        console.error(`[fetch-models] 未知 dtype：${part}（可选 q8|fp16|fp32|both|all）`);
        process.exit(2);
      }
      if (!out.includes(v)) out.push(v);
    }
  }
  return out;
}

function normalizeEndpoint(endpoint) {
  const base = endpoint || process.env.HF_ENDPOINT || DEFAULT_ENDPOINT;
  return base.endsWith('/') ? base : `${base}/`;
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** @param {string} lockPath */
function readLock(lockPath) {
  if (!fs.existsSync(lockPath)) return null;
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (!lock || !Array.isArray(lock.models) || lock.models.length === 0) {
      throw new Error('缺少 models 数组');
    }
    for (const model of lock.models) {
      if (!model.key || !model.id || !model.revision || !Array.isArray(model.files)) {
        throw new Error(`模型条目字段不完整：${JSON.stringify(model.key ?? model.id ?? '?')}`);
      }
    }
    return lock;
  } catch (err) {
    console.warn(`[fetch-models] ⚠ models.lock.json 无效（${err.message}），改用内置清单并重写。`);
    return null;
  }
}

/** 把内存中的模型清单序列化成 lock 对象（deterministic：保留已有 generatedAt） */
function buildLock(models, previousLock) {
  const normalized = models.map((model) => {
    const files = [...model.files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 ?? null }));
    const totalSizeBytes = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
    return {
      key: model.key,
      id: model.id,
      revision: model.revision,
      dim: model.dim,
      license: model.license,
      repo: `https://huggingface.co/${model.id}`,
      totalSizeBytes,
      files,
    };
  });
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    description:
      'SeekVec 模型资产锁文件：固定 revision 与 sha256，供 scripts/fetch-models.mjs 下载/校验。由脚本生成，请勿手工修改 sha256。',
    generatedBy: 'scripts/fetch-models.mjs',
    generatedAt: previousLock?.generatedAt ?? new Date().toISOString(),
    dtypeToFile: { ...DTYPE_FILES },
    models: normalized,
    totalSizeBytes: normalized.reduce((sum, m) => sum + m.totalSizeBytes, 0),
  };
}

function lockSignature(lock) {
  return JSON.stringify({
    schemaVersion: lock.schemaVersion,
    dtypeToFile: lock.dtypeToFile,
    models: lock.models,
  });
}

/** 仅在内容变化时写回 lock，避免每次运行都产生无意义 diff */
function writeLockIfChanged(lockPath, lock) {
  const previous = readLock(lockPath);
  if (previous && lockSignature(previous) === lockSignature(lock)) {
    return { changed: false };
  }
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return { changed: true };
}

/**
 * 以 lock 为权威来源，补齐内置清单里 lock 可能缺失的文件条目（向后兼容）。
 * @returns {{models: any[], dirty: boolean}}
 */
function resolveModels(lock) {
  const source = lock ?? buildLock(BUILTIN_MODELS, null);
  let dirty = false;
  const models = source.models.map((model) => {
    const builtin = BUILTIN_MODELS.find((m) => m.key === model.key);
    const files = [...model.files];
    const knownPaths = new Set(files.map((f) => f.path));
    // 补齐非 ONNX 基础文件；ONNX 文件以 lock 为准（锁文件决定要准备哪些文件）
    for (const basePath of BASE_FILES) {
      if (!knownPaths.has(basePath)) {
        const fallback = builtin?.files.find((f) => f.path === basePath);
        if (fallback) {
          files.push({ ...fallback });
          dirty = true;
        }
      }
    }
    return { ...model, files };
  });
  return { models, dirty };
}

function selectModels(models, selector) {
  const wanted = String(selector ?? 'all')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (wanted.includes('all') || wanted.length === 0) return models;
  const selected = models.filter((m) => wanted.includes(m.key) || wanted.includes(m.id));
  if (selected.length === 0) {
    console.error(`[fetch-models] --model 未匹配任何模型（可用：${models.map((m) => m.key).join(', ') || 'text_zh, text_en'}）`);
    process.exit(2);
  }
  return selected;
}

function requiredFiles(model, dtypes) {
  const wanted = new Set([...BASE_FILES]);
  for (const dtype of dtypes) wanted.add(DTYPE_FILES[dtype]);
  return model.files.filter((f) => wanted.has(f.path));
}

/** 下载单个文件到内存 hash + 写盘（先 .part 再原子改名） */
async function downloadFile(url, targetPath, expectedSize) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.part`;
  const hash = crypto.createHash('sha256');
  let received = 0;
  let lastLog = 0;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('下载超时')), DOWNLOAD_TIMEOUT_MS);
  let writeStream;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const contentLength = Number(res.headers.get('content-length') ?? 0);
    const total = expectedSize || contentLength || 0;
    if (!res.body) throw new Error('响应体为空');

    writeStream = fs.createWriteStream(tmpPath);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      hash.update(buf);
      received += buf.length;
      if (!writeStream.write(buf)) await once(writeStream, 'drain');
      const now = Date.now();
      if (now - lastLog > 2000) {
        lastLog = now;
        const pct = total ? ` (${((received / total) * 100).toFixed(1)}%)` : '';
        process.stdout.write(`\r    下载中 ${humanSize(received)}${pct} ...   `);
      }
    }
    await new Promise((resolve, reject) => {
      writeStream.end((err) => (err ? reject(err) : resolve()));
    });
    if (lastLog > 0) process.stdout.write('\r');
    if (expectedSize && received !== expectedSize) {
      throw new Error(`大小不符：期望 ${expectedSize}，实际 ${received}`);
    }
    return { sha256: hash.digest('hex'), size: received };
  } finally {
    clearTimeout(timer);
    if (writeStream && !writeStream.closed) {
      writeStream.destroy();
    }
  }
}

/**
 * 处理单个文件：本地校验 → 命中跳过 / 缺失/损坏则下载。
 * @returns {Promise<{status:'ok'|'download'|'fail', sha256?:string, size?:number, message?:string}>}
 */
async function ensureFile(model, file, opts, endpoint) {
  const target = path.join(opts.out, model.id, file.path);
  const exists = fs.existsSync(target);
  const expectedSha = file.sha256 ?? null;

  if (exists && !opts.force) {
    const size = fs.statSync(target).size;
    if (!file.size || size === file.size) {
      const actualSha = await sha256File(target);
      if (!expectedSha || actualSha === expectedSha) {
        return { status: 'ok', sha256: actualSha, size };
      }
      if (opts.verify) {
        return {
          status: 'fail',
          sha256: actualSha,
          size,
          message: `sha256 不匹配（期望 ${expectedSha.slice(0, 16)}…，实际 ${actualSha.slice(0, 16)}…）`,
        };
      }
      console.warn(`[fetch-models] ⚠ ${file.path} sha256 不匹配，重新下载`);
    } else if (opts.verify) {
      return {
        status: 'fail',
        size,
        message: `大小不符（期望 ${file.size}，实际 ${size}）`,
      };
    } else {
      console.warn(`[fetch-models] ⚠ ${file.path} 大小不符（期望 ${file.size}，实际 ${size}），重新下载`);
    }
  } else if (!exists && opts.verify) {
    return { status: 'fail', message: '文件缺失' };
  }

  if (opts.verify) {
    return { status: 'fail', message: '文件缺失' };
  }

  const url = `${endpoint}${model.id}/resolve/${model.revision}/${file.path}`;
  console.log(`[fetch-models] ↓ ${model.id}/${file.path}`);
  console.log(`    ${url}`);
  try {
    const result = await downloadFile(url, target, file.size ?? 0);
    if (expectedSha && result.sha256 !== expectedSha) {
      fs.rmSync(target, { force: true });
      return {
        status: 'fail',
        sha256: result.sha256,
        size: result.size,
        message: `下载后 sha256 校验失败（期望 ${expectedSha.slice(0, 16)}…，实际 ${result.sha256.slice(0, 16)}…）`,
      };
    }
    fs.renameSync(`${target}.part`, target);
    return { status: 'download', sha256: result.sha256, size: result.size };
  } catch (err) {
    fs.rmSync(`${target}.part`, { force: true });
    return { status: 'fail', message: err.message };
  }
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const endpoint = normalizeEndpoint(opts.endpoint);
  const lock = readLock(opts.lockPath);
  const { models, dirty: lockMissingEntries } = resolveModels(lock);
  let lockDirty = !lock || lockMissingEntries;

  // 用内置清单补齐 lock 中缺失的 sha256 / size（例如手写 lock 的情况）
  for (const model of models) {
    for (const file of model.files) {
      const builtin = BUILTIN_MODELS.find((m) => m.key === model.key)?.files.find((f) => f.path === file.path);
      if (builtin) {
        if (file.size == null) {
          file.size = builtin.size;
          lockDirty = true;
        }
        if (!file.sha256) {
          file.sha256 = builtin.sha256;
          lockDirty = true;
        }
      }
    }
  }

  const selectedModels = selectModels(models, opts.models);
  const lockObject = buildLock(models, lock);

  console.log('[fetch-models] SeekVec 模型资产');
  console.log(`  lock 文件：${path.relative(ROOT, opts.lockPath) || opts.lockPath}`);
  console.log(`  目标目录：${opts.out}`);
  console.log(`  下载源  ：${endpoint}`);
  console.log(`  dtype   ：${opts.dtypes.join(', ')}`);

  if (opts.lockOnly) {
    const { changed } = writeLockIfChanged(opts.lockPath, lockObject);
    console.log(`[fetch-models] ${changed ? '✓ 已生成/更新' : '✓ 已是最新'} ${path.relative(ROOT, opts.lockPath)}`);
    console.log(
      `[fetch-models] ${lockObject.models.length} 个模型 / ${lockObject.models.reduce((n, m) => n + m.files.length, 0)} 个文件 / 合计 ${humanSize(lockObject.totalSizeBytes)}`,
    );
    for (const model of lockObject.models) {
      console.log(
        `  ${model.key.padEnd(8)} ${model.id.padEnd(28)} @${model.revision.slice(0, 12)}…  ` +
          `${model.files.length} files  ${humanSize(model.totalSizeBytes)}`,
      );
    }
    return 0;
  }

  const rows = [];
  let failed = 0;
  let downloaded = 0;
  let skipped = 0;
  let downloadedBytes = 0;

  for (const model of selectedModels) {
    const files = requiredFiles(model, opts.dtypes);
    const missingFromLock = files.length === 0;
    if (missingFromLock) {
      console.error(`[fetch-models] ✗ ${model.key}: lock 中找不到所需文件条目`);
      failed += 1;
      continue;
    }
    console.log(`\n=== ${model.key} · ${model.id} @ ${model.revision.slice(0, 12)}… (dim=${model.dim}) ===`);
    for (const file of files) {
      const result = await ensureFile(model, file, opts, endpoint);
      if (result.status === 'fail') {
        failed += 1;
      } else if (result.status === 'download') {
        downloaded += 1;
        downloadedBytes += result.size ?? 0;
      } else {
        skipped += 1;
      }
      // 本地 hash 回填 lock（例如 lock 里 sha256 为 null 的情况）
      if (result.sha256 && file.sha256 !== result.sha256) {
        file.sha256 = result.sha256;
        lockDirty = true;
      }
      if (result.size && file.size !== result.size) {
        file.size = result.size;
        lockDirty = true;
      }
      rows.push({
        model: model.key,
        file: file.path,
        status: result.status,
        size: result.size ?? file.size ?? 0,
        detail: result.message ?? '',
      });
      const icon = result.status === 'ok' ? '✓' : result.status === 'download' ? '↓' : '✗';
      const label = result.status === 'ok' ? 'skip（已存在且校验通过）' : result.status === 'download' ? 'downloaded' : `FAIL：${result.message}`;
      console.log(`  ${icon} ${file.path.padEnd(38)} ${humanSize(result.size ?? file.size ?? 0).padEnd(12)} ${label}`);
    }
  }

  console.log('\n[fetch-models] 汇总');
  console.log(`  文件 ${rows.length} 个：跳过 ${skipped}，下载 ${downloaded}（${humanSize(downloadedBytes)}），失败 ${failed}`);
  console.log(`  输出目录：${opts.out}`);

  // 先刷新 lock（可能回填了 sha256），失败也保留已校验信息
  if (lockDirty) {
    const updated = buildLock(models, lock);
    const { changed } = writeLockIfChanged(opts.lockPath, updated);
    console.log(`  lock：${changed ? '已更新' : '未变化'} ${path.relative(ROOT, opts.lockPath)}`);
  } else {
    console.log(`  lock：无变化 ${path.relative(ROOT, opts.lockPath)}`);
  }

  if (failed > 0) {
    console.error(
      `\n[fetch-models] ✗ ${failed} 个文件准备失败。\n` +
        '  排查建议：\n' +
        '    - 网络不可达官方源时改用镜像：HF_ENDPOINT=https://hf-mirror.com/ node scripts/fetch-models.mjs\n' +
        '    - 断网/已有本地资产时改用 --verify 仅做完整性校验\n' +
        '    - 确认 models.lock.json 未被手工改动',
    );
    return 1;
  }

  console.log('[fetch-models] ✓ 全部文件已就绪且 sha256 校验通过。');
  if (opts.dtypes.includes('q8') || opts.dtypes.includes('fp16') || opts.dtypes.includes('fp32')) {
    console.log(
      '[fetch-models] 提示：web 使用本地模型时在 web/.env.local 设置 VITE_LOCAL_MODELS=1' +
        '（路径默认 /models/）；远程加载则无需该设置。',
    );
  }
  return 0;
}

run()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[fetch-models] ✗ 未预期错误：', err);
    process.exit(1);
  });
