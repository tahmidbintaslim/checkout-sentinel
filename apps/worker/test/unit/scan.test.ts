import { DelayedError, type Job } from 'bullmq';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunResult } from '@checkout-sentinel/core';
import type { ScanJob } from '@checkout-sentinel/jobs';
import { processScanJob, type ScanDeps } from '@checkout-sentinel/worker';

function deps(lockFree: boolean) {
  const release = vi.fn(async () => undefined);
  const run = vi.fn(async (_options: RunOptions) => ({ status: 'passed' }) as RunResult);
  const scanDeps = {
    lock: { acquire: async () => (lockFree ? { release } : null) },
    browsers: { get: async () => ({}) },
    targetGuard: {},
    logger: pino({ level: 'silent' }),
    run,
    config: { navigationTimeoutMs: 30_000, stepTimeoutMs: 15_000 },
  } as unknown as ScanDeps;
  return { scanDeps, run, release };
}

const job = (moveToDelayed = vi.fn(async () => undefined)) =>
  ({
    id: 'scan-1',
    data: { url: 'https://shop.example/products/tee' },
    moveToDelayed,
  }) as unknown as Job<ScanJob>;

describe('processScanJob', () => {
  it('runs both devices with the SSRF guard and no artifacts, then frees the store', async () => {
    const { scanDeps, run, release } = deps(true);
    const result = await processScanJob(scanDeps, job());
    expect(result.status).toBe('passed');
    const options = run.mock.calls[0]![0];
    expect(options).toMatchObject({
      url: 'https://shop.example/products/tee',
      devices: 'both',
      runId: 'scan-1',
    });
    expect(options.targetGuard).toBe(scanDeps.targetGuard);
    expect(options.artifactsDir).toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  });

  it('waits when the store is busy with another journey', async () => {
    const { scanDeps, run } = deps(false);
    const moveToDelayed = vi.fn(async () => undefined);
    await expect(processScanJob(scanDeps, job(moveToDelayed), 'token')).rejects.toBeInstanceOf(
      DelayedError,
    );
    expect(moveToDelayed).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });
});
