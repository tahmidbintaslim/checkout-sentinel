import type { Dirent } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { DeviceNameSchema, STEP_NAMES } from '@checkout-sentinel/core';
import type { DeletedRun, LostRun } from '@checkout-sentinel/db';
import type { WorkerMetrics } from './metrics.js';
import { acquireRedisLock, type HeldLock } from './store-lock.js';

export const DEFAULT_STALE_AFTER_MS = 15 * 60_000;
/** Browser launch, the use-time URL check, screenshots, traces and database writes. */
const RUN_OVERHEAD_MS = 2 * 60_000;

export interface StaleRunThreshold {
  /** Estimate of the longest run these timeouts allow. */
  longestRunMs: number;
  /** Runs still "running" this long after they started are marked lost. */
  staleAfterMs: number;
  /** RUN_STALE_AFTER_MS is below longestRunMs, so a slow run on a live worker may be swept. */
  belowLongestRun: boolean;
}

/**
 * How long a run may stay "running" before the sweeper decides its worker is gone. The
 * longest run is estimated from the timeouts: every step of both devices waiting out one
 * navigation timeout and one step timeout, plus fixed overhead. Without RUN_STALE_AFTER_MS
 * the threshold is 15 minutes, or that estimate when it is longer; RUN_STALE_AFTER_MS
 * replaces it as given.
 */
export function staleRunThreshold(input: {
  staleAfterMs?: number | undefined;
  navigationTimeoutMs: number;
  stepTimeoutMs: number;
}): StaleRunThreshold {
  const longestRunMs =
    DeviceNameSchema.options.length *
      STEP_NAMES.length *
      (input.navigationTimeoutMs + input.stepTimeoutMs) +
    RUN_OVERHEAD_MS;
  const staleAfterMs = input.staleAfterMs ?? Math.max(DEFAULT_STALE_AFTER_MS, longestRunMs);
  return { longestRunMs, staleAfterMs, belowLongestRun: staleAfterMs < longestRunMs };
}

/** The error stored on a swept run. */
export function workerLostMessage(staleAfterMs: number): string {
  const minutes = Math.round((staleAfterMs / 60_000) * 10) / 10;
  return `Worker lost: the run was still running ${minutes} min after it started`;
}

export const HOUSEKEEPING_LOCK_KEY = 'checkout-sentinel:housekeeping';

/** One pass at a time across all workers. The TTL frees the lock if its holder dies. */
export function housekeepingLock(redis: Redis, ttlMs: number, key = HOUSEKEEPING_LOCK_KEY) {
  return { acquire: () => acquireRedisLock(redis, key, ttlMs) };
}

export interface HousekeepingDeps {
  runs: {
    markLost(staleAfterMs: number, error: string): Promise<LostRun[]>;
    deleteExpired(olderThanDays: number, limit: number): Promise<DeletedRun[]>;
  };
  monitors: { listIds(): Promise<string[]> };
  lock: { acquire(): Promise<HeldLock | null> };
  metrics: WorkerMetrics;
  logger: Logger;
}

export interface HousekeepingOptions {
  staleAfterMs: number;
  /** Runs older than this many days are deleted. 0 keeps them forever. */
  retentionDays: number;
  /** The worker's ARTIFACTS_DIR: <dir>/<monitorId>/<runId>/ holds a run's screenshots and traces. */
  artifactsDir: string;
  intervalMs: number;
  /** Runs deleted per statement. */
  batchSize?: number;
  /** Statements per pass; the rest waits for the next pass, so one pass stays short. */
  maxBatches?: number;
}

export interface HousekeepingReport {
  swept: number;
  deletedRuns: number;
  deletedArtifactDirs: number;
}

type Task = 'sweep' | 'retention' | 'artifacts' | 'pass';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Keeps the runs table honest and bounded. Each pass, under a Redis lock:
 * 1. Sweep: runs still "running" after staleAfterMs are marked error ("Worker lost"). They
 *    are left by a worker that died mid-run; BullMQ retries such a job as a new run.
 * 2. Retention: runs older than retentionDays are deleted in batches, with their artifact
 *    directories, and the artifact directories of deleted monitors are removed.
 * Each worker tries a pass on start and every intervalMs.
 */
export class Housekeeping {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private readonly batchSize: number;
  private readonly maxBatches: number;

  constructor(
    private readonly deps: HousekeepingDeps,
    private readonly options: HousekeepingOptions,
  ) {
    this.batchSize = options.batchSize ?? 500;
    this.maxBatches = options.maxBatches ?? 20;
  }

