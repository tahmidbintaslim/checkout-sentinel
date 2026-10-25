import { describe, expect, it } from 'vitest';
import { isCheckoutFormSubmission, isOrderPlacementRequest } from '@checkout-sentinel/core';

describe('isOrderPlacementRequest', () => {
  it.each([
    ['https://s.test/checkouts/cn/abc/processing', 'POST'],
    ['https://deposit.shopifycs.com/sessions', 'POST'],
    ['https://s.test/?wc-ajax=checkout', 'POST'],
    ['https://s.test/wp-json/wc/store/v1/checkout', 'POST'],
    ['https://api.stripe.com/v1/payment_intents/pi_1/confirm', 'POST'],
  ])('blocks %s %s', (url, method) => {
    expect(isOrderPlacementRequest(url, method)).toBe(true);
  });

  it.each([
    ['https://s.test/checkouts/cn/abc/processing', 'GET'],
    ['https://s.test/cart/add', 'POST'],
    ['https://s.test/?wc-ajax=update_order_review', 'POST'],
    ['https://api.stripe.com/v1/elements/sessions', 'GET'],
  ])('allows %s %s', (url, method) => {
    expect(isOrderPlacementRequest(url, method)).toBe(false);
  });
});

describe('isCheckoutFormSubmission', () => {
  it('treats a POST to the checkout page as a submission', () => {
    expect(isCheckoutFormSubmission('https://s.test/checkout/', 'POST')).toBe(true);
    expect(isCheckoutFormSubmission('https://s.test/checkout/', 'GET')).toBe(false);
    expect(isCheckoutFormSubmission('https://s.test/product/x/', 'POST')).toBe(false);
  });
});
