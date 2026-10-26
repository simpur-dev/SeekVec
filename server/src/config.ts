/**
 * SeekVec server 配置
 *
 * seekdb 连接模式（二选一）：
 * - server 模式（默认，全平台可用）：连接本机 seekdb server。Windows 官方唯一支持形态
 * - 嵌入式模式（仅 Linux/macOS）：设置 SEEKDB_PATH 启用。
 *   官方兼容性表明确标注嵌入式 "Not supported yet" on Windows，勿在 Windows 设置该变量
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 读取仓库根目录 .env（若存在），让 `npm run dev` / `npm start` 也能使用 .env 配置。
 * 已存在的系统环境变量优先；不覆盖。解析规则与 scripts/lib/env.mjs 保持一致。
 */
function loadRootDotEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), '..', '.env'), // cwd=server 时
    path.resolve(process.cwd(), '.env'), // cwd=仓库根时
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
      }
    } catch {
      // .env 不可读时保持默认配置，不阻塞服务启动
    }
    return;
  }
}

loadRootDotEnv();

/** CORS 白名单：逗号分隔，逐项 trim，过滤空项；未配置时回退本地 dev 源 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return ['http://localhost:5173'];
  const origins = trimmed
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return origins.length > 0 ? origins : ['http://localhost:5173'];
}

/** SEEKDB_QUERY_TIMEOUT_MS：单条 SQL 查询超时（毫秒），默认 30000 */
export function parseQueryTimeoutMs(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}

export const SERVER_CONFIG = {
  port: Number(process.env.PORT ?? 3001),

  // 嵌入式模式开关（Linux/macOS 可用；Windows 下会被拒绝）
  seekdbPath: process.env.SEEKDB_PATH ?? '',

  // server 模式连接参数（本机 seekdb server 默认值，端口 2881 / 用户 root / 空密码）
  seekdbHost: process.env.SEEKDB_HOST ?? '127.0.0.1',
  seekdbPort: Number(process.env.SEEKDB_PORT ?? 2881),
  seekdbUser: process.env.SEEKDB_USER ?? 'root',
  seekdbPassword: process.env.SEEKDB_PASSWORD ?? '',
  seekdbDatabase: process.env.SEEKDB_DATABASE ?? 'seekvec',

  // 单条 SQL 查询超时（毫秒），透传给 seekdb SDK 的 queryTimeout
  queryTimeoutMs: parseQueryTimeoutMs(process.env.SEEKDB_QUERY_TIMEOUT_MS),

  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
} as const;
