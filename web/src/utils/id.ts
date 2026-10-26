/**
 * ID 生成工具
 *
 * chunk id 用「来源文件 + 块序号 + 文本」的 FNV-1a hash 生成：
 * 同一文件重复导入会得到相同 id，配合 server 端 upsert 实现幂等导入。
 */

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 稳定的分块 ID：同一来源、序号与文本永远得到同一 id */
export function chunkId(source: string, chunkIndex: number, text: string): string {
  return `chunk_${fnv1a32(`${source}\u0000${chunkIndex}\u0000${text}`).toString(36)}`;
}
