/**
 * 最小的 .env 读取工具（零依赖，供 Node 脚本使用）。
 *
 * 规则：
 * - 只读取调用方指定的仓库根目录下 `.env`；文件不存在时静默返回；
 * - KEY=VALUE，忽略空行与以 # 开头的注释；
 * - 去除值两侧成对的单/双引号；
 * - 已存在于 process.env 的变量优先，不会被 .env 覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';

/** @param {string} root 仓库根目录 */
export function loadDotEnv(root = process.cwd()) {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return { file: null, vars: {} };
  const vars = {};
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
    vars[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return { file, vars };
}
