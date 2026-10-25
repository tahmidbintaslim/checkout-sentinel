import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Queue, Worker } from 'bullmq';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MonitorSpecSchema,
  TargetGuard,
  runJourneys,
  targetPolicyFromEnv,
} from '@checkout-sentinel/core';
import {
  AlertDeliveryRepository,
  MonitorRepository,
  RUN_RETRIED_ERROR,
  RunRepository,
  StateRepository,
  createDb,
  runMigrations,
  type DbHandle,
} from '@checkout-sentinel/db';
import {
  probeTestServices,
  startFixtureStore,
  startWebhookReceiver,
  truncateAll,
  type FixtureStore,
  type WebhookReceiver,
} from '@checkout-sentinel/fixtures';
import { JourneyScheduler, createRedis, type JourneyJob } from '@checkout-sentinel/jobs';
import {
  BrowserPool,
  DEFAULT_STALE_AFTER_MS,
  HOUSEKEEPING_LOCK_KEY,
  Housekeeping,
  StoreLock,
  WorkerMetrics,
  housekeepingLock,
  loadConfig,
  processJourneyJob,
  startWorker,
  workerLostMessage,
  type HousekeepingOptions,
  type JobOutcome,
  type ProcessorDeps,
  type RunningWorker,
} from '@checkout-sentinel/worker';

const services = await probeTestServices();

type SeedStatus = 'running' | 'passed' | 'failed' | 'error';

/**
 * The stale-run sweep and retention against real Postgres and Redis. History is seeded with
 * SQL and backdated with the database clock, which is the clock both tasks use. The worker
 * started here has housekeeping off, so passes run only when a test calls one.
 */
