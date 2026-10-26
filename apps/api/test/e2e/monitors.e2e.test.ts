import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MonitorRepository, createDb } from '@checkout-sentinel/db';
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

  it('keeps stored alert channels by index when the alert list is replaced', async () => {
    const slack = 'https://hooks.slack.com/services/T111/B222/keepMeSecret';
    const created = (await (
      await api('/monitors', {
        method: 'POST',
        json: {
          name: 'Channels',
          url: 'https://store.example/products/tee',
          enabled: false,
          alerts: [
            { type: 'slack', url: slack },
            { type: 'webhook', url: 'https://ops.example/hook', secret: 'stored-webhook-secret' },
          ],
        },
      })
    ).json()) as { id: string; updatedAt: string };

    const patched = await api(`/monitors/${created.id}`, {
      method: 'PATCH',
      json: {
        alerts: [
          { type: 'stored', index: 1 },
          { type: 'webhook', url: 'https://ops.example/new' },
          { type: 'stored', index: 0 },
        ],
        expectedUpdatedAt: created.updatedAt,
      },
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as { alerts: unknown[]; updatedAt: string };
    expect(body.alerts).toEqual([
      { type: 'webhook', url: 'https://ops.example/hook', hasSecret: true },
      { type: 'webhook', url: 'https://ops.example/new', hasSecret: false },
      { type: 'slack', url: 'https://hooks.slack.com/...cret' },
    ]);
    expect(JSON.stringify(body)).not.toContain('stored-webhook-secret');

    const db = createDb(services.databaseUrl);
    try {
      const stored = await new MonitorRepository(db.db).get(created.id);
      expect(stored?.alerts).toEqual([
        { type: 'webhook', url: 'https://ops.example/hook', secret: 'stored-webhook-secret' },
        { type: 'webhook', url: 'https://ops.example/new' },
        { type: 'slack', url: slack },
      ]);
    } finally {
      await db.close();
    }

    const pastTheEnd = await api(`/monitors/${created.id}`, {
      method: 'PATCH',
      json: {
        name: 'Renamed',
        alerts: [
          { type: 'stored', index: 0 },
          { type: 'stored', index: 3 },
        ],
        expectedUpdatedAt: body.updatedAt,
      },
    });
    expect(pastTheEnd.status).toBe(400);
    expect(((await pastTheEnd.json()) as { issues: unknown[] }).issues).toEqual([
      {
        path: 'alerts.1.index',
        message: 'No stored alert channel at this index; the monitor has 3',
      },
    ]);
    // A refused update changes nothing, the other fields included.
    expect(await (await api(`/monitors/${created.id}`)).json()).toMatchObject({
      name: 'Channels',
      alerts: [{ url: 'https://ops.example/hook' }, { url: 'https://ops.example/new' }, {}],
    });

    const twice = await api(`/monitors/${created.id}`, {
      method: 'PATCH',
      json: {
        alerts: [
          { type: 'stored', index: 0 },
          { type: 'stored', index: 0 },
        ],
        expectedUpdatedAt: body.updatedAt,
      },
    });
    expect(twice.status).toBe(400);
    expect(
      (
        await api('/monitors', {
          method: 'POST',
          json: {
            name: 'x',
            url: 'https://store.example/p',
            alerts: [{ type: 'stored', index: 0 }],
          },
        })
      ).status,
    ).toBe(400);
  });

  it('refuses stored channel references made against a list that changed since', async () => {
    const created = (await (
      await api('/monitors', {
        method: 'POST',
        json: {
          name: 'Two tabs',
          url: 'https://store.example/products/tee',
          enabled: false,
          alerts: [
            { type: 'slack', url: 'https://hooks.slack.com/services/T0/B0/keepThisOne' },
            { type: 'webhook', url: 'https://ops.example/remove-me', secret: 'remove-me-secret' },
          ],
        },
      })
    ).json()) as { id: string; updatedAt: string };
    const patch = (json: unknown) => api(`/monitors/${created.id}`, { method: 'PATCH', json });

    // Both tabs loaded the monitor as created. Tab B keeps only the webhook.
    const tabB = await patch({
      alerts: [{ type: 'stored', index: 1 }],
      expectedUpdatedAt: created.updatedAt,
    });
    expect(tabB.status).toBe(200);
    const afterB = (await tabB.json()) as { updatedAt: string };
    expect(afterB.updatedAt).not.toBe(created.updatedAt);

    // Tab A still shows the old list, where index 0 was the Slack channel.
    const tabA = await patch({
      name: 'Renamed',
      alerts: [{ type: 'stored', index: 0 }],
      expectedUpdatedAt: created.updatedAt,
    });
    expect(tabA.status).toBe(409);
    expect(await tabA.json()).toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('changed after'),
    });
    const db = createDb(services.databaseUrl);
    try {
      const stored = await new MonitorRepository(db.db).get(created.id);
      expect(stored?.name).toBe('Two tabs');
      expect(stored?.alerts).toEqual([
        { type: 'webhook', url: 'https://ops.example/remove-me', secret: 'remove-me-secret' },
      ]);
      expect(stored?.updatedAt.toISOString()).toBe(afterB.updatedAt);
    } finally {
      await db.close();
    }

    // A reference without the version it was read at is refused before anything is read.
    const unversioned = await patch({ alerts: [{ type: 'stored', index: 0 }] });
    expect(unversioned.status).toBe(400);
    expect(((await unversioned.json()) as { issues: unknown[] }).issues).toEqual([
      {
        path: 'expectedUpdatedAt',
        message: 'Required when alerts keeps stored channels; send the updatedAt you read',
      },
    ]);

    // Any PATCH may carry the precondition; each write moves updatedAt on.
    const renamed = await patch({ name: 'Renamed', expectedUpdatedAt: afterB.updatedAt });
    expect(renamed.status).toBe(200);
    expect((await patch({ enabled: true, expectedUpdatedAt: afterB.updatedAt })).status).toBe(409);
    const current = (await renamed.json()) as { updatedAt: string };
    expect((await patch({ expectedUpdatedAt: current.updatedAt })).status).toBe(200);
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
