import type { Page } from 'playwright';
import type { Detection, Platform } from './schema.js';

/**
 * Observable facts about a product page. Collected in the browser by collectPageSignals and
 * scored by detectPlatform, which is a pure function so the scoring is unit tested without
 * a browser.
 */
export interface PageSignals {
  shopifyGlobal: boolean;
  shopifyMeta: boolean;
  shopifyCdnAssets: boolean;
  shopifyCartAddForm: boolean;
  shopifyHeaders: boolean;
  wooBodyClass: boolean;
  wooGenerator: boolean;
  wooScriptGlobals: boolean;
  wooAssets: boolean;
  wooAddToCartButton: boolean;
}

export type SignalName = keyof PageSignals;

interface SignalRule {
  platform: Exclude<Platform, 'unknown'>;
  weight: number;
  description: string;
}

/**
 * Weights: 3 = set by the platform itself and rarely faked by themes (globals, generator
 * meta, response headers); 2 = platform assets or body classes; 1 = markup a theme or a
 * page builder could imitate.
 */
export const SIGNAL_RULES: Readonly<Record<SignalName, SignalRule>> = {
  shopifyGlobal: { platform: 'shopify', weight: 3, description: 'window.Shopify is defined' },
  shopifyMeta: {
    platform: 'shopify',
    weight: 3,
    description: 'meta[name="shopify-checkout-api-token"] or shopify-digital-wallet',
  },
  shopifyHeaders: {
    platform: 'shopify',
    weight: 3,
    description: 'Shopify response headers (x-shopid, x-shopify-stage, powered-by: Shopify)',
  },
  shopifyCdnAssets: { platform: 'shopify', weight: 2, description: 'assets from cdn.shopify.com' },
  shopifyCartAddForm: { platform: 'shopify', weight: 1, description: 'form[action*="/cart/add"]' },
  wooGenerator: {
    platform: 'woocommerce',
    weight: 3,
    description: 'meta[name="generator"] mentions WooCommerce',
  },
  wooScriptGlobals: {
    platform: 'woocommerce',
    weight: 3,
    description: 'wc_add_to_cart_params or woocommerce_params is defined',
  },
  wooBodyClass: {
    platform: 'woocommerce',
    weight: 2,
    description: 'body has class woocommerce or woocommerce-page',
  },
  wooAssets: {
    platform: 'woocommerce',
    weight: 2,
    description: 'assets under /plugins/woocommerce/',
  },
  wooAddToCartButton: {
    platform: 'woocommerce',
    weight: 1,
    description: 'button.single_add_to_cart_button',
  },
};

/** Minimum score for a verdict; a single weak markup signal is not enough. */
export const DETECTION_THRESHOLD = 2;

export function emptySignals(): PageSignals {
  return {
    shopifyGlobal: false,
    shopifyMeta: false,
    shopifyCdnAssets: false,
    shopifyCartAddForm: false,
    shopifyHeaders: false,
    wooBodyClass: false,
    wooGenerator: false,
    wooScriptGlobals: false,
    wooAssets: false,
    wooAddToCartButton: false,
  };
}

export interface DetectionOutcome {
  platform: Platform;
  confidence: Detection['confidence'];
  scores: Record<'shopify' | 'woocommerce', number>;
  signals: SignalName[];
}

export function detectPlatform(signals: PageSignals): DetectionOutcome {
  const scores = { shopify: 0, woocommerce: 0 };
  const fired: SignalName[] = [];
  for (const name of Object.keys(SIGNAL_RULES) as SignalName[]) {
    if (!signals[name]) continue;
    const rule = SIGNAL_RULES[name];
    scores[rule.platform] += rule.weight;
    fired.push(name);
  }

  const best = scores.shopify >= scores.woocommerce ? 'shopify' : 'woocommerce';
  const bestScore = scores[best];
  const tie = scores.shopify === scores.woocommerce;
  if (bestScore < DETECTION_THRESHOLD || tie) {
    return { platform: 'unknown', confidence: 'low', scores, signals: fired };
  }
  const margin = bestScore - Math.min(scores.shopify, scores.woocommerce);
  const confidence = bestScore >= 5 && margin >= 3 ? 'high' : bestScore >= 3 ? 'medium' : 'low';
  return {
    platform: best,
    confidence,
    scores,
    signals: fired.filter((name) => SIGNAL_RULES[name].platform === best),
  };
}

export function headerSignals(
  headers: Record<string, string>,
): Pick<PageSignals, 'shopifyHeaders'> {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const poweredBy = lower['powered-by'] ?? lower['x-powered-by'] ?? '';
  return {
    shopifyHeaders:
      'x-shopid' in lower ||
      'x-shopify-stage' in lower ||
      'x-sorting-hat-shopid' in lower ||
      /shopify/i.test(poweredBy),
  };
}

/** Reads detection signals from the live page. Runs no store code and makes no requests. */
export async function collectPageSignals(
  page: Page,
  responseHeaders: Record<string, string>,
): Promise<PageSignals> {
  const dom = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const has = (selector: string): boolean => document.querySelector(selector) !== null;
    const generator = document.querySelector('meta[name="generator"]')?.getAttribute('content');
    const body = document.body;
    return {
      shopifyGlobal: typeof w['Shopify'] === 'object' && w['Shopify'] !== null,
      shopifyMeta: has(
        'meta[name="shopify-checkout-api-token"], meta[name="shopify-digital-wallet"]',
      ),
      shopifyCdnAssets: has('script[src*="cdn.shopify.com"], link[href*="cdn.shopify.com"]'),
      shopifyCartAddForm: has('form[action*="/cart/add"]'),
      wooBodyClass:
        body !== null &&
        (body.classList.contains('woocommerce') || body.classList.contains('woocommerce-page')),
      wooGenerator: typeof generator === 'string' && /woocommerce/i.test(generator),
      wooScriptGlobals:
        typeof w['wc_add_to_cart_params'] !== 'undefined' ||
        typeof w['woocommerce_params'] !== 'undefined',
      wooAssets: has('script[src*="/plugins/woocommerce/"], link[href*="/plugins/woocommerce/"]'),
      wooAddToCartButton: has('button.single_add_to_cart_button'),
    };
  });
  return { ...dom, ...headerSignals(responseHeaders) };
}

export function describeSignals(signals: readonly SignalName[]): string[] {
  return signals.map((name) => SIGNAL_RULES[name].description);
}
