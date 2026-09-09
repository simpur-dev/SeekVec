import clsx from 'clsx';
import { useBackendStore } from '../store/backendStore';
import { backendColor, backendLabel } from '../inference/backend';

export function BackendBadge() {
  const backend = useBackendStore((s) => s.backend);
  const reason = useBackendStore((s) => s.reason);

  if (!backend) {
    return (
      <span className="inline-flex animate-pulse items-center gap-2 rounded-full border border-slate-200 bg-slate-100 px-4 py-1.5 text-sm text-slate-500">
        <span className="h-2 w-2 rounded-full bg-slate-400" />
        探测中…
      </span>
    );
  }

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium shadow-sm',
        backendColor(backend),
      )}
      title={reason ?? undefined}
    >
      <span className="h-2 w-2 rounded-full bg-current opacity-80" />
      {backendLabel(backend)}
      {backend === 'wasm' && reason ? (
        <span className="opacity-70">· {reason}</span>
      ) : null}
    </span>
  );
}
