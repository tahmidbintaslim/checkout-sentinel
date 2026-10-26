import { beforeEach, describe, expect, it } from 'vitest';
import { TOKEN_STORAGE_KEY, clearToken, readToken, saveToken } from '../../src/auth/token';

describe('API token storage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it('keeps the token in sessionStorage only, trimmed', () => {
    expect(readToken()).toBeNull();
    saveToken('  e2e-api-token-0123456789 ');
    expect(readToken()).toBe('e2e-api-token-0123456789');
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe('e2e-api-token-0123456789');
    expect(localStorage.length).toBe(0);
    clearToken();
    expect(readToken()).toBeNull();
  });

  it('treats an empty token as no token', () => {
    saveToken('   ');
    expect(readToken()).toBeNull();
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('keeps the token in memory for this page when the browser blocks storage', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    } as unknown as Storage;
    expect(readToken(blocked)).toBeNull();
    expect(() => saveToken('x'.repeat(16), blocked)).not.toThrow();
    expect(readToken(blocked)).toBe('x'.repeat(16));
    expect(() => clearToken(blocked)).not.toThrow();
    expect(readToken(blocked)).toBeNull();
  });
});
