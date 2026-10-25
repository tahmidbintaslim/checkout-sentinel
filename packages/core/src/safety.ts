import type { BrowserContext } from 'playwright';

/**
 * Defense in depth for "never place an order". The journey never fills or submits checkout
 * forms, and on top of that every non-GET request to an order placement or payment endpoint
 * is aborted in the browser and recorded as blocked.
 */
const ORDER_PLACEMENT_PATTERNS: readonly RegExp[] = [
  // Shopify checkout completion and payment session endpoints.
  /\/checkouts\/(?:[^/?]+\/)+(processing|payments?|complete)\b/,
  /\/\/(deposit\.shopifycs\.com|checkout\.pci\.shopifyinc\.com)\//,
  /\/api\/unstable\/graphql.*SubmitForCompletion/i,
  // WooCommerce classic and block checkout submission.
  /[?&]wc-ajax=checkout\b/,
  /\/wc\/store(\/v1)?\/checkout\b/,
  // Payment provider confirmation calls.
  /\/\/api\.stripe\.com\/v1\/(payment_intents|setup_intents)\/[^/]+\/confirm/,
  /\/\/(www\.)?paypal\.com\/.*\/(orders|payments)\b/,
];

export function isOrderPlacementRequest(url: string, method: string): boolean {
  if (method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD') return false;
  return ORDER_PLACEMENT_PATTERNS.some((pattern) => pattern.test(url));
}

/** A POST to the checkout page itself is a form submission (WooCommerce classic). */
export function isCheckoutFormSubmission(url: string, method: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  try {
    return /\/checkout\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Only these URLs go through the route handler, so ordinary assets are not intercepted. */
const GUARDED_URL = /checkout|payment|stripe|paypal|shopifycs|wc-ajax/i;

/**
 * Aborts order placement and payment requests for every page in the context. Blocked
 * requests surface as failedRequests with kind "blocked" (net::ERR_BLOCKED_BY_CLIENT).
 */
export async function installOrderGuard(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => GUARDED_URL.test(url.toString()),
    async (route) => {
      const request = route.request();
      if (
        isOrderPlacementRequest(request.url(), request.method()) ||
        isCheckoutFormSubmission(request.url(), request.method())
      ) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.fallback();
    },
  );
}
