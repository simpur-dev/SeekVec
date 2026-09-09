import { useModelStore } from '../store/modelStore';
import { useKbStore } from '../store/kbStore';
import { MODEL_REGISTRY } from '../inference/models';

export function StatsBar() {
  const modelKey = useModelStore((s) => s.modelKey);
  const counts = useKbStore((s) => s.counts);
  const collections = useKbStore((s) => s.collections);
  const ingestStatus = useKbStore((s) => s.ingestStatus);
  const progress = useKbStore((s) => s.ingestProgress);

  const textColls = Object.values(collections).filter((c) => c.modality === 'text');
  const totalDocs = textColls.reduce((sum, c) => sum + (counts[c.name] ?? 0), 0);
  const info = MODEL_REGISTRY[modelKey];

  const statusMap: Record<string, { label: string; cls: string }> = {
    idle:      { label: '空闲',   cls: 'text-slate-400' },
    reading:   { label: '读取中', cls: 'text-amber-600' },
    embedding: { label: '向量化', cls: 'text-amber-600' },
    writing:   { label: '写入中', cls: 'text-amber-600' },
    done:      { label: '完成',   cls: 'text-emerald-600' },
    error:     { label: '错误',   cls: 'text-red-500' },
  };
  const cfg = statusMap[ingestStatus] ?? { label: ingestStatus, cls: 'text-slate-400' };

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl border border-slate-200/80 bg-white/80 px-5 py-2.5 text-sm backdrop-blur-sm">
      {/* Model */}
      <div className="flex items-center gap-2 text-slate-600">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/>
          <line x1="9" y1="2" x2="9" y2="4"/><line x1="15" y1="2" x2="15" y2="4"/>
          <line x1="9" y1="20" x2="9" y2="22"/><line x1="15" y1="20" x2="15" y2="22"/>
        </svg>
        <span className="font-mono text-slate-700">{info.id}</span>
        <span className="text-slate-400">{info.dim}d</span>
      </div>

      <div className="h-4 w-px bg-slate-200" />

      {/* Collections & docs */}
      <div className="flex items-center gap-2 text-slate-600">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/>
        </svg>
        <span>{textColls.length} 集合</span>
        <span className="font-mono text-slate-700">{totalDocs}</span>
        <span className="text-slate-400">分块</span>
      </div>

      <div className="h-4 w-px bg-slate-200" />

      {/* Status */}
      <div className="flex items-center gap-2">
        <span className="text-slate-400">状态</span>
        <strong className={cfg.cls}>{cfg.label}</strong>
        {(ingestStatus === 'embedding' || ingestStatus === 'reading' || ingestStatus === 'writing') && (
          <span className="font-mono text-slate-500">{progress.done}/{progress.total}</span>
        )}
        {ingestStatus === 'done' && (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round">
            <polyline points="20,6 9,17 4,12" />
          </svg>
        )}
      </div>
    </div>
  );
}
