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

  it('不把普通业务错误当连接错误', () => {
    expect(isConnectionError(new Error('Collection not found: x'))).toBe(false);
    expect(isConnectionError(new Error('duplicate entry'))).toBe(false);
  });
});
