import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '../../src/api/client';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return respond(call);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createApiClient', () => {
  it('calls the API under /api and sends the token as a bearer token', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json([]));
    const client = createApiClient({ token: () => 'token-from-session-storage', fetch: fetchImpl });
    expect(await client.listMonitors()).toEqual([]);
    expect(calls[0]).toMatchObject({
      url: '/api/monitors',
      method: 'GET',
      headers: { authorization: 'Bearer token-from-session-storage', accept: 'application/json' },
    });
  });

  it('sends no authorization header without a token', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json([]));
    await createApiClient({ token: () => null, fetch: fetchImpl }).listMonitors();
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('sends JSON bodies and encodes path and query parameters', async () => {
    const { calls, fetchImpl } = fakeFetch((call) =>
      call.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ id: 'm1' }),
    );
    const client = createApiClient({ token: () => null, fetch: fetchImpl });
    await client.createMonitor({ name: 'Tee', url: 'https://s.test/p' });
    await client.updateMonitor('a/b', { alerts: [{ type: 'stored', index: 0 }] });
    await client.listRuns('m1', { limit: 10, before: '2026-10-26T01:02:03.456Z' });
    await client.listAlerts({ monitorId: 'm1' });
    await client.runNow('m1');
    await expect(client.deleteMonitor('m1')).resolves.toBeUndefined();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/monitors',
      'PATCH /api/monitors/a%2Fb',
      'GET /api/monitors/m1/runs?limit=10&before=2026-10-26T01%3A02%3A03.456Z',
      'GET /api/alerts?monitorId=m1',
      'POST /api/monitors/m1/runs',
      'DELETE /api/monitors/m1',
    ]);
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[1]?.body ?? '')).toEqual({ alerts: [{ type: 'stored', index: 0 }] });
  });

  it('turns a 400 into an ApiError with the field issues', async () => {
    const { fetchImpl } = fakeFetch(() =>
      json(
        {
          statusCode: 400,
          message: 'Validation failed',
          issues: [{ path: 'url', message: 'Host resolves to a private address' }],
        },
        400,
      ),
    );
    const error = await createApiClient({ token: () => null, fetch: fetchImpl })
      .createMonitor({ name: 'x', url: 'http://10.0.0.1/' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      message: 'Validation failed',
      issues: [{ path: 'url', message: 'Host resolves to a private address' }],
    });
  });

  it('reports a 401 so the app can ask for a token', async () => {
    const onUnauthorized = vi.fn();
    const { fetchImpl } = fakeFetch(() =>
      json({ statusCode: 401, message: 'Missing or invalid API token' }, 401),
    );
    const client = createApiClient({ token: () => 'stale', fetch: fetchImpl, onUnauthorized });
    await expect(client.getMonitor('m1')).rejects.toMatchObject({
      status: 401,
      message: 'Missing or invalid API token',
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('explains a network failure and a non-JSON error page', async () => {
    const offline = createApiClient({
      token: () => null,
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
    });
    await expect(offline.listMonitors()).rejects.toMatchObject({
      status: 0,
      message: 'Cannot reach the API: Failed to fetch',
    });
    const proxy = createApiClient({
      token: () => null,
      fetch: fakeFetch(() => new Response('<h1>Bad gateway</h1>', { status: 502 })).fetchImpl,
    });
    await expect(proxy.listMonitors()).rejects.toMatchObject({
      status: 502,
      message: 'The API answered HTTP 502',
    });
  });

  it('downloads a run artifact as a blob with the token', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { calls, fetchImpl } = fakeFetch(
      () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    const blob = await createApiClient({ token: () => 'tok', fetch: fetchImpl }).getArtifact(
      'r1',
      'mobile-find_add_to_cart.png',
    );
    expect(calls[0]).toMatchObject({
      url: '/api/runs/r1/artifacts/mobile-find_add_to_cart.png',
      headers: { authorization: 'Bearer tok' },
    });
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png);
  });
});
