/**
 * SeekVec server 配置
 *
 * seekdb 连接模式（二选一）：
 * - server 模式（默认，全平台可用）：连接本机 seekdb server。Windows 官方唯一支持形态
 * - 嵌入式模式（仅 Linux/macOS）：设置 SEEKDB_PATH 启用。
 *   官方兼容性表明确标注嵌入式 "Not supported yet" on Windows，勿在 Windows 设置该变量
 */
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

  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(','),
} as const;
