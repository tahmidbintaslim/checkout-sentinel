import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '../../src/api/client';
import { READ_ONLY_MESSAGE, createDemoFetch, demoFileFor } from '../../src/api/demo';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function demoClient(files: Record<string, unknown>) {
  const fetched: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    const file = url.replace('/demo-data/', '');
    return file in files ? json(files[file]) : new Response('missing', { status: 404 });
  }) as unknown as typeof fetch;
  const client = createApiClient({
    token: () => null,
    fetch: createDemoFetch('/demo-data/', fetchImpl),
  });
  return { client, fetched };
}

describe('demoFileFor', () => {
  it('maps each read route to its file', () => {
    expect(demoFileFor('/monitors')).toBe('monitors.json');
    expect(demoFileFor('/monitors/demo-tee')).toBe('monitors/demo-tee.json');
    expect(demoFileFor('/monitors/demo-tee/runs')).toBe('monitor-runs/demo-tee.json');
    expect(demoFileFor('/runs/abc-123')).toBe('runs/abc-123.json');
    expect(demoFileFor('/runs/abc/artifacts/mobile-find_add_to_cart.png')).toBe(
      'artifacts/abc/mobile-find_add_to_cart.png',
    );
    expect(demoFileFor('/alerts')).toBe('alerts.json');
  });

  it('refuses unknown routes and segments that could leave the data directory', () => {
    expect(demoFileFor('/metrics')).toBeNull();
    expect(demoFileFor('/runs/..')).toBeNull();
    expect(demoFileFor('/runs/%2e%2e%2fsecret')).toBeNull();
    expect(demoFileFor('/runs/x/artifacts/.hidden.png')).toBeNull();
  });
});

describe('createDemoFetch', () => {
  it('serves reads from the demo files', async () => {
    const { client, fetched } = demoClient({ 'monitors.json': [{ id: 'demo-tee' }] });
    await expect(client.listMonitors()).resolves.toEqual([{ id: 'demo-tee' }]);
    expect(fetched).toEqual(['/demo-data/monitors.json']);
  });

  it('answers every write with 403 and the read-only message, without fetching', async () => {
    const { client, fetched } = demoClient({});
    const attempts = [
      client.runNow('demo-tee'),
      client.deleteMonitor('demo-tee'),
      client.updateMonitor('demo-tee', { enabled: false }),
    ];
    for (const attempt of attempts) {
      const error = await attempt.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 403, message: READ_ONLY_MESSAGE });
    }
    expect(fetched).toEqual([]);
  });

  it('filters the alert log by monitor', async () => {
    const { client } = demoClient({
      'alerts.json': { items: [{ monitorId: 'a' }, { monitorId: 'b' }], nextCursor: null },
    });
    await expect(client.listAlerts({ monitorId: 'b' })).resolves.toEqual({
      items: [{ monitorId: 'b' }],
      nextCursor: null,
    });
  });

  it('answers 404 when a static host falls back to the app page for a missing file', async () => {
    const fetchImpl = (async () =>
      new Response('<!doctype html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })) as unknown as typeof fetch;
    const client = createApiClient({
      token: () => null,
      fetch: createDemoFetch('/demo-data/', fetchImpl),
    });
    await expect(client.getRun('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('answers 404 for a missing file', async () => {
    const { client } = demoClient({});
    await expect(client.getRun('nope')).rejects.toMatchObject({ status: 404 });
  });
});
