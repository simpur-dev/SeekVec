/**
 * 批处理、计时与渲染同步工具
 */

/** 将数组按 size 切分为多组 */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  const safeSize = Math.max(1, Math.floor(size));
  for (let i = 0; i < arr.length; i += safeSize) {
    out.push(arr.slice(i, i + safeSize));
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

/**
 * 等待两次 requestAnimationFrame：
 * 第一次回调在下一帧绘制前，第二次回调说明上一帧已真正上屏。
 * 用于「端到端耗时 = 到结果渲染完成」的口径（浏览器环境之外直接 resolve）。
 */
export function afterNextPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/** 毫秒取整（perf 展示口径：整数 ms） */
export function roundMs(ms: number): number {
  return Math.max(0, Math.round(ms));
}
