/**
 * 性能观测（?perf=1 才启用）
 *
 * 结构（契约第 3 节）：
 * - PerfEvent：单次阶段耗时（runId/phase/ms/ts/backend/modelKey/dtype/batchSize/refreshPolicy/warm/meta）
 * - MetricsSnapshot：环境 + 配置 + 事件（环形缓冲 ≤ 2000 条）
 * - summary()：每个 phase 的 n / p50 / p95 / mean
 *
 * 说明：
 * - 默认关闭，只有 `?perf=1` 时 installPerfGlobals() 才会暴露 window.__seekvecPerf；
 *   关闭时不记录事件（避免无意义的常驻开销）
 * - 评测入口 window.__seekvecEval 在 perf/evalApi.ts 中安装（依赖真实 runtime + API）
 * - p50/p95 用线性插值分位数（与 numpy 默认一致），便于和 benchmark 报告对齐
 */
import type { Backend, Dtype, ModelKey } from '../types';
import { getRuntimeConfig, type RuntimeConfig } from '../config/runtimeConfig';
import { useBackendStore } from '../store/backendStore';
import { MODEL_REGISTRY } from '../inference/models';

export type PerfPhase =
  | 'model.download'
  | 'model.init'
  | 'model.total'
  | 'doc.read'
  | 'doc.chunk'
  | 'doc.embed'
  | 'doc.write'
  | 'index.refresh'
  | 'ingest.total'
  | 'query.embed'
  | 'db.search'
  | 'query.http'
  | 'query.e2e';

export const PERF_PHASES: readonly PerfPhase[] = [
  'model.download',
  'model.init',
  'model.total',
  'doc.read',
  'doc.chunk',
  'doc.embed',
  'doc.write',
  'index.refresh',
  'ingest.total',
  'query.embed',
  'db.search',
  'query.http',
  'query.e2e',
];

export interface PerfEvent {
  runId: string;
  phase: PerfPhase;
  /** 阶段耗时 ms */
  ms: number;
  /** 采集时间戳（Date.now()，便于跨进程对齐） */
  ts: number;
  backend?: Backend;
  modelKey?: ModelKey;
  dtype?: Dtype;
  batchSize?: number;
  refreshPolicy?: 'last' | 'each';
  /** true=模型已缓存（warm），false/undefined=cold */
  warm?: boolean;
  /** 阶段附加信息（来源文件、批次下标等） */
  meta?: Record<string, unknown>;
}

export interface PerfEnv {
  ua: string;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  gpuAdapter?: Record<string, string> | null;
  backend: Backend | null;
  backendReason: string | null;
  model: {
    key: ModelKey | null;
    id: string | null;
    revision?: string;
    dtype: Dtype | null;
  };
  /** seekdb 连接信息（web 端可选，由 server /api/health 提供） */
  seekdb?: Record<string, unknown> | null;
}

export interface PhaseSummary {
  n: number;
  p50: number;
  p95: number;
  mean: number;
}

export interface MetricsSummary {
  schemaVersion: 1;
  runId: string;
  count: number;
  /** 只包含有事件的 phase，便于评测脚本读取 */
  phases: Partial<Record<PerfPhase, PhaseSummary>>;
  generatedAt: number;
}

export interface MetricsSnapshot {
  schemaVersion: 1;
  runId: string;
  env: PerfEnv;
  config: RuntimeConfig;
  events: PerfEvent[];
}

interface MetricsContext {
  modelKey?: ModelKey | null;
  dtype?: Dtype | null;
  backend?: Backend | null;
}

const MAX_EVENTS = 2000;

let runId = createRunId();
let events: PerfEvent[] = [];
let enabled = false;
let context: MetricsContext = {};
let seekdbInfo: Record<string, unknown> | null = null;

export function createRunId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `run_${Date.now().toString(36)}_${random}`;
}

/** 当前 runId（clear()/reset 后更换新 runId） */
export function getRunId(): string {
  return runId;
}

export function isMetricsEnabled(): boolean {
  return enabled;
}

/** 手动开关（安装 globals 时按 ?perf=1 打开；单测用） */
export function setMetricsEnabled(value: boolean): void {
  enabled = value;
}

/** 由运行时在模型加载成功后回填上下文，供 env/事件补全 */
export function setMetricsContext(next: MetricsContext): void {
  context = { ...context, ...next };
}

