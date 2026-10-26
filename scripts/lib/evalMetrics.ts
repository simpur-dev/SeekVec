/**
 * 检索质量指标（纯函数，无 I/O、无副作用）
 *
 * 统一口径（与 `data/eval/README.md`、`scripts/eval-quality.ts` 保持一致）：
 * - 相关性等级 rel ∈ {0,1,2,3}，rel ≥ 1 视为「相关」；未标注的文档按 0 处理（pooled judgment）。
 * - 排序输入 rankedIds 应是「候选 id 的有序列表」（越靠前越相关）。
 *   若列表里出现重复 id，只保留**首次出现**的位置，后续重复项忽略（重复不会增加收益）。
 * - K 先向下取整；K ≤ 0、空排序、空相关集时指标为 0（不抛异常）。
 * - 所有函数均为 macro 平均的「单条查询」实现，跨查询平均由调用方完成。
 *
 * 为什么不用浮点阈值：输入只有 id 与等级，指标结果是确定性的有理数，
 * 单测可直接断言精确值或 1e-12 精度。
 */

/** 相关 id 集合：既接受 Set，也接受数组（内部会去重） */
export type IdSet = ReadonlySet<string> | readonly string[];

/** 分级相关映射：id -> rel（0-3；缺省视为 0；负值/非有限值按 0 处理） */
export type GradedMap = ReadonlyMap<string, number> | Readonly<Record<string, number>>;

/** 相关性等级上限（gain=2^rel−1；防御异常输入导致 Infinity） */
const MAX_GRADE = 10;

function toIdSet(input: IdSet): Set<string> {
  return input instanceof Set ? new Set(input) : new Set(input);
}

function toGradedMap(input: GradedMap): Map<string, number> {
  if (input instanceof Map) return new Map(input);
  return new Map(Object.entries(input));
}

function normalizeGrade(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(MAX_GRADE, Math.max(0, value));
}

/** 去掉排在后面重复出现的 id，保留首次出现顺序 */
function dedupeIds(rankedIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of rankedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function clampK(k: number): number {
  if (!Number.isFinite(k)) return 0;
  const kk = Math.floor(k);
  return kk > 0 ? kk : 0;
}

/**
 * Recall@K：前 K 个结果中命中的相关 id 数 / 相关 id 总数。
 *
 * - 分母是相关 id 的**全部**数量（不因 K 截断），取值 [0,1]；
 * - 空相关集或 K ≤ 0 返回 0；
 * - 排序里的重复 id 只计首次，即重复项不占 K 名额。
 */
export function recallAtK(rankedIds: readonly string[], relevantSet: IdSet, k: number): number {
  const kk = clampK(k);
  const total = toIdSet(relevantSet);
  if (kk === 0 || total.size === 0) return 0;
  const top = dedupeIds(rankedIds).slice(0, kk);
  let hit = 0;
  for (const id of top) {
    if (total.has(id)) hit += 1;
  }
  return hit / total.size;
}

/**
 * nDCG@K：gain = 2^rel − 1（rel 0-3），位置折损 = log2(rank + 1)，rank 从 1 开始。
 *
 * - DCG 按 rankedIds 的次序累加 gain（未标注 id 的 gain 为 0，但仍占用位置）；
 * - IDCG 取 gradedMap 中 gain 从大到小的前 K 项（即理想排序）；
 * - 空 gradedMap 或 IDCG=0 时返回 0；重复 id 只计首次。
 */
export function ndcgAtK(rankedIds: readonly string[], gradedMap: GradedMap, k: number): number {
  const kk = clampK(k);
  if (kk === 0) return 0;
  const grades = toGradedMap(gradedMap);
  if (grades.size === 0) return 0;

  const top = dedupeIds(rankedIds).slice(0, kk);
  let dcg = 0;
  for (let i = 0; i < top.length; i++) {
    const rel = normalizeGrade(grades.get(top[i]));
    if (rel > 0) dcg += (2 ** rel - 1) / Math.log2(i + 2);
  }

  const idealGains = [...grades.values()]
    .map(normalizeGrade)
    .filter((rel) => rel > 0)
    .sort((a, b) => b - a)
    .slice(0, kk);
  let idcg = 0;
  for (let i = 0; i < idealGains.length; i++) {
    idcg += (2 ** idealGains[i] - 1) / Math.log2(i + 2);
  }
  return idcg > 0 ? dcg / idcg : 0;
}

/**
 * MRR（单条查询）：第一条相关结果排名的倒数；没有命中返回 0。
 *
 * - 只看第一个 rel ≥ 1 的结果的位置，最强调「最相关结果排在前面」；
 * - 重复 id 只计首次。
 */
export function mrr(rankedIds: readonly string[], relevantSet: IdSet): number {
  const rel = toIdSet(relevantSet);
  if (rel.size === 0) return 0;
  const ranked = dedupeIds(rankedIds);
  const idx = ranked.findIndex((id) => rel.has(id));
  return idx < 0 ? 0 : 1 / (idx + 1);
}

/**
 * 按分数降序生成 id 排序（评测与一致性分析共用）。
 *
 * - 只保留有限分数；NaN/Infinity 视为无效并剔除；
 * - 分数相同时按 id 字典序升序打破平局，保证同一输入在任意运行环境下排序完全一致；
 * - 排序本身不做截断。
 */
export function rankIdsByScore(scores: ReadonlyMap<string, number> | Readonly<Record<string, number>>): string[] {
  const entries: Array<{ id: string; score: number }> = [];
  const iterable: Iterable<[string, number]> =
    scores instanceof Map ? scores.entries() : Object.entries(scores);
  for (const [id, score] of iterable) {
    if (typeof score === 'number' && Number.isFinite(score)) entries.push({ id, score });
  }
  entries.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return entries.map((entry) => entry.id);
}
