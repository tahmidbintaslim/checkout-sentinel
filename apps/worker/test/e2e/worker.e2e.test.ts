import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MonitorSpecSchema } from '@checkout-sentinel/core';
import {
  AlertDeliveryRepository,
  MonitorRepository,
  RunRepository,
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
import { JourneyScheduler, createRedis } from '@checkout-sentinel/jobs';
import {
  SIGNATURE_HEADER,
  loadConfig,
  signBody,
  startWorker,
  type RunningWorker,
} from '@checkout-sentinel/worker';

const services = await probeTestServices();

describe.skipIf(!services.available)('worker end to end (Postgres + Redis + Chromium)', () => {
  let db: DbHandle;
  let redis: ReturnType<typeof createRedis>;
  let scheduler: JourneyScheduler;
  let running: RunningWorker;
  let broken: FixtureStore;
  let healthy: FixtureStore;
  let hooks: WebhookReceiver;
  let artifacts: string;
  const secret = 'e2e-shared-secret-value';

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
    artifacts = await mkdtemp(path.join(tmpdir(), 'checkout-sentinel-worker-'));
    running = await startWorker(
      loadConfig({
        DATABASE_URL: services.databaseUrl,
        REDIS_URL: services.redisUrl,
        METRICS_PORT: '0',
        ARTIFACTS_DIR: artifacts,
        STEP_TIMEOUT_MS: '3000',
        LOG_LEVEL: 'silent',
      }),
      pino({ level: 'silent' }),
    );
  });

  afterAll(async () => {
    await running?.shutdown();
    await scheduler?.queue.obliterate({ force: true }).catch(() => undefined);
    await scheduler?.close();
    redis?.disconnect();
    await db?.close();
    await Promise.all([broken?.close(), healthy?.close(), hooks?.close()]);
    if (artifacts) await rm(artifacts, { recursive: true, force: true });
  });

  async function runOnce(monitorId: string, expectedRuns: number) {
    await scheduler.enqueueNow(monitorId);
    const runs = new RunRepository(db.db);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const page = await runs.listForMonitor(monitorId, 20);
      if (page.items.length >= expectedRuns && page.items.every((r) => r.status !== 'running')) {
        return page.items[0]!;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('run did not finish in time');
  }

  it('alerts once on failure, stays quiet while failing, and alerts on recovery', async () => {
    const monitors = new MonitorRepository(db.db);
    const monitor = await monitors.create(
      MonitorSpecSchema.parse({
        name: 'Fixture tee',
        url: broken.productUrl,
        devices: ['mobile'],
        alertAfterFailures: 1,
        alerts: [
          { type: 'webhook', url: hooks.url('/webhook'), secret },
          { type: 'slack', url: hooks.url('/slack') },
        ],
      }),
    );

    const first = await runOnce(monitor.id, 1);
    expect(first.status).toBe('failed');
    expect(first.failedStep).toBe('find_add_to_cart');
    const stored = await new RunRepository(db.db).get(first.id);
    expect(stored?.result?.journeys[0]?.device).toBe('mobile');

    const afterFailure = await hooks.waitFor(2);
    expect(afterFailure.map((h) => h.path).sort()).toEqual(['/slack', '/webhook']);
    const webhook = afterFailure.find((h) => h.path === '/webhook')!;
    expect(webhook.body).toMatchObject({
      kind: 'failure',
      monitor: { id: monitor.id },
      run: { id: first.id },
    });
    expect(webhook.headers[SIGNATURE_HEADER]).toBe(signBody(JSON.stringify(webhook.body), secret));
    expect(
      (afterFailure.find((h) => h.path === '/slack')!.body as { text: string }).text,
    ).toContain('Checkout journey failing: Fixture tee');

    // Still broken: a second failed run must not alert again.
    const second = await runOnce(monitor.id, 2);
    expect(second.status).toBe('failed');
    await new Promise((r) => setTimeout(r, 500));
    expect(hooks.received).toHaveLength(2);

    // The merchant fixes the theme.
    await monitors.update(monitor.id, { url: healthy.productUrl });
    const third = await runOnce(monitor.id, 3);
    expect(third.status).toBe('passed');
    const afterRecovery = await hooks.waitFor(4);
    expect(
      afterRecovery
        .slice(2)
        .map((h) => (h.path === '/webhook' ? (h.body as { kind: string }).kind : 'slack')),
    ).toEqual(expect.arrayContaining(['recovery', 'slack']));

    const state = (await monitors.get(monitor.id))?.state;
    expect(state).toMatchObject({
      health: 'passing',
      consecutiveFailures: 0,
      lastRunId: third.id,
      lastRunStatus: 'passed',
    });
    const deliveries = await new AlertDeliveryRepository(db.db).listForMonitor(monitor.id);
    expect(deliveries).toHaveLength(4);
    expect(deliveries.every((d) => d.status === 'sent')).toBe(true);

    const metrics = await running.metrics.registry.metrics();
    expect(metrics).toContain('checkout_sentinel_runs_total{status="failed",trigger="manual"} 2');
    expect(metrics).toContain('checkout_sentinel_runs_total{status="passed",trigger="manual"} 1');
    expect(metrics).toContain(
      'checkout_sentinel_alerts_total{kind="failure",channel="webhook",outcome="sent"} 1',
    );
  });

  it('skips jobs for deleted monitors and removes their scheduler', async () => {
    const monitors = new MonitorRepository(db.db);
    const monitor = await monitors.create(
      MonitorSpecSchema.parse({ name: 'gone', url: healthy.productUrl }),
    );
    await scheduler.sync({ id: monitor.id, schedule: '0 3 * * *', timezone: 'UTC', enabled: true });
    expect(await scheduler.queue.getJobScheduler(`monitor:${monitor.id}`)).toBeTruthy();
    await monitors.delete(monitor.id);
    const job = await scheduler.queue.add('journey', {
      monitorId: monitor.id,
      trigger: 'schedule',
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !(await job.isCompleted()))
      await new Promise((r) => setTimeout(r, 100));
    expect((await scheduler.queue.getJob(job.id!))?.returnvalue).toEqual({
      outcome: 'skipped',
      reason: 'monitor deleted',
    });
    expect(await scheduler.queue.getJobScheduler(`monitor:${monitor.id}`)).toBeFalsy();
  });
});
