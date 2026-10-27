import { describe, expect, it } from 'vitest';
import { isConnectionError } from '../src/db/client.js';

describe('isConnectionError', () => {
  it('识别 seekdb 重启后的典型连接错误', () => {
    expect(
      isConnectionError(new Error("Can't add new command when connection is in closed state")),
    ).toBe(true);
    expect(isConnectionError(new Error('Connection lost: The server closed the connection.'))).toBe(
      true,
    );
    expect(isConnectionError(new Error('read ECONNRESET'))).toBe(true);
    expect(isConnectionError(new Error('PROTOCOL_CONNECTION_LOST'))).toBe(true);
  });

  it('识别 SDK 外层 SeekdbConnectionError 及 cause 里的 ECONNREFUSED', () => {
    const wrapped = Object.assign(new Error('Failed to connect to 127.0.0.1:2882'), {
      name: 'SeekdbConnectionError',
      cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:2882' },
    });
    expect(isConnectionError(wrapped)).toBe(true);
    expect(isConnectionError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isConnectionError({ cause: { code: 'ENOTFOUND' } })).toBe(true);
  });

  it('不把普通业务错误当连接错误', () => {
    expect(isConnectionError(new Error('Collection not found: x'))).toBe(false);
    expect(isConnectionError(new Error('duplicate entry'))).toBe(false);
  });
});
