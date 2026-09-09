/**
 * 启动期探测后端 + 运行时失败降级
 */
import { useEffect } from 'react';
import { detectBackend } from '../inference/backend';
import { useBackendStore } from '../store/backendStore';

export function useBackendProbe() {
  const setBackend = useBackendStore((s) => s.setBackend);

  useEffect(() => {
    let cancelled = false;
    detectBackend().then((b) => {
      if (!cancelled) setBackend(b);
    });
    return () => {
      cancelled = true;
    };
  }, [setBackend]);
}
