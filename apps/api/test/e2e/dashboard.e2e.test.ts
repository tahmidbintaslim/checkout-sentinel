import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESULT_SCHEMA_VERSION, type RunResult } from '@checkout-sentinel/core';
import {
  AlertDeliveryRepository,
  RunRepository,
  StateRepository,
  createDb,
  type DbHandle,
} from '@checkout-sentinel/db';
import { probeTestServices, truncateAll } from '@checkout-sentinel/fixtures';
import { JourneyScheduler, createRedis } from '@checkout-sentinel/jobs';
import { DASHBOARD_CSP, createApp, loadApiConfig } from '@checkout-sentinel/api';

const services = await probeTestServices();
const TOKEN = 'e2e-api-token-0123456789';
const INDEX_HTML = '<!doctype html><title>dashboard</title><div id="app"></div>';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** A stored result in the shape the worker writes; the paths are the worker's own. */
function failedResult(runId: string, workerArtifacts: string): RunResult {
  const at = new Date().toISOString();
  const step = (name: RunResult['journeys'][number]['steps'][number]['name'], extra = {}) => ({
    name,
    status: 'passed' as const,
    startedAt: at,
    durationMs: 10,
    slow: false,
    details: {},
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    ...extra,
  });
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    tool: { name: 'checkout-sentinel', version: '0.1.0' },
    runId,
    url: 'https://store.example/products/tee',
    requestedPlatform: 'auto',
    startedAt: at,
    finishedAt: at,
    durationMs: 20,
    status: 'failed',
    summary: { journeys: 1, passed: 0, failed: 1, slowSteps: 0 },
    journeys: [
      {
        device: 'mobile',
        status: 'failed',
        startedAt: at,
        durationMs: 20,
        platform: null,
        failedStep: 'find_add_to_cart',
        steps: [
          step('open_product'),
          step('find_add_to_cart', {
            status: 'failed',
            message: 'hidden',
            screenshot: path.join(workerArtifacts, runId, 'mobile-find_add_to_cart.png'),
          }),
        ],
        trace: path.join(workerArtifacts, runId, 'mobile-trace.zip'),
      },
    ],
  };
}

