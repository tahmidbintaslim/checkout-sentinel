import type { Browser } from 'playwright';
import { launchBrowser } from '@checkout-sentinel/core';

/**
 * One Chromium process per worker, shared by concurrent jobs; each journey gets its own
 * context, which is the isolation unit (cookies, cart, storage). A crashed or disconnected
 * browser is replaced on the next acquire.
 */
export class BrowserPool {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;

  constructor(private readonly launch: () => Promise<Browser> = () => launchBrowser()) {}

  async get(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.launching ??= this.launch()
      .then((browser) => {
        this.browser = browser;
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = null;
        });
        return browser;
      })
      .finally(() => {
        this.launching = null;
      });
    return this.launching;
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => undefined);
  }
}
