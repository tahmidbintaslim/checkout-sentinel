import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { STRICT_TARGET_POLICY, TargetGuard, type ResolveHost } from '@checkout-sentinel/core';
import { deliverAlert, type AlertContext } from '@checkout-sentinel/worker';

const t = '2026-10-25T10:00:00.000Z';
const context: AlertContext = {
  monitor: { id: 'm1', name: 'Tee', url: 'https://s.test/products/tee' },
  runId: 'run-1',
  result: {
    schemaVersion: 1,
    tool: { name: 'checkout-sentinel', version: '0.1.0' },
    runId: 'run-1',
    url: 'https://s.test/products/tee',
    requestedPlatform: 'auto',
    startedAt: t,
    finishedAt: t,
    durationMs: 10,
    status: 'passed',
    summary: { journeys: 0, passed: 0, failed: 0, slowSteps: 0 },
    journeys: [],
  },
  decision: { kind: 'recovery' },
};

// The receiver listens on 127.0.0.1. Host names below are answered by fake resolvers only.
const received: string[] = [];
let port = 0;
let redirectTo: string | null = null;
const server = createServer((req, res) => {
  received.push(req.url ?? '/');
  req.resume();
  if (redirectTo) {
    res.writeHead(302, { location: redirectTo }).end();
    return;
  }
  res.writeHead(200).end('ok');
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  received.length = 0;
  redirectTo = null;
});

const toLoopback: ResolveHost = async (hostname) => {
  if (hostname === 'relay.test' || hostname === 'rebind.test') {
    return [{ address: '127.0.0.1', family: 4 }];
  }
  throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
};

const options = (targetGuard: TargetGuard) => ({
  timeoutMs: 2_000,
  attempts: 2,
  userAgent: 'checkout-sentinel/test',
  targetGuard,
});

describe('deliverAlert with a target guard', () => {
  it('refuses a private webhook URL without connecting', async () => {
    const outcome = await deliverAlert(
      { type: 'webhook', url: `http://127.0.0.1:${port}/hook` },
      context,
      options(new TargetGuard(STRICT_TARGET_POLICY)),
    );
    expect(outcome).toEqual({
      ok: false,
      error: 'Blocked: 127.0.0.1 is a loopback address (127.0.0.0/8)',
    });
    expect(received).toEqual([]);
  });

  it('refuses Slack channels that are not https://hooks.slack.com', async () => {
    const outcome = await deliverAlert(
      { type: 'slack', url: 'https://attacker.example/services/T/B/X' },
      context,
      options(new TargetGuard(STRICT_TARGET_POLICY)),
    );
    expect(outcome.error).toBe(
      'Blocked: Slack channel URLs must start with https://hooks.slack.com/',
    );
  });

  it('refuses a name that resolves to a private address at send time (DNS rebinding)', async () => {
    const guard = new TargetGuard({ allowedPorts: [port] }, { resolve: toLoopback });
    const outcome = await deliverAlert(
      { type: 'webhook', url: `http://rebind.test:${port}/hook` },
      context,
      options(guard),
    );
    expect(outcome).toEqual({
      ok: false,
      error: 'Blocked: rebind.test resolves to 127.0.0.1, a loopback address (127.0.0.0/8)',
    });
    // Blocks are final: no retry, and nothing reached the receiver.
    expect(received).toEqual([]);
  });

  it('connects to the address the guard resolved for an allowed host', async () => {
    // relay.test exists only in the fake resolver, so a delivery proves the guard's lookup
    // chose the address the socket connected to.
    const guard = new TargetGuard(
      { allowedHosts: ['relay.test'], allowedPorts: [port] },
      { resolve: toLoopback },
    );
    const outcome = await deliverAlert(
      { type: 'webhook', url: `http://relay.test:${port}/hook` },
      context,
      options(guard),
    );
    expect(outcome).toEqual({ ok: true, status: 200 });
    expect(received).toEqual(['/hook']);
  });

  it('does not follow redirects', async () => {
    redirectTo = 'http://169.254.169.254/latest/meta-data/';
    const outcome = await deliverAlert(
      { type: 'webhook', url: `http://127.0.0.1:${port}/hook` },
      context,
      options(new TargetGuard({ allowPrivate: true })),
    );
    expect(outcome).toEqual({
      ok: false,
      status: 302,
      error: 'HTTP 302 (redirects are not followed)',
    });
    expect(received).toEqual(['/hook']);
  });

  it('delivers to private addresses when the guard allows them (local development)', async () => {
    const outcome = await deliverAlert(
      { type: 'slack', url: `http://127.0.0.1:${port}/slack` },
      context,
      options(new TargetGuard({ allowPrivate: true })),
    );
    expect(outcome).toEqual({ ok: true, status: 200 });
  });
});
