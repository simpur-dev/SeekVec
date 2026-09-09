import { useState } from 'react';
import { BackendBadge } from './components/BackendBadge';
import { ModelBadge } from './components/ModelBadge';
import { StatsBar } from './components/StatsBar';
import { IngestPanel } from './components/IngestPanel';
import { SearchPanel } from './components/SearchPanel';
import { IngestImagePanel } from './components/IngestImagePanel';
import { useBackendProbe } from './hooks/useBackendProbe';

type Tab = 'text' | 'image';

export default function App() {
  useBackendProbe();
  const [tab, setTab] = useState<Tab>('text');

  return (
    <div className="min-h-screen bg-slate-100">
      {/* ── Topbar ─────────────────────────────────────── */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto flex items-center justify-between gap-6 px-8 py-4">
          {/* Brand */}
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-indigo-500 shadow-md">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <span className="text-lg font-bold tracking-tight text-slate-900">
              Seek<span className="text-indigo-600">Vec</span>
            </span>
            <span className="ml-1 text-sm text-slate-400">端侧向量化 · SeekDB 检索</span>
          </div>

          {/* Tab nav */}
          <nav className="flex gap-1 rounded-2xl border border-slate-200 bg-slate-50 p-1.5">
            <TabButton active={tab === 'text'} onClick={() => setTab('text')}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14,2 14,8 20,8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              文本检索
            </TabButton>
            <TabButton active={tab === 'image'} onClick={() => setTab('image')}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21,15 16,10 5,21" />
              </svg>
              图片管线
              <span className="ml-1.5 rounded-md bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-600">v1.1</span>
            </TabButton>
          </nav>

          {/* Backend badge */}
          <BackendBadge />
        </div>
      </header>

      {/* ── Subheader ─────────────────────────────────── */}
      <div className="border-b border-slate-200/60 bg-white/80 px-8 py-3 backdrop-blur-sm">
        <div className="mx-auto flex items-center justify-between gap-6">
          <ModelBadge />
          <StatsBar />
        </div>
      </div>

      {/* ── Main: stacked panels ─────────────────────── */}
      <main className="mx-auto px-8 py-8 space-y-6">
        {tab === 'text' ? (
          <>
            <IngestPanel />
            <SearchPanel />
          </>
        ) : (
          <IngestImagePanel />
        )}
      </main>

      {/* ── Footer ─────────────────────────────────────── */}
      <footer className="mx-auto px-8 pb-10">
        <p className="rounded-2xl border border-slate-200 bg-white/80 px-6 py-3 text-center text-sm text-slate-400 backdrop-blur-sm">
          SeekVec · 端侧向量化引擎 · Transformers.js + SeekDB
        </p>
      </footer>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? 'flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-all'
          : 'flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium text-slate-500 hover:bg-white hover:text-slate-800 transition-colors'
      }
    >
      {children}
    </button>
  );
}
