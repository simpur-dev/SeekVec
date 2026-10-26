import { useState } from 'react';
import { ResultCard } from './ResultCard';
import { useSearchStore } from '../store/searchStore';
import { useSearch } from '../hooks/useSearch';
import type { SearchHit, SearchMetric } from '../types';

export function SearchPanel() {
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const keyword = useSearchStore((s) => s.keyword);
  const setKeyword = useSearchStore((s) => s.setKeyword);
  const isSearching = useSearchStore((s) => s.isSearching);
  const textResults = useSearchStore((s) => s.textResults);
  const imageResults = useSearchStore((s) => s.imageResults);
  const error = useSearchStore((s) => s.error);
  const [topK, setTopK] = useState(10);
  const { searchAll, ready, error: modelError, reload } = useSearch();

  const canSearch = ready && !isSearching && query.trim().length > 0;
  const runSearch = () => {
    if (canSearch) searchAll(query, keyword, topK);
  };

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-8 shadow-card">
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-slate-900">语义检索</h2>
        <p className="mt-1 text-sm text-slate-500">向量相似度 + 全文关键字 · RRF 融合</p>
      </div>

      {/* Model load error */}
      {modelError && !ready && (
        <div className="mb-4 flex items-center justify-between gap-2 rounded-xl border border-red-100 bg-red-50 px-5 py-3.5 text-sm text-red-700">
          <span>embedding 模型加载失败：{modelError}</span>
          <button
            type="button"
            onClick={reload}
            className="shrink-0 rounded-lg bg-red-600 px-3 py-1.5 text-white hover:bg-red-500"
          >
            重试
          </button>
        </div>
      )}

      {/* Search bar */}
      <div className="mb-4 flex items-stretch gap-3">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-slate-400">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
            placeholder="输入查询，例如：端侧量化的优势"
            className="w-full rounded-xl border border-slate-200 bg-slate-50 py-3.5 pl-11 pr-4 text-base text-slate-900 placeholder-slate-400 transition-all focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-100 disabled:text-slate-400"
            disabled={!ready}
          />
        </div>
        <button
          onClick={runSearch}
          disabled={!canSearch}
          className={[
            'flex items-center gap-2 rounded-xl px-7 py-3.5 text-base font-medium transition-all active:scale-95',
            canSearch
              ? 'bg-indigo-600 text-white shadow-md hover:bg-indigo-500'
              : 'bg-slate-100 text-slate-400 cursor-not-allowed',
          ].join(' ')}
        >
          {isSearching ? (
            <>
              <svg className="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              检索中
            </>
          ) : '检索'}
        </button>
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2 text-slate-600">
          <span className="text-sm text-slate-400">关键字</span>
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
            placeholder="可选"
            className="w-40 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm transition-colors focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />
        </label>
        <label className="flex items-center gap-2 text-slate-600">
          <span className="text-sm text-slate-400">top-K</span>
          <input
            type="number"
            min={1}
            max={50}
            value={topK}
            onChange={(e) => setTopK(Math.max(1, Math.min(50, Number(e.target.value) || 10)))}
            className="w-16 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm transition-colors focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />
        </label>
        {textResults && !textResults.notice && (
          <span className="ml-auto rounded-full bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-600">
            {textResults.hits.length} 条结果
            {textResults.embeddingMs != null
              ? ` · 向量化 ${textResults.embeddingMs.toFixed(0)}ms`
              : ''}
            {' · '}检索 {textResults.latencyMs.toFixed(0)}ms
          </span>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-red-100 bg-red-50 px-5 py-3.5 text-sm text-red-700">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="16" y1="16" x2="16.01" y2="16" />
          </svg>
          {error}
        </div>
      )}

      {/* Results grid */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <ResultSection
          title="文本结果"
          subtitle={
            textResults?.metric === 'score'
              ? '混合检索 · RRF 融合分（越大越相关，进度条按最高分归一化）'
              : '向量检索 · 相似度 = 1 - cosine 距离'
          }
          hits={textResults?.hits ?? null}
          latencyMs={textResults?.latencyMs}
          metric={textResults?.metric ?? 'distance'}
          notice={textResults?.notice}
          placeholder="输入查询并点击检索"
        />
        <ResultSection
          title="图片结果"
          subtitle="图片管线 v1.1 待启用"
          hits={imageResults?.hits ?? null}
          latencyMs={imageResults?.latencyMs}
          metric="distance"
          placeholder="图片管线 v1.1 待启用"
        />
      </div>
    </section>
  );
}

function ResultSection({
  title,
  subtitle,
  hits,
  latencyMs,
  metric,
  notice,
  placeholder,
}: {
  title: string;
  subtitle?: string;
  hits: SearchHit[] | null;
  latencyMs?: number;
  metric: SearchMetric;
  notice?: string | null;
  placeholder?: string;
}) {
  const count = hits?.length ?? 0;
  const maxScore =
    metric === 'score' && hits && hits.length > 0
      ? Math.max(...hits.map((h) => h.score ?? 0))
      : undefined;

  return (
    <div className="flex flex-col">
      <header className="mb-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
          {hits && !notice && (
            <span className="font-mono text-sm text-slate-400">
              {count > 0 ? `${count} 条 · ${latencyMs?.toFixed(0) ?? '?'}ms` : '无结果'}
            </span>
          )}
        </div>
        {subtitle && <p className="mt-1 text-xs text-slate-400">{subtitle}</p>}
      </header>

      {notice ? (
        <div className="flex flex-1 items-center justify-center rounded-2xl border-2 border-dashed border-amber-200 bg-amber-50/50 p-10">
          <p className="text-center text-base text-amber-700">{notice}</p>
        </div>
      ) : !hits ? (
        <div className="flex flex-1 items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/40 p-10">
          <p className="text-center text-base text-slate-400">{placeholder ?? '尚未检索'}</p>
        </div>
      ) : hits.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/40 p-10">
          <p className="text-center text-base text-slate-400">无匹配结果，试试放宽条件</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {hits.map((h, i) => (
            <ResultCard key={h.id} hit={h} rank={i + 1} metric={metric} maxScore={maxScore} />
          ))}
        </div>
      )}
    </div>
  );
}
