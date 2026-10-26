/**
 * FIFO 异步互斥锁
 *
 * 用途：seekdb 的混合检索（DBMS_HYBRID_SEARCH）分两步执行
 *   1) `SET @search_parm = '<json>'`（会话变量）
 *   2) `SELECT DBMS_HYBRID_SEARCH.GET_SQL(...)`
 * 两步不是原子的，同一个连接上并发请求会互相覆盖 @search_parm，
 * 导致「A 的查询用了 B 的参数」。这里用进程内 FIFO 互斥把混合检索串行化，
 * 保证同一条连接上「设置变量 + 取 SQL」不被打断。
 *
 * 语义（严格 FIFO）：
 * - acquire() 按调用顺序排队，先来先得
 * - release() 幂等，重复调用不会打乱队列
 * - 推荐用 runExclusive()，异常路径也会自动释放
 */
export class AsyncMutex {
  /** 队尾：resolve 后表示「上一个持有者已释放」 */
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  /** 当前排队 + 持有中的数量（观测/测试用） */
  get size(): number {
    return this.pending;
  }

  /** 排队获取锁，返回幂等的 release 函数 */
  async acquire(): Promise<() => void> {
    this.pending += 1;
    const previous = this.tail;
    let releaseNext!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    // 新的队尾 = 旧队尾结束后等待「本持有者释放」
    this.tail = previous.then(() => current);

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.pending -= 1;
      releaseNext();
    };

    try {
      await previous;
    } catch {
      // 前序持有者异常不影响本请求（previous 只会 resolve，这里防御性兜底）
    }
    return release;
  }

  /** 独占执行：异常时也会释放锁 */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** 混合检索专用互斥锁（进程内全局单例） */
export const hybridSearchMutex = new AsyncMutex();