describe.skipIf(!services.available)('housekeeping end to end (Postgres + Redis)', () => {
  let db: DbHandle;
  let redis: ReturnType<typeof createRedis>;
  let scheduler: JourneyScheduler;
  let running: RunningWorker;
  let broken: FixtureStore;
  let healthy: FixtureStore;
  let hooks: WebhookReceiver;
  let artifacts: string;
  let monitors: MonitorRepository;
  let runs: RunRepository;
  let deliveries: AlertDeliveryRepository;
  let browsers: BrowserPool;

  beforeAll(async () => {
    db = createDb(services.databaseUrl);
    await runMigrations(db);
    await truncateAll(services.databaseUrl);
    redis = createRedis(services.redisUrl);
    scheduler = new JourneyScheduler(redis);
    await scheduler.queue.obliterate({ force: true });
    broken = await startFixtureStore({ platform: 'shopify', variant: 'mobile-hidden' });
    healthy = await startFixtureStore({ platform: 'shopify' });
    hooks = await startWebhookReceiver();
    artifacts = await mkdtemp(path.join(tmpdir(), 'checkout-sentinel-housekeeping-'));
    monitors = new MonitorRepository(db.db);
    runs = new RunRepository(db.db);
    deliveries = new AlertDeliveryRepository(db.db);
    browsers = new BrowserPool();
    running = await startWorker(
      loadConfig({
        DATABASE_URL: services.databaseUrl,
        REDIS_URL: services.redisUrl,
        METRICS_PORT: '0',
        ARTIFACTS_DIR: artifacts,
        STEP_TIMEOUT_MS: '3000',
        HOUSEKEEPING_INTERVAL_MS: '0',
        LOG_LEVEL: 'silent',
        // Fixture stores and the webhook receiver listen on 127.0.0.1.
        ALLOW_PRIVATE_TARGETS: 'true',
      }),
      pino({ level: 'silent' }),
    );
  });

  beforeEach(async () => {
    await truncateAll(services.databaseUrl);
    await redis.del(HOUSEKEEPING_LOCK_KEY);
  });

  afterAll(async () => {
    await running?.shutdown();
    await browsers?.close();
    await scheduler?.queue.obliterate({ force: true }).catch(() => undefined);
    await scheduler?.close();
    await redis?.del(HOUSEKEEPING_LOCK_KEY).catch(() => undefined);
    redis?.disconnect();
    await db?.close();
    await Promise.all([broken?.close(), healthy?.close(), hooks?.close()]);
    if (artifacts) await rm(artifacts, { recursive: true, force: true });
  });

  function housekeeping(options: Partial<HousekeepingOptions> = {}) {
    const metrics = new WorkerMetrics({ defaultMetrics: false });
    const pass = new Housekeeping(
      {
        runs,
        monitors,
        lock: housekeepingLock(redis, 60_000),
        metrics,
        logger: pino({ level: 'silent' }),
      },
      {
        staleAfterMs: DEFAULT_STALE_AFTER_MS,
        retentionDays: 30,
        artifactsDir: artifacts,
        intervalMs: 300_000,
        ...options,
      },
    );
    return { pass, metrics };
  }

  /** What startWorker gives processJourneyJob, for tests that drive the processor themselves. */
  function processorDeps(overrides: Partial<ProcessorDeps> = {}): ProcessorDeps {
    return {
      monitors,
      runs,
      state: new StateRepository(db.db),
      deliveries,
      lock: new StoreLock(redis, 1, 600_000, `test-store-lock-${randomUUID()}`),
      browsers,
      metrics: new WorkerMetrics({ defaultMetrics: false }),
      logger: pino({ level: 'silent' }),
      removeScheduler: async () => undefined,
      targetGuard: new TargetGuard(
        targetPolicyFromEnv(
          loadConfig({ DATABASE_URL: services.databaseUrl, ALLOW_PRIVATE_TARGETS: 'true' }),
        ),
      ),
      config: {
        artifactsDir: artifacts,
        alertTimeoutMs: 5_000,
        navigationTimeoutMs: 30_000,
        stepTimeoutMs: 3_000,
      },
      ...overrides,
    };
  }

  async function createMonitor(name: string, url = broken.productUrl) {
    return monitors.create(MonitorSpecSchema.parse({ name, url, devices: ['mobile'] }));
  }

  /** Inserts a run that started `age` ago (a Postgres interval) by the database clock. */
  async function seedRun(
    monitorId: string,
    status: SeedStatus,
    age: string,
    jobId: string | null = null,
  ): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `insert into runs (monitor_id, trigger, status, started_at, finished_at, job_id)
       values ($1, 'schedule', $2::run_status, now() - $3::interval,
               case when $2::run_status = 'running' then null
                    else now() - $3::interval + interval '5 seconds' end,
               $4)
       returning id`,
      [monitorId, status, age, jobId],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('insert returned no row');
    return id;
  }

  async function seedDelivery(monitorId: string, runId: string, kind: 'failure', age: string) {
    const claim = await deliveries.claim({
      monitorId,
      runId,
      kind,
      channelIndex: 0,
      channelType: 'webhook',
    });
    if (!claim) throw new Error('delivery already claimed');
    await deliveries.markSent(claim.id, 200);
    await db.pool.query(
      `update alert_deliveries set created_at = now() - $2::interval where id = $1`,
      [claim.id, age],
    );
    return claim.id;
  }

  async function seedArtifacts(...segments: string[]) {
    const dir = path.join(artifacts, ...segments);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'mobile-trace.zip'), 'trace');
  }

  async function runIds(monitorId: string): Promise<string[]> {
    return (await runs.listForMonitor(monitorId, 100)).items.map((r) => r.id).sort();
  }

  async function waitFor<T>(probe: () => Promise<T | null | undefined>, what: string): Promise<T> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value !== null && value !== undefined) return value;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  async function jobOutcome(jobId: string): Promise<JobOutcome> {
    return waitFor(async () => {
      const job = await scheduler.queue.getJob(jobId);
      return job && (await job.isCompleted()) ? (job.returnvalue as JobOutcome) : null;
    }, `job ${jobId}`);
  }

  it('marks a run left running past the threshold as error and leaves the alert state alone', async () => {
    const monitor = await createMonitor('Stuck run');
    // The monitor is in an open incident: failing, two failures in a row.
    const last = await seedRun(monitor.id, 'failed', '20 minutes');
    await new StateRepository(db.db).withLockedState(monitor.id, async () => ({
      update: {
        health: 'failing',
        consecutiveFailures: 2,
        slowSteps: [],
        lastRunId: last,
        lastRunStatus: 'failed',
        lastRunAt: new Date(),
        healthChanged: true,
      },
      value: null,
    }));
    const before = (await monitors.get(monitor.id))?.state;
    // Left behind by a worker that was killed an hour ago, and a journey in progress now.
    const stuck = await seedRun(monitor.id, 'running', '1 hour');
    const live = await seedRun(monitor.id, 'running', '2 minutes');

    const { pass, metrics } = housekeeping();
    expect(await pass.runOnce()).toEqual({ swept: 1, deletedRuns: 0, deletedArtifactDirs: 0 });

    const swept = await runs.get(stuck);
    expect(swept).toMatchObject({
      status: 'error',
      error: 'Worker lost: the run was still running 15 min after it started',
      result: null,
    });
    expect(swept?.finishedAt).toBeInstanceOf(Date);
    expect((await runs.get(live))?.status).toBe('running');
    // An error says nothing about the store: health, failure count and last run are unchanged.
    expect((await monitors.get(monitor.id))?.state).toEqual(before);
    expect(await deliveries.listForMonitor(monitor.id)).toEqual([]);
    expect(await metrics.registry.metrics()).toContain('checkout_sentinel_runs_swept_total 1');

    expect(await pass.runOnce()).toMatchObject({ swept: 0 });
  });

  it('runs one pass at a time across workers', async () => {
    const monitor = await createMonitor('Locked');
    const stuck = await seedRun(monitor.id, 'running', '1 hour');
    // Another worker is in the middle of a pass.
    await redis.set(HOUSEKEEPING_LOCK_KEY, 'another-worker', 'PX', 60_000);
    const { pass } = housekeeping();
    expect(await pass.runOnce()).toBeNull();
    expect((await runs.get(stuck))?.status).toBe('running');

    await redis.del(HOUSEKEEPING_LOCK_KEY);
    expect(await pass.runOnce()).toMatchObject({ swept: 1 });
    expect(await redis.exists(HOUSEKEEPING_LOCK_KEY)).toBe(0);
  });

  it('deletes old runs in batches, keeping the latest per monitor, the status run and the runs behind current alerts', async () => {
    const a = await createMonitor('History A');
    const b = await createMonitor('History B');
    const a1 = await seedRun(a.id, 'passed', '40 days');
    // a2 sent the failure alert of an incident that is still open; a3 an older one.
    const a2 = await seedRun(a.id, 'failed', '39 days');
    const a3 = await seedRun(a.id, 'failed', '41 days');
    const a4 = await seedRun(a.id, 'passed', '35 days');
    const a5 = await seedRun(a.id, 'error', '31 days');
    const a6 = await seedRun(a.id, 'error', '2 days');
    const a7 = await seedRun(a.id, 'running', '1 minute');
    const b1 = await seedRun(b.id, 'passed', '60 days');
    const b2 = await seedRun(b.id, 'failed', '50 days');
    const keptDelivery = await seedDelivery(a.id, a2, 'failure', '39 days');
    await seedDelivery(a.id, a3, 'failure', '41 days');
    // a6 crashed, and the crash path leaves monitor_state alone, so the status still shows a4.
    await db.pool.query('update monitor_state set last_run_id = $2 where monitor_id = $1', [
      a.id,
      a4,
    ]);
    for (const [monitorId, runId] of [
      [a.id, a1],
      [a.id, a2],
      [a.id, a3],
      [b.id, b1],
      [b.id, b2],
    ] as const) {
      await seedArtifacts(monitorId, runId);
    }
    // A monitor deleted through the API leaves its directory; other names are not ours.
    const deletedMonitor = randomUUID();
    await seedArtifacts(deletedMonitor, randomUUID());
    await seedArtifacts('notes');

    const { pass, metrics } = housekeeping({ batchSize: 2 });
    expect(await pass.runOnce()).toEqual({ swept: 0, deletedRuns: 4, deletedArtifactDirs: 4 });

    for (const id of [a1, a3, a5, b1]) expect(await runs.get(id)).toBeNull();
    expect(await runIds(a.id)).toEqual([a2, a4, a6, a7].sort());
    expect(await runIds(b.id)).toEqual([b2]);
    expect((await deliveries.listForMonitor(a.id)).map((d) => d.id)).toEqual([keptDelivery]);
    expect((await readdir(artifacts)).sort()).toEqual([a.id, b.id, 'notes'].sort());
    expect(await readdir(path.join(artifacts, a.id))).toEqual([a2]);
    expect(await readdir(path.join(artifacts, b.id))).toEqual([b2]);
    const text = await metrics.registry.metrics();
    expect(text).toContain('checkout_sentinel_runs_deleted_total 4');
    expect(text).toContain('checkout_sentinel_artifact_dirs_deleted_total 4');

    // Nothing left to delete: the kept runs stay on the next pass too.
    expect(await pass.runOnce()).toEqual({ swept: 0, deletedRuns: 0, deletedArtifactDirs: 0 });
    expect(await runIds(a.id)).toEqual([a2, a4, a6, a7].sort());
  });

  it('never deletes a running row; the sweep in the same pass finishes it first', async () => {
    const monitor = await createMonitor('Old stuck run');
    const stuck = await seedRun(monitor.id, 'running', '40 days');
    await seedRun(monitor.id, 'passed', '1 day');
    expect(await runs.deleteExpired(30, 10)).toEqual([]);
    expect((await runs.get(stuck))?.status).toBe('running');

    const { pass } = housekeeping();
    expect(await pass.runOnce()).toMatchObject({ swept: 1, deletedRuns: 1 });
    expect(await runs.get(stuck)).toBeNull();
  });

  it('keeps everything when RUN_RETENTION_DAYS is 0', async () => {
    const monitor = await createMonitor('Forever');
    await seedRun(monitor.id, 'passed', '400 days');
    await seedRun(monitor.id, 'passed', '1 day');
    const { pass } = housekeeping({ retentionDays: 0 });
    expect(await pass.runOnce()).toEqual({ swept: 0, deletedRuns: 0, deletedArtifactDirs: 0 });
    expect(await runIds(monitor.id)).toHaveLength(2);
  });

  it('discards a result that arrives after its run was swept, and applies the next run normally', async () => {
    const monitor = await monitors.create(
      MonitorSpecSchema.parse({
        name: 'Slow worker',
        url: broken.productUrl,
        devices: ['mobile'],
        alertAfterFailures: 1,
        alerts: [{ type: 'webhook', url: hooks.url('/late') }],
      }),
    );
    const jobId = await scheduler.enqueueNow(monitor.id);
    // While the journey runs (the hidden button keeps it busy for about two seconds), its row
    // is made to look an hour old and swept, as the sweep treats a live run that outlived
    // RUN_STALE_AFTER_MS. This worker keeps its job lock, so BullMQ records its outcome.
    const runId = await waitFor(async () => {
      const [latest] = (await runs.listForMonitor(monitor.id, 1)).items;
      return latest?.status === 'running' ? latest.id : null;
    }, 'the run to start');
    await db.pool.query(`update runs set started_at = now() - interval '1 hour' where id = $1`, [
      runId,
    ]);
    const { pass } = housekeeping();
    expect(await pass.runOnce()).toMatchObject({ swept: 1 });

    // The journey then finishes: a real failed result for a run already marked lost.
    expect(await jobOutcome(jobId)).toEqual({
      outcome: 'discarded',
      runId,
      status: 'failed',
      reason: `run was already marked error (${workerLostMessage(DEFAULT_STALE_AFTER_MS)})`,
    });
    expect(await runs.get(runId)).toMatchObject({
      status: 'error',
      error: workerLostMessage(DEFAULT_STALE_AFTER_MS),
      failedStep: null,
      result: null,
    });
    expect((await monitors.get(monitor.id))?.state).toMatchObject({
      health: 'unknown',
      consecutiveFailures: 0,
      lastRunId: null,
    });
    expect(await deliveries.listForMonitor(monitor.id)).toEqual([]);
    await new Promise((r) => setTimeout(r, 300));
    expect(hooks.received).toEqual([]);
    const metrics = await running.metrics.registry.metrics();
    expect(metrics).toContain('checkout_sentinel_discarded_results_total 1');
    expect(metrics).not.toContain('checkout_sentinel_runs_total{status="failed"');

    // The next job of the monitor starts its own run, so its result is applied as usual and
    // the swept run stays as it is. A real BullMQ retry of a stalled job is covered below.
    const nextJobId = await scheduler.enqueueNow(monitor.id);
    const next = await jobOutcome(nextJobId);
    expect(next).toMatchObject({
      outcome: 'completed',
      status: 'failed',
      alerts: ['failure:webhook'],
    });
    const nextRunId = next.outcome === 'completed' ? next.runId : '';
    expect((await monitors.get(monitor.id))?.state).toMatchObject({
      health: 'failing',
      consecutiveFailures: 1,
      lastRunId: nextRunId,
      lastRunStatus: 'failed',
    });
    expect((await runs.get(runId))?.status).toBe('error');
    expect((await deliveries.listForMonitor(monitor.id)).map((d) => d.runId)).toEqual([nextRunId]);
    expect((await hooks.waitFor(1)).map((h) => h.path)).toEqual(['/late']);
  });

  it('marks the running runs of earlier attempts of the same job lost when the job starts again', async () => {
    const monitor = await createMonitor('Retried job');
    const other = await createMonitor('Other monitor');
    const stalled = await seedRun(monitor.id, 'running', '3 minutes', 'job-1');
    const finished = await seedRun(monitor.id, 'failed', '4 minutes', 'job-1');
    const otherJob = await seedRun(monitor.id, 'running', '1 minute', 'job-2');
    const noJob = await seedRun(monitor.id, 'running', '2 minutes');
    const otherMonitor = await seedRun(other.id, 'running', '1 minute', 'job-1');
    const finishedBefore = await runs.get(finished);

    const { run, superseded } = await runs.start(monitor.id, 'schedule', 'job-1');
    expect(superseded).toEqual([stalled]);
    expect(run).toMatchObject({ monitorId: monitor.id, status: 'running', jobId: 'job-1' });
    const lost = await runs.get(stalled);
    expect(lost).toMatchObject({ status: 'error', error: RUN_RETRIED_ERROR, result: null });
    expect(lost?.finishedAt).toBeInstanceOf(Date);
    expect(await runs.get(finished)).toEqual(finishedBefore);
    for (const id of [otherJob, noJob, otherMonitor, run.id]) {
      expect((await runs.get(id))?.status).toBe('running');
    }
    // A run started without a job id supersedes nothing.
    expect((await runs.start(monitor.id, 'manual')).superseded).toEqual([]);
    expect((await runs.get(run.id))?.status).toBe('running');
  });

  it('discards a stalled attempt that finishes after BullMQ ran the job again, before any sweep', async () => {
    const monitor = await monitors.create(
      MonitorSpecSchema.parse({
        name: 'Stalled worker',
        url: healthy.productUrl,
        devices: ['mobile'],
        alertAfterFailures: 1,
        alerts: [{ type: 'webhook', url: hooks.url('/stalled') }],
      }),
    );
    // A queue of its own, so the worker started in beforeAll does not take the job.
    const queue = new Queue<JourneyJob, JobOutcome>(`stall-${randomUUID()}`, {
      connection: redis,
    });
    const stallingConnection = createRedis(services.redisUrl);
    const retryingConnection = createRedis(services.redisUrl);
    const metrics = new WorkerMetrics({ defaultMetrics: false });
    const base = processorDeps({
      // PER_STORE_CONCURRENCY=2: the retry does not wait for the stalled attempt's store slot.
      lock: new StoreLock(redis, 2, 600_000, `stall-lock-${randomUUID()}`),
      metrics,
    });

    // Attempt 1 finds the store broken (a real journey against the mobile-hidden fixture), then
    // its worker stops responding before it stores the result. It does not renew its job lock,
    // so BullMQ declares the job stalled and a second worker runs it again. By then the store
    // works (the healthy fixture, the monitor's own URL).
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    let attemptOneDone!: (runId: string) => void;
    const attemptOneResult = new Promise<string>((resolve) => (attemptOneDone = resolve));
    const lateOutcomes: JobOutcome[] = [];
    const stalledWorkerErrors: Error[] = [];
    const stalling = new Worker<JourneyJob, JobOutcome>(
      queue.name,
      async (job, token) => {
        const outcome = await processJourneyJob(
          {
            ...base,
            run: async (options) => {
              const result = await runJourneys({ ...options, url: broken.productUrl });
              attemptOneDone(options.runId ?? '');
              await paused;
              return result;
            },
          },
          job,
          token,
        );
        lateOutcomes.push(outcome);
        return outcome;
      },
      {
        connection: stallingConnection,
        lockDuration: 1_000,
        skipLockRenewal: true,
        skipStalledCheck: true,
      },
    );
    stalling.on('error', (error) => stalledWorkerErrors.push(error));
    let retrying: Worker<JourneyJob, JobOutcome> | null = null;

    try {
      const job = await queue.add('journey', { monitorId: monitor.id, trigger: 'manual' });
      const firstRunId = await attemptOneResult;
      expect((await runs.get(firstRunId))?.status).toBe('running');

      retrying = new Worker<JourneyJob, JobOutcome>(
        queue.name,
        (retried, token) => processJourneyJob(base, retried, token),
        { connection: retryingConnection, stalledInterval: 300 },
      );
      const retried = await waitFor(async () => {
        const current = await queue.getJob(job.id ?? '');
        return current && (await current.isCompleted()) ? current.returnvalue : null;
      }, 'the retry to complete');
      expect(retried).toMatchObject({ outcome: 'completed', status: 'passed', alerts: [] });
      const retryRunId = retried.outcome === 'completed' ? retried.runId : '';
      expect(retryRunId).not.toBe(firstRunId);
      const afterRetry = (await monitors.get(monitor.id))?.state;
      expect(afterRetry).toMatchObject({
        health: 'passing',
        consecutiveFailures: 0,
        lastRunId: retryRunId,
      });
      // Nothing is stale yet: the default threshold is 15 minutes.
      expect(await housekeeping().pass.runOnce()).toMatchObject({ swept: 0 });

      // The first worker resumes with its older, failed result.
      resume();
      await waitFor(async () => lateOutcomes[0], 'the stalled attempt to return');
      expect((await monitors.get(monitor.id))?.state).toEqual(afterRetry);
      expect(await deliveries.listForMonitor(monitor.id)).toEqual([]);
      await new Promise((r) => setTimeout(r, 300));
      expect(hooks.received.filter((h) => h.path === '/stalled')).toEqual([]);
      expect(lateOutcomes).toEqual([
        {
          outcome: 'discarded',
          runId: firstRunId,
          status: 'failed',
          reason: `run was already marked error (${RUN_RETRIED_ERROR})`,
        },
      ]);
      // The retry marked the stalled attempt's run lost when it started; the late result was
      // not stored.
      expect(await runs.get(firstRunId)).toMatchObject({
        status: 'error',
        error: RUN_RETRIED_ERROR,
        failedStep: null,
        result: null,
      });
      expect(await runs.get(retryRunId)).toMatchObject({ status: 'passed', jobId: job.id });
      const text = await metrics.registry.metrics();
      expect(text).toContain('checkout_sentinel_runs_superseded_total 1');
      expect(text).toContain('checkout_sentinel_discarded_results_total 1');
      // BullMQ refuses the stalled worker's completion: the retry owns the job now.
      await waitFor(
        async () => stalledWorkerErrors.find((e) => /Missing lock|Lock mismatch/.test(e.message)),
        'BullMQ to refuse the stalled completion',
      );
      expect((await queue.getJob(job.id ?? ''))?.returnvalue).toEqual(retried);
    } finally {
      resume();
      await Promise.all([stalling.close(), retrying?.close()]);
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      stallingConnection.disconnect();
      retryingConnection.disconnect();
    }
  });

  it('sweeps once when a worker starts', async () => {
    const monitor = await createMonitor('Before boot');
    const stuck = await seedRun(monitor.id, 'running', '2 hours');
    const ownArtifacts = await mkdtemp(path.join(tmpdir(), 'checkout-sentinel-boot-'));
    const booted = await startWorker(
      loadConfig({
        DATABASE_URL: services.databaseUrl,
        REDIS_URL: services.redisUrl,
        METRICS_PORT: '0',
        ARTIFACTS_DIR: ownArtifacts,
        LOG_LEVEL: 'silent',
        ALLOW_PRIVATE_TARGETS: 'true',
      }),
      pino({ level: 'silent' }),
    );
    try {
      expect(booted.housekeeping).not.toBeNull();
      await waitFor(
        async () => ((await runs.get(stuck))?.status === 'error' ? true : null),
        'the boot sweep',
      );
      expect(await booted.metrics.registry.metrics()).toContain(
        'checkout_sentinel_runs_swept_total 1',
      );
    } finally {
      await booted.shutdown();
      await rm(ownArtifacts, { recursive: true, force: true });
    }
  });
});
