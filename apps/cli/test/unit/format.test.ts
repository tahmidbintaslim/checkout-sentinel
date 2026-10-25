import { describe, expect, it } from 'vitest';
import type { RunResult } from '@checkout-sentinel/core';
import { formatMs, formatRunResult } from '@checkout-sentinel/cli';

const t = '2026-10-25T10:00:00.000Z';
const step = (name: RunResult['journeys'][number]['steps'][number]['name'], extra = {}) => ({
  name,
  status: 'passed' as const,
  startedAt: t,
  durationMs: 120,
  slow: false,
  details: {},
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  ...extra,
});

describe('formatRunResult', () => {
  it('renders a failed mobile journey with the reason and artifacts', () => {
    const result: RunResult = {
      schemaVersion: 1,
      tool: { name: 'checkout-sentinel', version: '0.1.0' },
      runId: 'r1',
      url: 'https://s.test/products/tee',
      requestedPlatform: 'auto',
      startedAt: t,
      finishedAt: t,
      durationMs: 2500,
      status: 'failed',
      summary: { journeys: 1, passed: 0, failed: 1, slowSteps: 0 },
      journeys: [
        {
          device: 'mobile',
          status: 'failed',
          startedAt: t,
          durationMs: 2500,
          platform: {
            detected: 'shopify',
            used: 'shopify',
            confidence: 'high',
            signals: ['window.Shopify is defined'],
          },
          failedStep: 'find_add_to_cart',
          trace: '/tmp/r1/mobile-trace.zip',
          steps: [
            step('open_product', {
              details: { httpStatus: 200, detectedPlatform: 'shopify', platformUsed: 'shopify' },
            }),
            step('find_add_to_cart', {
              status: 'failed',
              message: 'Add-to-cart control exists but is hidden',
              screenshot: '/tmp/r1/mobile-find_add_to_cart.png',
              pageErrors: [{ message: 'boom' }],
            }),
            step('add_to_cart', {
              status: 'skipped',
              durationMs: 0,
              message: 'Skipped because find_add_to_cart failed',
            }),
          ],
        },
      ],
    };
    const text = formatRunResult(result);
    expect(text).toContain('Platform: shopify (high confidence: window.Shopify is defined)');
    expect(text).toMatch(/mobile\s+FAILED/);
    expect(text).toMatch(/FAIL\s+find_add_to_cart.*hidden/);
    expect(text).toContain('page error: boom');
    expect(text).toContain('screenshot: /tmp/r1/mobile-find_add_to_cart.png');
    expect(text).toContain('trace: /tmp/r1/mobile-trace.zip');
    expect(text).toContain('Result: FAILED  0/1 journeys passed');
    // No ANSI codes with the plain painter.
    expect(text.includes('\u001b[')).toBe(false);
  });
});

describe('formatMs', () => {
  it('switches to seconds at 1000 ms', () => {
    expect(formatMs(999)).toBe('999 ms');
    expect(formatMs(1234)).toBe('1.23 s');
  });
});
