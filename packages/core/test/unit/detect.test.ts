import { describe, expect, it } from 'vitest';
import {
  DETECTION_THRESHOLD,
  SIGNAL_RULES,
  detectPlatform,
  emptySignals,
  headerSignals,
  type PageSignals,
} from '@checkout-sentinel/core';

const withSignals = (overrides: Partial<PageSignals>): PageSignals => ({
  ...emptySignals(),
  ...overrides,
});

describe('detectPlatform', () => {
  it('returns unknown when nothing fires', () => {
    expect(detectPlatform(emptySignals())).toMatchObject({
      platform: 'unknown',
      confidence: 'low',
      signals: [],
    });
  });

  it('detects Shopify with high confidence from strong signals', () => {
    const outcome = detectPlatform(
      withSignals({ shopifyGlobal: true, shopifyMeta: true, shopifyCartAddForm: true }),
    );
    expect(outcome.platform).toBe('shopify');
    expect(outcome.confidence).toBe('high');
    expect(outcome.signals).toEqual(['shopifyGlobal', 'shopifyMeta', 'shopifyCartAddForm']);
  });

  it('detects WooCommerce from generator meta and body class', () => {
    const outcome = detectPlatform(withSignals({ wooGenerator: true, wooBodyClass: true }));
    expect(outcome.platform).toBe('woocommerce');
    expect(outcome.scores.woocommerce).toBe(5);
  });

  it('does not decide on a single weak markup signal', () => {
    expect(SIGNAL_RULES.shopifyCartAddForm.weight).toBeLessThan(DETECTION_THRESHOLD);
    expect(detectPlatform(withSignals({ shopifyCartAddForm: true })).platform).toBe('unknown');
    expect(detectPlatform(withSignals({ wooAddToCartButton: true })).platform).toBe('unknown');
  });

  it('returns unknown on a tie instead of guessing', () => {
    const outcome = detectPlatform(withSignals({ shopifyGlobal: true, wooGenerator: true }));
    expect(outcome.platform).toBe('unknown');
  });

  it('lets the stronger platform win when a theme imitates the other', () => {
    // A WooCommerce store whose theme copied a Shopify-style form action.
    const outcome = detectPlatform(
      withSignals({
        shopifyCartAddForm: true,
        wooGenerator: true,
        wooScriptGlobals: true,
        wooBodyClass: true,
      }),
    );
    expect(outcome.platform).toBe('woocommerce');
    expect(outcome.signals).not.toContain('shopifyCartAddForm');
  });
});

describe('headerSignals', () => {
  it.each([
    [{ 'x-shopid': '123' }, true],
    [{ 'X-Shopify-Stage': 'production' }, true],
    [{ 'powered-by': 'Shopify' }, true],
    [{ 'x-powered-by': 'PHP/8.3' }, false],
    [{}, false],
  ])('%o -> %s', (headers, expected) => {
    expect(headerSignals(headers).shopifyHeaders).toBe(expected);
  });
});
