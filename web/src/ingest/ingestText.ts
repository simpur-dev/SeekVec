/**
 * 文本导入核心流程（与 React 解耦，供 useIngest 与 window.__seekvecEval 共用）
 *
 * 流程（进度阶段与实际时序一致）：
 *   1) reading  读文件 → 分块（确定性 chunk id，重复导入幂等）
 *   2) reading  确保集合存在（created=true → 后续 mode=insert，否则 upsert）
 *   3) embedding 端侧向量化（按 batch 配置分批）
 *   4) writing  按 batch 写入 SeekDB（refresh=last 只在最后一批刷新索引；each 每批刷新）
 *   5) writing  按 source 清理陈旧 chunk（文件变短/改写后旧 id 不该残留）
 *   6) done     回填计数、登记集合、设为 activeCollection
 *
 * 错误处理：
 * - 失败且已有批次写入时调用 refreshCollection 补偿（尽量让已写入数据可检索），再抛原始错误
 * - 清理/补偿失败只记警告，不掩盖主流程错误
 */
import type { ModelKey } from '../types';
import type { RefreshPolicy } from '../config/runtimeConfig';
import { chunkText } from '../inference/chunk';
import { chunkId } from '../utils/id';
import { chunkArray } from '../utils/perf';
import { readTextFile } from '../utils/fileReader';
import {
  ensureCollection,
  ingestDocuments,
  getCount,
  listDocumentIds,
  deleteDocuments,
  refreshCollection,
} from '../db/api';
import { recordPerf } from '../perf/metrics';
import { useKbStore, type IngestStatus } from '../store/kbStore';

export interface IngestTimes {
  readMs: number;
  chunkMs: number;
  embedMs: number;
  writeMs: number;
  refreshMs: number;
  cleanupMs: number;
  totalMs: number;
}

export interface IngestOutcome {
  count: number;
  times: IngestTimes;
  collectionName: string;
  mode: 'upsert' | 'insert';
  created: boolean;
  refreshed: boolean;
  cleanupDeleted: number;
}

export interface IngestProgress {
  total: number;
  done: number;
}

export interface IngestTextOptions {
  files: File[];
  collectionName: string;
  modelKey: ModelKey;
  embed: (texts: string[]) => Promise<number[][]>;
  /** 批大小（?batch=，默认 16） */
  batch: number;
  /** 索引刷新策略（?refresh=） */
  refresh: RefreshPolicy;
  /** 状态回调（useIngest 用它更新 kbStore 进度） */
  onStatus?: (status: IngestStatus, progress?: IngestProgress) => void;
}

interface ChunkRecord {
  id: string;
  text: string;
  source: string;
  chunkIndex: number;
}

/** 单请求删除 id 上限（server 校验 ids ≤ 512） */
const MAX_DELETE_IDS = 512;

let busy = false;

export function isIngestBusy(): boolean {
  return busy;
}

function createTimes(): IngestTimes {
  return {
    readMs: 0,
    chunkMs: 0,
    embedMs: 0,
    writeMs: 0,
    refreshMs: 0,
    cleanupMs: 0,
    totalMs: 0,
  };
}

/**
 * 导入一批文本文件到指定集合。
 * 并发导入会被拒绝（busy 标记），避免同一集合交叉写入导致进度/计数错乱。
 */