/** 可选：写入 seekdb 健康信息（server /api/health） */
export function setSeekdbInfo(info: Record<string, unknown> | null): void {
  seekdbInfo = info;
}

function roundMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.round(ms * 1000) / 1000;
}

/**
 * 记录一个阶段事件（未启用观测时是 no-op）。
 * 调用方通过 extra 提供事件上下文；未提供的字段从运行时上下文补齐。
 */
export function recordPerf(
  phase: PerfPhase,
  ms: number,
  extra: Omit<Partial<PerfEvent>, 'runId' | 'phase' | 'ms' | 'ts'> = {},
): void {
  if (!enabled) return;
  const store = useBackendStore.getState();
  const event: PerfEvent = {
    runId,
    phase,
    ms: roundMs(ms),
    ts: Date.now(),
    backend: extra.backend ?? context.backend ?? store.actual ?? undefined,
    modelKey: extra.modelKey ?? context.modelKey ?? undefined,
    dtype: extra.dtype ?? context.dtype ?? store.dtype ?? undefined,
    batchSize: extra.batchSize,
    refreshPolicy: extra.refreshPolicy,
    warm: extra.warm,
    meta: extra.meta,
  };
  events.push(event);
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
}

/** 清空事件并开始新的 run（窗口 API clear() 与评测 reset() 都走这里） */
export function clearPerf(): void {
  events = [];
  runId = createRunId();
}

export function getPerfEvents(): readonly PerfEvent[] {
  return events;
}

/** 线性插值分位数：空数组返回 0，单值返回该值 */
export function quantile(sortedValues: readonly number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const clampedQ = Math.min(1, Math.max(0, q));
  const position = (sortedValues.length - 1) * clampedQ;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const weight = position - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight;
}

/** 每 phase 的 n/p50/p95/mean（无事件时 phases 为空对象） */
export function summary(): MetricsSummary {
  const grouped = new Map<PerfPhase, number[]>();
  for (const event of events) {
    const list = grouped.get(event.phase);
    if (list) list.push(event.ms);
    else grouped.set(event.phase, [event.ms]);
  }
  const phases: Partial<Record<PerfPhase, PhaseSummary>> = {};
  for (const [phase, values] of grouped) {
    const sorted = [...values].sort((a, b) => a - b);
    const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    phases[phase] = {
      n: sorted.length,
      p50: roundMs(quantile(sorted, 0.5)),
      p95: roundMs(quantile(sorted, 0.95)),
      mean: roundMs(mean),
    };
  }
  return { schemaVersion: 1, runId, count: events.length, phases, generatedAt: Date.now() };
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildEnv(): PerfEnv {
  const store = useBackendStore.getState();
  const modelKey = context.modelKey ?? null;
  const info = modelKey ? MODEL_REGISTRY[modelKey] : null;
  const nav =
    typeof navigator === 'undefined'
      ? null
      : (navigator as Navigator & { deviceMemory?: number });
  return {
    ua: nav?.userAgent ?? 'node',
    hardwareConcurrency: readNumber(nav?.hardwareConcurrency),
    deviceMemory: readNumber(nav?.deviceMemory),
    gpuAdapter: store.adapterInfo,
    backend: store.actual ?? store.backend,
    backendReason: store.reason,
    model: {
      key: modelKey,
      id: info?.id ?? null,
      revision: info?.revision,
      dtype: context.dtype ?? store.dtype,
    },
    seekdb: seekdbInfo,
  };
}

/** 生成完整快照（环境 + 配置 + 事件） */
export function snapshot(): MetricsSnapshot {
  return {
    schemaVersion: 1,
    runId,
    env: buildEnv(),
    config: getRuntimeConfig(),
    events: [...events],
  };
}

/**
 * 安装 window.__seekvecPerf（仅 ?perf=1）。
 * window.__seekvecEval 的安装在 perf/evalApi.ts，避免 metrics 依赖真实推理链路。
 */
export function installPerfGlobals(): void {
  if (!getRuntimeConfig().perf) return;
  enabled = true;
  if (typeof window === 'undefined') return;
  window.__seekvecPerf = { snapshot, summary, clear: clearPerf };
}

// 模块初始化时按配置决定是否启用（main.tsx 安装 globals 之前也可能已有模型事件）
enabled = getRuntimeConfig().perf;
