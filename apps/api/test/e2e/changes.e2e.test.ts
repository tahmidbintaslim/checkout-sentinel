import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiKeyRepository, ChangeEventRepository, createDb } from '@checkout-sentinel/db';
import { probeTestServices, truncateAll } from '@checkout-sentinel/fixtures';
import { JourneyScheduler, createRedis } from '@checkout-sentinel/jobs';
import { createApp, loadApiConfig } from '@checkout-sentinel/api';

const services = await probeTestServices();
const TOKEN = 'e2e-api-token-0123456789';
const SECRET = 'shopify-app-secret';

describe.skipIf(!services.available)('changes and Shopify webhooks (Postgres + Redis)', () => {
  let app: INestApplication;
  let base: string;
  let redis: ReturnType<typeof createRedis>;
  let scheduler: JourneyScheduler;
  let monitorId: string;

  const api = (path: string, token: string | null, init: RequestInit & { json?: unknown } = {}) => {
    const { json, ...rest } = init;
    return fetch(`${base}/api${path}`, {
      ...rest,
      headers: {
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
  };
  const changes = async (token = TOKEN) =>
    (await (await api(`/monitors/${monitorId}/changes`, token)).json()) as Array<{
      summary: string;
      source: string;
    }>;

  /** A webhook as Shopify sends it: the HMAC is over the exact bytes of the body. */
  const webhook = (topic: string, body: object, opts: { id?: string; secret?: string } = {}) => {
    const raw = JSON.stringify(body);
    return fetch(`${base}/api/webhooks/shopify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shopify-topic': topic,
        'x-shopify-shop-domain': 'demo-shop.myshopify.com',
        'x-shopify-webhook-id': opts.id ?? crypto.randomUUID(),
        'x-shopify-hmac-sha256': createHmac('sha256', opts.secret ?? SECRET)
          .update(raw)
          .digest('base64'),
      },
      body: raw,
    });
  };

  beforeAll(async () => {
    redis = createRedis(services.redisUrl);
    scheduler = new JourneyScheduler(redis);
    app = await createApp(
      loadApiConfig({
        DATABASE_URL: services.databaseUrl,
        REDIS_URL: services.redisUrl,
        API_TOKEN: TOKEN,
        SHOPIFY_API_SECRET: SECRET,
        LOG_LEVEL: 'silent',
      }),
      { resolveHost: async () => [{ address: '93.184.215.14', family: 4 }] },
    );
    await truncateAll(services.databaseUrl);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const created = await api('/monitors', TOKEN, {
      method: 'POST',
      json: { name: 'Tee', url: 'https://Shop.Example/products/tee', enabled: false },
    });
    monitorId = ((await created.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await app?.close();
    await scheduler?.queue.obliterate({ force: true }).catch(() => undefined);
    await scheduler?.close();
    redis?.disconnect();
  });

  it("records changes by store host and lists them on that store's monitors", async () => {
    const sent = await api('/changes', TOKEN, {
      method: 'POST',
      json: {
        store: 'https://shop.example/',
        kind: 'deploy',
        summary: 'Deployed v42',
        externalId: 'd-42',
      },
    });
    expect(await sent.json()).toEqual({ recorded: true, host: 'shop.example' });
    const again = await api('/changes', TOKEN, {
      method: 'POST',
      json: { store: 'shop.example', kind: 'deploy', summary: 'Deployed v42', externalId: 'd-42' },
    });
    expect(await again.json()).toMatchObject({ recorded: false });
    expect(await changes()).toEqual([
      expect.objectContaining({ summary: 'Deployed v42', source: 'api' }),
    ]);

    expect(
      (
        await api('/changes', TOKEN, {
          method: 'POST',
          json: { store: 'a b', kind: 'x', summary: 'y' },
        })
      ).status,
    ).toBe(400);
    expect((await api('/changes', null, { method: 'POST', json: {} })).status).toBe(401);
  });

  it('keeps changes inside their workspace', async () => {
    const db = createDb(services.databaseUrl);
    const { key: other } = await new ApiKeyRepository(db.db).create('ws_other', 'other');
    await db.close();
    // Another workspace reporting the same store host records its own event...
    await api('/changes', other, {
      method: 'POST',
      json: { store: 'shop.example', kind: 'deploy', summary: 'Not yours' },
    });
    // ...which this workspace never sees, and it cannot read this workspace's monitor.
    expect((await changes()).map((c) => c.summary)).toEqual(['Deployed v42']);
    expect((await api(`/monitors/${monitorId}/changes`, other)).status).toBe(404);
  });

  it('accepts only Shopify webhooks signed with the app secret', async () => {
    expect((await webhook('themes/publish', { name: 'X' }, { secret: 'wrong' })).status).toBe(401);
    const unsigned = await fetch(`${base}/api/webhooks/shopify`, { method: 'POST', body: '{}' });
    expect(unsigned.status).toBe(401);
  });

  it('drops events from shops that never installed the app', async () => {
    expect((await webhook('themes/publish', { name: 'Stranger' })).status).toBe(200);
    expect((await changes()).map((c) => c.summary)).not.toContain('Theme published: Stranger');
  });

  it('turns theme events of an installed shop into changes, once each', async () => {
    const db = createDb(services.databaseUrl);
    await new ChangeEventRepository(db.db).linkShopifyShop(
      'demo-shop.myshopify.com',
      'default',
      'shop.example',
    );
    await db.close();

    expect((await webhook('themes/publish', { name: 'Summer' }, { id: 'w-1' })).status).toBe(200);
    expect((await webhook('themes/publish', { name: 'Summer' }, { id: 'w-1' })).status).toBe(200);
    await webhook('themes/update', { name: 'Draft', role: 'unpublished' });
    await webhook('themes/update', { name: 'Summer', role: 'main' });
    // Mandatory privacy topics are acknowledged; no customer data exists to send or erase.
    expect((await webhook('customers/data_request', { customer: { id: 1 } })).status).toBe(200);
    expect((await webhook('customers/redact', { customer: { id: 1 } })).status).toBe(200);

    const shopify = (await changes()).filter((c) => c.source === 'shopify').map((c) => c.summary);
    expect(shopify.sort()).toEqual(['Live theme edited: Summer', 'Theme published: Summer']);
  });

  it('forgets the shop and its events on shop/redact', async () => {
    expect((await webhook('shop/redact', { shop_domain: 'demo-shop.myshopify.com' })).status).toBe(
      200,
    );
    expect((await changes()).map((c) => c.source)).toEqual(['api']);
    await webhook('themes/publish', { name: 'After' });
    expect((await changes()).map((c) => c.source)).toEqual(['api']);
  });
});
