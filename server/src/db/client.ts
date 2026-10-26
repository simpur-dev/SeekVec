/**
 * SeekDB 客户端单例（server 模式为主，嵌入式可选）
 *
 * - 默认 server 模式：连接本机 seekdb server（Windows 官方唯一支持形态）
 * - SEEKDB_PATH 设置时走嵌入式（仅 Linux/macOS；Windows 直接拒绝，
 *   官方文档标注嵌入式 "Not supported yet" on Windows，实测 1.4.0 引擎启动挂死）
 *
 * 合规约束：本进程只做存储与检索，禁止引入任何向量化推理依赖
 * （seekdb 客户端的默认向量化依赖已从依赖移除，向量一律由 web 端传入）。
 *
 * 连接韧性：seekdb 服务/容器重启后旧连接会失效
 * （典型报错 "Can't add new command when connection is in closed state"），
 * 路由层用 retryOnConnectionError 做一次「重建连接 + 重试」，dev 无需重启。
 *
 * 查询超时：SEEKDB_QUERY_TIMEOUT_MS（默认 30000）通过 queryTimeout 透传给 SDK，
 * 避免慢查询把 HTTP 请求无限期挂住。
 */
import { SeekdbClient, SeekdbAdminClient } from 'seekdb';
import { SERVER_CONFIG } from '../config.js';

let clientInstance: SeekdbClient | null = null;

export function describeConnection(): string {
  return SERVER_CONFIG.seekdbPath
    ? `embedded(${SERVER_CONFIG.seekdbPath})`
    : `server(${SERVER_CONFIG.seekdbHost}:${SERVER_CONFIG.seekdbPort}/${SERVER_CONFIG.seekdbDatabase})`;
}

export async function ensureDatabase(): Promise<void> {
  if (SERVER_CONFIG.seekdbPath) return; // 嵌入式模式 database 自动创建
  // server 模式需显式建库（SeekdbAdminClient 连接到 information_schema）
  const admin = new SeekdbAdminClient({
    host: SERVER_CONFIG.seekdbHost,
    port: SERVER_CONFIG.seekdbPort,
    user: SERVER_CONFIG.seekdbUser,
    password: SERVER_CONFIG.seekdbPassword,
  });
  try {
    await admin.createDatabase(SERVER_CONFIG.seekdbDatabase);
    console.log(`[server] database '${SERVER_CONFIG.seekdbDatabase}' created`);
  } catch (err: unknown) {
    // 库已存在时直接忽略（错误信息含 "already exists"）
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('already exists')) {
      console.log(`[server] database '${SERVER_CONFIG.seekdbDatabase}' already exists`);
    } else {
      console.warn(`[server] ensureDatabase warning: ${msg}`);
    }
  } finally {
    await admin.close();
  }
}

function buildClient(): SeekdbClient {
  if (SERVER_CONFIG.seekdbPath) {
    if (process.platform === 'win32') {
      throw new Error(
        'SEEKDB_PATH（嵌入式模式）在 Windows 上不受 seekdb 官方支持，请改用本机 seekdb server（默认 127.0.0.1:2881）。详见 README。',
      );
    }
    return new SeekdbClient({
      path: SERVER_CONFIG.seekdbPath,
      database: SERVER_CONFIG.seekdbDatabase,
      queryTimeout: SERVER_CONFIG.queryTimeoutMs,
    });
  }
  return new SeekdbClient({
    host: SERVER_CONFIG.seekdbHost,
    port: SERVER_CONFIG.seekdbPort,
    user: SERVER_CONFIG.seekdbUser,
    password: SERVER_CONFIG.seekdbPassword,
    database: SERVER_CONFIG.seekdbDatabase,
    queryTimeout: SERVER_CONFIG.queryTimeoutMs,
  });
}

export async function getClient(): Promise<SeekdbClient> {
  if (clientInstance) {
    if (clientInstance.isConnected()) return clientInstance;
    // 连接已断开（seekdb 重启等）：丢弃旧实例后重建
    await resetClientConnection();
  }
  clientInstance = buildClient();
  return clientInstance;
}

/** 丢弃当前单例连接（不抛错），下一次 getClient 会重新建连 */
export async function resetClientConnection(): Promise<void> {
  const stale = clientInstance;
  clientInstance = null;
  if (stale) {
    try {
      await stale.close();
    } catch {
      // 连接已经坏了，close 失败可忽略
    }
  }
}

/** seekdb 重启/连接中断时 SDK 抛出的典型错误 */
const CONNECTION_ERROR_RE =
  /closed state|connection (?:is )?(?:lost|closed)|ECONNRESET|PROTOCOL_CONNECTION_LOST|EPIPE/i;

export function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return CONNECTION_ERROR_RE.test(msg);
}

/**
 * 执行一次数据库操作；若因连接中断失败，则重建连接后重试一次。
 * 让 dev server 在 seekdb 容器重启后可以自愈，而不是一直 500 直到手动重启。
 */
export async function retryOnConnectionError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    console.warn('[seekdb] connection lost, reconnecting and retrying once');
    await resetClientConnection();
    return fn();
  }
}

export async function closeClient(): Promise<void> {
  if (clientInstance) {
    await clientInstance.close();
    clientInstance = null;
  }
}
