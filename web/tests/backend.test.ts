import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeBackend } from '../src/inference/backend';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubGpu(adapter: unknown): void {
  vi.stubGlobal('navigator', {
    gpu: {
      requestAdapter: async () => adapter,
    },
  });
}

describe('probeBackend 强制后端（评测口径不能静默降级）', () => {
  it('强制 wasm：直接返回 wasm 且 available', async () => {
    const probe = await probeBackend('wasm');
    expect(probe).toMatchObject({
      backend: 'wasm',
      preferred: 'wasm',
      forced: true,
      available: true,
      reason: null,
    });
  });

  it('强制 webgpu 且真实可用：返回 webgpu（不能误判降级）', async () => {
    stubGpu({ info: { vendor: 'NVIDIA', architecture: 'lovelace' } });
    const probe = await probeBackend('webgpu');
    expect(probe.backend).toBe('webgpu');
    expect(probe.preferred).toBe('webgpu');
    expect(probe.forced).toBe(true);
    expect(probe.available).toBe(true);
    expect(probe.reason).toBeNull();
    expect(probe.adapterInfo).toMatchObject({ vendor: 'NVIDIA', architecture: 'lovelace' });
  });

  it('强制 webgpu 但拿不到适配器：available=false + 原因（由 runtime 报错）', async () => {
    stubGpu(null);
    const probe = await probeBackend('webgpu');
    expect(probe.backend).toBe('webgpu');
    expect(probe.forced).toBe(true);
    expect(probe.available).toBe(false);
    expect(probe.reason).toContain('强制 WebGPU 不可用');
  });

  it('强制 webgpu 且 requestAdapter 抛错：available=false + 原因', async () => {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => {
          throw new Error('driver crash');
        },
      },
    });
    const probe = await probeBackend('webgpu');
    expect(probe.available).toBe(false);
    expect(probe.reason).toContain('driver crash');
  });
});

describe('probeBackend auto 模式', () => {
  it('无 navigator.gpu → 降级 wasm 并说明原因', async () => {
    vi.stubGlobal('navigator', {});
    const probe = await probeBackend('auto');
    expect(probe.backend).toBe('wasm');
    expect(probe.preferred).toBe('webgpu');
    expect(probe.forced).toBe(false);
    expect(probe.available).toBe(false);
    expect(probe.reason).toContain('WebGPU');
  });

  it('有可用 WebGPU → 使用 webgpu', async () => {
    stubGpu({ info: { vendor: 'NVIDIA' } });
    const probe = await probeBackend('auto');
    expect(probe.backend).toBe('webgpu');
    expect(probe.forced).toBe(false);
    expect(probe.available).toBe(true);
    expect(probe.reason).toBeNull();
  });

  it('adapter 为 null → 降级 wasm 并说明原因', async () => {
    stubGpu(null);
    const probe = await probeBackend('auto');
    expect(probe.backend).toBe('wasm');
    expect(probe.reason).toContain('适配器');
  });

  it('旧版 requestAdapterInfo 异步接口也能读到适配器信息', async () => {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({
          requestAdapterInfo: async () => ({ vendor: 'AMD', device: 'Radeon' }),
        }),
      },
    });
    const probe = await probeBackend('auto');
    expect(probe.adapterInfo).toMatchObject({ vendor: 'AMD', device: 'Radeon' });
  });
});
