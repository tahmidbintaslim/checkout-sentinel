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
import { loadConfig, startWorker, type RunningWorker } from '@checkout-sentinel/worker';

const services = await probeTestServices();
const port = (url: string) => new URL(url).port;

/**
 * The worker with the SSRF guard on, as in production. Monitors are written straight to the
 * database, as if they predate the guard or their DNS changed after the API accepted them:
 * the worker must refuse them at use time on its own.
 *
 * 127.0.0.1 is an allowed host (with the fixture ports allowed) so one store can be reached
 * at all; "localhost" is the same machine under a name the guard always refuses.
 */
describe.skipIf(!services.available)('worker SSRF guard end to end', () => {
  let db: DbHandle;
  let redis: ReturnType<typeof createRedis>;
  let scheduler: JourneyScheduler;
  let running: RunningWorker;
  let untouched: FixtureStore;
  let broken: FixtureStore;
  let hooks: WebhookReceiver;
  let artifacts: string;

  beforeAll(async () => {
    db = createDb(services.databaseUrl);
    await runMigrations(db);
    await truncateAll(services.databaseUrl);
    redis = createRedis(services.redisUrl);
    scheduler = new JourneyScheduler(redis);
    await scheduler.queue.obliterate({ force: true });
    untouched = await startFixtureStore({ platform: 'shopify' });
    broken = await startFixtureStore({ platform: 'shopify', variant: 'mobile-hidden' });
    hooks = await startWebhookReceiver();
    artifacts = await mkdtemp(path.join(tmpdir(), 'checkout-sentinel-ssrf-'));
    running = await startWorker(
      loadConfig({
        DATABASE_URL: services.databaseUrl,
        REDIS_URL: services.redisUrl,
        METRICS_PORT: '0',
        ARTIFACTS_DIR: artifacts,
        STEP_TIMEOUT_MS: '3000',
        LOG_LEVEL: 'silent',
        ALLOWED_TARGET_HOSTS: '127.0.0.1',
        ALLOWED_TARGET_PORTS: `${port(broken.origin)},${port(hooks.url('/'))}`,
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
    await Promise.all([untouched?.close(), broken?.close(), hooks?.close()]);
    if (artifacts) await rm(artifacts, { recursive: true, force: true });
  });

  async function runOnce(monitorId: string) {
    await scheduler.enqueueNow(monitorId);
    const runs = new RunRepository(db.db);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const [latest] = (await runs.listForMonitor(monitorId, 1)).items;
      if (latest && latest.status !== 'running') return latest;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('run did not finish in time');
  }

  it('refuses a stored monitor whose URL points at the local machine, without loading it', async () => {
    const monitors = new MonitorRepository(db.db);
    const monitor = await monitors.create(
      MonitorSpecSchema.parse({
        name: 'Internal',
        url: untouched.productUrl.replace('127.0.0.1', 'localhost'),
        devices: ['mobile'],
        alertAfterFailures: 1,
        alerts: [{ type: 'webhook', url: hooks.url('/never') }],
      }),
    );
    const run = await runOnce(monitor.id);
    expect(run.status).toBe('error');
    expect(run.error).toBe(
      'Target blocked: localhost always points at the local machine (loopback)',
    );
    // Errors describe our side, not the store: no state change, no alert, no request.
    expect((await monitors.get(monitor.id))?.state?.health).toBe('unknown');
    expect(await new AlertDeliveryRepository(db.db).listForMonitor(monitor.id)).toEqual([]);
    expect(untouched.userAgents()).toEqual([]);
  });

  it('runs an allowed store through the guard and refuses a private alert channel at send time', async () => {
    const monitors = new MonitorRepository(db.db);
    const monitor = await monitors.create(
      MonitorSpecSchema.parse({
        name: 'Fixture tee',
        url: broken.productUrl,
        devices: ['mobile'],
        alertAfterFailures: 1,
        alerts: [
          { type: 'webhook', url: hooks.url('/allowed') },
          { type: 'webhook', url: hooks.url('/blocked').replace('127.0.0.1', 'localhost') },
        ],
      }),
    );
    const run = await runOnce(monitor.id);
    // A real journey verdict: the page loaded through the egress proxy and the step failed.
    expect(run.status).toBe('failed');
    expect(run.failedStep).toBe('find_add_to_cart');

    const deadline = Date.now() + 15_000;
    const deliveries = new AlertDeliveryRepository(db.db);
    let rows = await deliveries.listForMonitor(monitor.id);
    // Alerts are sent after the run row is finished; wait for both deliveries to settle.
    while (
      (rows.length < 2 || rows.some((row) => row.status === 'pending')) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 100));
      rows = await deliveries.listForMonitor(monitor.id);
    }
    const byChannel = [...rows].sort((a, b) => a.channelIndex - b.channelIndex);
    expect(byChannel.map((row) => row.status)).toEqual(['sent', 'failed']);
    expect(byChannel[1]?.error).toBe(
      'Blocked: localhost always points at the local machine (loopback)',
    );
    expect((await hooks.waitFor(1)).map((hook) => hook.path)).toEqual(['/allowed']);

    const metrics = await running.metrics.registry.metrics();
    expect(metrics).toContain(
      'checkout_sentinel_alerts_total{kind="failure",channel="webhook",outcome="failed"} 1',
    );
  });
});
