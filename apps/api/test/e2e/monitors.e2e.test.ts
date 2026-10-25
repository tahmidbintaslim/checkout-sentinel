import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeTestServices, truncateAll } from '@checkout-sentinel/fixtures';
import { JourneyScheduler, createRedis, schedulerId } from '@checkout-sentinel/jobs';
import { createApp, loadApiConfig } from '@checkout-sentinel/api';

const services = await probeTestServices();
const TOKEN = 'e2e-api-token-0123456789';

describe.skipIf(!services.available)('API end to end (Postgres + Redis)', () => {
  let app: INestApplication;
  let base: string;
  let redis: ReturnType<typeof createRedis>;
  let scheduler: JourneyScheduler;

  const api = (path: string, init: RequestInit & { json?: unknown; auth?: boolean } = {}) => {
    const { json, auth = true, ...rest } = init;
    return fetch(`${base}${path}`, {
      ...rest,
      headers: {
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
  };

  beforeAll(async () => {
    redis = createRedis(services.redisUrl);
    scheduler = new JourneyScheduler(redis);
    await scheduler.queue.obliterate({ force: true });
    // Migrations run in createApp (MIGRATE_ON_BOOT defaults to true).
    app = await createApp(
      loadApiConfig({
        DATABASE_URL: services.databaseUrl,
        REDIS_URL: services.redisUrl,
        API_TOKEN: TOKEN,
        LOG_LEVEL: 'silent',
      }),
    );
    await truncateAll(services.databaseUrl);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    await scheduler?.queue.obliterate({ force: true }).catch(() => undefined);
    await scheduler?.close();
    redis?.disconnect();
  });

  it('serves health, OpenAPI docs and metrics without a token', async () => {
    const health = await api('/health', { auth: false });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: 'ok',
      checks: { database: 'up', redis: 'up' },
    });

    const docs = (await (await api('/docs/openapi.json', { auth: false })).json()) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(docs.paths)).toEqual(
      expect.arrayContaining([
        '/monitors',
        '/monitors/{id}',
        '/monitors/{id}/runs',
        '/runs/{id}',
        '/health',
      ]),
    );
    expect((await api('/docs', { auth: false })).status).toBe(200);

    const metrics = await (await api('/metrics', { auth: false })).text();
    expect(metrics).toContain('checkout_sentinel_api_requests_total');
    expect(metrics).toContain('checkout_sentinel_monitors');
  });

  it('requires the bearer token on monitor routes', async () => {
    expect((await api('/monitors', { auth: false })).status).toBe(401);
    expect(
      (
        await fetch(`${base}/monitors`, {
          headers: { authorization: 'Bearer wrong-token-0000000000' },
        })
      ).status,
    ).toBe(401);
    expect((await api('/monitors')).status).toBe(200);
  });

  it('creates, reads, updates and deletes a monitor and keeps its schedule in sync', async () => {
    const created = await api('/monitors', {
      method: 'POST',
      json: {
        name: 'Bestseller',
        url: 'https://store.example/products/tee',
        devices: ['mobile'],
        schedule: '*/10 * * * *',
        alerts: [
          { type: 'slack', url: 'https://hooks.slack.com/services/T000/B000/secretXYZ1' },
          { type: 'webhook', url: 'https://ops.example/hook', secret: 'sixteen-chars-secret' },
        ],
      },
    });
    expect(created.status).toBe(201);
    const monitor = (await created.json()) as Record<string, unknown> & { id: string };
    expect(monitor).toMatchObject({
      name: 'Bestseller',
      platform: 'auto',
      devices: ['mobile'],
      alertAfterFailures: 2,
      enabled: true,
      status: { health: 'unknown', lastRunId: null },
      alerts: [
        { type: 'slack', url: 'https://hooks.slack.com/...XYZ1' },
        { type: 'webhook', url: 'https://ops.example/hook', hasSecret: true },
      ],
    });
    expect(JSON.stringify(monitor)).not.toContain('sixteen-chars-secret');
    expect(JSON.stringify(monitor)).not.toContain('T000/B000');

    const scheduled = await scheduler.queue.getJobScheduler(schedulerId(monitor.id));
    expect(scheduled).toMatchObject({ pattern: '*/10 * * * *' });

    const list = (await (await api('/monitors')).json()) as Array<{ id: string }>;
    expect(list.map((m) => m.id)).toContain(monitor.id);
    expect((await (await api(`/monitors/${monitor.id}`)).json()) as object).toMatchObject({
      id: monitor.id,
    });

    const patched = await api(`/monitors/${monitor.id}`, {
      method: 'PATCH',
      json: { schedule: '0 * * * *' },
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      schedule: '0 * * * *',
      devices: ['mobile'],
      name: 'Bestseller',
    });
    expect(await scheduler.queue.getJobScheduler(schedulerId(monitor.id))).toMatchObject({
      pattern: '0 * * * *',
    });

    await api(`/monitors/${monitor.id}`, { method: 'PATCH', json: { enabled: false } });
    expect(await scheduler.queue.getJobScheduler(schedulerId(monitor.id))).toBeFalsy();

    const status = await (await api(`/monitors/${monitor.id}/status`)).json();
    expect(status).toMatchObject({ health: 'unknown', consecutiveFailures: 0 });

    expect((await api(`/monitors/${monitor.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(`/monitors/${monitor.id}`)).status).toBe(404);
    expect((await api(`/monitors/${monitor.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('rejects invalid input with field-level issues', async () => {
    const response = await api('/monitors', {
      method: 'POST',
      json: { name: '', url: 'javascript:alert(1)', schedule: '* * * * *', devices: ['tablet'] },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues: Array<{ path: string }> };
    expect(body.issues.map((i) => i.path).sort()).toEqual(['devices.0', 'name', 'schedule', 'url']);

    const unknownField = await api('/monitors/00000000-0000-4000-8000-000000000000', {
      method: 'PATCH',
      json: { colour: 'red' },
    });
    expect(unknownField.status).toBe(400);
    expect((await api('/monitors/not-a-uuid')).status).toBe(400);
    expect((await api('/monitors/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await api('/runs/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('queues a manual run and lists run history', async () => {
    const created = (await (
      await api('/monitors', {
        method: 'POST',
        json: { name: 'Hoodie', url: 'https://shop.example/product/hoodie/' },
      })
    ).json()) as { id: string };

    const queued = await api(`/monitors/${created.id}/runs`, { method: 'POST' });
    expect(queued.status).toBe(202);
    const { jobId } = (await queued.json()) as { jobId: string };
    const job = await scheduler.queue.getJob(jobId);
    expect(job?.data).toEqual({ monitorId: created.id, trigger: 'manual' });

    const history = await api(`/monitors/${created.id}/runs?limit=5`);
    expect(await history.json()).toEqual({ items: [], nextCursor: null });
    expect((await api(`/monitors/${created.id}/runs?limit=500`)).status).toBe(400);
    expect(await (await api(`/monitors/${created.id}/alerts`)).json()).toEqual([]);
  });
});