  /** Runs one pass. Returns null when another worker's pass holds the lock. */
  async runOnce(): Promise<HousekeepingReport | null> {
    const lock = await this.deps.lock.acquire();
    if (!lock) {
      this.deps.logger.debug('housekeeping: another worker holds the lock; skipping this pass');
      return null;
    }
    const report: HousekeepingReport = { swept: 0, deletedRuns: 0, deletedArtifactDirs: 0 };
    try {
      await this.guard('sweep', () => this.sweep(report));
      if (this.options.retentionDays > 0) {
        await this.guard('retention', () => this.retention(report));
      }
    } finally {
      await lock
        .release()
        .catch((error: unknown) =>
          this.deps.logger.warn({ err: error }, 'housekeeping lock release failed'),
        );
    }
    const level =
      report.swept + report.deletedRuns + report.deletedArtifactDirs > 0 ? 'info' : 'debug';
    this.deps.logger[level](report, 'housekeeping pass finished');
    return report;
  }

  /** Runs a pass now, then every intervalMs. A pass still running when the next is due is not doubled. */
  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.options.intervalMs);
    this.timer.unref();
  }

  /** Stops the timer and waits for a pass in progress. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.current;
  }

  private tick(): void {
    if (this.current) return;
    this.current = this.runOnce()
      .then(() => undefined)
      .catch((error: unknown) => {
        // Only taking the lock can throw here (Redis down); the tasks catch their own errors.
        this.deps.metrics.housekeepingFailures.inc({ task: 'pass' });
        this.deps.logger.error({ err: error }, 'housekeeping pass failed');
      })
      .finally(() => {
        this.current = null;
      });
  }

  private async guard(task: Task, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.deps.metrics.housekeepingFailures.inc({ task });
      this.deps.logger.error({ err: error, task }, 'housekeeping task failed');
    }
  }

  private async sweep(report: HousekeepingReport): Promise<void> {
    const { staleAfterMs } = this.options;
    const lost = await this.deps.runs.markLost(staleAfterMs, workerLostMessage(staleAfterMs));
    if (lost.length === 0) return;
    report.swept += lost.length;
    this.deps.metrics.runsSwept.inc(lost.length);
    for (const run of lost) {
      this.deps.logger.warn(
        { runId: run.id, monitorId: run.monitorId, startedAt: run.startedAt, staleAfterMs },
        'run marked lost: still running after the stale threshold',
      );
    }
  }

  private async retention(report: HousekeepingReport): Promise<void> {
    for (let batch = 0; batch < this.maxBatches; batch += 1) {
      const deleted = await this.deps.runs.deleteExpired(
        this.options.retentionDays,
        this.batchSize,
      );
      if (deleted.length > 0) {
        report.deletedRuns += deleted.length;
        this.deps.metrics.runsDeleted.inc(deleted.length);
      }
      // Rows go first: a crash before the files are removed leaves files, never rows that
      // point at missing screenshots.
      for (const run of deleted) {
        if (await this.removeArtifactDir(run.monitorId, run.id)) report.deletedArtifactDirs += 1;
      }
      if (deleted.length < this.batchSize) break;
    }
    await this.removeDeletedMonitorDirs(report);
  }

  /** Monitors deleted through the API take their runs with them (cascade); this takes their files. */
  private async removeDeletedMonitorDirs(report: HousekeepingReport): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.options.artifactsDir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    // Directory names that are not monitor ids are not ours to delete.
    const dirs = entries.filter((e) => e.isDirectory() && UUID.test(e.name)).map((e) => e.name);
    if (dirs.length === 0) return;
    // Listed after reading the directory, so a monitor created in between is known here.
    const known = new Set(await this.deps.monitors.listIds());
    for (const monitorId of dirs) {
      if (!known.has(monitorId) && (await this.removeArtifactDir(monitorId))) {
        report.deletedArtifactDirs += 1;
      }
    }
  }

  /** Removes <artifactsDir>/<monitorId>[/<runId>]. False when it did not exist or failed. */
  private async removeArtifactDir(...ids: string[]): Promise<boolean> {
    if (!ids.every((id) => UUID.test(id))) return false;
    try {
      await rm(path.join(this.options.artifactsDir, ...ids), { recursive: true });
      this.deps.metrics.artifactDirsDeleted.inc();
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      this.deps.metrics.housekeepingFailures.inc({ task: 'artifacts' });
      this.deps.logger.warn({ err: error, ids }, 'could not remove an artifact directory');
      return false;
    }
  }
}
