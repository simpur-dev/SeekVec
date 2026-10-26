/**
 * scripts/lib/evalMetrics.ts 单元测试
 *
 * 覆盖：Recall@K / nDCG@K / MRR 的已知值、边界（空输入、K=0、K 超长、重复 id、平局）
 * 与 rankIdsByScore 的确定性排序。所有期望值都用公式手算，不依赖实现细节。
 */
import { describe, expect, it } from 'vitest';
import { mrr, ndcgAtK, rankIdsByScore, recallAtK } from '../lib/evalMetrics';

const LOG2_3 = Math.log2(3);

describe('recallAtK', () => {
  it('命中数 / 相关总数（分母不随 K 截断）', () => {
    const ranked = ['a', 'b', 'c', 'd'];
    const relevant = ['a', 'c'];
    expect(recallAtK(ranked, relevant, 1)).toBe(0.5);
    expect(recallAtK(ranked, relevant, 2)).toBe(0.5);
    expect(recallAtK(ranked, relevant, 3)).toBe(1);
    expect(recallAtK(ranked, relevant, 99)).toBe(1);
  });

  it('支持 Set 输入', () => {
    expect(recallAtK(['x', 'a'], new Set(['a']), 2)).toBe(1);
  });

  it('边界：空排序 / 空相关集 / K ≤ 0 / K 非整数', () => {
    expect(recallAtK([], ['a'], 5)).toBe(0);
    expect(recallAtK(['a'], [], 5)).toBe(0);
    expect(recallAtK(['a'], ['a'], 0)).toBe(0);
    expect(recallAtK(['a'], ['a'], -3)).toBe(0);
    expect(recallAtK(['a'], ['a'], 2.9)).toBe(1); // 向下取整为 2
    expect(recallAtK(['a'], ['a'], Number.NaN)).toBe(0);
  });

  it('重复 id 只保留首次出现，不重复占用 K 名额', () => {
    expect(recallAtK(['a', 'a', 'b'], ['a', 'b'], 2)).toBe(1);
    expect(recallAtK(['x', 'x', 'a'], ['a'], 1)).toBe(0);
    expect(recallAtK(['x', 'x', 'a'], ['a'], 2)).toBe(1); // 去重后 x, a —— 重复的 x 不占名额
    expect(recallAtK(['x', 'x', 'a'], ['a'], 3)).toBe(1);
  });
});

describe('ndcgAtK', () => {
  it('只有一条 grade=3 且排第一时 nDCG=1', () => {
    expect(ndcgAtK(['a'], { a: 3 }, 5)).toBe(1);
  });

  it('位置折损：grade=3 排在第二名', () => {
    const expected = 7 / LOG2_3 / 7;
    expect(ndcgAtK(['b', 'a'], { a: 3, b: 0 }, 2)).toBeCloseTo(expected, 12);
  });

  it('未标注 id 的 gain=0，但会占用位置', () => {
    expect(ndcgAtK(['x', 'a'], { a: 3 }, 2)).toBeCloseTo(7 / LOG2_3 / 7, 12);
  });

  it('IDCG 用 gradedMap 的等级降序（含未检索到的高相关项）', () => {
    // ranked 只有 b(1)，理想排序是 [a(3), b(1)]
    const dcg = 1 / Math.log2(2);
    const idcg = 7 / Math.log2(2) + 1 / Math.log2(3);
    expect(ndcgAtK(['b'], { a: 3, b: 1 }, 2)).toBeCloseTo(dcg / idcg, 12);
  });

  it('重复 id 只计首次', () => {
    expect(ndcgAtK(['a', 'a', 'b'], { a: 1, b: 1 }, 2)).toBe(1);
  });

  it('grade=0 不产生 gain；负值/非有限值按 0 处理', () => {
    expect(ndcgAtK(['a', 'b'], { a: 0, b: 2 }, 2)).toBeCloseTo((3 / LOG2_3) / 3, 12);
    expect(ndcgAtK(['a', 'b'], { a: -2, b: 2 }, 2)).toBeCloseTo((3 / LOG2_3) / 3, 12);
    expect(ndcgAtK(['a'], { a: Number.NaN }, 3)).toBe(0);
  });

  it('边界：空 gradedMap / 全 0 等级 / K ≤ 0 / 空排序', () => {
    expect(ndcgAtK(['a'], {}, 5)).toBe(0);
    expect(ndcgAtK(['a'], { a: 0 }, 5)).toBe(0);
    expect(ndcgAtK(['a'], { a: 3 }, 0)).toBe(0);
    expect(ndcgAtK([], { a: 3 }, 5)).toBe(0);
  });

  it('支持 Record 与 Map 两种 gradedMap', () => {
    expect(ndcgAtK(['a'], new Map([['a', 3]]), 5)).toBe(1);
    expect(ndcgAtK(['a'], { a: 3 }, 5)).toBe(1);
  });
});

describe('mrr', () => {
  it('第一条相关结果的倒数排名', () => {
    expect(mrr(['a', 'b'], ['a'], ) ).toBe(1);
    expect(mrr(['x', 'y', 'a'], ['a'])).toBeCloseTo(1 / 3, 12);
    expect(mrr(['x', 'a', 'y', 'b'], ['a', 'b'])).toBe(0.5);
  });

  it('边界：无命中 / 空相关集 / 空排序', () => {
    expect(mrr(['x', 'y'], ['a'])).toBe(0);
    expect(mrr(['a'], [])).toBe(0);
    expect(mrr([], ['a'])).toBe(0);
  });

  it('重复 id 只计首次', () => {
    expect(mrr(['x', 'x', 'a'], ['a'])).toBeCloseTo(1 / 2, 12);
  });
});

describe('rankIdsByScore', () => {
  it('按分数降序，分数相同按 id 字典序升序（确定性平局）', () => {
    expect(rankIdsByScore({ a: 0.5, b: 0.9, c: 0.5 })).toEqual(['b', 'a', 'c']);
    expect(rankIdsByScore(new Map([['z', 1], ['a', 1]]))).toEqual(['a', 'z']);
  });

  it('剔除 NaN/Infinity，空输入返回空数组', () => {
    expect(rankIdsByScore({ a: Number.NaN, b: 1, c: Number.POSITIVE_INFINITY, d: 0.2 })).toEqual(['b', 'd']);
    expect(rankIdsByScore({})).toEqual([]);
  });
});
