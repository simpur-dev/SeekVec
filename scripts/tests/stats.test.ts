/**
 * scripts/lib/stats.ts 单元测试
 *
 * 覆盖：mean/median/quantile（R-7 线性插值）/iqr 的已知值、边界（空数组、单元素、
 * 非法 q）以及「不修改输入」的纯函数约束。
 */
import { describe, expect, it } from 'vitest';
import { iqr, mean, median, quantile } from '../lib/stats';

describe('mean', () => {
  it('算术平均', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([2, 4])).toBe(3);
    expect(mean([5])).toBe(5);
  });

  it('空数组返回 NaN', () => {
    expect(Number.isNaN(mean([]))).toBe(true);
  });
});

describe('median / quantile', () => {
  it('中位数：奇数个与偶数个', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
  });

  it('分位数使用 R-7 线性插值（与 numpy.percentile 默认一致）', () => {
    const values = [1, 2, 3, 4, 5];
    expect(quantile(values, 0)).toBe(1);
    expect(quantile(values, 0.25)).toBe(2);
    expect(quantile(values, 0.5)).toBe(3);
    expect(quantile(values, 0.75)).toBe(4);
    expect(quantile(values, 1)).toBe(5);

    const even = [1, 2, 3, 4];
    expect(quantile(even, 0.25)).toBe(1.75);
    expect(quantile(even, 0.5)).toBe(2.5);
    expect(quantile(even, 0.75)).toBe(3.25);
  });

  it('q 会被夹紧到 [0,1]；非法 q 与空数组返回 NaN', () => {
    const values = [10, 20, 30];
    expect(quantile(values, -1)).toBe(10);
    expect(quantile(values, 2)).toBe(30);
    expect(Number.isNaN(quantile(values, Number.NaN))).toBe(true);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
    expect(Number.isNaN(median([]))).toBe(true);
  });

  it('不修改传入数组', () => {
    const values = [3, 2, 1];
    const copy = [...values];
    quantile(values, 0.5);
    median(values);
    iqr(values);
    expect(values).toEqual(copy);
  });
});

describe('iqr', () => {
  it('四分位距 = Q3 − Q1', () => {
    expect(iqr([1, 2, 3, 4, 5])).toBe(2);
    expect(iqr([1, 2, 3, 4])).toBe(1.5);
    expect(iqr([2, 2, 2])).toBe(0);
  });

  it('空数组返回 NaN', () => {
    expect(Number.isNaN(iqr([]))).toBe(true);
  });
});
