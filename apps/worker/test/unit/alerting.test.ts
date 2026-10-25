import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunResult } from '@checkout-sentinel/core';
import {
  SIGNATURE_HEADER,
  deliverAlert,
  signBody,
  slackPayload,
  webhookPayload,
  type AlertContext,
} from '@checkout-sentinel/worker';

const t = '2026-10-25T10:00:00.000Z';
const failedResult: RunResult = {
  schemaVersion: 1,
  tool: { name: 'checkout-sentinel', version: '0.1.0' },
  runId: 'run-1',
  url: 'https://s.test/products/tee',
  requestedPlatform: 'auto',
  startedAt: t,
  finishedAt: t,
  durationMs: 4000,
  status: 'failed',
  summary: { journeys: 1, passed: 0, failed: 1, slowSteps: 0 },
  journeys: [
    {
      device: 'mobile',
      status: 'failed',
      startedAt: t,
      durationMs: 4000,
      platform: null,
      failedStep: 'find_add_to_cart',
      steps: [
        {
          name: 'find_add_to_cart',
          status: 'failed',
          startedAt: t,
          durationMs: 2000,
          slow: false,
          message: 'Add-to-cart control exists but is hidden',
          details: {},
          consoleErrors: [],
          pageErrors: [],
          failedRequests: [],
        },
      ],
    },
  ],
};

const context: AlertContext = {
  monitor: { id: 'm1', name: 'Tee', url: 'https://s.test/products/tee' },
  runId: 'run-1',
  result: failedResult,
  decision: { kind: 'failure' },
  publicBaseUrl: 'https://sentinel.example.com',
};

describe('payloads', () => {
  it('builds a versioned webhook payload with failure summaries', () => {
    expect(webhookPayload(context)).toMatchObject({
      event: 'checkout_sentinel.alert',
      version: 1,
      kind: 'failure',
      monitor: { id: 'm1', name: 'Tee' },
      run: {
        id: 'run-1',
        status: 'failed',
        failures: [
          {
            device: 'mobile',
            step: 'find_add_to_cart',
            message: 'Add-to-cart control exists but is hidden',
          },
        ],
        url: 'https://sentinel.example.com/runs/run-1',
      },
    });
  });

  it('builds a Slack message naming the failing step', () => {
    const { text } = slackPayload(context);
    expect(text).toContain('*Checkout journey failing: Tee*');
    expect(text).toContain('mobile: `find_add_to_cart`');
    expect(slackPayload({ ...context, decision: { kind: 'recovery' } }).text).toContain(
      'recovered',
    );
  });
});

describe('deliverAlert', () => {
  const received: Array<{ headers: IncomingMessage['headers']; body: string }> = [];
  let status = 200;
  let calls = 0;
  let base = '';
  const server = createServer((req, res) => {
    calls += 1;
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(status).end('ok');
    });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const options = { timeoutMs: 2000, attempts: 2, userAgent: 'checkout-sentinel/test' };

  it('signs webhook bodies with HMAC-SHA256 when a secret is set', async () => {
    received.length = 0;
    const secret = 'a-very-long-shared-secret';
    const outcome = await deliverAlert(
      { type: 'webhook', url: `${base}/hook`, secret },
      context,
      options,
    );
    expect(outcome).toEqual({ ok: true, status: 200 });
    const [request] = received;
    expect(request?.headers[SIGNATURE_HEADER]).toBe(signBody(request?.body ?? '', secret));
    expect(JSON.parse(request?.body ?? '{}')).toHaveProperty('event', 'checkout_sentinel.alert');
  });

  it('sends Slack-shaped bodies to Slack channels', async () => {
    received.length = 0;
    await deliverAlert({ type: 'slack', url: `${base}/slack` }, context, options);
    expect(Object.keys(JSON.parse(received[0]?.body ?? '{}'))).toEqual(['text']);
    expect(received[0]?.headers[SIGNATURE_HEADER]).toBeUndefined();
  });

  it('retries 5xx and gives up on 4xx', async () => {
    status = 503;
    calls = 0;
    expect(await deliverAlert({ type: 'slack', url: `${base}/x` }, context, options)).toMatchObject(
      {
        ok: false,
        status: 503,
      },
    );
    expect(calls).toBe(2);
    status = 404;
    calls = 0;
    await deliverAlert({ type: 'slack', url: `${base}/x` }, context, options);
    expect(calls).toBe(1);
    status = 200;
  });

  it('reports network errors without throwing', async () => {
    const outcome = await deliverAlert(
      { type: 'webhook', url: 'http://127.0.0.1:1/nope' },
      context,
      {
        ...options,
        attempts: 1,
      },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
  });
});
