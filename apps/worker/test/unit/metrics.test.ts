import { describe, expect, it } from 'vitest';
import type { RunResult } from '@checkout-sentinel/core';
import { WorkerMetrics } from '@checkout-sentinel/worker';

describe('WorkerMetrics', () => {
  it('counts runs and failures and records step durations', async () => {
    const metrics = new WorkerMetrics({ defaultMetrics: false });
    const t = '2026-10-25T10:00:00.000Z';
    const step = (name: 'open_product' | 'find_add_to_cart', status: 'passed' | 'failed') => ({
      name,
      status,
      startedAt: t,
      durationMs: 1500,
      slow: false,
      details: {},
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
    });
    metrics.observeRun(
      {
        status: 'failed',
        journeys: [
          {
            device: 'mobile',
            status: 'failed',
            failedStep: 'find_add_to_cart',
            startedAt: t,
            durationMs: 3000,
            platform: null,
            steps: [step('open_product', 'passed'), step('find_add_to_cart', 'failed')],
          },
        ],
      } as unknown as RunResult,
      'schedule',
    );
    const text = await metrics.registry.metrics();
    expect(text).toContain('checkout_sentinel_runs_total{status="failed",trigger="schedule"} 1');
    expect(text).toContain(
      'checkout_sentinel_journey_failures_total{device="mobile",step="find_add_to_cart"} 1',
    );
    expect(text).toMatch(
      /checkout_sentinel_step_duration_seconds_count\{step="open_product",device="mobile",status="passed"\} 1/,
    );
  });
});
