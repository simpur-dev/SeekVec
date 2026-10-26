#!/usr/bin/env node
/**
 * 合规自检（赛题硬性约束：推理只在浏览器端，server 不做 embedding）
 *
 * 检查项：
 *   1) server 依赖中不允许出现推理/embedding 相关包（onnx*、transformers、@xenova、default-embed）；
 *   2) server/src 代码（忽略注释）中不允许出现 onnx / transformers / default-embed 等字样；
 *      注释里出现相关字样仅记为 WARN（不影响退出码），建议一并改写以便通过严格 grep 审计；
 *   3) web 必须依赖 @huggingface/transformers（浏览器端推理）；
 *   4) server 必须依赖 seekdb 客户端；
 *   5) 额外信息项：web/src 不得直接 import seekdb（架构上只经 HTTP API）。
 *
 * 输出 PASS/FAIL/WARN 表，任一 FAIL → exit 1。CI 中由 `npm run check:compliance` 调用。
 *
 * 用法：
 *   node scripts/check-compliance.mjs [--json] [--strict]
 *
 * --strict：注释命中同样视为 FAIL（用于最终严格审计；默认不启用，避免误伤说明性注释）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const SERVER_DIR = path.join(ROOT, 'server');
const SERVER_SRC = path.join(SERVER_DIR, 'src');
const WEB_DIR = path.join(ROOT, 'web');

/** server 禁止出现的依赖名（大小写不敏感） */
const FORBIDDEN_DEP_PATTERNS = [
  /onnx/i,
  /transformers/i,
  /@xenova\//i,
  /default-embed/i,
  /@huggingface\//i,
  /tensorflow/i,
  /sentence-transformers/i,
];

/** server/src 禁用的 token 列表（代码中命中即失败；注释中 strict=FAIL / 默认=WARN）
 *  由 Lead 确认：onnx、@huggingface/transformers、@xenova/transformers、default-embed。 */
const FORBIDDEN_SRC_PATTERNS = [
  { pattern: /onnx/i, label: 'onnx' },
  { pattern: /@huggingface\/transformers/i, label: '@huggingface/transformers' },
  { pattern: /@xenova\/transformers/i, label: '@xenova/transformers' },
  { pattern: /default-embed/i, label: 'default-embed' },
];

/** @type {Array<{status:'PASS'|'FAIL'|'WARN', name:string, detail:string}>} */
const results = [];

/** @param {'PASS'|'FAIL'|'WARN'} status */
function add(status, name, detail) {
  results.push({ status, name, detail });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function allDependencyNames(pkg) {
  const names = new Set();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) names.add(name);
  }
  return [...names];
}

function walkFiles(dir, predicate) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      out.push(...walkFiles(full, predicate));
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 去掉 TS/JS 注释（保留换行以维持行号对齐），保留字符串字面量内容。
 * 只需足够健壮以支持"注释 vs 代码"判断，不追求完整词法分析。
 * @param {string} text
 */
