import { createSign, generateKeyPairSync } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeTestServices, truncateAll } from '@checkout-sentinel/fixtures';
import { JourneyScheduler, createRedis } from '@checkout-sentinel/jobs';
import { createApp, loadApiConfig } from '@checkout-sentinel/api';

const services = await probeTestServices();
const TOKEN = 'e2e-api-token-0123456789';
const ORIGIN = 'https://app.example';

// A local key pair stands in for Clerk: CLERK_JWT_KEY makes verification networkless.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

function sessionToken(claims: Record<string, unknown>, azp = ORIGIN): string {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: 'https://clerk.example',
    sid: 'sess_1',
    azp,
    iat: now,
    nbf: now - 5,
    exp: now + 60,
    v: 2,
    ...claims,
  })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey, 'base64url')}`;
}

describe.skipIf(!services.available)('workspaces (Postgres + Redis)', () => {
  let app: INestApplication;
  let base: string;
  let redis: ReturnType<typeof createRedis>;
  let scheduler: JourneyScheduler;

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
  const orgA = sessionToken({ sub: 'user_a', o: { id: 'org_a' } });
  const orgB = sessionToken({ sub: 'user_b', o: { id: 'org_b' } });
  const monitor = { name: 'Tee', url: 'https://example.com/products/tee', enabled: false };

  beforeAll(async () => {
    redis = createRedis(services.redisUrl);
    scheduler = new JourneyScheduler(redis);
    app = await createApp(
      loadApiConfig({
        DATABASE_URL: services.databaseUrl,
        REDIS_URL: services.redisUrl,
        API_TOKEN: TOKEN,
        CLERK_JWT_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from('clerk.example$').toString('base64')}`,
        CLERK_AUTHORIZED_PARTIES: ORIGIN,
        LOG_LEVEL: 'silent',
      }),
      { resolveHost: async () => [{ address: '93.184.215.14', family: 4 }] },
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

  it('tells the dashboard to sign in with Clerk, without a token', async () => {
    const config = (await (await api('/auth/config', null)).json()) as {
      clerkPublishableKey: string;
    };
    expect(config.clerkPublishableKey).toMatch(/^pk_test_/);
  });

  it('refuses missing, forged and foreign-origin tokens', async () => {
    expect((await api('/monitors', null)).status).toBe(401);
    expect((await api('/monitors', `${orgA.slice(0, -4)}AAAA`)).status).toBe(401);
    const elsewhere = sessionToken({ sub: 'user_a', o: { id: 'org_a' } }, 'https://evil.example');
    expect((await api('/monitors', elsewhere)).status).toBe(401);
    expect((await api('/monitors', 'cs_not-a-real-key')).status).toBe(401);
  });

  it("keeps one workspace's monitors, runs and alerts from another", async () => {
    const created = await api('/monitors', orgA, { method: 'POST', json: monitor });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    expect(await (await api('/monitors', orgA)).json()).toHaveLength(1);
    expect(await (await api('/monitors', orgB)).json()).toEqual([]);
    // The self-hosted token and a user with no active organization are workspaces of their own.
    expect(await (await api('/monitors', TOKEN)).json()).toEqual([]);
    expect(await (await api('/monitors', sessionToken({ sub: 'user_a' }))).json()).toEqual([]);

    for (const [path, init] of [
      [`/monitors/${id}`, {}],
      [`/monitors/${id}`, { method: 'PATCH', json: { name: 'Taken' } }],
      [`/monitors/${id}`, { method: 'DELETE' }],
      [`/monitors/${id}/status`, {}],
      [`/monitors/${id}/runs`, {}],
      [`/monitors/${id}/runs`, { method: 'POST' }],
      [`/monitors/${id}/alerts`, {}],
    ] as const) {
      expect((await api(path, orgB, init)).status, `${init.method ?? 'GET'} ${path}`).toBe(404);
    }
    expect(((await (await api(`/monitors/${id}`, orgA)).json()) as { name: string }).name).toBe(
      'Tee',
    );
  });

  it('scopes API keys to the workspace that made them, until revoked', async () => {
    const response = await api('/api-keys', orgA, { method: 'POST', json: { name: 'CI' } });
    const { id, key, prefix } = (await response.json()) as Record<string, string>;
    expect(key).toMatch(/^cs_/);
    expect(await (await api('/monitors', key!)).json()).toHaveLength(1);

    // Listed without the key itself, and only in its own workspace.
    expect(await (await api('/api-keys', orgA)).json()).toEqual([
      expect.objectContaining({ id, name: 'CI', prefix }),
    ]);
    expect(JSON.stringify(await (await api('/api-keys', orgA)).json())).not.toContain(key);
    expect(await (await api('/api-keys', orgB)).json()).toEqual([]);
    expect((await api(`/api-keys/${id}`, orgB, { method: 'DELETE' })).status).toBe(404);

    expect((await api(`/api-keys/${id}`, orgA, { method: 'DELETE' })).status).toBe(204);
    expect((await api('/monitors', key!)).status).toBe(401);
  });
});
