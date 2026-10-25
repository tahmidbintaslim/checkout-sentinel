import { chromium, type Browser } from 'playwright';

export interface LaunchOptions {
  /** Defaults to CHECKOUT_SENTINEL_CHROMIUM_PATH, then Playwright's own downloaded Chromium. */
  executablePath?: string;
  headless?: boolean;
}

export const CHROMIUM_PATH_ENV = 'CHECKOUT_SENTINEL_CHROMIUM_PATH';

export function resolveExecutablePath(explicit?: string): string | undefined {
  const fromEnv = process.env[CHROMIUM_PATH_ENV];
  return explicit ?? (fromEnv && fromEnv.length > 0 ? fromEnv : undefined);
}

export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  const executablePath = resolveExecutablePath(options.executablePath);
  return chromium.launch({
    headless: options.headless ?? true,
    ...(executablePath ? { executablePath } : {}),
    // /dev/shm is 64MB in default Docker containers, which crashes Chromium tabs.
    args: ['--disable-dev-shm-usage'],
  });
}
