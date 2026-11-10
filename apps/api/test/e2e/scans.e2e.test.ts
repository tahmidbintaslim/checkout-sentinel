import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ResolveHost } from '@checkout-sentinel/core';
import { probeTestServices } from '@checkout-sentinel/fixtures';
import { createRedis, createScanQueue, type ScanQueue } from '@checkout-sentinel/jobs';
import { createApp, loadApiConfig } from '@checkout-sentinel/api';

const services = await probeTestServices();
const TOKEN = 'e2e-api-token-0123456789';

const resolveHost: ResolveHost = async (hostname) => {
  if (hostname === 'public-shop.test') return [{ address: '93.184.215.14', family: 4 }];
  throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
};

describe.skipIf(!services.available)('public scanner (Redis)', () => {
  let app: INestApplication;
  let base: string;
  let redis: ReturnType<typeof createRedis>;
  let queue: ScanQueue;

  const post = (json: unknown) =>
    fetch(`${base}/api/scans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(json),
    });
  const url = 'https://public-shop.test/products/tee';

  beforeAll(async () => {
    redis = createRedis(services.redisUrl);
    queue = createScanQueue(redis);
    app = await createApp(
      loadApiConfig({
        DATABASE_URL: services.databaseUrl,
        REDIS_URL: services.redisUrl,
        // The scanner answers without the token even when the rest of the API needs it.
        API_TOKEN: TOKEN,
        SCANNER_ENABLED: 'true',
        TURNSTILE_SITE_KEY: 'site-key',
        TURNSTILE_SECRET_KEY: 'secret-key',
        SCAN_RATE_LIMIT_PER_HOUR: '4',
        SCAN_QUEUE_LIMIT: '2',
        LOG_LEVEL: 'silent',
      }),
      { resolveHost, verifyTurnstile: async (token) => token === 'human' },
    );
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    const keys = await redis.keys('checkout-sentinel:scan-rate:*');
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    await app?.close();
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    redis?.disconnect();
  });

  it('serves its config without the API token', async () => {
    const response = await fetch(`${base}/api/scans/config`);
    expect(await response.json()).toEqual({ enabled: true, turnstileSiteKey: 'site-key' });
  });

  it('queues a scan and reports it by id', async () => {
    const response = await post({ url, turnstileToken: 'human' });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const scan = await (await fetch(`${base}/api/scans/${id}`)).json();
    expect(scan).toMatchObject({ id, url, status: 'queued' });
    expect((await fetch(`${base}/api/scans/00000000-0000-4000-8000-000000000000`)).status).toBe(
      404,
    );
  });

  it('refuses a failed human check, private targets and bad URLs', async () => {
    expect((await post({ url, turnstileToken: 'bot' })).status).toBe(403);
    const internal = await post({ url: 'http://127.0.0.1/products/tee', turnstileToken: 'human' });
    expect(internal.status).toBe(400);
    expect((await post({ url: 'javascript:alert(1)', turnstileToken: 'human' })).status).toBe(400);
    expect(await queue.count()).toBe(0);
  });

  it('caps the queue, then the scans per address', async () => {
    expect((await post({ url, turnstileToken: 'human' })).status).toBe(201);
    expect((await post({ url, turnstileToken: 'human' })).status).toBe(201);
    expect((await post({ url, turnstileToken: 'human' })).status).toBe(503);
    expect((await post({ url, turnstileToken: 'human' })).status).toBe(503);
    expect((await post({ url, turnstileToken: 'human' })).status).toBe(429);
  });
});