describe.skipIf(!services.available)('dashboard, /api prefix and run artifacts', () => {
  let app: INestApplication;
  let base: string;
  let db: DbHandle;
  let redis: ReturnType<typeof createRedis>;
  let scheduler: JourneyScheduler;
  let dashboard: string;
  let artifacts: string;
  let outside: string;

  const api = (path: string, init: RequestInit & { json?: unknown; auth?: boolean } = {}) => {
    const { json, auth = true, headers, ...rest } = init;
    return fetch(`${base}${path}`, {
      ...rest,
      headers: {
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
        ...(headers as Record<string, string> | undefined),
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
  };
  const browserNavigation = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };

  beforeAll(async () => {
    dashboard = await mkdtemp(path.join(tmpdir(), 'checkout-sentinel-dashboard-'));
    await mkdir(path.join(dashboard, 'assets'));
    await writeFile(path.join(dashboard, 'index.html'), INDEX_HTML);
    await writeFile(path.join(dashboard, 'assets', 'index-abc123.js'), 'console.log(1);');
    await writeFile(path.join(dashboard, '.env'), 'SECRET=1');
    artifacts = await mkdtemp(path.join(tmpdir(), 'checkout-sentinel-api-artifacts-'));
    outside = await mkdtemp(path.join(tmpdir(), 'checkout-sentinel-outside-'));
    await writeFile(path.join(outside, 'secret.png'), 'not yours');

    redis = createRedis(services.redisUrl);
    scheduler = new JourneyScheduler(redis);
    await scheduler.queue.obliterate({ force: true });
    app = await createApp(
      loadApiConfig({
        DATABASE_URL: services.databaseUrl,
        REDIS_URL: services.redisUrl,
        API_TOKEN: TOKEN,
        LOG_LEVEL: 'silent',
        DASHBOARD_DIR: dashboard,
        ARTIFACTS_DIR: artifacts,
      }),
    );
    await truncateAll(services.databaseUrl);
    db = createDb(services.databaseUrl);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
    await scheduler?.queue.obliterate({ force: true }).catch(() => undefined);
    await scheduler?.close();
    redis?.disconnect();
    for (const dir of [dashboard, artifacts, outside]) {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it('serves the dashboard at / without a token, with a strict content security policy', async () => {
    const page = await api('/', { auth: false });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toBe(DASHBOARD_CSP);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(await page.text()).toBe(INDEX_HTML);

    const asset = await api('/assets/index-abc123.js', { auth: false });
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(await asset.text()).toBe('console.log(1);');

    expect((await api('/.env', { auth: false, headers: browserNavigation })).status).toBe(200);
    expect(await (await api('/.env', { auth: false, headers: browserNavigation })).text()).toBe(
      INDEX_HTML,
    );
    expect((await api('/.env', { auth: false })).status).toBe(404);
    expect((await api('/assets/missing.js', { auth: false })).status).toBe(404);
  });

  it('answers a browser page load of a dashboard path with the dashboard, and scripts with the API', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    for (const pagePath of [`/monitors/${id}`, `/runs/${id}`, '/monitors/new', '/alerts']) {
      const page = await api(pagePath, { auth: false, headers: browserNavigation });
      expect(page.status, pagePath).toBe(200);
      expect(await page.text()).toBe(INDEX_HTML);
    }
    // A script or SDK keeps getting the API at the v0.1 paths.
    expect((await api('/monitors', { auth: false })).status).toBe(401);
    expect(
      (await api('/monitors', { auth: false, headers: { accept: 'application/json' } })).status,
    ).toBe(401);
    expect((await api(`/monitors/${id}`)).status).toBe(404);
    expect(await (await api('/monitors')).json()).toEqual([]);
    // Swagger UI, health and metrics are never the dashboard.
    expect(
      await (await api('/docs', { auth: false, headers: browserNavigation })).text(),
    ).toContain('swagger');
    expect(
      (await api('/health', { auth: false, headers: browserNavigation })).headers.get(
        'content-type',
      ),
    ).toContain('application/json');
  });

  it('serves every API route under /api as well', async () => {
    expect((await api('/api/health', { auth: false })).status).toBe(200);
    expect((await api('/api/monitors', { auth: false })).status).toBe(401);
    expect((await api('/api/monitors', { auth: false, headers: browserNavigation })).status).toBe(
      401,
    );
    expect(await (await api('/api/monitors')).json()).toEqual([]);
    expect((await api('/api/runs/not-a-uuid')).status).toBe(400);
    expect((await api('/api/nothing-here')).status).toBe(404);
    const docs = (await (await api('/api/docs/openapi.json', { auth: false })).json()) as {
      servers: Array<{ url: string }>;
      paths: Record<string, unknown>;
    };
    expect(docs.servers).toEqual([{ url: '/api' }]);
    expect(Object.keys(docs.paths)).toEqual(
      expect.arrayContaining(['/alerts', '/runs/{id}/artifacts/{name}']),
    );
    const metrics = await (await api('/metrics', { auth: false })).text();
    expect(metrics).toMatch(/route="\/monitors",status="200"/);
    expect(metrics).not.toContain('route="/api/monitors"');
  });

  it('serves the screenshots and traces a run references, and nothing else', async () => {
    const monitor = (await (
      await api('/monitors', {
        method: 'POST',
        json: { name: 'Artifacts', url: 'https://store.example/products/tee', enabled: false },
      })
    ).json()) as { id: string };
    const { run } = await new RunRepository(db.db).start(monitor.id, 'manual');
    const result = failedResult(run.id, `/data/worker-only/${monitor.id}`);
    await new StateRepository(db.db).applyRunResult(monitor.id, run.id, result, async () => ({
      update: {
        health: 'failing',
        consecutiveFailures: 1,
        slowSteps: [],
        lastRunId: run.id,
        lastRunStatus: 'failed',
        lastRunAt: new Date(),
        healthChanged: true,
      },
      value: null,
    }));
    const runDir = path.join(artifacts, monitor.id, run.id);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'mobile-find_add_to_cart.png'), PNG);
    await writeFile(path.join(runDir, 'mobile-trace.zip'), 'PK');
    await writeFile(path.join(runDir, 'desktop-open_product.png'), PNG);

    const detail = (await (await api(`/api/runs/${run.id}`)).json()) as {
      artifacts: Array<Record<string, string>>;
    };
    expect(detail.artifacts).toEqual([
      {
        name: 'mobile-find_add_to_cart.png',
        kind: 'screenshot',
        device: 'mobile',
        step: 'find_add_to_cart',
      },
      { name: 'mobile-trace.zip', kind: 'trace', device: 'mobile' },
    ]);

    const screenshot = await api(`/api/runs/${run.id}/artifacts/mobile-find_add_to_cart.png`);
    expect(screenshot.status).toBe(200);
    expect(screenshot.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await screenshot.arrayBuffer())).toEqual(PNG);

    const trace = await api(`/runs/${run.id}/artifacts/mobile-trace.zip`);
    expect(trace.status).toBe(200);
    expect(trace.headers.get('content-type')).toBe('application/zip');
    expect(trace.headers.get('content-disposition')).toBe(
      'attachment; filename="mobile-trace.zip"',
    );

    expect(
      (await api(`/api/runs/${run.id}/artifacts/mobile-find_add_to_cart.png`, { auth: false }))
        .status,
    ).toBe(401);
    // On disk, but not named by the result.
    expect((await api(`/api/runs/${run.id}/artifacts/desktop-open_product.png`)).status).toBe(404);
    for (const name of [
      '..%2F..%2F..%2Fetc%2Fpasswd',
      '%2Fetc%2Fpasswd',
      '..%5C..%5Cindex.html',
      '.hidden.png',
      'mobile-trace.zip%00.png',
    ]) {
      expect((await api(`/api/runs/${run.id}/artifacts/${name}`)).status, name).toBe(404);
    }
    expect(
      (await api(`/api/runs/00000000-0000-4000-8000-000000000000/artifacts/mobile-trace.zip`))
        .status,
    ).toBe(404);

    // A link on disk that leads out of ARTIFACTS_DIR is not followed.
    await rm(path.join(runDir, 'mobile-find_add_to_cart.png'));
    await symlink(
      path.join(outside, 'secret.png'),
      path.join(runDir, 'mobile-find_add_to_cart.png'),
    );
    expect((await api(`/api/runs/${run.id}/artifacts/mobile-find_add_to_cart.png`)).status).toBe(
      404,
    );

    // Referenced but gone (retention, or another worker's disk).
    await rm(path.join(runDir, 'mobile-trace.zip'));
    expect((await api(`/api/runs/${run.id}/artifacts/mobile-trace.zip`)).status).toBe(404);
  });

  it('lists alert deliveries of every monitor, newest first, page by page', async () => {
    const created = await Promise.all(
      ['Alpha', 'Beta'].map(async (name) => {
        const response = await api('/monitors', {
          method: 'POST',
          json: { name, url: 'https://store.example/products/tee', enabled: false },
        });
        return (await response.json()) as { id: string; name: string };
      }),
    );
    const runs = new RunRepository(db.db);
    const deliveries = new AlertDeliveryRepository(db.db);
    const ids: string[] = [];
    for (const [i, monitor] of [created[0], created[1], created[0]].entries()) {
      const { run } = await runs.start(monitor!.id, 'schedule');
      const claim = await deliveries.claim({
        monitorId: monitor!.id,
        runId: run.id,
        kind: i === 2 ? 'recovery' : 'failure',
        channelIndex: 0,
        channelType: 'webhook',
      });
      if (i === 1) await deliveries.markFailed(claim!.id, 'HTTP 500', 500);
      else await deliveries.markSent(claim!.id, 204);
      ids.push(claim!.id);
    }

    const first = (await (await api('/api/alerts?limit=2')).json()) as {
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    expect(first.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    expect(first.items[0]).toMatchObject({
      monitorId: created[0]!.id,
      monitorName: 'Alpha',
      kind: 'recovery',
      status: 'sent',
      responseStatus: 204,
    });
    expect(first.items[1]).toMatchObject({
      monitorName: 'Beta',
      status: 'failed',
      error: 'HTTP 500',
    });
    expect(first.nextCursor).toBe(ids[1]);

    const second = (await (await api(`/api/alerts?limit=2&before=${first.nextCursor}`)).json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(second).toEqual({ items: [expect.objectContaining({ id: ids[0] })], nextCursor: null });

    const alpha = (await (await api(`/api/alerts?monitorId=${created[0]!.id}`)).json()) as {
      items: Array<{ id: string }>;
    };
    expect(alpha.items.map((item) => item.id)).toEqual([ids[2], ids[0]]);
    expect((await api('/api/alerts?before=not-a-cursor')).status).toBe(400);
    expect((await api('/api/alerts', { auth: false })).status).toBe(401);
  });
});