export async function ingestTextFiles(options: IngestTextOptions): Promise<IngestOutcome> {
  const { files, collectionName, modelKey, embed, refresh, onStatus } = options;
  const batchSize = Math.max(1, Math.floor(options.batch));
  if (files.length === 0) throw new Error('没有待导入的文件');
  if (busy) throw new Error('已有导入任务进行中，请等待完成');

  busy = true;
  const times = createTimes();
  const startedAt = performance.now();
  let wroteAnyBatch = false;
  let refreshed = false;
  let created = false;
  let mode: 'upsert' | 'insert' = 'upsert';
  let wroteCount = 0;
  let cleanupDeleted = 0;

  try {
    // ── 1) 读取 + 分块 ─────────────────────────────────────────
    onStatus?.('reading', { total: files.length, done: 0 });
    const chunksById = new Map<string, ChunkRecord>();
    const idsBySource = new Map<string, Set<string>>();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const readStart = performance.now();
      const text = await readTextFile(file);
      const readMs = performance.now() - readStart;
      times.readMs += readMs;
      recordPerf('doc.read', readMs, {
        meta: { source: file.name, bytes: file.size },
      });

      const chunkStart = performance.now();
      const chunks = chunkText(text);
      const chunkMs = performance.now() - chunkStart;
      times.chunkMs += chunkMs;
      recordPerf('doc.chunk', chunkMs, {
        meta: { source: file.name, chunks: chunks.length },
      });

      let sourceIds = idsBySource.get(file.name);
      if (!sourceIds) {
        sourceIds = new Set<string>();
        idsBySource.set(file.name, sourceIds);
      }
      chunks.forEach((chunk, chunkIndex) => {
        const id = chunkId(file.name, chunkIndex, chunk.text);
        sourceIds!.add(id);
        if (!chunksById.has(id)) {
          chunksById.set(id, { id, text: chunk.text, source: file.name, chunkIndex });
        }
      });

      onStatus?.('reading', { total: files.length, done: i + 1 });
    }

    const uniqueChunks = [...chunksById.values()];
    const totalChunks = uniqueChunks.length;
    if (totalChunks === 0) {
      throw new Error('没有可导入的文本内容（分块结果为空）');
    }

    // ── 2) 确保集合存在 ─────────────────────────────────────────
    const ensured = await ensureCollection(collectionName, modelKey);
    created = Boolean(ensured.created);
    // ensureCollection 返回 number，窄化为模型维度类型
    const dimension: 384 | 512 = ensured.dimension === 384 ? 384 : 512;
    mode = created ? 'insert' : 'upsert';
    const kb = useKbStore.getState();
    kb.registerCollection({
      name: collectionName,
      modelKey,
      dimension,
      modality: 'text',
      count: created ? 0 : (kb.counts[collectionName] ?? null),
    });

    // ── 3) 端侧向量化 ──────────────────────────────────────────
    onStatus?.('embedding', { total: totalChunks, done: 0 });
    const batches = chunkArray(uniqueChunks, batchSize);
    const vectors: number[][] = [];
    let embedded = 0;
    for (let b = 0; b < batches.length; b++) {
      const batchItems = batches[b];
      const embedStart = performance.now();
      const batchVectors = await embed(batchItems.map((chunk) => chunk.text));
      const embedMs = performance.now() - embedStart;
      times.embedMs += embedMs;
      recordPerf('doc.embed', embedMs, {
        batchSize: batchItems.length,
        refreshPolicy: refresh,
        meta: { items: batchItems.length, batchIndex: b, batches: batches.length },
      });
      vectors.push(...batchVectors);
      embedded += batchItems.length;
      onStatus?.('embedding', { total: totalChunks, done: embedded });
    }
    if (vectors.length !== uniqueChunks.length) {
      throw new Error(
        `embedding 返回数量（${vectors.length}）与分块数量（${uniqueChunks.length}）不一致`,
      );
    }

    // ── 4) 写入 SeekDB（索引刷新策略：last / each） ─────────────
    onStatus?.('writing', { total: totalChunks, done: 0 });
    let written = 0;
    for (let b = 0; b < batches.length; b++) {
      const batchItems = batches[b];
      const shouldRefresh = refresh === 'each' || b === batches.length - 1;
      const writeStart = performance.now();
      const response = await ingestDocuments({
        collectionName,
        ids: batchItems.map((chunk) => chunk.id),
        documents: batchItems.map((chunk) => chunk.text),
        embeddings: batchItems.map((chunk, index) => vectors[written + index]),
        metadatas: batchItems.map((chunk) => ({
          source: chunk.source,
          chunkIndex: chunk.chunkIndex,
        })),
        mode,
        refreshIndex: shouldRefresh,
      });
      const writeMs = performance.now() - writeStart;
      times.writeMs += writeMs;
      const refreshMs = response.timings?.refreshMs;
      if (shouldRefresh && typeof refreshMs === 'number') {
        times.refreshMs += refreshMs;
        recordPerf('index.refresh', refreshMs, {
          refreshPolicy: refresh,
          meta: { batchIndex: b, mode, serverTiming: true },
        });
      }
      recordPerf('doc.write', writeMs, {
        batchSize: batchItems.length,
        refreshPolicy: refresh,
        meta: {
          items: batchItems.length,
          batchIndex: b,
          batches: batches.length,
          mode,
          refreshed: shouldRefresh,
          serverTiming: typeof refreshMs === 'number',
          serverTotalMs: response.timings?.totalMs,
        },
      });
      wroteAnyBatch = true;
      refreshed = refreshed || shouldRefresh;
      wroteCount += response.count ?? batchItems.length;
      written += batchItems.length;
      onStatus?.('writing', { total: totalChunks, done: written });
    }

    // ── 5) 按 source 清理陈旧 chunk（旧版本遗留的 id）────────────
    onStatus?.('writing', { total: totalChunks, done: totalChunks });
    const cleanupStart = performance.now();
    for (const [source, newIds] of idsBySource) {
      try {
        const existing = await listDocumentIds(collectionName, source);
        const staleIds = existing.ids.filter((id) => !newIds.has(id));
        for (const idsBatch of chunkArray(staleIds, MAX_DELETE_IDS)) {
          const result = await deleteDocuments(collectionName, { ids: idsBatch });
          cleanupDeleted += result.deleted ?? idsBatch.length;
        }
      } catch (err) {
        // 老 server 可能还没有 /api/documents 查询/删除接口：降级为警告，不中断导入
        console.warn(`[ingest] 清理 source=${source} 的陈旧分块失败`, err);
      }
    }
    times.cleanupMs = performance.now() - cleanupStart;

    // 有陈旧分块被删除时补一次索引刷新，保证删除在索引中生效（检索不再返回旧 id）
    if (cleanupDeleted > 0) {
      try {
        const cleanupRefreshStart = performance.now();
        const cleanupRefresh = await refreshCollection(collectionName);
        const refreshMs =
          cleanupRefresh.timings?.refreshMs ?? performance.now() - cleanupRefreshStart;
        times.refreshMs += refreshMs;
        refreshed = true;
        recordPerf('index.refresh', refreshMs, {
          refreshPolicy: refresh,
          meta: {
            op: 'after-cleanup',
            deleted: cleanupDeleted,
            serverTiming: typeof cleanupRefresh.timings?.refreshMs === 'number',
          },
        });
      } catch (err) {
        console.warn('[ingest] 清理陈旧分块后的索引刷新失败', err);
      }
    }

    // ── 6) 收尾：计数 / 登记 / 设 active ────────────────────────
    const total = await getCount(collectionName);
    times.totalMs = performance.now() - startedAt;
    useKbStore.getState().setCount(collectionName, total);
    useKbStore.getState().registerCollection({
      name: collectionName,
      modelKey,
      dimension,
      modality: 'text',
      count: total,
    });
    useKbStore.getState().setActiveCollection(collectionName);
    onStatus?.('done', { total: totalChunks, done: totalChunks });

    recordPerf('ingest.total', times.totalMs, {
      batchSize,
      refreshPolicy: refresh,
      meta: {
        files: files.length,
        chunks: totalChunks,
        count: wroteCount,
        mode,
        created,
        refreshed,
        cleanupDeleted,
        times: { ...times },
      },
    });

    return {
      count: wroteCount,
      times,
      collectionName,
      mode,
      created,
      refreshed,
      cleanupDeleted,
    };
  } catch (err) {
    // 失败补偿：已有写入时尝试刷新索引，让已写入的数据仍可被检索
    if (wroteAnyBatch) {
      try {
        const compensation = await refreshCollection(collectionName);
        recordPerf('index.refresh', compensation.timings?.refreshMs ?? 0, {
          meta: { op: 'compensate-on-failure', collectionName },
        });
      } catch (refreshErr) {
        console.warn('[ingest] 失败后补偿刷新索引也失败', refreshErr);
      }
    }
    recordPerf('ingest.total', performance.now() - startedAt, {
      batchSize,
      refreshPolicy: refresh,
      meta: { failed: true, error: (err as Error).message, count: wroteCount },
    });
    onStatus?.('error');
    throw err;
  } finally {
    busy = false;
  }
}
