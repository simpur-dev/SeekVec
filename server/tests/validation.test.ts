/**
 * 纯逻辑单测：集中校验 / 混合检索转义 / FIFO 互斥 / 健康检查版本解析 / 计时工具
 * （不连 seekdb）
 */
import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/routes/errors.js';
import {
  MAX_IDS_PER_REQUEST,
  MAX_KEYWORD_LENGTH,
  assertInsertIdsUnique,
  assertSameLength,
  isDeepProbe,
  readQueryString,
  requireJsonBody,
  validateCollectionName,
  validateDocumentMode,
  validateEmbeddings,
  validateIds,
  validateIkMode,
  validateKeyword,
  validateMetadatas,
  validateModelKey,
  validateNResults,
  validateQueryEmbedding,
  validateRefreshIndex,
  validateSource,
} from '../src/routes/validation.js';
import { escapeQueryStringKeyword } from '../src/util/lucene.js';
import { AsyncMutex } from '../src/util/asyncMutex.js';
import {
  compareSemver,
  extractVersionFromRows,
  isRefreshIndexSupported,
  parseSeekdbSemver,
} from '../src/routes/health.js';
import { elapsedMs, nowMs, roundMs } from '../src/util/timing.js';
import { parseCorsOrigins, parseQueryTimeoutMs } from '../src/config.js';

/** 断言函数抛出指定 HTTP 状态 + code 的 HttpError */
function expectHttpError(fn: () => unknown, status: number, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    const httpError = err as HttpError;
    expect(httpError.status).toBe(status);
    expect(httpError.code).toBe(code);
    return;
  }
  throw new Error(`expected HttpError(${status}, ${code}) to be thrown`);
}

function makeRequest(query: Record<string, unknown>) {
  return { query } as never;
}

describe('validateCollectionName', () => {
  it('接受字母/数字/下划线/连字符，长度 1-64', () => {
    expect(validateCollectionName('kb_text_zh')).toBe('kb_text_zh');
    expect(validateCollectionName('bench-2026_01')).toBe('bench-2026_01');
    expect(validateCollectionName('A'.repeat(64))).toHaveLength(64);
  });

  it('拒绝空值 / 非法字符 / 超长 / 非字符串', () => {
    expectHttpError(() => validateCollectionName(''), 400, 'INVALID_COLLECTION_NAME');
    expectHttpError(() => validateCollectionName(undefined), 400, 'INVALID_COLLECTION_NAME');
    expectHttpError(() => validateCollectionName(123), 400, 'INVALID_COLLECTION_NAME');
    expectHttpError(() => validateCollectionName('bad name'), 400, 'INVALID_COLLECTION_NAME');
    expectHttpError(() => validateCollectionName('a;drop'), 400, 'INVALID_COLLECTION_NAME');
    expectHttpError(() => validateCollectionName('中文'), 400, 'INVALID_COLLECTION_NAME');
    expectHttpError(() => validateCollectionName('A'.repeat(65)), 400, 'INVALID_COLLECTION_NAME');
  });
});

describe('requireJsonBody', () => {
  it('接受普通对象', () => {
    expect(requireJsonBody({ a: 1 })).toEqual({ a: 1 });
  });

  it('拒绝 null / 数组 / 标量', () => {
    expectHttpError(() => requireJsonBody(null), 400, 'INVALID_BODY');
    expectHttpError(() => requireJsonBody([1, 2]), 400, 'INVALID_BODY');
    expectHttpError(() => requireJsonBody('x'), 400, 'INVALID_BODY');
    expectHttpError(() => requireJsonBody(undefined), 400, 'INVALID_BODY');
  });
});

