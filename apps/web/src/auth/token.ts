/**
 * The API token lives in sessionStorage: it survives reloads and navigation in this tab, and is
 * gone when the tab closes. It is never written to localStorage or a cookie.
 */
export const TOKEN_STORAGE_KEY = 'checkout-sentinel.api-token';

/** Used only when the browser refuses storage access, so the token lasts for this page. */
let memoryToken: string | null = null;

function defaultStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function readToken(storage: Storage | null = defaultStorage()): string | null {
  try {
    const value = storage?.getItem(TOKEN_STORAGE_KEY) ?? memoryToken;
    return value && value.length > 0 ? value : null;
  } catch {
    return memoryToken;
  }
}

export function saveToken(token: string, storage: Storage | null = defaultStorage()): void {
  const value = token.trim();
  if (value.length === 0) {
    clearToken(storage);
    return;
  }
  try {
    if (!storage) throw new Error('no session storage');
    storage.setItem(TOKEN_STORAGE_KEY, value);
    memoryToken = null;
  } catch {
    memoryToken = value;
  }
}

export function clearToken(storage: Storage | null = defaultStorage()): void {
  memoryToken = null;
  try {
    storage?.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Nothing was stored there.
  }
}
