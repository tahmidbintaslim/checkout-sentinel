import type { Server } from 'node:http';
import { Worker } from 'bullmq';
import { pino, type Logger } from 'pino';
import { TargetGuard, targetPolicyFromEnv } from '@checkout-sentinel/core';
import {
  AlertDeliveryRepository,
  MonitorRepository,
  RunRepository,
  StateRepository,
  createDb,
  pingDb,
} from '@checkout-sentinel/db';
import {
  JOURNEY_QUEUE,
  JourneyScheduler,
  createRedis,
  type JourneyJob,
} from '@checkout-sentinel/jobs';
import { BrowserPool } from './browser-pool.js';
import type { WorkerConfig } from './config.js';
import { Housekeeping, housekeepingLock, staleRunThreshold } from './housekeeping.js';
import { startMetricsServer } from './http.js';
import { WorkerMetrics } from './metrics.js';
import { processJourneyJob, type JobOutcome } from './processor.js';
import { StoreLock } from './store-lock.js';

export interface RunningWorker {
  worker: Worker<JourneyJob, JobOutcome>;
  metrics: WorkerMetrics;
  metricsServer: Server | null;
  /** Null when HOUSEKEEPING_INTERVAL_MS is 0. */
  housekeeping: Housekeeping | null;
  logger: Logger;
  /**
   * Stops taking jobs and starting housekeeping passes, waits for running journeys and a pass
   * in progress, then closes browser, Redis and Postgres.
   */
  shutdown(): Promise<void>;
}

/** Longest a single run may hold its store lock before Redis expires it. */
const STORE_LOCK_TTL_MS = 10 * 60_000;
/** A pass is a few bounded statements; the TTL only matters if its worker dies mid-pass. */
const HOUSEKEEPING_LOCK_TTL_MS = 5 * 60_000;

export async function startWorker(config: WorkerConfig, logger?: Logger): Promise<RunningWorker> {
  const log =
    logger ?? pino({ level: config.LOG_LEVEL, base: { service: 'checkout-sentinel-worker' } });
  const db = createDb(config.DATABASE_URL, { max: Math.max(4, config.WORKER_CONCURRENCY * 2) });
  const redis = createRedis(config.REDIS_URL);
  const workerConnection = createRedis(config.REDIS_URL);
  const scheduler = new JourneyScheduler(redis);
  const metrics = new WorkerMetrics();
  const browsers = new BrowserPool();
  const targetGuard = new TargetGuard(targetPolicyFromEnv(config), {
    // Refusal reasons in results and delivery logs leave the address out; operators get it here.
    onDnsRefusal: ({ host, address, range }) => {
      log.debug({ host, address, range }, 'target refused: name resolves to a non-public address');
    },
  });

  const monitors = new MonitorRepository(db.db);
  const runs = new RunRepository(db.db);
  const deps = {
    monitors,
    runs,
    state: new StateRepository(db.db),
    deliveries: new AlertDeliveryRepository(db.db),
    lock: new StoreLock(redis, config.PER_STORE_CONCURRENCY, STORE_LOCK_TTL_MS),
    browsers,
    metrics,
    logger: log,
    removeScheduler: (id: string) => scheduler.remove(id),
    targetGuard,
    config: {
      artifactsDir: config.ARTIFACTS_DIR,
      alertTimeoutMs: config.ALERT_TIMEOUT_MS,
      navigationTimeoutMs: config.NAVIGATION_TIMEOUT_MS,
      stepTimeoutMs: config.STEP_TIMEOUT_MS,
      publicBaseUrl: config.PUBLIC_BASE_URL,
      userAgentContactUrl: config.USER_AGENT_CONTACT_URL,
    },
  };

  const worker = new Worker<JourneyJob, JobOutcome>(
    JOURNEY_QUEUE,
    (job, token) => processJourneyJob(deps, job, token),
    {
      connection: workerConnection,
      concurrency: config.WORKER_CONCURRENCY,
      // A journey can legitimately take minutes; renew the job lock well inside that.
      lockDuration: 120_000,
    },
  );
  worker.on('failed', (job, error) => {
    log.error({ jobId: job?.id, err: error }, 'job failed');
  });
  worker.on('error', (error) => log.error({ err: error }, 'worker error'));

  const metricsServer =
    config.METRICS_PORT > 0
      ? await startMetricsServer(metrics, config.METRICS_PORT, async () => {
          const [dbOk, redisOk] = await Promise.all([pingDb(db), scheduler.ping()]);
          return dbOk && redisOk && worker.isRunning();
        })
      : null;

  const staleness = staleRunThreshold({
    staleAfterMs: config.RUN_STALE_AFTER_MS,
    navigationTimeoutMs: config.NAVIGATION_TIMEOUT_MS,
    stepTimeoutMs: config.STEP_TIMEOUT_MS,
  });
  const housekeeping =
    config.HOUSEKEEPING_INTERVAL_MS > 0
      ? new Housekeeping(
          {
            runs,
            monitors,
            lock: housekeepingLock(redis, HOUSEKEEPING_LOCK_TTL_MS),
            metrics,
            logger: log,
          },
          {
            staleAfterMs: staleness.staleAfterMs,
            retentionDays: config.RUN_RETENTION_DAYS,
            artifactsDir: config.ARTIFACTS_DIR,
            intervalMs: config.HOUSEKEEPING_INTERVAL_MS,
          },
        )
      : null;

  log.info(
    {
      concurrency: config.WORKER_CONCURRENCY,
      perStore: config.PER_STORE_CONCURRENCY,
      metricsPort: config.METRICS_PORT,
      targetPolicy: targetGuard.policy,
      housekeeping: housekeeping
        ? {
            intervalMs: config.HOUSEKEEPING_INTERVAL_MS,
            staleAfterMs: staleness.staleAfterMs,
            retentionDays: config.RUN_RETENTION_DAYS,
          }
        : 'off',
    },
    'worker started',
  );
  if (housekeeping && staleness.belowLongestRun) {
    log.warn(
      { staleAfterMs: staleness.staleAfterMs, longestRunMs: staleness.longestRunMs },
      'RUN_STALE_AFTER_MS is below the longest run these timeouts allow: a slow run on a live worker may be marked lost',
    );
  }
  if (targetGuard.permissive) {
    log.warn(
      'ALLOW_PRIVATE_TARGETS is on: journeys and alerts may reach private and internal addresses. Use it only for local development.',
    );
  }

  // Sweeps once now (runs left by a worker that died while this one was down), then on a timer.
  housekeeping?.start();

  let closing: Promise<void> | null = null;
  const shutdown = () => {
    closing ??= (async () => {
      log.info('shutting down: waiting for running journeys');
      await Promise.all([worker.close(), housekeeping?.stop()]);
      await browsers.close();
      await scheduler.close();
      redis.disconnect();
      workerConnection.disconnect();
      await db.close();
      await new Promise<void>((resolve) =>
        metricsServer ? metricsServer.close(() => resolve()) : resolve(),
      );
      log.info('shutdown complete');
    })();
    return closing;
  };

  return { worker, metrics, metricsServer, housekeeping, logger: log, shutdown };
}