describe('枚举校验', () => {
  it('modelKey 只接受三个枚举值', () => {
    expect(validateModelKey('text_zh')).toBe('text_zh');
    expect(validateModelKey('image')).toBe('image');
    expectHttpError(() => validateModelKey('bge'), 400, 'INVALID_MODEL_KEY');
    expectHttpError(() => validateModelKey(undefined), 400, 'INVALID_MODEL_KEY');
  });

  it('ikMode 可选，非法值 400', () => {
    expect(validateIkMode(undefined)).toBeUndefined();
    expect(validateIkMode('max_word')).toBe('max_word');
    expectHttpError(() => validateIkMode('ik'), 400, 'INVALID_IK_MODE');
  });

  it('mode 默认 upsert，非法值 400', () => {
    expect(validateDocumentMode(undefined)).toBe('upsert');
    expect(validateDocumentMode('insert')).toBe('insert');
    expectHttpError(() => validateDocumentMode('replace'), 400, 'INVALID_MODE');
  });

  it('refreshIndex 只接受布尔值', () => {
    expect(validateRefreshIndex(undefined)).toBeUndefined();
    expect(validateRefreshIndex(false)).toBe(false);
    expectHttpError(() => validateRefreshIndex('false'), 400, 'INVALID_REFRESH_INDEX');
  });
});

describe('nResults 校验', () => {
  it('默认 10，接受 1..50 整数', () => {
    expect(validateNResults(undefined)).toBe(10);
    expect(validateNResults(1)).toBe(1);
    expect(validateNResults(50)).toBe(50);
  });

  it('拒绝小数 / 越界 / 字符串', () => {
    expectHttpError(() => validateNResults(0), 400, 'INVALID_N_RESULTS');
    expectHttpError(() => validateNResults(51), 400, 'INVALID_N_RESULTS');
    expectHttpError(() => validateNResults(1.5), 400, 'INVALID_N_RESULTS');
    expectHttpError(() => validateNResults('10'), 400, 'INVALID_N_RESULTS');
  });
});

