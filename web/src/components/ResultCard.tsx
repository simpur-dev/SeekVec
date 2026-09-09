import type { SearchHit } from '../types';

export function ResultCard({ hit, rank }: { hit: SearchHit; rank: number }) {
  const distance = hit.distance ?? 0;
  const similarity = Math.max(0, Math.min(1, 1 - distance));

  const rankColors = [
    'bg-amber-100 text-amber-700',
    'bg-slate-100 text-slate-600',
    'bg-orange-50 text-orange-600',
  ];
  const barColors = [
    similarity > 0.85 ? 'bg-emerald-500' :
    similarity > 0.65 ? 'bg-blue-500' :
    similarity > 0.45 ? 'bg-amber-500' : 'bg-slate-400',
  ];
  const badgeColors = [
    similarity > 0.85 ? 'bg-emerald-50 text-emerald-700' :
    similarity > 0.65 ? 'bg-blue-50 text-blue-700' :
    similarity > 0.45 ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500',
  ];

  return (
    <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card transition-shadow hover:shadow-card-hover">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={`flex h-6 w-6 items-center justify-center rounded-lg text-sm font-bold ${rankColors[rank - 1] ?? 'bg-slate-100 text-slate-500'}`}>
            {rank}
          </span>
          <span className="font-mono text-sm text-slate-400 truncate max-w-[180px]" title={hit.id}>
            {hit.id.length > 36 ? hit.id.slice(0, 36) + '…' : hit.id}
          </span>
        </div>
        <span className={`shrink-0 rounded-full px-3 py-1 text-sm font-semibold ${badgeColors[rank - 1] ?? badgeColors[3]}`}>
          {(similarity * 100).toFixed(1)}%
        </span>
      </header>

      {/* Similarity bar */}
      <div className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full transition-all duration-700 ${barColors[rank - 1] ?? barColors[3]}`}
          style={{ width: `${similarity * 100}%` }}
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
