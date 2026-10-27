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
  listDocumentItems,
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

/**
 * 索引刷新脏标记（per collection）。
 * 场景：写入已成功但 refresh 失败时，下一次“内容完全相同”的幂等导入会走
 * “无变化 → 不写/不刷新”路径，导致数据永远检不到。这里记录失败集合，
 * 下一次导入即使无变化也强制补一次 refresh。
 */
const pendingRefresh = new Set<string>();
const PENDING_REFRESH_STORAGE_KEY = 'seekvec:pendingRefresh';

function loadPendingRefresh(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(PENDING_REFRESH_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    // localStorage 不可用/损坏时退化为内存态
  }
  return new Set<string>();
}

function persistPendingRefresh(): void {
  try {
    globalThis.localStorage?.setItem(PENDING_REFRESH_STORAGE_KEY, JSON.stringify([...pendingRefresh]));
  } catch {
    // 隐私模式等场景不阻断导入
  }
}

for (const name of loadPendingRefresh()) pendingRefresh.add(name);

function markRefreshDirty(name: string): void {
  pendingRefresh.add(name);
  persistPendingRefresh();
}

function markRefreshClean(name: string): void {
  if (!pendingRefresh.delete(name)) return;
  persistPendingRefresh();
}

/** 供测试/诊断：某集合是否有未完成的刷新 */
export function hasPendingRefresh(name: string): boolean {
  return pendingRefresh.has(name);
}

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
  let collectionReady = false;
  const refreshWasPending = pendingRefresh.has(collectionName);

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
    collectionReady = true;
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

    // ── 2.5) 增量识别：复用集合时一次取回 id+source ──────────────
    // 优化（增量导入）：chunk id 由内容确定，id 已存在说明内容未变；
    // 只对「新增/变化」的 chunk 做 embedding 与写入，重复导入不再重算全量。
    let existingItems: Array<{ id: string; source?: string }> | null = created ? [] : null;
    if (!created && existingItems === null) {
      try {
        const listed = await listDocumentItems(collectionName);
        if (Array.isArray(listed.items)) existingItems = listed.items;
      } catch {
        // 旧 server 不支持 withSource：退化为全量 embedding/写入 + 逐 source 清理
      }
    }
    const existingIdSet = new Set((existingItems ?? []).map((item) => item.id));
    const chunksToWrite = existingItems
      ? uniqueChunks.filter((chunk) => !existingIdSet.has(chunk.id))
      : uniqueChunks;
    const skippedUnchanged = totalChunks - chunksToWrite.length;

    // 提前计算陈旧块：若本次会删除旧 chunk，则把索引刷新推迟到清理之后，
    // 避免「写末批刷新 + 清理后刷新」两次全量刷新（旧实现最坏 +0.5–0.8s）。
    let staleIdsToDelete: string[] = [];
    if (!created && existingItems) {
      const existingBySource = new Map<string, string[]>();
      for (const item of existingItems) {
        if (!item.source) continue;
        const list = existingBySource.get(item.source);
        if (list) list.push(item.id);
        else existingBySource.set(item.source, [item.id]);
      }
      for (const [source, newIds] of idsBySource) {
        for (const existingId of existingBySource.get(source) ?? []) {
          if (!newIds.has(existingId)) staleIdsToDelete.push(existingId);
        }
      }
    }
    const deferRefreshToCleanup = staleIdsToDelete.length > 0 && refresh !== 'each';

    // ── 3) 端侧向量化（仅新增/变化 chunk）──────────────────────
    onStatus?.('embedding', { total: totalChunks, done: skippedUnchanged });
    // 批次 padding 的廉价代理：UTF-8 字节长度比 UTF-16 字符长度更接近 BGE tokenizer
    // 的实际 token 数（中文 3 字节、ASCII 1 字节；tokenizer 模拟中 padding 开销约 10%→4%）。
    // 写入仍按原始文件顺序分批；仅 embedding 顺序按字节长度分桶。
    const utf8 = new TextEncoder();
    const writeBatches = chunkArray(chunksToWrite, batchSize);
    const embedItems = chunksToWrite
      .map((chunk) => ({ chunk, order: utf8.encode(chunk.text).length }))
      .sort((a, b) => a.order - b.order);
    const embedBatches = chunkArray(embedItems, batchSize);
    const vectorsById = new Map<string, number[]>();
    let embedded = 0;
    for (let b = 0; b < embedBatches.length; b++) {
      const batchItems = embedBatches[b];
      const embedStart = performance.now();
      const batchVectors = await embed(batchItems.map((item) => item.chunk.text));
      const embedMs = performance.now() - embedStart;
      times.embedMs += embedMs;
      if (batchVectors.length !== batchItems.length) {
        throw new Error(
          `embedding 返回数量（${batchVectors.length}）与批内分块数量（${batchItems.length}）不一致`,
        );
      }
      batchItems.forEach((item, index) => {
        vectorsById.set(item.chunk.id, batchVectors[index]);
      });
      embedded += batchItems.length;
      recordPerf('doc.embed', embedMs, {
        batchSize: batchItems.length,
        refreshPolicy: refresh,
        meta: {
          items: batchItems.length,
          batchIndex: b,
          batches: embedBatches.length,
          skippedUnchanged,
          paddingBucket: 'utf8-bytes',
          maxBytes: batchItems[batchItems.length - 1]?.order ?? 0,
        },
      });
      onStatus?.('embedding', { total: totalChunks, done: skippedUnchanged + embedded });
    }

    // ── 4) 写入 SeekDB（索引刷新策略：last / each） ─────────────
    onStatus?.('writing', { total: totalChunks, done: skippedUnchanged });
    let written = 0;
    for (let b = 0; b < writeBatches.length; b++) {
      const batchItems = writeBatches[b];
      const shouldRefresh = refresh === 'each' || (b === writeBatches.length - 1 && !deferRefreshToCleanup);
      const writeStart = performance.now();
      const response = await ingestDocuments({
        collectionName,
        ids: batchItems.map((chunk) => chunk.id),
        documents: batchItems.map((chunk) => chunk.text),
        embeddings: batchItems.map((chunk) => {
          const vector = vectorsById.get(chunk.id);
          if (!vector) throw new Error(`缺少分块 ${chunk.id} 的 embedding 结果`);
          return vector;
        }),
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
      if (shouldRefresh) markRefreshClean(collectionName);
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
          batches: writeBatches.length,
          mode,
          skippedUnchanged,
          refreshed: shouldRefresh,
          serverTiming: typeof refreshMs === 'number',
          serverTotalMs: response.timings?.totalMs,
        },
      });
      wroteAnyBatch = true;
      refreshed = refreshed || shouldRefresh;
      wroteCount += response.count ?? batchItems.length;
      written += batchItems.length;
      onStatus?.('writing', { total: totalChunks, done: skippedUnchanged + written });
    }

    // ── 5) 按 source 清理陈旧 chunk（旧版本遗留的 id）────────────
    // 优化：
    //   - 新建空集合（created=true）不可能有陈旧块，直接跳过；
    //   - 复用旧集合时用 withSource=1 一次拿全量 id+source 在内存对比，
    //     避免逐文件 list（120 文件曾产生 120 次 HTTP 往返，占导入耗时 ~1.4s）；
    //   - 一次批量删除 + 最多一次刷新；无删除则不刷新。
    onStatus?.('writing', { total: totalChunks, done: totalChunks });
    const cleanupStart = performance.now();
    if (!created) {
      let allItems = existingItems;
      if (!allItems) {
        try {
          const listed = await listDocumentItems(collectionName);
          if (Array.isArray(listed.items)) allItems = listed.items;
        } catch {
          // 旧 server 不支持 withSource：回退逐 source 清理
        }
      }

      if (allItems) {
        // 只清理本次导入涉及的 source；未涉及的文件/集合内容保持不动。
        // existingItems 路径已在写入前算好 stale，复用避免重复比较。
        let staleIds: string[] = staleIdsToDelete;
        if (!existingItems) {
          const existingBySource = new Map<string, string[]>();
          for (const item of allItems) {
            if (!item.source) continue;
            const list = existingBySource.get(item.source);
            if (list) list.push(item.id);
            else existingBySource.set(item.source, [item.id]);
          }
          staleIds = [];
          for (const [source, newIds] of idsBySource) {
            for (const existingId of existingBySource.get(source) ?? []) {
              if (!newIds.has(existingId)) staleIds.push(existingId);
            }
          }
        }
        try {
          for (const idsBatch of chunkArray(staleIds, MAX_DELETE_IDS)) {
            const result = await deleteDocuments(collectionName, { ids: idsBatch });
            cleanupDeleted += result.deleted ?? idsBatch.length;
          }
        } catch (err) {
          console.warn('[ingest] 批量清理陈旧分块失败', err);
        }
      } else {
        // 兼容路径：旧 server / 旧接口
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
      }
    }
    times.cleanupMs = performance.now() - cleanupStart;

    // 有陈旧分块被删除时补一次索引刷新，保证删除在索引中生效（检索不再返回旧 id）。
    // 若写入末批因「预计有清理」而推迟刷新，但清理实际未删掉任何行（例如删除失败），
    // 这里兜底刷新一次，保证已写入的新数据可检索。
    // 关键：刷新失败不能吞掉——否则会向调用方返回“导入成功”，但新写入/删除可能不可检索。
    let cleanupRefreshError: unknown = null;
    if (cleanupDeleted > 0 || (deferRefreshToCleanup && wroteAnyBatch && !refreshed)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const cleanupRefreshStart = performance.now();
          const cleanupRefresh = await refreshCollection(collectionName);
          const refreshMs =
            cleanupRefresh.timings?.refreshMs ?? performance.now() - cleanupRefreshStart;
          times.refreshMs += refreshMs;
          refreshed = true;
          markRefreshClean(collectionName);
          cleanupRefreshError = null;
          recordPerf('index.refresh', refreshMs, {
            refreshPolicy: refresh,
            meta: {
              op: 'after-cleanup',
              deleted: cleanupDeleted,
              deferredWriteRefresh: deferRefreshToCleanup,
              attempt,
              serverTiming: typeof cleanupRefresh.timings?.refreshMs === 'number',
            },
          });
          break;
        } catch (err) {
          cleanupRefreshError = err;
          markRefreshDirty(collectionName);
          console.warn(
            `[ingest] 清理陈旧分块后的索引刷新失败（attempt ${attempt + 1}/2），` +
              '数据可能尚不可检索',
            err,
          );
        }
      }
    }
    if (cleanupRefreshError) {
      throw new Error(
        '清理后索引刷新失败，无法保证本轮新增/删除数据可检索；请重试导入或检查 seekdb 后手动刷新。',
      );
    }

    // 上一次导入写入成功但刷新失败：即使本次内容完全相同（无写入/无清理），
    // 也必须补一次刷新，否则部分数据可能永久不可检索。
    if (refreshWasPending && !refreshed) {
      try {
        const retryRefreshStart = performance.now();
        const retryRefresh = await refreshCollection(collectionName);
        const refreshMs = retryRefresh.timings?.refreshMs ?? performance.now() - retryRefreshStart;
        times.refreshMs += refreshMs;
        refreshed = true;
        markRefreshClean(collectionName);
        recordPerf('index.refresh', refreshMs, {
          refreshPolicy: refresh,
          meta: { op: 'retry-pending-refresh', serverTiming: true },
        });
      } catch (err) {
        markRefreshDirty(collectionName);
        throw new Error(
          `补刷新失败，集合 ${collectionName} 仍有未建索引的数据；请检查 seekdb 后重试。`,
        );
      }
    }
    markRefreshClean(collectionName);

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
    if (collectionReady && !refreshed) markRefreshDirty(collectionName);
    // 失败补偿：已有写入时尝试刷新索引，让已写入的数据仍可被检索
    if (wroteAnyBatch) {
      try {
        const compensation = await refreshCollection(collectionName);
        markRefreshClean(collectionName);
        recordPerf('index.refresh', compensation.timings?.refreshMs ?? 0, {
          meta: { op: 'compensate-on-failure', collectionName },
        });
      } catch (refreshErr) {
        markRefreshDirty(collectionName);
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
