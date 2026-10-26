/**
 * 描述统计（纯函数，无 I/O、无副作用）
 *
 * 口径：
 * - 所有函数都不修改传入数组（内部复制排序）；
 * - 空数组返回 NaN（而不是 0），调用方需显式处理「没有样本」的情况；
 * - quantile 使用线性插值（R-7 / 与 numpy.percentile 默认、Excel PERCENTILE.INC 一致）：
 *   位置 h = (n − 1) * q，结果 = x[floor(h)] + (h − floor(h)) * (x[floor(h)+1] − x[floor(h)])；
 * - q 会被夹紧到 [0,1]；NaN/Infinity 的 q 返回 NaN。
 */

/** 升序排序后的数值副本 */
function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** 算术平均；空数组 NaN */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** 中位数（偶数个样本取中间两个的平均）；空数组 NaN */
export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

/**
 * 分位数（线性插值，R-7）；空数组或非法 q 返回 NaN。
 *
 * @param q 目标分位，0 ≤ q ≤ 1（超出范围会被夹紧）
 */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  if (!Number.isFinite(q)) return Number.NaN;
  const clamped = Math.min(1, Math.max(0, q));
  const nums = sorted(values);
  const h = (nums.length - 1) * clamped;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return nums[lo];
  return nums[lo] + (h - lo) * (nums[hi] - nums[lo]);
}

/** 四分位距 IQR = Q3 − Q1；空数组 NaN */
export function iqr(values: readonly number[]): number {
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  return q3 - q1;
}
