import clsx from 'clsx';
import { MODEL_REGISTRY } from '../inference/models';
import { useModelStore } from '../store/modelStore';
import type { ModelKey } from '../types';

const ALL_MODELS: ModelKey[] = ['text_en', 'text_zh', 'image'];

export function ModelBadge() {
  const modelKey = useModelStore((s) => s.modelKey);
  const setModelKey = useModelStore((s) => s.setModelKey);
  const info = MODEL_REGISTRY[modelKey];

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-slate-400">模型</span>
      <div className="inline-flex overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {ALL_MODELS.map((k) => {
          const mi = MODEL_REGISTRY[k];
          const isActive = k === modelKey;
          return (
            <button
              key={k}
              disabled={k === 'image'}
              onClick={() => !isActive && setModelKey(k)}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 transition-all',
                isActive
                  ? 'bg-indigo-600 text-white font-medium'
                  : 'text-slate-600 hover:bg-slate-50',
                k === 'image' ? 'cursor-not-allowed opacity-50' : '',
              )}
              title={k === 'image' ? 'v1.1 待启用' : `${mi.id} · ${mi.dim}d · ${mi.lang}`}
            >
              {k === 'text_en' ? '英文' : k === 'text_zh' ? '中文' : '图片'}
              <span className="text-xs opacity-60">{mi.dim}d</span>
            </button>
          );
        })}
      </div>
      <span className="font-mono text-sm text-slate-400">{info.id}</span>
    </div>
  );
}
