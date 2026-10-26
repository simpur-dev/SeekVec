/**
 * 启动期探测后端（不加载模型）：填充 backendStore 的 preferred/forced/原因/适配器信息
 *
 * 真正的实际后端与模型加载状态由 inference/runtime 在模型加载完成/失败后更新。
 * ?perf=1 时额外读取 /api/health，把 seekdb 连接信息写入 perf 快照环境。
 */
import { useEffect } from 'react';
import { detectBackend } from '../inference/backend';
import { useBackendStore } from '../store/backendStore';
import { getRuntimeConfig } from '../config/runtimeConfig';
import { getHealth } from '../db/api';
import { setSeekdbInfo } from '../perf/metrics';

export function useBackendProbe() {
  const setProbe = useBackendStore((s) => s.setProbe);

  useEffect(() => {
    let cancelled = false;
    detectBackend()
      .then((probe) => {
        if (!cancelled) setProbe(probe);
      })
      .catch((err) => {
        console.error('[backend] 探测失败', err);
      });

    // 观测模式下记录 seekdb 环境（health 有 5s 服务端缓存，开销可忽略）
    if (getRuntimeConfig().perf) {
      getHealth()
        .then((health) => {
          if (!cancelled) setSeekdbInfo(health.seekdb as unknown as Record<string, unknown>);
        })
        .catch((err) => {
          console.debug('[health] seekdb 健康信息获取失败（不影响功能）', err);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [setProbe]);
}
