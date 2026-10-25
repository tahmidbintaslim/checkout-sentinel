import { describe, expect, it } from 'vitest';
import {
  ExitCode,
  RESULT_SCHEMA_VERSION,
  RunResultSchema,
  exitCodeFor,
  parseRunResult,
  runResultJsonSchema,
  type RunResult,
} from '@checkout-sentinel/core';

const now = '2026-10-25T10:00:00.000Z';

function sampleResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    tool: { name: 'checkout-sentinel', version: '0.1.0' },
    runId: 'run-1',
    url: 'https://store.test/products/tee',
    requestedPlatform: 'auto',
    startedAt: now,
    finishedAt: now,
    durationMs: 1200,
    status: 'failed',
    summary: { journeys: 1, passed: 0, failed: 1, slowSteps: 0 },
    journeys: [
      {
        device: 'mobile',
        status: 'failed',
        startedAt: now,
        durationMs: 1200,
        platform: { detected: 'shopify', used: 'shopify', confidence: 'high', signals: [] },
        failedStep: 'find_add_to_cart',
        steps: [
          {
            name: 'open_product',
            status: 'passed',
            startedAt: now,
            durationMs: 300,
            slow: false,
            details: { httpStatus: 200 },
            consoleErrors: [],
            pageErrors: [{ message: 'x is undefined' }],
            failedRequests: [
              {
                url: 'https://store.test/a.js',
                method: 'GET',
                resourceType: 'script',
                kind: 'http_error',
                status: 404,
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('RunResultSchema', () => {
  it('accepts a well-formed result', () => {
    expect(() => parseRunResult(sampleResult())).not.toThrow();
  });

  it('round-trips through JSON', () => {
    const result = sampleResult();
    expect(parseRunResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it('rejects a different schema version', () => {
    expect(RunResultSchema.safeParse({ ...sampleResult(), schemaVersion: 2 }).success).toBe(false);
  });

  it('rejects unknown step names and statuses', () => {
    const bad = sampleResult();
    (bad.journeys[0]!.steps[0] as { name: string }).name = 'pay_now';
    expect(RunResultSchema.safeParse(bad).success).toBe(false);

    const bad2 = sampleResult();
    (bad2.journeys[0]!.steps[0] as { status: string }).status = 'flaky';
    expect(RunResultSchema.safeParse(bad2).success).toBe(false);
  });

  it('exports a JSON Schema', () => {
    const schema = runResultJsonSchema();
    expect(schema).toHaveProperty('type', 'object');
    expect(schema).toHaveProperty('properties.schemaVersion');
  });
});

describe('exitCodeFor', () => {
  it('maps run status to exit codes', () => {
    expect(exitCodeFor({ status: 'passed' })).toBe(ExitCode.Passed);
    expect(exitCodeFor({ status: 'failed' })).toBe(ExitCode.JourneyFailed);
    expect(exitCodeFor({ status: 'error' })).toBe(ExitCode.RuntimeError);
  });
});
