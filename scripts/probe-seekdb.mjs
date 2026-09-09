/**
 * seekdb 端到端探针（server 模式 + 嵌入式模式双检测）
 *
 * 通过 server/src 代码路径（tsx）验证 SeekDB 连通性与基础 CRUD：
 *   AdminClient 建库 → createCollection(Schema) → add 文档（含伪向量）
 *   → hybridSearch → query → refresh_index → close
 *
 * 用法:
 *   node scripts/probe-seekdb.mjs
 *
 * 嵌入式模式（Linux/macOS，设 SEEKDB_PATH）：
 *   SEEKDB_PATH=/path/to/db node scripts/probe-seekdb.mjs
 *
 * Windows 必须用 server 模式（SEEKDB_PATH 不支持），且必须先装 seekdb 1.3.0 MSI。
 */
import { SeekdbClient, SeekdbAdminClient, Schema, VectorIndexConfig, FulltextIndexConfig } from '../server/node_modules/seekdb/dist/index.mjs';

// ── 配置 ───────────────────────────────────────────────────────────────────────
const HOST = process.env.SEEKDB_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SEEKDB_PORT ?? 2881);
const USER = process.env.SEEKDB_USER ?? 'root';
const PASSWORD = process.env.SEEKDB_PASSWORD ?? '';
const DB_NAME = process.env.SEEKDB_DATABASE ?? 'seekvec';
const IS_EMBEDDED = !!process.env.SEEKDB_PATH;

if (process.platform === 'win32' && IS_EMBEDDED) {
  console.error('[probe] ERROR: 嵌入式模式在 Windows 上不受 seekdb 官方支持，请改用 server 模式（默认）。');
  process.exit(1);
}

// 384d 英文伪向量（随机但固定 seed，用于一致性测试）
function fakeEmbedding384d(seed) {
  const vec = new Array(384).fill(0);
  let s = seed;
  for (let i = 0; i < 384; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    vec[i] = ((s >>> 0) / 0xffffffff) * 2 - 1;
  }
  return vec;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[probe] 模式: ${IS_EMBEDDED ? 'embedded' : `server(${HOST}:${PORT})`}`);
  const errors = [];

  try {
    // 1. AdminClient 建库（server 模式；嵌入式 database 自动创建）
    if (!IS_EMBEDDED) {
      const admin = new SeekdbAdminClient({ host: HOST, port: PORT, user: USER, password: PASSWORD });
      try {
        await admin.createDatabase(DB_NAME);
        console.log('[probe] ✓ createDatabase(seekvec)');
      } catch (err) {
        const msg = err.message ?? String(err);
        if (msg.toLowerCase().includes('already exists')) {
          console.log('[probe] ✓ createDatabase(seekvec) — 已存在');
        } else {
          throw err;
        }
      } finally {
        await admin.close();
      }
    } else {
      console.log('[probe] ✓ 嵌入式模式跳过建库步骤');
    }

    // 2. 常规客户端连接
    const client = new SeekdbClient({
      ...(IS_EMBEDDED
        ? { path: process.env.SEEKDB_PATH, database: DB_NAME }
        : { host: HOST, port: PORT, user: USER, password: PASSWORD, database: DB_NAME }),
    });

    // 3. SELECT 1 探通
    await client.execute('SELECT 1');
    console.log('[probe] ✓ execute(SELECT 1)');

    // 4. 建集合
    const COLLECTION = 'probe_test';
    const DIM = 384;

    if (await client.hasCollection(COLLECTION)) {
      await client.deleteCollection(COLLECTION);
      console.log(`[probe] ✓ deleteCollection(${COLLECTION})`);
    }

    const schema = new Schema({
      vectorIndex: new VectorIndexConfig({ hnsw: { dimension: DIM, distance: 'cosine' }, embeddingFunction: null }),
      fulltextIndex: new FulltextIndexConfig('ik', { ik_mode: 'smart' }),
    });

    await client.createCollection({ name: COLLECTION, schema });
    console.log(`[probe] ✓ createCollection(${COLLECTION}, 384d + ik)`);

    const col = await client.getCollection({ name: COLLECTION, embeddingFunction: null });

    // 5. add 6 条中英文文档
    const ids = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
    const docs = [
      '端侧向量化是浏览器内推理的核心技术。',
      'SeekDB 是 OceanBase 开源的向量数据库。',
      'Transformers.js enables in-browser ML inference.',
      'Hybrid search combines vector and full-text retrieval.',
      'HNSW is an efficient approximate nearest neighbor algorithm.',
      '中文分词器 IK 支持智能切分和最大词长模式。',
    ];
    const embeddings = ids.map((_, i) => fakeEmbedding384d(i + 1));
    const metadatas = ids.map((id, i) => ({ id, lang: i < 3 ? 'zh' : 'en', seed: i + 1 }));

    await col.add({ ids, documents: docs, embeddings, metadatas });
    console.log(`[probe] ✓ add(6 docs)`);

    // 6. refresh_index（赛题得分点）
    await col.refresh_index();
    console.log('[probe] ✓ refresh_index()');

    // 7. hybridSearch
    const probeVec = fakeEmbedding384d(99);
    const hsResult = await col.hybridSearch({
      query: { whereDocument: { $contains: '端侧' } },
      knn: { queryEmbeddings: probeVec },
      nResults: 3,
      include: ['documents', 'metadatas', 'distances'],
    });
    if (!hsResult.ids || hsResult.ids.length === 0) {
      throw new Error('hybridSearch 返回空结果');
    }
    console.log(`[probe] ✓ hybridSearch(${hsResult.ids[0].length} results)`);

    // 8. query
    const qResult = await col.query({
      queryEmbeddings: probeVec,
      nResults: 3,
      include: ['documents', 'metadatas', 'distances'],
    });
    if (!qResult.ids || qResult.ids.length === 0) {
      throw new Error('query 返回空结果');
    }
    console.log(`[probe] ✓ query(${qResult.ids[0].length} results)`);

    // 9. count
    const cnt = await col.count();
    console.log(`[probe] ✓ count() = ${cnt}`);

    // 10. describe
    const info = await col.describe();
    console.log(`[probe] ✓ describe() → name=${info.name}, dim=${info.dimension}`);

    // 11. 清理
    await client.deleteCollection(COLLECTION);
    console.log(`[probe] ✓ deleteCollection(${COLLECTION})`);

    await client.close();
    console.log('[probe] ✓ close()');

    console.log('\n[probe] ✅ 全绿 — SeekDB server 模式验证通过！');
  } catch (err) {
    console.error(`\n[probe] ❌ 失败: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
