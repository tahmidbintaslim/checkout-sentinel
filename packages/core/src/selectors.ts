import type { Platform } from './schema.js';

export type AddToCartStrategy =
  | { id: string; platform: Platform; kind: 'css'; selector: string; description: string }
  | { id: string; platform: Platform; kind: 'role'; name: RegExp; description: string };

/**
 * Ordered from most to least specific. Platform strategies match the markup the platform's
 * own templates emit (Dawn and other Online Store 2.0 themes for Shopify, the default
 * single-product template for WooCommerce). The generic strategy finds a button by its
 * accessible name, which also covers page builders and headless storefronts.
 */
export const SHOPIFY_STRATEGIES: readonly AddToCartStrategy[] = [
  {
    id: 'shopify-cart-add-form-submit',
    platform: 'shopify',
    kind: 'css',
    selector:
      'form[action*="/cart/add"] [type="submit"][name="add"], form[action*="/cart/add"] button[type="submit"]',
    description: 'submit button inside form[action*="/cart/add"]',
  },
  {
    id: 'shopify-name-add',
    platform: 'shopify',
    kind: 'css',
    selector: '[name="add"]',
    description: '[name="add"]',
  },
];

export const WOOCOMMERCE_STRATEGIES: readonly AddToCartStrategy[] = [
  {
    id: 'woo-single-add-to-cart-button',
    platform: 'woocommerce',
    kind: 'css',
    selector: 'button.single_add_to_cart_button',
    description: 'button.single_add_to_cart_button',
  },
  {
    id: 'woo-add-to-cart-link',
    platform: 'woocommerce',
    kind: 'css',
    selector: 'a[href*="add-to-cart="]',
    description: 'a[href*="add-to-cart="]',
  },
];

export const ADD_TO_CART_NAME = /^\s*(add to (cart|bag|basket)|buy (it )?now)\b/i;

export const GENERIC_STRATEGIES: readonly AddToCartStrategy[] = [
  {
    id: 'generic-button-name',
    platform: 'unknown',
    kind: 'role',
    name: ADD_TO_CART_NAME,
    description: 'button with accessible name "Add to cart" (or bag, basket, buy now)',
  },
];

export function addToCartStrategies(platform: Platform): AddToCartStrategy[] {
  switch (platform) {
    case 'shopify':
      return [...SHOPIFY_STRATEGIES, ...GENERIC_STRATEGIES];
    case 'woocommerce':
      return [...WOOCOMMERCE_STRATEGIES, ...GENERIC_STRATEGIES];
    case 'unknown':
      return [...SHOPIFY_STRATEGIES, ...WOOCOMMERCE_STRATEGIES, ...GENERIC_STRATEGIES];
  }
}

/** Requests that mean "an item is being added to the cart" for the platforms we know. */
export function isCartAddRequest(url: string, method: string, postData: string | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const path = parsed.pathname;
  if (/\/cart\/add(\.js)?$/.test(path)) return true;
  if (parsed.searchParams.has('add-to-cart')) return true;
  if (parsed.searchParams.get('wc-ajax') === 'add_to_cart') return true;
  if (/\/wc\/store(\/v1)?\/cart\/add-item$/.test(path)) return true;
  return method === 'POST' && postData !== null && /(^|&)add-to-cart=/.test(postData);
}

export interface CheckoutTarget {
  /** Path navigated to after the cart is verified. */
  path: string;
  /** Final URL must match one of these after redirects. */
  urlPatterns: RegExp[];
  /** At least one must render for the checkout to count as usable. */
  markers: string;
}

const EMAIL_FIELD = 'input[type="email"], input[autocomplete~="email"], #email';

export const CHECKOUT_TARGETS: Readonly<Record<Platform, CheckoutTarget>> = {
  shopify: {
    path: '/checkout',
    urlPatterns: [/\/checkouts\//, /\/checkout\/?$/],
    markers: `${EMAIL_FIELD}, form[action*="/checkouts/"], [data-checkout-root]`,
  },
  woocommerce: {
    path: '/checkout/',
    urlPatterns: [/\/checkout\/?$/],
    markers: `form.checkout, form.woocommerce-checkout, .wc-block-checkout, #billing_email, ${EMAIL_FIELD}`,
  },
  unknown: {
    path: '/checkout',
    urlPatterns: [/\/checkouts?\b/],
    markers: `form.checkout, ${EMAIL_FIELD}`,
  },
};

export function matchesCheckoutUrl(platform: Platform, url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return CHECKOUT_TARGETS[platform].urlPatterns.some((pattern) => pattern.test(path));
}
