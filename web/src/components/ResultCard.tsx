import type { SearchHit, SearchMetric } from '../types';

const RANK_STYLES = [
  'bg-amber-100 text-amber-700',
  'bg-slate-100 text-slate-600',
  'bg-orange-50 text-orange-600',
];

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function ResultCard({
  hit,
  rank,
  metric,
  maxScore,
}: {
  hit: SearchHit;
  rank: number;
  metric: SearchMetric;
  /** 混合检索时用于把 RRF 分归一化成进度条长度 */
  maxScore?: number;
}) {
  const isScore = metric === 'score' && typeof hit.score === 'number';
  // 纯向量：cosine distance → 相似度 = 1 - distance
  const similarity =
    metric === 'distance' && typeof hit.distance === 'number'
      ? clamp01(1 - hit.distance)
      : null;

  const score = isScore ? (hit.score as number) : null;
  const ratio = isScore
    ? maxScore && maxScore > 0
      ? clamp01(score! / maxScore)
      : 0
    : (similarity ?? 0);
  const pct = Math.round(ratio * 100);

  const barColor = isScore
    ? 'bg-indigo-500'
    : (similarity ?? 0) > 0.85
      ? 'bg-emerald-500'
      : (similarity ?? 0) > 0.65
        ? 'bg-blue-500'
        : (similarity ?? 0) > 0.45
          ? 'bg-amber-500'
          : 'bg-slate-400';

  const badgeColor = isScore
    ? 'bg-indigo-50 text-indigo-700'
    : (similarity ?? 0) > 0.85
      ? 'bg-emerald-50 text-emerald-700'
      : (similarity ?? 0) > 0.65
        ? 'bg-blue-50 text-blue-700'
        : (similarity ?? 0) > 0.45
          ? 'bg-amber-50 text-amber-700'
          : 'bg-slate-100 text-slate-500';

  const badgeLabel = isScore
    ? `RRF ${score!.toFixed(3)}`
    : similarity !== null
      ? `${(similarity * 100).toFixed(1)}%`
      : '—';

  const badgeTitle = isScore
    ? 'RRF 融合分（越大越相关）；进度条按本次结果集最高分归一化'
    : 'cosine 相似度 = 1 - distance';

  const rankClass = RANK_STYLES[rank - 1] ?? 'bg-slate-100 text-slate-500';

  return (
    <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card transition-shadow hover:shadow-card-hover">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={`flex h-6 w-6 items-center justify-center rounded-lg text-sm font-bold ${rankClass}`}>
            {rank}
          </span>
          <span className="font-mono text-sm text-slate-400 truncate max-w-[180px]" title={hit.id}>
            {hit.id.length > 36 ? hit.id.slice(0, 36) + '…' : hit.id}
          </span>
        </div>
        <span
          className={`shrink-0 rounded-full px-3 py-1 text-sm font-semibold ${badgeColor}`}
          title={badgeTitle}
        >
          {badgeLabel}
        </span>
      </header>

      {/* 进度条：纯向量按相似度，混合检索按本结果集最高 RRF 分归一化 */}
      <div className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full transition-all duration-700 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Document */}
      <p className="text-base leading-relaxed text-slate-700 line-clamp-4">
        {hit.document ?? '(无原文)'}
      </p>

      {/* Metadata */}
      {hit.metadata && Object.keys(hit.metadata).length > 0 && (
        <footer className="mt-3 flex flex-wrap gap-2">
          {Object.entries(hit.metadata).map(([k, v]) => (
            <span
              key={k}
              className="rounded-lg bg-slate-100 px-2.5 py-1 font-mono text-sm text-slate-500"
            >
              {k}=<span className="text-slate-700">{String(v)}</span>
            </span>
          ))}
        </footer>
      )}
    </article>
  );
}
