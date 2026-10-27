import { describe, expect, it } from 'vitest';
import {
  ORT_WASM_PATH_DEFAULT,
  STORAGE_BACKEND_KEY,
  parseRuntimeConfig,
  resolveDtype,
  resolveModelSource,
  resolveOrtWasmPath,
  type StorageLike,
} from '../src/config/runtimeConfig';

/** 内存版 localStorage（Node 测试环境没有浏览器 storage） */
function memoryStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

describe('parseRuntimeConfig 默认值', () => {
  it('全部缺省时保持现状默认值', () => {
    const config = parseRuntimeConfig('', { storage: memoryStorage(), crossOriginIsolated: false });
    expect(config).toMatchObject({
      backend: 'auto',
      backendSource: 'default',
      forcedBackend: null,
      dtype: null,
      batch: 32,
      refresh: 'last',
      threads: 1,
      models: 'auto',
      perf: false,
      collection: null,
      crossOriginIsolated: false,
    });
  });

  it('crossOriginIsolated=true 时 wasm 线程数默认 8', () => {
    const config = parseRuntimeConfig('', { storage: memoryStorage(), crossOriginIsolated: true });
    expect(config.threads).toBe(8);
    expect(config.crossOriginIsolated).toBe(true);
  });
});

describe('parseRuntimeConfig 夹紧与非法回退', () => {
  const base = () => ({ storage: memoryStorage(), crossOriginIsolated: false });

  it('batch 越界夹紧到 1..64，非数字回退 32', () => {
    expect(parseRuntimeConfig('?batch=0', base()).batch).toBe(1);
    expect(parseRuntimeConfig('?batch=-3', base()).batch).toBe(1);
    expect(parseRuntimeConfig('?batch=100', base()).batch).toBe(64);
    expect(parseRuntimeConfig('?batch=abc', base()).batch).toBe(32);
    expect(parseRuntimeConfig('?batch=32', base()).batch).toBe(32);
  });

  it('threads 越界夹紧到 1..8，非数字回退默认值', () => {
    expect(parseRuntimeConfig('?threads=0', base()).threads).toBe(1);
    expect(parseRuntimeConfig('?threads=99', base()).threads).toBe(8);
    expect(parseRuntimeConfig('?threads=x', base()).threads).toBe(1);
    const isolated = parseRuntimeConfig('?threads=x', {
      storage: memoryStorage(),
      crossOriginIsolated: true,
    });
    expect(isolated.threads).toBe(8);
    expect(parseRuntimeConfig('?threads=2', base()).threads).toBe(2);
  });

  it('非法枚举值回退默认（backend/dtype/refresh/models）', () => {
    const config = parseRuntimeConfig(
      '?backend=metal&dtype=int4&refresh=never&models=cloud',
      base(),
    );
    expect(config.backend).toBe('auto');
    expect(config.dtype).toBeNull();
    expect(config.refresh).toBe('last');
    expect(config.models).toBe('auto');
    expect(config.forcedBackend).toBeNull();
  });

  it('合法枚举值生效', () => {
    const config = parseRuntimeConfig(
      '?backend=wasm&dtype=fp32&refresh=each&models=local',
      base(),
    );
    expect(config.backend).toBe('wasm');
    expect(config.forcedBackend).toBe('wasm');
    expect(config.backendSource).toBe('url');
    expect(config.dtype).toBe('fp32');
    expect(config.refresh).toBe('each');
    expect(config.models).toBe('local');
  });

  it('perf=1（或 true）才启用观测', () => {
    expect(parseRuntimeConfig('?perf=1', base()).perf).toBe(true);
    expect(parseRuntimeConfig('?perf=true', base()).perf).toBe(true);
    expect(parseRuntimeConfig('?perf=0', base()).perf).toBe(false);
    expect(parseRuntimeConfig('?perf=yes', base()).perf).toBe(false);
    expect(parseRuntimeConfig('', base()).perf).toBe(false);
  });

  it('collection 只接受与服务端一致的名称规则', () => {
    expect(parseRuntimeConfig('?collection=kb_text_zh', base()).collection).toBe('kb_text_zh');
    expect(parseRuntimeConfig('?collection=bench_20261026', base()).collection).toBe(
      'bench_20261026',
    );
    expect(parseRuntimeConfig('?collection=bad name!', base()).collection).toBeNull();
    expect(parseRuntimeConfig('?collection=', base()).collection).toBeNull();
  });
});

