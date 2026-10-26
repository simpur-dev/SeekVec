import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPerf,
  getRunId,
  quantile,
  recordPerf,
  setMetricsContext,
  setMetricsEnabled,
  snapshot,
  summary,
} from '../src/perf/metrics';
import { MODEL_REGISTRY } from '../src/inference/models';

beforeEach(() => {
  setMetricsEnabled(true);
  clearPerf();
  setMetricsContext({ modelKey: null, dtype: null, backend: null });
});

describe('quantile', () => {
  it('线性插值分位数与边界', () => {
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([7], 0.95)).toBe(7);
    expect(quantile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(quantile([10, 20, 30, 40], 0)).toBe(10);
    expect(quantile([10, 20, 30, 40], 1)).toBe(40);
    expect(quantile([10, 20, 30, 40], 0.95)).toBeCloseTo(38.5, 6);
  });
});

describe('summary', () => {
  it('按 phase 输出 n/p50/p95/mean', () => {
    for (const ms of [10, 20, 30, 40]) recordPerf('query.embed', ms);
    recordPerf('doc.read', 5);

    const result = summary();
    expect(result.schemaVersion).toBe(1);
    expect(result.count).toBe(5);
    expect(result.phases['query.embed']).toEqual({
      n: 4,
      p50: 25,
      p95: 38.5,
      mean: 25,
    });
    expect(result.phases['doc.read']).toEqual({ n: 1, p50: 5, p95: 5, mean: 5 });
    expect(result.phases['query.e2e']).toBeUndefined();
  });

  it('浮点耗时保留 3 位小数', () => {
    recordPerf('doc.write', 1.23456);
    expect(summary().phases['doc.write']?.mean).toBe(1.235);
  });
});

describe('环形缓冲与快照', () => {
  it('事件最多保留 2000 条（丢弃最旧的）', () => {
    for (let i = 0; i < 2005; i++) recordPerf('db.search', i);
    const snap = snapshot();
    expect(snap.events).toHaveLength(2000);
    expect(snap.events[0].ms).toBe(5);
    expect(snap.events[1999].ms).toBe(2004);
    expect(summary().phases['db.search']?.n).toBe(2000);
  });

  it('snapshot 返回副本，后续事件不改变已取快照', () => {
    recordPerf('query.http', 12);
    const snap = snapshot();
    recordPerf('query.http', 99);
    expect(snap.events).toHaveLength(1);
    expect(snapshot().events).toHaveLength(2);
  });

  it('未启用观测时 recordPerf 是 no-op', () => {
    setMetricsEnabled(false);
    recordPerf('query.e2e', 42);
    expect(snapshot().events).toHaveLength(0);
    expect(summary().count).toBe(0);
  });

  it('clear() 清空事件并更换 runId', () => {
    recordPerf('query.embed', 1);
    const before = getRunId();
    clearPerf();
    expect(snapshot().events).toHaveLength(0);
    expect(getRunId()).not.toBe(before);
  });
});

describe('事件上下文与 snapshost env', () => {
  it('未显式传 modelKey/dtype 时由运行时上下文补齐', () => {
    setMetricsContext({ modelKey: 'text_zh', dtype: 'q8', backend: 'wasm' });
    recordPerf('model.total', 100, { warm: false });
    const event = snapshot().events[0];
    expect(event).toMatchObject({
      phase: 'model.total',
      modelKey: 'text_zh',
      dtype: 'q8',
      backend: 'wasm',
      warm: false,
    });
    expect(typeof event.runId).toBe('string');
    expect(typeof event.ts).toBe('number');
  });

  it('snapshot 包含配置、环境与模型 revision', () => {
    setMetricsContext({ modelKey: 'text_zh', dtype: 'fp16', backend: 'webgpu' });
    recordPerf('model.total', 1);
    const snap = snapshot();
    expect(snap.schemaVersion).toBe(1);
    expect(snap.config).toHaveProperty('batch');
    expect(snap.config).toHaveProperty('perf');
    expect(snap.env.model.key).toBe('text_zh');
    expect(snap.env.model.id).toBe(MODEL_REGISTRY.text_zh.id);
    expect(snap.env.model.revision).toBe(
      '75c43b069aac4d136ba6bc1122f995fedcfd2781',
    );
    expect(snap.env.model.dtype).toBe('fp16');
    expect(snap.env.backend).toBe(null); // 本测试未经过 backendStore
  });
});
