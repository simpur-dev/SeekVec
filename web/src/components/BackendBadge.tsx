import clsx from 'clsx';
import { useBackendStore } from '../store/backendStore';
import { backendColor, backendLabel } from '../inference/backend';

/**
 * 后端徽标
 *
 * 必须满足（契约第 2 节）：
 * - 显示 WebGPU/WASM + 强制时「（强制）」+ 降级原因
 * - 模型加载失败时显示红色错误态，绝不能继续显示绿色 WebGPU
 * - 显示模型加载耗时（加载中 / 已加载 N s）
 */
export function BackendBadge() {
  const backend = useBackendStore((s) => s.backend);
  const preferred = useBackendStore((s) => s.preferred);
  const actual = useBackendStore((s) => s.actual);
  const forced = useBackendStore((s) => s.forced);
  const reason = useBackendStore((s) => s.reason);
  const modelState = useBackendStore((s) => s.modelState);
  const error = useBackendStore((s) => s.error);
  const modelLoadMs = useBackendStore((s) => s.modelLoadMs);
  const adapterInfo = useBackendStore((s) => s.adapterInfo);
  const dtype = useBackendStore((s) => s.dtype);

  if (modelState === 'error') {
    const title = [error, reason].filter(Boolean).join(' · ') || undefined;
    return (
      <span
        className="inline-flex max-w-[420px] items-center gap-2 rounded-full border border-red-300 bg-red-50 px-4 py-1.5 text-sm font-medium text-red-700 shadow-sm"
        title={title}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="16" y1="16" x2="16.01" y2="16" />
        </svg>
        模型加载失败
        <span className="truncate font-normal opacity-80">{error}</span>
      </span>
    );
  }

  const effective = actual ?? backend ?? preferred;
  if (!effective) {
    return (
      <span className="inline-flex animate-pulse items-center gap-2 rounded-full border border-slate-200 bg-slate-100 px-4 py-1.5 text-sm text-slate-500">
        <span className="h-2 w-2 rounded-full bg-slate-400" />
        探测中…
      </span>
    );
  }

  const adapterLabel = adapterInfo
    ? [adapterInfo.vendor, adapterInfo.architecture, adapterInfo.device]
        .filter(Boolean)
        .join(' / ')
    : null;
  const title =
    [
      reason,
      dtype ? `dtype=${dtype}` : null,
      adapterLabel,
      modelLoadMs !== null ? `模型加载 ${(modelLoadMs / 1000).toFixed(1)}s` : null,
      forced ? '后端由 URL ?backend= / localStorage 强制指定' : null,
    ]
      .filter(Boolean)
      .join(' · ') || undefined;

  // 降级：实际后端与期望后端不一致（auto 模式下 WebGPU → WASM）
  const downgraded = Boolean(actual && preferred && actual !== preferred);
  const loading = modelState === 'loading';

  return (
    <span
      className={clsx(
        'inline-flex max-w-[420px] items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium shadow-sm',
        backendColor(effective),
        forced && 'ring-1 ring-indigo-300',
      )}
      title={title}
    >
      <span className="h-2 w-2 rounded-full bg-current opacity-80" />
      <span className="whitespace-nowrap">
        {backendLabel(effective)}
        {forced ? '（强制）' : ''}
        {loading ? ' · 加载中' : modelLoadMs !== null ? ` · ${(modelLoadMs / 1000).toFixed(1)}s` : ''}
      </span>
      {downgraded && reason ? (
        <span className="truncate font-normal opacity-80">· {reason}</span>
      ) : null}
    </span>
  );
}
