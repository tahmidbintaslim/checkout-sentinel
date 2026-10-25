import type { APIRequestContext } from 'playwright';
import type { Platform } from './schema.js';

export interface CartReading {
  /** Item count, or null when the cart could not be read with this method. */
  count: number | null;
  source: string;
}

async function readJsonCount(
  request: APIRequestContext,
  url: string,
  field: string,
  source: string,
): Promise<CartReading> {
  try {
    const response = await request.get(url, {
      headers: { accept: 'application/json' },
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    if (!response.ok()) return { count: null, source: `${source} (HTTP ${response.status()})` };
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const value = (body as Record<string, unknown>)[field];
      if (typeof value === 'number') return { count: value, source };
    }
    return { count: null, source: `${source} (no ${field})` };
  } catch {
    return { count: null, source: `${source} (unreadable)` };
  }
}

/** Counts cart rows on a server-rendered WooCommerce cart page. */
async function readWooCartPage(request: APIRequestContext, origin: string): Promise<CartReading> {
  const source = '/cart/ page';
  try {
    const response = await request.get(new URL('/cart/', origin).toString(), {
      failOnStatusCode: false,
    });
    if (!response.ok()) return { count: null, source: `${source} (HTTP ${response.status()})` };
    const html = await response.text();
    if (/class="[^"]*\bcart-empty\b/.test(html)) return { count: 0, source };
    const rows = html.match(/class="[^"]*\bcart_item\b/g)?.length ?? 0;
    if (rows > 0 || /woocommerce-cart-form/.test(html)) return { count: rows, source };
    return { count: null, source: `${source} (not a WooCommerce cart)` };
  } catch {
    return { count: null, source: `${source} (unreadable)` };
  }
}

/**
 * Reads the cart through the same cookie jar as the browser page (the context's request
 * client), so it sees exactly the session the journey created.
 */
export async function readCart(
  request: APIRequestContext,
  origin: string,
  platform: Platform,
): Promise<CartReading> {
  const shopify = () =>
    readJsonCount(request, new URL('/cart.js', origin).toString(), 'item_count', '/cart.js');
  const woo = async () => {
    const storeApi = await readJsonCount(
      request,
      new URL('/wp-json/wc/store/v1/cart', origin).toString(),
      'items_count',
      'Store API /wp-json/wc/store/v1/cart',
    );
    return storeApi.count !== null ? storeApi : readWooCartPage(request, origin);
  };

  switch (platform) {
    case 'shopify':
      return shopify();
    case 'woocommerce':
      return woo();
    case 'unknown': {
      const fromShopify = await shopify();
      return fromShopify.count !== null ? fromShopify : woo();
    }
  }
}
