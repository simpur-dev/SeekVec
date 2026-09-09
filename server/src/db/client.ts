/**
 * SeekDB 客户端单例（server 模式为主，嵌入式可选）
 *
 * - 默认 server 模式：连接本机 seekdb server（Windows 官方唯一支持形态）
 * - SEEKDB_PATH 设置时走嵌入式（仅 Linux/macOS；Windows 直接拒绝，
 *   官方文档标注嵌入式 "Not supported yet" on Windows，实测 1.4.0 引擎启动挂死）
 *
 * 合规约束：本进程只做存储与检索，禁止引入任何 embedding 推理依赖
 * （@seekdb/default-embed 已从依赖移除，向量一律由 web 端传入）。
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

export async function getClient(): Promise<SeekdbClient> {
  if (!clientInstance) {
    if (SERVER_CONFIG.seekdbPath) {
      if (process.platform === 'win32') {
        throw new Error(
          'SEEKDB_PATH（嵌入式模式）在 Windows 上不受 seekdb 官方支持，请改用本机 seekdb server（默认 127.0.0.1:2881）。详见 README。',
        );
      }
      clientInstance = new SeekdbClient({
        path: SERVER_CONFIG.seekdbPath,
        database: SERVER_CONFIG.seekdbDatabase,
      });
    } else {
      clientInstance = new SeekdbClient({
        host: SERVER_CONFIG.seekdbHost,
        port: SERVER_CONFIG.seekdbPort,
        user: SERVER_CONFIG.seekdbUser,
        password: SERVER_CONFIG.seekdbPassword,
        database: SERVER_CONFIG.seekdbDatabase,
      });
    }
  }
  return clientInstance;
}

export async function closeClient(): Promise<void> {
  if (clientInstance) {
    await clientInstance.close();
    clientInstance = null;
  }
}
