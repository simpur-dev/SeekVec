import { useCallback, useEffect, useRef, useState } from 'react';
import { isTextLike } from '../utils/fileReader';
import { useIngestText } from '../hooks/useIngest';
import { useKbStore } from '../store/kbStore';
import { useModelStore } from '../store/modelStore';

const STEPS = ['拖入文件', '读取中', '向量化', '写入 DB', '完成'];

function defaultCollectionName(modelKey: string): string {
  return modelKey === 'text_en' ? 'kb_text_en' : 'kb_text_zh';
}

function StepIcon({ status }: { status: string }) {
  if (status === 'done') {
    return (
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="9,12 12,15 16,9" />
      </svg>
    );
  }
  if (status === 'idle' || status === 'error') {
    return (
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17,8 12,3 7,8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
    );
  }
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" className="animate-spin" style={{ animationDuration: '1.2s' }}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function statusStep(s: string): number {
  switch (s) {
    case 'reading': return 1;
    case 'embedding': return 2;
    case 'writing': return 3;
    case 'done': return 4;
    default: return 0;
  }
}

export function IngestPanel() {
  const modelKey = useModelStore((s) => s.modelKey);
  const dim = useModelStore((s) => s.dim);
  const [collectionName, setCollectionName] = useState<string>(defaultCollectionName(modelKey));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const { ingestFiles, ready, error: modelError, reload } = useIngestText();
  const ingestStatus = useKbStore((s) => s.ingestStatus);
  const progress = useKbStore((s) => s.ingestProgress);
  const [error, setError] = useState<string | null>(null);

  const isActive =
    ingestStatus === 'reading' || ingestStatus === 'embedding' || ingestStatus === 'writing';

  // 切换模型时同步默认集合名，避免把新模型的向量写进旧集合（维度不匹配）
  useEffect(() => {
    setCollectionName(defaultCollectionName(modelKey));
    setError(null);
  }, [modelKey]);

  const onFiles = useCallback(
    async (files: File[]) => {
      if (isActive) return;
      const filtered = files.filter(isTextLike);
      if (filtered.length === 0) {
        setError('请选择 .txt 或 .md 文件');
        return;
      }
      setError(null);
      try {
        await ingestFiles(filtered, collectionName.trim() || defaultCollectionName(modelKey));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [ingestFiles, collectionName, modelKey, isActive],
  );

  const step = statusStep(ingestStatus);
  const pct = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);

  const statusConfig: Record<string, { label: string; cls: string }> = {
    idle:      { label: '空闲',     cls: 'bg-slate-100 text-slate-500' },
    reading:   { label: '读取文件', cls: 'bg-amber-50 text-amber-700' },
    embedding: { label: '向量化中', cls: 'bg-amber-50 text-amber-700' },
    writing:   { label: '写入中',   cls: 'bg-amber-50 text-amber-700' },
    done:      { label: '已完成',   cls: 'bg-emerald-50 text-emerald-700' },
    error:     { label: '错误',     cls: 'bg-red-50 text-red-600' },
  };
  const cfg = statusConfig[ingestStatus] ?? { label: ingestStatus, cls: 'bg-slate-100 text-slate-500' };

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-8 shadow-card">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">导入文本</h2>
          <p className="mt-1 text-sm text-slate-500">int8 量化 · {dim}d · SeekDB 存储</p>
        </div>
        <span className={`rounded-full px-3 py-1.5 text-sm font-medium ${cfg.cls}`}>
          {cfg.label}
        </span>
      </div>

      {/* Collection name */}
      <div className="mb-5 flex items-center gap-3">
        <label className="shrink-0 text-sm text-slate-500">集合名</label>
        <input
          value={collectionName}
          onChange={(e) => setCollectionName(e.target.value)}
          disabled={isActive}
          className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 font-mono text-sm text-slate-800 placeholder-slate-400 transition-colors focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-100 disabled:text-slate-400"
          placeholder={defaultCollectionName(modelKey)}
        />
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); if (!isActive) setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!isActive) onFiles(Array.from(e.dataTransfer.files)); }}
        className={[
          'relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-14 transition-all duration-200',
          dragOver
            ? 'border-indigo-400 bg-indigo-50/60 scale-[1.01]'
            : isActive
            ? 'border-amber-300 bg-amber-50/40'
            : 'border-slate-200 bg-slate-50/60 hover:border-slate-300 hover:bg-white',
        ].join(' ')}
      >
        <div className="mb-5 transition-transform duration-200" style={{ transform: dragOver ? 'scale(1.08)' : 'scale(1)' }}>
          <StepIcon status={ingestStatus} />
        </div>
        <p className="mb-2 text-base font-medium text-slate-700">
          {dragOver ? '放开以导入' : '拖拽 .txt / .md 文件到此处'}
        </p>
        <p className="mb-5 text-sm text-slate-400">或</p>
        <button
          type="button"
          onClick={() => {
            if (modelError && !ready) {
              reload();
              return;
            }
            fileInputRef.current?.click();
          }}
          disabled={isActive || (!ready && !modelError)}
          className={[
            'rounded-xl px-8 py-3 text-base font-medium transition-all active:scale-95',
            ready || modelError
              ? 'bg-indigo-600 text-white shadow-md hover:bg-indigo-500'
              : 'bg-slate-200 text-slate-400 cursor-not-allowed',
          ].join(' ')}
        >
          {ready
            ? '选择文件'
            : modelError
              ? '模型加载失败，点此重试'
              : '模型加载中…'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,text/plain,text/markdown"
          multiple
          hidden
          disabled={isActive}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (!isActive) onFiles(files);
            e.target.value = '';
          }}
        />
        <p className="mt-4 text-sm text-slate-400">支持 .txt、.md；其他格式自动过滤</p>
      </div>

      {/* Model load error */}
      {modelError && !ready && (
        <div className="mt-5 flex items-center justify-between gap-2 rounded-xl border border-red-100 bg-red-50 px-5 py-3.5 text-sm text-red-700">
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

      {/* Progress */}
      {(isActive || ingestStatus === 'done') && (
        <div className="mt-6 rounded-2xl bg-slate-50 p-5">
          {/* Step rail */}
          <div className="mb-5 flex items-center gap-0">
            {STEPS.map((label, i) => {
              const s = i + 1;
              const done = step > s;
              const active = step === s;
              return (
                <div key={i} className="relative flex flex-1 flex-col items-center">
                  {i > 0 && (
                    <div className={`absolute right-1/2 top-3 h-px w-full ${done ? 'bg-indigo-400' : 'bg-slate-200'}`} />
                  )}
                  <div className={`relative z-10 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${done ? 'bg-indigo-500 text-white' : active ? 'bg-amber-500 text-white' : 'bg-slate-200 text-slate-400'}`}>
                    {done ? '✓' : s}
                  </div>
                  <span className={`mt-2 text-sm ${active ? 'text-amber-700 font-medium' : done ? 'text-indigo-600' : 'text-slate-400'}`}>
                    {label}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Bar */}
          {isActive && (
            <div className="h-2 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-indigo-400 transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}

          <div className="mt-3 flex items-center justify-between text-sm">
            <span className="text-slate-600">
              {ingestStatus === 'reading' ? '正在读取文件…' :
               ingestStatus === 'embedding' ? '端侧向量化中…' :
               ingestStatus === 'writing' ? '正在写入 SeekDB…' : '已完成'}
            </span>
            <span className="font-mono text-slate-500">{progress.done} / {progress.total}</span>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mt-5 flex items-center gap-2 rounded-xl border border-red-100 bg-red-50 px-5 py-3.5 text-sm text-red-700">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="16" y1="16" x2="16.01" y2="16" />
          </svg>
          {error}
        </div>
      )}
    </section>
  );
}