function stripComments(text) {
  let out = '';
  let state = 'code'; // code | line | block | single | double | template
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line';
        i += 1;
        continue;
      }
      if (c === '/' && next === '*') {
        state = 'block';
        i += 1;
        continue;
      }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'template';
      out += c;
    } else if (state === 'line') {
      if (c === '\n') {
        out += '\n';
        state = 'code';
      }
    } else if (state === 'block') {
      if (c === '*' && next === '/') {
        i += 1;
        state = 'code';
      } else if (c === '\n') {
        out += '\n';
      }
    } else if (state === 'single' || state === 'double' || state === 'template') {
      out += c;
      const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (c === quote) {
        state = 'code';
      }
    }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes('--json');
  const strict = argv.includes('--strict');

  // ---- 1) server 依赖检查 ----
  let serverPkg = null;
  try {
    serverPkg = readJson(path.join(SERVER_DIR, 'package.json'));
  } catch (err) {
    add('FAIL', 'server/package.json 可读', err.message);
  }
  if (serverPkg) {
    const deps = allDependencyNames(serverPkg);
    const offenders = deps.filter((name) => FORBIDDEN_DEP_PATTERNS.some((re) => re.test(name)));
    add(
      offenders.length === 0 ? 'PASS' : 'FAIL',
      'server 无推理/embedding 依赖',
      offenders.length === 0 ? '未发现 onnx/transformers/@xenova/default-embed 等依赖' : `发现：${offenders.join(', ')}`,
    );
    add(
      serverPkg.dependencies?.seekdb ? 'PASS' : 'FAIL',
      'server 依赖 seekdb 客户端',
      serverPkg.dependencies?.seekdb ? `seekdb@${serverPkg.dependencies.seekdb}` : 'dependencies.seekdb 缺失',
    );
  }

  // ---- 2) server/src 源码扫描（代码 vs 注释）----
  const serverFiles = walkFiles(SERVER_SRC, (file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file));
  if (serverFiles.length === 0) {
    add('FAIL', 'server/src 存在源文件', `未找到：${path.relative(ROOT, SERVER_SRC)}`);
  } else {
    const codeHits = [];
    const commentHits = [];
    for (const file of serverFiles) {
      const raw = fs.readFileSync(file, 'utf8');
      const stripped = stripComments(raw);
      const rawLines = raw.split(/\r?\n/);
      const codeLines = stripped.split(/\r?\n/);
      const rel = path.relative(ROOT, file);
      for (const { pattern, label } of FORBIDDEN_SRC_PATTERNS) {
        for (let i = 0; i < rawLines.length; i += 1) {
          if (!pattern.test(rawLines[i])) continue;
          if (pattern.test(codeLines[i] ?? '')) codeHits.push(`${rel}:${i + 1}（${label}）`);
          else if (strict) codeHits.push(`${rel}:${i + 1}（注释中的 ${label}）`);
          else commentHits.push(`${rel}:${i + 1}（${label}）`);
        }
      }
    }
    add(
      codeHits.length === 0 ? 'PASS' : 'FAIL',
      'server/src 无推理库代码引用（忽略注释）',
      codeHits.length === 0
        ? `扫描 ${serverFiles.length} 个文件，代码中未命中 ${FORBIDDEN_SRC_PATTERNS.map((p) => p.label).join(' / ')}`
        : `命中：${codeHits.slice(0, 8).join('; ')}${codeHits.length > 8 ? ' …' : ''}`,
    );
    if (commentHits.length > 0) {
      add(
        'WARN',
        'server/src 注释含相关字样（建议改写以通过严格 grep 审计）',
        `命中 ${commentHits.length} 处：${commentHits.slice(0, 6).join('; ')}${commentHits.length > 6 ? ' …' : ''}`,
      );
    } else {
      add('PASS', 'server/src 注释无相关字样', '注释与代码均干净');
    }
  }

  // ---- 3) web 依赖检查 ----
  let webPkg = null;
  try {
    webPkg = readJson(path.join(WEB_DIR, 'package.json'));
  } catch (err) {
    add('FAIL', 'web/package.json 可读', err.message);
  }
  if (webPkg) {
    const version = webPkg.dependencies?.['@huggingface/transformers'];
    add(
      version ? 'PASS' : 'FAIL',
      'web 依赖 @huggingface/transformers',
      version ? `@huggingface/transformers@${version}` : 'dependencies["@huggingface/transformers"] 缺失',
    );
  }

  // ---- 4) 信息项：web 源码不应直连 seekdb（架构上 web 只经 HTTP API）----
  const webFiles = walkFiles(path.join(WEB_DIR, 'src'), (file) => /\.(ts|tsx)$/.test(file));
  const webSeekdbHits = [];
  for (const file of webFiles) {
    const text = fs.readFileSync(file, 'utf8');
    if (/from\s+['"]seekdb['"]/.test(text) || /require\(['"]seekdb['"]\)/.test(text)) {
      webSeekdbHits.push(path.relative(ROOT, file));
    }
  }
  add(
    webSeekdbHits.length === 0 ? 'PASS' : 'FAIL',
    'web/src 不直接 import seekdb（信息项）',
    webSeekdbHits.length === 0 ? '未发现（经 HTTP API 访问）' : `发现：${webSeekdbHits.join(', ')}`,
  );

  // ---- 输出 ----
  const failed = results.filter((r) => r.status === 'FAIL');
  const warned = results.filter((r) => r.status === 'WARN');
  const ok = failed.length === 0;
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ok, results }, null, 2)}\n`);
  } else {
    console.log('SeekVec 合规自检（推理在浏览器端 / server 只做数据层）\n');
    for (const r of results) {
      console.log(`${r.status.padEnd(4)}  ${r.name}`);
      console.log(`      ${r.detail}`);
    }
    console.log(`\n${ok ? 'ALL PASS' : `${failed.length} 项 FAIL`}（共 ${results.length} 项，WARN ${warned.length}）`);
    if (warned.length > 0) console.log('提示：WARN 不影响合规结论，但建议清理以通过严格 grep 审计。');
  }
  process.exit(ok ? 0 : 1);
}

main();
