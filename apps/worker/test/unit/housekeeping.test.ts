import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STALE_AFTER_MS,
  Housekeeping,
  WorkerMetrics,
  staleRunThreshold,
  workerLostMessage,
  type HousekeepingDeps,
} from '@checkout-sentinel/worker';

describe('staleRunThreshold', () => {
  it('uses 15 minutes with the default timeouts, which is above the longest possible run', () => {
    expect(staleRunThreshold({ navigationTimeoutMs: 30_000, stepTimeoutMs: 15_000 })).toEqual({
      // 2 devices x 6 steps x (30 s + 15 s) + 2 min of overhead = 11 min
      longestRunMs: 660_000,
      staleAfterMs: DEFAULT_STALE_AFTER_MS,
      belowLongestRun: false,
    });
    expect(DEFAULT_STALE_AFTER_MS).toBe(15 * 60_000);
  });

  it('raises the default when long timeouts allow runs over 15 minutes', () => {
    expect(staleRunThreshold({ navigationTimeoutMs: 60_000, stepTimeoutMs: 30_000 })).toEqual({
      // 2 x 6 x 90 s + 2 min = 20 min
      longestRunMs: 1_200_000,
      staleAfterMs: 1_200_000,
      belowLongestRun: false,
    });
  });

  it('uses RUN_STALE_AFTER_MS as given and says when it is below the longest run', () => {
    expect(
      staleRunThreshold({
        staleAfterMs: 300_000,
        navigationTimeoutMs: 30_000,
        stepTimeoutMs: 15_000,
      }),
    ).toEqual({ longestRunMs: 660_000, staleAfterMs: 300_000, belowLongestRun: true });
    expect(
      staleRunThreshold({
        staleAfterMs: 1_800_000,
        navigationTimeoutMs: 30_000,
        stepTimeoutMs: 15_000,
      }),
    ).toEqual({ longestRunMs: 660_000, staleAfterMs: 1_800_000, belowLongestRun: false });
  });

  it('names the threshold in the error a swept run gets', () => {
    expect(workerLostMessage(900_000)).toBe(
      'Worker lost: the run was still running 15 min after it started',
    );
    expect(workerLostMessage(90_000)).toBe(
      'Worker lost: the run was still running 1.5 min after it started',
    );
  });
});

interface FakeRun {
  id: string;
  monitorId: string;
}

/** In-memory stand-ins for the repositories and the Redis lock; SQL is covered by e2e tests. */
function fakes(options: { expired?: FakeRun[]; monitorIds?: string[]; lockFree?: boolean } = {}) {
  const expired = [...(options.expired ?? [])];
  const calls = { markLost: [] as number[], deleteExpired: [] as Array<[number, number]> };
  let lockHeld = !(options.lockFree ?? true);
  let sweepError: Error | null = null;
  const deps: HousekeepingDeps = {
    runs: {
      markLost: async (staleAfterMs: number) => {
        calls.markLost.push(staleAfterMs);
        if (sweepError) throw sweepError;
        return [{ id: randomUUID(), monitorId: randomUUID(), startedAt: new Date(0) }];
      },
      deleteExpired: async (days: number, limit: number) => {
        calls.deleteExpired.push([days, limit]);
        return expired.splice(0, limit);
      },
    },
    monitors: { listIds: async () => options.monitorIds ?? [] },
    lock: {
      acquire: async () => {
        if (lockHeld) return null;
        lockHeld = true;
        return {
          release: async () => {
            lockHeld = false;
          },
        };
      },
    },
    metrics: new WorkerMetrics({ defaultMetrics: false }),
    logger: pino({ level: 'silent' }),
  };
  return {
    deps,
    calls,
    failSweep(error: Error) {
      sweepError = error;
    },
  };
}

