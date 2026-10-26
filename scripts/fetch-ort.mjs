#!/usr/bin/env node
/**
 * 把 ONNX Runtime Web 的 wasm 资源复制到 web/public/ort/（同源托管）。
 *
 * 背景：Transformers.js 默认从 jsDelivr CDN 加载 onnxruntime-web 的 wasm 资源；
 * 在无法访问该 CDN 的环境中会加载失败。prepare:assets 会把运行所需的 4 个文件
 * 复制到 web/public/ort/，再用 VITE_ORT_WASM_PATH=/ort/ 指向它们（见 web/.env.local.example）。
 *
 * 用法：
 *   node scripts/fetch-ort.mjs                 # 复制到 web/public/ort（已存在且大小一致则跳过）
 *   node scripts/fetch-ort.mjs --force         # 强制覆盖
 *   node scripts/fetch-ort.mjs --from <dir> --out <dir>
 *
 * 源目录默认 web/node_modules/onnxruntime-web/dist（从 web 的依赖版本复制，保证与页面运行时一致）。
 * 注意：web/public/ort/ 已被 .gitignore 忽略，不进入仓库，也不在 CI 中生成。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const DEFAULT_FROM = path.join(ROOT, 'web', 'node_modules', 'onnxruntime-web', 'dist');
const DEFAULT_OUT = path.join(ROOT, 'web', 'public', 'ort');

// 页面运行所需的最小文件集合（与 onnxruntime-web 1.17+ 的 wasm EP 文件命名一致）：
// - ort-wasm-simd-threaded.mjs/.wasm          WASM 后端
// - ort-wasm-simd-threaded.jsep.mjs/.wasm     WebGPU (JSEP) 后端
const FILES = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
];

const HELP = `SeekVec · 复制 ONNX Runtime wasm 资源

用法：
  node scripts/fetch-ort.mjs [选项]

选项：
  --from <dir>    源目录（默认 web/node_modules/onnxruntime-web/dist）
  --out <dir>     目标目录（默认 web/public/ort，已被 .gitignore 忽略）
  --force         即使大小一致也强制复制
  -h, --help      显示帮助

随后在 web/.env.local 中设置：
  VITE_ORT_WASM_PATH=/ort/
`;

function parseArgs(argv) {
  const opts = { from: DEFAULT_FROM, out: DEFAULT_OUT, force: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from') opts.from = path.resolve(argv[++i] ?? '');
    else if (arg === '--out') opts.out = path.resolve(argv[++i] ?? '');
    else if (arg === '--force') opts.force = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else {
      console.error(`[fetch-ort] 未知参数：${arg}（--help 查看用法）`);
      process.exit(2);
    }
  }
  return opts;
}

function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  console.log('[fetch-ort] 源目录：', opts.from);
  console.log('[fetch-ort] 目标目录：', opts.out);

  if (!fs.existsSync(opts.from) || !fs.statSync(opts.from).isDirectory()) {
    console.error(
      `[fetch-ort] ✗ 源目录不存在：${opts.from}\n` +
        '           请先安装 web 依赖：npm install --prefix web（或 npm run install:all）',
    );
    process.exit(1);
  }

  fs.mkdirSync(opts.out, { recursive: true });

  let copied = 0;
  let skipped = 0;
  let totalBytes = 0;
  const missing = [];
  const rows = [];

  for (const name of FILES) {
    const src = path.join(opts.from, name);
    const dst = path.join(opts.out, name);

    if (!fs.existsSync(src)) {
      missing.push(name);
      rows.push([name, 'MISSING', '-', '-']);
      continue;
    }
    const srcSize = fs.statSync(src).size;
    totalBytes += srcSize;

    const dstExists = fs.existsSync(dst);
    const dstSize = dstExists ? fs.statSync(dst).size : -1;
    const upToDate = dstExists && dstSize === srcSize && !opts.force;

    if (upToDate) {
      skipped += 1;
      rows.push([name, 'skip', mb(srcSize), dst]);
      continue;
    }
    fs.copyFileSync(src, dst);
    // 复制后立即校验大小，避免被占位/半截文件骗过
    const written = fs.statSync(dst).size;
    if (written !== srcSize) {
      console.error(`[fetch-ort] ✗ 复制后大小不一致：${name}（期望 ${srcSize}，实际 ${written}）`);
      process.exit(1);
    }
    copied += 1;
    rows.push([name, 'copy', mb(srcSize), dst]);
  }

  console.log('');
  console.log('文件'.padEnd(38), '状态'.padEnd(8), '大小'.padEnd(12), '目标');
  for (const [name, status, size, dst] of rows) {
    console.log(String(name).padEnd(38), String(status).padEnd(8), String(size).padEnd(12), dst);
  }

  if (missing.length > 0) {
    console.error(
      `\n[fetch-ort] ✗ 缺少 ${missing.length} 个源文件：${missing.join(', ')}\n` +
        '           onnxruntime-web 版本可能与预期不符，请检查 web/node_modules/onnxruntime-web/dist。',
    );
    process.exit(1);
  }

  console.log(`\n[fetch-ort] ✓ 完成：复制 ${copied} 个，跳过 ${skipped} 个，合计 ${mb(totalBytes)}`);
  console.log('[fetch-ort] 提示：在 web/.env.local 设置 VITE_ORT_WASM_PATH=/ort/ 后重启 dev server 生效。');
}

main();
