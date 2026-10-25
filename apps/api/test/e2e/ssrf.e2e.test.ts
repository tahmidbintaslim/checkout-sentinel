import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolveHost } from '@checkout-sentinel/core';
import { probeTestServices, truncateAll } from '@checkout-sentinel/fixtures';
import { JourneyScheduler, createRedis } from '@checkout-sentinel/jobs';
import { createApp, loadApiConfig } from '@checkout-sentinel/api';

const services = await probeTestServices();
const TOKEN = 'e2e-api-token-0123456789';

/** Fixed DNS answers so the tests never depend on real DNS. Other names do not resolve. */
const resolveHost: ResolveHost = async (hostname) => {
  const answers: Record<string, string> = {
    'public-shop.test': '93.184.215.14',
    'internal-shop.test': '10.0.0.7',
    'hooks.slack.com': '3.130.95.182',
  };
  const address = answers[hostname];
  if (!address) {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
  }
  return [{ address, family: 4 }];
};

interface Issue {
  path: string;
  message: string;
}

describe.skipIf(!services.available)('API SSRF guard end to end', () => {
  let strict: INestApplication;
  let permissive: INestApplication;
  let strictBase: string;
  let permissiveBase: string;
  let redis: ReturnType<typeof createRedis>;
  let scheduler: JourneyScheduler;

  const call = (base: string, path: string, method = 'GET', json?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });

  const issuesOf = async (response: Response) =>
    ((await response.json()) as { issues: Issue[] }).issues;

  beforeAll(async () => {
    redis = createRedis(services.redisUrl);
    scheduler = new JourneyScheduler(redis);
    await scheduler.queue.obliterate({ force: true });
    const env = {
      DATABASE_URL: services.databaseUrl,
      REDIS_URL: services.redisUrl,
      API_TOKEN: TOKEN,
      LOG_LEVEL: 'silent',
    };
    // The production default: no ALLOW_PRIVATE_TARGETS.
    strict = await createApp(loadApiConfig(env), { resolveHost });
    permissive = await createApp(loadApiConfig({ ...env, ALLOW_PRIVATE_TARGETS: 'true' }), {
      resolveHost,
    });
    await truncateAll(services.databaseUrl);
    await strict.listen(0, '127.0.0.1');
    await permissive.listen(0, '127.0.0.1');
    strictBase = await strict.getUrl();
    permissiveBase = await permissive.getUrl();
  });

  afterAll(async () => {
    await strict?.close();
    await permissive?.close();
    await scheduler?.queue.obliterate({ force: true }).catch(() => undefined);
    await scheduler?.close();
    redis?.disconnect();
  });

  it.each([
    ['http://127.0.0.1:8080/products/tee', 'loopback'],
    ['http://localhost/products/tee', 'local machine'],
    ['http://shop.localhost/products/tee', 'local machine'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://[fd00:ec2::254]/latest/meta-data/', 'unique-local'],
    ['http://[::1]/products/tee', 'loopback'],
    ['http://[::ffff:127.0.0.1]/products/tee', 'IPv4-mapped'],
    ['http://2130706433/products/tee', 'loopback'],
    ['http://0x7f.1/products/tee', 'loopback'],
    ['http://0177.0.0.1/products/tee', 'loopback'],
    ['http://0.0.0.0/products/tee', 'unspecified'],
    ['http://10.0.0.5/products/tee', 'private'],
    ['http://100.64.1.1/products/tee', 'carrier-grade NAT'],
    [
      'http://internal-shop.test/products/tee',
      'internal-shop.test resolves to a private or internal address',
    ],
    ['https://user:pass@public-shop.test/products/tee', 'user name or password'],
    ['https://public-shop.test:8443/products/tee', 'Port 8443 is not allowed'],
  ])('rejects the monitor URL %s with a 400', async (url, reason) => {
    const response = await call(strictBase, '/monitors', 'POST', { name: 'x', url });
    expect(response.status).toBe(400);
    const issues = await issuesOf(response);
    expect(issues).toEqual([{ path: 'url', message: expect.stringContaining(reason) }]);
    // Where an internal name points stays on the server.
    expect(JSON.stringify(issues)).not.toContain('10.0.0.7');
  });

  it.each([
    [[{ type: 'webhook', url: 'http://10.0.0.5/hook' }], 'alerts.0.url', 'private'],
    [[{ type: 'webhook', url: 'http://localhost:9000/hook' }], 'alerts.0.url', 'local machine'],
    [
      [{ type: 'webhook', url: 'http://internal-shop.test/hook' }],
      'alerts.0.url',
      'internal-shop.test resolves to a private or internal address',
    ],
    [
      [
        { type: 'webhook', url: 'https://public-shop.test/hook' },
        { type: 'webhook', url: 'http://169.254.169.254/latest/meta-data/' },
      ],
      'alerts.1.url',
      'cloud metadata',
    ],
    [
      [{ type: 'slack', url: 'https://public-shop.test/services/T0/B0/x' }],
      'alerts.0.url',
      'https://hooks.slack.com/',
    ],
    [
      [{ type: 'slack', url: 'http://hooks.slack.com/services/T0/B0/x' }],
      'alerts.0.url',
      'https://hooks.slack.com/',
    ],
  ])('rejects private or wrong alert channels (%j) with a 400', async (alerts, path, reason) => {
    const response = await call(strictBase, '/monitors', 'POST', {
      name: 'x',
      url: 'https://public-shop.test/products/tee',
      alerts,
    });
    expect(response.status).toBe(400);
    const issues = await issuesOf(response);
    expect(issues).toEqual([{ path, message: expect.stringContaining(reason) }]);
    expect(JSON.stringify(issues)).not.toContain('10.0.0.7');
  });

  it('reports every refused URL at once and stores nothing', async () => {
    const response = await call(strictBase, '/monitors', 'POST', {
      name: 'x',
      url: 'http://192.168.1.1/products/tee',
      alerts: [
        { type: 'webhook', url: 'http://127.0.0.1/hook' },
        { type: 'slack', url: 'https://hooks.slack.com/services/T0/B0/ok' },
      ],
    });
    expect(response.status).toBe(400);
    expect((await issuesOf(response)).map((issue) => issue.path)).toEqual(['url', 'alerts.0.url']);
    expect(await (await call(strictBase, '/monitors')).json()).toEqual([]);
  });

  it('accepts public targets, and checks PATCHed URLs too', async () => {
    const created = await call(strictBase, '/monitors', 'POST', {
      name: 'Public tee',
      url: 'https://public-shop.test/products/tee',
      alerts: [
        { type: 'slack', url: 'https://hooks.slack.com/services/T0/B0/abcd' },
        { type: 'webhook', url: 'https://public-shop.test/hook' },
        // A name that does not resolve yet is accepted; the worker checks again before use.
        { type: 'webhook', url: 'https://not-yet-registered.test/hook' },
      ],
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const toPrivate = await call(strictBase, `/monitors/${id}`, 'PATCH', {
      url: 'http://192.168.0.10/products/tee',
    });
    expect(toPrivate.status).toBe(400);
    expect(await issuesOf(toPrivate)).toEqual([
      { path: 'url', message: expect.stringContaining('private') },
    ]);
    const privateAlert = await call(strictBase, `/monitors/${id}`, 'PATCH', {
      alerts: [{ type: 'webhook', url: 'http://[::1]:9000/hook' }],
    });
    expect(privateAlert.status).toBe(400);
    expect(await issuesOf(privateAlert)).toEqual([
      { path: 'alerts.0.url', message: expect.stringContaining('loopback') },
    ]);

    const unchanged = (await (await call(strictBase, `/monitors/${id}`)).json()) as {
      url: string;
      alerts: unknown[];
    };
    expect(unchanged.url).toBe('https://public-shop.test/products/tee');
    expect(unchanged.alerts).toHaveLength(3);

    const moved = await call(strictBase, `/monitors/${id}`, 'PATCH', {
      url: 'https://public-shop.test/products/hoodie',
    });
    expect(moved.status).toBe(200);
  });

  it('accepts private targets only when ALLOW_PRIVATE_TARGETS is on', async () => {
    const body = {
      name: 'Local fixture',
      url: 'http://127.0.0.1:4011/products/demo-tee',
      alerts: [{ type: 'slack', url: 'http://127.0.0.1:9000/slack' }],
    };
    expect((await call(strictBase, '/monitors', 'POST', body)).status).toBe(400);
    expect((await call(permissiveBase, '/monitors', 'POST', body)).status).toBe(201);
    // Credentials stay forbidden either way.
    const withPassword = await call(permissiveBase, '/monitors', 'POST', {
      name: 'x',
      url: 'http://admin:secret@127.0.0.1:4011/',
    });
    expect(withPassword.status).toBe(400);
    expect(await issuesOf(withPassword)).toEqual([
      { path: 'url', message: 'URLs must not contain a user name or password' },
    ]);
  });
});