describe('Housekeeping pass', () => {
  let artifacts: string;

  beforeEach(async () => {
    artifacts = await mkdtemp(path.join(tmpdir(), 'checkout-sentinel-housekeeping-'));
  });
  afterEach(async () => {
    await rm(artifacts, { recursive: true, force: true });
  });

  const options = (overrides: Partial<ConstructorParameters<typeof Housekeeping>[1]> = {}) => ({
    staleAfterMs: 900_000,
    retentionDays: 30,
    artifactsDir: artifacts,
    intervalMs: 300_000,
    batchSize: 2,
    maxBatches: 10,
    ...overrides,
  });

  it('does nothing while another worker holds the lock', async () => {
    const { deps, calls } = fakes({ lockFree: false });
    expect(await new Housekeeping(deps, options()).runOnce()).toBeNull();
    expect(calls).toEqual({ markLost: [], deleteExpired: [] });
  });

  it('sweeps, then deletes expired runs in batches until a short batch', async () => {
    const monitorId = randomUUID();
    const expired = Array.from({ length: 5 }, () => ({ id: randomUUID(), monitorId }));
    const { deps, calls } = fakes({ expired, monitorIds: [monitorId] });
    const report = await new Housekeeping(deps, options()).runOnce();
    expect(report).toEqual({ swept: 1, deletedRuns: 5, deletedArtifactDirs: 0 });
    expect(calls.markLost).toEqual([900_000]);
    // 2 + 2 + 1: the short third batch ends the loop.
    expect(calls.deleteExpired).toEqual([
      [30, 2],
      [30, 2],
      [30, 2],
    ]);
    const text = await deps.metrics.registry.metrics();
    expect(text).toContain('checkout_sentinel_runs_swept_total 1');
    expect(text).toContain('checkout_sentinel_runs_deleted_total 5');
  });

  it('stops after maxBatches and leaves the rest for the next pass', async () => {
    const monitorId = randomUUID();
    const expired = Array.from({ length: 9 }, () => ({ id: randomUUID(), monitorId }));
    const { deps, calls } = fakes({ expired, monitorIds: [monitorId] });
    const report = await new Housekeeping(deps, options({ maxBatches: 3 })).runOnce();
    expect(report?.deletedRuns).toBe(6);
    expect(calls.deleteExpired).toHaveLength(3);
  });

  it('removes the artifacts of deleted runs and of monitors that no longer exist, nothing else', async () => {
    const kept = randomUUID();
    const gone = randomUUID();
    const deletedRun = { id: randomUUID(), monitorId: kept };
    const keptRun = randomUUID();
    for (const dir of [
      path.join(artifacts, kept, deletedRun.id),
      path.join(artifacts, kept, keptRun),
      path.join(artifacts, gone, randomUUID()),
      path.join(artifacts, 'not-a-monitor'),
    ]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'mobile-trace.zip'), 'trace');
    }
    const { deps } = fakes({ expired: [deletedRun], monitorIds: [kept] });
    const report = await new Housekeeping(deps, options()).runOnce();
    expect(report).toMatchObject({ deletedRuns: 1, deletedArtifactDirs: 2 });
    expect((await readdir(artifacts)).sort()).toEqual([kept, 'not-a-monitor'].sort());
    expect(await readdir(path.join(artifacts, kept))).toEqual([keptRun]);
    expect(await deps.metrics.registry.metrics()).toContain(
      'checkout_sentinel_artifact_dirs_deleted_total 2',
    );
  });

  it('works when the artifacts directory does not exist yet', async () => {
    const { deps } = fakes({ expired: [{ id: randomUUID(), monitorId: randomUUID() }] });
    const report = await new Housekeeping(
      deps,
      options({ artifactsDir: path.join(artifacts, 'missing') }),
    ).runOnce();
    expect(report).toEqual({ swept: 1, deletedRuns: 1, deletedArtifactDirs: 0 });
  });

  it('keeps everything when retention is off', async () => {
    const { deps, calls } = fakes({ expired: [{ id: randomUUID(), monitorId: randomUUID() }] });
    await mkdir(path.join(artifacts, randomUUID()));
    const report = await new Housekeeping(deps, options({ retentionDays: 0 })).runOnce();
    expect(report).toEqual({ swept: 1, deletedRuns: 0, deletedArtifactDirs: 0 });
    expect(calls.deleteExpired).toEqual([]);
    expect(await readdir(artifacts)).toHaveLength(1);
  });

  it('still runs retention when the sweep fails, and counts the failure', async () => {
    const { deps, calls, failSweep } = fakes({
      expired: [{ id: randomUUID(), monitorId: randomUUID() }],
    });
    failSweep(new Error('connection terminated'));
    const report = await new Housekeeping(deps, options()).runOnce();
    expect(report).toEqual({ swept: 0, deletedRuns: 1, deletedArtifactDirs: 0 });
    expect(calls.deleteExpired).toHaveLength(1);
    expect(await deps.metrics.registry.metrics()).toContain(
      'checkout_sentinel_housekeeping_failures_total{task="sweep"} 1',
    );
  });

  it('releases the lock after a pass, so the next pass can run', async () => {
    const { deps, calls } = fakes();
    const housekeeping = new Housekeeping(deps, options());
    await housekeeping.runOnce();
    await housekeeping.runOnce();
    expect(calls.markLost).toHaveLength(2);
  });
});
