/**
 * 批处理工具
 */

/**
 * 将数组按 size 切分为多组
 */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * 串行批处理：对每个批次执行 fn 后合并结果
 */
export async function batchProcess<T, R>(
  items: T[],
  size: number,
  fn: (batch: T[]) => Promise<R[]>,
): Promise<R[]> {
  const batches = chunkArray(items, size);
  const results: R[] = [];
  for (const batch of batches) {
    const r = await fn(batch);
    results.push(...r);
  }
  return results;
}

/** 计时器，返回 ms */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  const ms = performance.now() - start;
  console.debug(`[perf] ${label}: ${ms.toFixed(1)}ms`);
  return { value, ms };
}
