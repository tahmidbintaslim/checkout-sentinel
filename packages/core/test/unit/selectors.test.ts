import { describe, expect, it } from 'vitest';
import {
  ADD_TO_CART_NAME,
  CHECKOUT_TARGETS,
  SCRIPT_DISABLED_CONTROLS,
  addToCartStrategies,
  isCartAddRequest,
  matchesCheckoutUrl,
} from '@checkout-sentinel/core';

describe('addToCartStrategies', () => {
  it('tries Shopify selectors first, then the generic fallback', () => {
    expect(addToCartStrategies('shopify').map((s) => s.id)).toEqual([
      'shopify-cart-add-form-submit',
      'shopify-name-add',
      'generic-button-name',
    ]);
  });

  it('tries WooCommerce selectors first, then the generic fallback', () => {
    expect(addToCartStrategies('woocommerce').map((s) => s.id)).toEqual([
      'woo-single-add-to-cart-button',
      'woo-add-to-cart-link',
      'generic-button-name',
    ]);
  });

  it("treats WooCommerce's class-disabled button as disabled, and nothing else by class", () => {
    // Checked on every candidate, whichever strategy matched it (integration tests run it).
    expect(SCRIPT_DISABLED_CONTROLS).toBe('.single_add_to_cart_button.disabled');
  });

  it('tries everything, generic last, when the platform is unknown', () => {
    const ids = addToCartStrategies('unknown').map((s) => s.id);
    expect(ids).toHaveLength(5);
    expect(ids.at(-1)).toBe('generic-button-name');
  });
});

describe('ADD_TO_CART_NAME', () => {
  it.each(['Add to cart', 'ADD TO BAG', '  Add to basket', 'Buy it now', 'Buy now'])(
    'matches %j',
    (label) => expect(ADD_TO_CART_NAME.test(label)).toBe(true),
  );
  it.each(['Add to wishlist', 'Added', 'Sold out', 'Remove from cart'])(
    'does not match %j',
    (label) => expect(ADD_TO_CART_NAME.test(label)).toBe(false),
  );
});

describe('isCartAddRequest', () => {
  it.each([
    ['https://s.test/cart/add', 'POST', null, true],
    ['https://s.test/cart/add.js', 'POST', null, true],
    ['https://s.test/en-th/cart/add', 'POST', null, true],
    ['https://s.test/?add-to-cart=42', 'GET', null, true],
    ['https://s.test/?wc-ajax=add_to_cart', 'POST', null, true],
    ['https://s.test/wp-json/wc/store/v1/cart/add-item', 'POST', null, true],
    ['https://s.test/product/hoodie/', 'POST', 'quantity=1&add-to-cart=42', true],
    ['https://s.test/product/hoodie/', 'POST', 'quantity=1', false],
    ['https://s.test/cart.js', 'GET', null, false],
    ['not a url', 'POST', null, false],
  ])('%s %s %s -> %s', (url, method, body, expected) => {
    expect(isCartAddRequest(url, method, body)).toBe(expected);
  });
});

describe('checkout targets', () => {
  it('uses the platform checkout paths', () => {
    expect(CHECKOUT_TARGETS.shopify.path).toBe('/checkout');
    expect(CHECKOUT_TARGETS.woocommerce.path).toBe('/checkout/');
  });

  it.each([
    ['shopify', 'https://s.test/checkouts/cn/abc123', true],
    ['shopify', 'https://s.test/checkout', true],
    ['shopify', 'https://s.test/cart', false],
    ['woocommerce', 'https://s.test/checkout/', true],
    ['woocommerce', 'https://s.test/cart/', false],
    ['woocommerce', 'https://s.test/my-account/', false],
  ] as const)('%s %s -> %s', (platform, url, expected) => {
    expect(matchesCheckoutUrl(platform, url)).toBe(expected);
  });
});
