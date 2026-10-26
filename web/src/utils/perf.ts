/**
 * 批处理与计时工具
 */

/** 将数组按 size 切分为多组 */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/** 计时器，返回结果与耗时 ms（用于向量化/检索分段耗时统计） */
export async function timed<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  const ms = performance.now() - start;
  console.debug(`[perf] ${label}: ${ms.toFixed(1)}ms`);
  return { value, ms };
}