describe('ids / documents 校验', () => {
  it('接受字符串数组', () => {
    expect(validateIds(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('拒绝非数组 / 非字符串元素 / 空数组', () => {
    expectHttpError(() => validateIds('a'), 400, 'INVALID_IDS');
    expectHttpError(() => validateIds([1, 2]), 400, 'INVALID_IDS');
    expectHttpError(() => validateIds([]), 400, 'INVALID_IDS');
  });

  it(`单请求超过 ${MAX_IDS_PER_REQUEST} 条 → 400 TOO_MANY_IDS`, () => {
    const tooMany = Array.from({ length: MAX_IDS_PER_REQUEST + 1 }, (_, i) => `id-${i}`);
    expectHttpError(() => validateIds(tooMany), 400, 'TOO_MANY_IDS');
  });

  it('长度不一致 → 400', () => {
    expectHttpError(() => assertSameLength(2, 3, 'documents'), 400, 'INVALID_BODY');
  });

  it('insert 模式请求内重复 id → 409 DOCUMENT_EXISTS', () => {
    expect(() => assertInsertIdsUnique(['a', 'b'])).not.toThrow();
    expectHttpError(() => assertInsertIdsUnique(['a', 'a']), 409, 'DOCUMENT_EXISTS');
  });
});

describe('embeddings 校验', () => {
  it('接受有限数二维数组', () => {
    expect(validateEmbeddings([[1, 2], [3, 4]])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('拒绝空数组 / 非数组行 / 非有限数 / 行长度不一致', () => {
    expectHttpError(() => validateEmbeddings([]), 400, 'INVALID_EMBEDDINGS');
    expectHttpError(() => validateEmbeddings([1, 2]), 400, 'INVALID_EMBEDDINGS');
    expectHttpError(() => validateEmbeddings([['a', 'b']]), 400, 'INVALID_EMBEDDINGS');
    expectHttpError(() => validateEmbeddings([[1, 2], [3]]), 400, 'INVALID_EMBEDDINGS');
  });

  it('queryEmbedding 必须为非空有限数数组', () => {
    expect(validateQueryEmbedding([0.1, 0.2])).toEqual([0.1, 0.2]);
    expectHttpError(() => validateQueryEmbedding([]), 400, 'INVALID_QUERY_EMBEDDING');
    expectHttpError(() => validateQueryEmbedding([1, 'x']), 400, 'INVALID_QUERY_EMBEDDING');
  });
});

describe('metadatas 校验', () => {
  it('允许 null 占位，长度必须与 ids 对齐', () => {
    expect(validateMetadatas(undefined, 2)).toBeUndefined();
    expect(validateMetadatas([{ source: 'a.md' }, null], 2)).toEqual([{ source: 'a.md' }, null]);
  });

  it('长度不一致 / 元素非法 → 400', () => {
    expectHttpError(() => validateMetadatas([{}], 2), 400, 'INVALID_METADATAS');
    expectHttpError(() => validateMetadatas([[1]], 1), 400, 'INVALID_METADATAS');
    expectHttpError(() => validateMetadatas('x', 1), 400, 'INVALID_METADATAS');
  });
});

describe('keyword 校验', () => {
  it('可选，接受 ≤128 字符', () => {
    expect(validateKeyword(undefined)).toBeUndefined();
    expect(validateKeyword('OceanBase')).toBe('OceanBase');
    expect(validateKeyword('k'.repeat(MAX_KEYWORD_LENGTH))).toHaveLength(MAX_KEYWORD_LENGTH);
  });

  it('超长 / 非字符串 → 400', () => {
    expectHttpError(
      () => validateKeyword('k'.repeat(MAX_KEYWORD_LENGTH + 1)),
      400,
      'INVALID_KEYWORD',
    );
    expectHttpError(() => validateKeyword(42), 400, 'INVALID_KEYWORD');
  });
});

describe('source 与 query 参数', () => {
  it('source 可选非空字符串', () => {
    expect(validateSource(undefined)).toBeUndefined();
    expect(validateSource('docs/a.md')).toBe('docs/a.md');
    expectHttpError(() => validateSource('   '), 400, 'INVALID_SOURCE');
    expectHttpError(() => validateSource(1), 400, 'INVALID_SOURCE');
  });

  it('readQueryString 只接受单值字符串', () => {
    expect(readQueryString(makeRequest({ a: 'x' }), 'a')).toBe('x');
    expect(readQueryString(makeRequest({}), 'a')).toBeUndefined();
    expectHttpError(() => readQueryString(makeRequest({ a: ['x', 'y'] }), 'a'), 400, 'INVALID_QUERY');
  });

  it('isDeepProbe 识别 1/true', () => {
    expect(isDeepProbe('1')).toBe(true);
    expect(isDeepProbe('true')).toBe(true);
    expect(isDeepProbe('0')).toBe(false);
    expect(isDeepProbe(undefined)).toBe(false);
    expect(isDeepProbe(['1'])).toBe(true);
  });
});

describe('escapeQueryStringKeyword', () => {
  it('转义 Lucene query_string 特殊字符', () => {
    expect(escapeQueryStringKeyword('a+b')).toBe('a\\+b');
    expect(escapeQueryStringKeyword('(x) [y] {z}')).toBe('\\(x\\) \\[y\\] \\{z\\}');
    expect(escapeQueryStringKeyword('"quoted"')).toBe('\\"quoted\\"');
    expect(escapeQueryStringKeyword('a~b*c?d:e\\f/g')).toBe('a\\~b\\*c\\?d\\:e\\\\f\\/g');
    expect(escapeQueryStringKeyword('a&&b||c')).toBe('a\\&\\&b\\|\\|c');
    expect(escapeQueryStringKeyword('^prefix')).toBe('\\^prefix');
  });

  it('普通中英文/空格不需要转义', () => {
    expect(escapeQueryStringKeyword('OceanBase 向量检索')).toBe('OceanBase 向量检索');
  });
});

describe('AsyncMutex FIFO', () => {
  it('串行执行，先来先得', async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];
    const task = (id: number, delay: number) =>
      mutex.runExclusive(async () => {
        order.push(id);
        await new Promise((resolve) => setTimeout(resolve, delay));
        order.push(-id);
      });

    await Promise.all([task(1, 20), task(2, 5), task(3, 1)]);
    // 若并发执行，-1/-2/-3 顺序会被 delay 打乱
    expect(order).toEqual([1, -1, 2, -2, 3, -3]);
    expect(mutex.size).toBe(0);
  });

  it('异常也会释放锁', async () => {
    const mutex = new AsyncMutex();
    await expect(
      mutex.runExclusive(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(mutex.runExclusive(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('health 版本解析', () => {
  it('解析 seekdb 语义版本', () => {
    expect(parseSeekdbSemver('5.7.25-OceanBase_SeekDB-v1.4.0.0')).toEqual([1, 4, 0]);
    expect(parseSeekdbSemver('5.7.25-OceanBase_SeekDB-v1.3.0')).toEqual([1, 3, 0]);
    expect(parseSeekdbSemver('8.0.32')).toEqual([8, 0, 32]);
    expect(parseSeekdbSemver('not-a-version')).toBeNull();
    expect(parseSeekdbSemver('1.2.3 and 4.5.6')).toBeNull();
  });

  it('refreshIndexSupported 要求 ≥ 1.3.0', () => {
    expect(compareSemver([1, 4, 0], [1, 3, 0])).toBeGreaterThan(0);
    expect(isRefreshIndexSupported('5.7.25-OceanBase_SeekDB-v1.4.0.0')).toBe(true);
    expect(isRefreshIndexSupported('5.7.25-OceanBase_SeekDB-v1.3.0')).toBe(true);
    expect(isRefreshIndexSupported('5.7.25-OceanBase_SeekDB-v1.2.0')).toBe(false);
    expect(isRefreshIndexSupported(null)).toBe(false);
  });

  it('从 SELECT VERSION() 行结果提取版本串', () => {
    expect(extractVersionFromRows([{ version: '5.7.25-OceanBase_SeekDB-v1.4.0.0' }])).toBe(
      '5.7.25-OceanBase_SeekDB-v1.4.0.0',
    );
    expect(extractVersionFromRows([{ 'VERSION()': '8.0.32' }])).toBe('8.0.32');
    expect(extractVersionFromRows([{ version: { VARCHAR: '1.3.0' } }])).toBe('1.3.0');
    expect(extractVersionFromRows([])).toBeNull();
    expect(extractVersionFromRows(null)).toBeNull();
  });
});

describe('timing 工具', () => {
  it('roundMs 保留 2 位小数且不产生负数', () => {
    expect(roundMs(1.23456)).toBe(1.23);
    expect(roundMs(-5)).toBe(0);
    expect(roundMs(Number.NaN)).toBe(0);
  });

  it('elapsedMs 为单调递增的毫秒差', () => {
    const start = nowMs();
    const elapsed = elapsedMs(start, start + 12.345);
    expect(elapsed).toBe(12.35);
  });
});

describe('config 解析', () => {
  it('CORS 白名单逐项 trim 并过滤空项', () => {
    expect(parseCorsOrigins(undefined)).toEqual(['http://localhost:5173']);
    expect(parseCorsOrigins('')).toEqual(['http://localhost:5173']);
    expect(parseCorsOrigins('  ')).toEqual(['http://localhost:5173']);
    expect(parseCorsOrigins(' http://a:1 , http://b:2 ,')).toEqual(['http://a:1', 'http://b:2']);
    expect(parseCorsOrigins(',,')).toEqual(['http://localhost:5173']);
  });

  it('SEEKDB_QUERY_TIMEOUT_MS 默认 30000，非法值回退', () => {
    expect(parseQueryTimeoutMs(undefined)).toBe(30000);
    expect(parseQueryTimeoutMs('')).toBe(30000);
    expect(parseQueryTimeoutMs('0')).toBe(30000);
    expect(parseQueryTimeoutMs('abc')).toBe(30000);
    expect(parseQueryTimeoutMs('15000')).toBe(15000);
  });
});
