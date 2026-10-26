/**
 * 计时工具
 *
 * 统一的毫秒耗时口径，供 API 响应的 timings 字段使用：
 * - 使用单调时钟 performance.now()，不受系统时间回拨影响
 * - 统一保留 2 位小数，避免浮点噪声进入 API 契约
 */

/** 当前单调时钟（毫秒） */
export function nowMs(): number {
  return performance.now();
}

/** 毫秒数保留 2 位小数；非有限值归零，保证 JSON 可序列化 */
export function roundMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.round(ms * 100) / 100;
}

/** 从 startedAt 到当前（或给定终点）的耗时（毫秒，2 位小数） */
export function elapsedMs(startedAt: number, endedAt: number = performance.now()): number {
  return roundMs(endedAt - startedAt);
}

/**
 * 轻量分段计时器：
 * - `lap()` 返回距上一次 lap 的耗时
 * - `total()` 返回距创建时的总耗时
 */
export class Stopwatch {
  private readonly startedAt = nowMs();
  private lastLapAt = this.startedAt;

  /** 距上一次 lap（或创建）的耗时 */
  lap(): number {
    const current = nowMs();
    const duration = elapsedMs(this.lastLapAt, current);
    this.lastLapAt = current;
    return duration;
  }

  /** 距创建时的总耗时 */
  total(): number {
    return elapsedMs(this.startedAt);
  }
}