describe('强制后端 localStorage 同步（契约第 2 节）', () => {
  it('URL 显式 webgpu 会写入 localStorage，后续无参数访问继续生效', () => {
    const storage = memoryStorage();
    const fromUrl = parseRuntimeConfig('?backend=webgpu', { storage });
    expect(fromUrl.backend).toBe('webgpu');
    expect(storage.data[STORAGE_BACKEND_KEY]).toBe('webgpu');

    const fromStorage = parseRuntimeConfig('', { storage });
    expect(fromStorage.backend).toBe('webgpu');
    expect(fromStorage.backendSource).toBe('storage');
    expect(fromStorage.forcedBackend).toBe('webgpu');
  });

  it('URL backend=auto 清除 localStorage 强制项', () => {
    const storage = memoryStorage({ [STORAGE_BACKEND_KEY]: 'wasm' });
    const config = parseRuntimeConfig('?backend=auto', { storage });
    expect(config.backend).toBe('auto');
    expect(config.backendSource).toBe('url');
    expect(storage.data[STORAGE_BACKEND_KEY]).toBeUndefined();
  });

  it('非法 URL backend 不会覆盖已有强制项', () => {
    const storage = memoryStorage({ [STORAGE_BACKEND_KEY]: 'wasm' });
    const config = parseRuntimeConfig('?backend=metal', { storage });
    expect(config.backend).toBe('wasm');
    expect(config.backendSource).toBe('storage');
    expect(storage.data[STORAGE_BACKEND_KEY]).toBe('wasm');
  });

  it('storage 不可用时不影响解析', () => {
    const config = parseRuntimeConfig('?backend=wasm', { storage: null });
    expect(config.backend).toBe('wasm');
  });
});

describe('dtype / 模型来源解析', () => {
  it('dtype 默认按后端：webgpu→fp16，wasm→q8', () => {
    expect(resolveDtype('webgpu', null)).toBe('fp16');
    expect(resolveDtype('wasm', null)).toBe('q8');
    expect(resolveDtype('webgpu', 'q8')).toBe('q8');
    expect(resolveDtype('wasm', 'fp32')).toBe('fp32');
  });

  it('models=auto 时按构建期 VITE_LOCAL_MODELS 决定来源', () => {
    expect(resolveModelSource({ models: 'auto' }, {})).toBe('remote');
    expect(
      resolveModelSource({ models: 'auto' }, { VITE_LOCAL_MODELS: '1' }),
    ).toBe('local');
    expect(
      resolveModelSource({ models: 'auto' }, { VITE_LOCAL_MODELS: '0' }),
    ).toBe('remote');
  });

  it('显式 remote/local 优先于构建期开关', () => {
    expect(resolveModelSource({ models: 'remote' }, { VITE_LOCAL_MODELS: '1' })).toBe(
      'remote',
    );
    expect(resolveModelSource({ models: 'local' }, {})).toBe('local');
  });

  it('ORT 资源默认同源 /ort/，构建期变量可覆盖', () => {
    expect(resolveOrtWasmPath({})).toBe(ORT_WASM_PATH_DEFAULT);
    expect(resolveOrtWasmPath({})).toBe('/ort/');
    expect(resolveOrtWasmPath({ VITE_ORT_WASM_PATH: 'http://cdn/ort/' })).toBe(
      'http://cdn/ort/',
    );
  });
});
