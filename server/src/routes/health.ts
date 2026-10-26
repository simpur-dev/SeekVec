/**
 * GET /api/health
 *
 * 轻量探活：`SELECT 1` + `SELECT VERSION()`，结果缓存 5 秒（`?deep=1` 强制打穿缓存）。
 * seekdb 不可达时仍返回 HTTP 200，但 `status:'degraded'`、`seekdb.reachable=false`，
 * 让前端/验收脚本可以区分「server 活着但 DB 挂了」与「server 挂了」。
 *
 * refreshIndexSupported：SDK 的 refresh_index() 要求 seekdb ≥ 1.3.0
 * （CALL dbms_index_manager.refresh()），这里按 VERSION() 解析结果判断，
 * 规则与 seekdb SDK 内部的 parseSemver / MIN_REFRESH_INDEX_VERSION 对齐。
 */
import { Router } from 'express';
import { getClient, retryOnConnectionError } from '../db/client.js';
import { asyncHandler } from './errors.js';
import { isDeepProbe } from './validation.js';
import { elapsedMs, nowMs } from '../util/timing.js';
import type { HealthResponse, HealthSeekdbStatus } from '../types.js';

/** 健康检查缓存时长 */
export const HEALTH_CACHE_TTL_MS = 5_000;
/** SDK 的 MIN_REFRESH_INDEX_VERSION（seekdb 1.3.0 起支持 refresh_index） */
export const MIN_REFRESH_INDEX_VERSION: SemverTriple = [1, 3, 0];

export type SemverTriple = [number, number, number];

/** seekdb 版本串形如 `5.7.25-OceanBase_SeekDB-v1.4.0.0` 时优先取 seekdb 语义版本 */
const SEEKDB_VERSION_RE = /seekdb(?:[-_\s]*v)?[-_\s]*(\d+)\.(\d+)\.(\d+)/i;

/** 解析版本串为 [major, minor, patch]；无法解析返回 null（与 SDK 逻辑一致） */
export function parseSeekdbSemver(versionText: string): SemverTriple | null {
  const text = versionText.trim();
  if (/seekdb/i.test(text)) {
    const seekdbMatch = text.match(SEEKDB_VERSION_RE);
    if (!seekdbMatch) return null;
    return [Number(seekdbMatch[1]), Number(seekdbMatch[2]), Number(seekdbMatch[3])];
  }
  const matches = [...text.matchAll(/(\d+)\.(\d+)\.(\d+)/g)];
  if (matches.length !== 1) return null;
  const [, major, minor, patch] = matches[0];
  return [Number(major), Number(minor), Number(patch)];
}

export function compareSemver(left: SemverTriple, right: SemverTriple): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** 版本是否支持 refresh_index（对应 seekdb SDK Collection.refresh_index） */
export function isRefreshIndexSupported(version: string | null): boolean {
  if (!version) return false;
  const parsed = parseSeekdbSemver(version);
  if (!parsed) return false;
  return compareSemver(parsed, MIN_REFRESH_INDEX_VERSION) >= 0;
}

function unwrapVersionValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const candidates = ['version', 'VERSION', 'varchar', 'VARCHAR', 'text', 'TEXT'];
    for (const key of candidates) {
      const wrapped = record[key];
      if (typeof wrapped === 'string' || typeof wrapped === 'number') {
        return String(wrapped);
      }
    }
  }
  return null;
}

/** 从 `SELECT VERSION()` 的行结果里提取版本串 */
export function extractVersionFromRows(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const rowList = rows as Array<Record<string, unknown>>;
  // 优先取列名含 version 的列
  for (const row of rowList) {
    for (const [key, value] of Object.entries(row)) {
      if (!key.toLowerCase().includes('version')) continue;
      const text = unwrapVersionValue(value);
      if (text) return text;
    }
  }
  // 兜底：任意可解析为语义版本的列
  for (const row of rowList) {
    for (const value of Object.values(row)) {
      const text = unwrapVersionValue(value);
      if (text && parseSeekdbSemver(text)) return text;
    }
  }
  return null;
}

/** 真正打一次 seekdb 探活（不做缓存、不抛错） */
export async function probeSeekdb(): Promise<HealthResponse> {
  const startedAt = nowMs();
  try {
    // getClient 的 isConnected 仅是 SDK 内部状态；容器重建后可能仍是 stale client。
    // 与业务路由一致：连接错误时重建连接并重试一次，避免重启后健康检查一直 degraded。
    const rows = await retryOnConnectionError(async () => {
      const client = await getClient();
      await client.execute('SELECT 1');
      return client.execute('SELECT VERSION() AS version');
    });
    const version = extractVersionFromRows(rows);
    const seekdb: HealthSeekdbStatus = {
      reachable: true,
      latencyMs: elapsedMs(startedAt),
      version,
      refreshIndexSupported: isRefreshIndexSupported(version),
    };
    return { status: 'ok', ts: Date.now(), seekdb };
  } catch {
    const seekdb: HealthSeekdbStatus = {
      reachable: false,
      latencyMs: elapsedMs(startedAt),
      version: null,
      refreshIndexSupported: false,
    };
    return { status: 'degraded', ts: Date.now(), seekdb };
  }
}

/**
 * 健康检查路由（每个 app 实例一份缓存，测试互不影响）
 * - 默认命中 5s 缓存
 * - `?deep=1` / `?deep=true` 强制实时探活
 */
export function createHealthRouter(): Router {
  const router = Router();
  let cachedAt = 0;
  let cached: HealthResponse | null = null;

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const deep = isDeepProbe(req.query.deep);
      if (!deep && cached && Date.now() - cachedAt < HEALTH_CACHE_TTL_MS) {
        res.json(cached);
        return;
      }
      const payload = await probeSeekdb();
      // 只缓存健康结果：seekdb 重启/恢复后不应被旧的 degraded 结果阻塞 5 秒。
      if (payload.status === 'ok') {
        cached = payload;
        cachedAt = Date.now();
      } else {
        cached = null;
        cachedAt = 0;
      }
      res.json(payload);
    }),
  );

  return router;
}
