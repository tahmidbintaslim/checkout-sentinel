/**
 * Writes the read-only demo's data (apps/web/demo/data/) from real journeys against the local
 * fixture stores. No database, Redis or worker: it calls runJourneys directly, then shapes the
 * results the way the API answers, so the dashboard renders them unchanged.
 *
 *   pnpm build
 *   pnpm --filter @checkout-sentinel/web demo:data
 *
 * What is real: every step, verdict, duration, detected platform and failure screenshot. What
 * the script adds: the runs are placed on an hourly timeline ending at the time it runs, and the
 * monitor status and alert log are derived from them with the worker's own state machine
 * (evaluateTransition: a failure alert after alertAfterFailures failing runs in a row, one on
 * recovery, one when a step becomes newly slow). Each alert is POSTed to the
 * fixtures' local webhook receiver, and its logged status is that delivery's.
 * Fixture URLs (http://127.0.0.1:<port>) are rewritten to *.example hosts.
 */
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, runJourneys, type RunResult } from '@checkout-sentinel/core';
import {
  startFixtureStore,
  startWebhookReceiver,
  type FixtureStoreOptions,
  type FixtureVariant,
} from '@checkout-sentinel/fixtures';
import { evaluateTransition, type AlertState } from '@checkout-sentinel/worker';

const outDir = fileURLToPath(new URL('../demo/data/', import.meta.url));
const HOUR = 3_600_000;

interface MonitorPlan {
  id: string;
  name: string;
  host: string;
  store: Omit<FixtureStoreOptions, 'variant' | 'port'>;
  port: number;
  slowStepMs: number;
  alertAfterFailures: number;
  /** One fixture variant per hourly run, oldest first. */
  runs: FixtureVariant[];
}

const plans: MonitorPlan[] = [
  {
    id: 'demo-tee',
    name: 'Demo Tee (Shopify)',
    host: 'https://demo-tee.example',
    store: { platform: 'shopify' },
    port: 4110,
    slowStepMs: 8_000,
    alertAfterFailures: 2,
    // A theme edit hides Add to cart on mobile for three runs, then it is fixed.
    runs: ['ok', 'ok', 'mobile-hidden', 'mobile-hidden', 'mobile-hidden', 'ok', 'ok'],
  },
  {
    id: 'demo-hoodie',
    name: 'Demo Hoodie (WooCommerce)',
    host: 'https://demo-hoodie.example',
    store: { platform: 'woocommerce' },
    port: 4111,
    slowStepMs: 8_000,
    alertAfterFailures: 2,
    runs: ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'],
  },
  {
    id: 'demo-slow',
    name: 'Demo Tee, slow checkout (Shopify)',
    host: 'https://demo-slow.example',
    store: { platform: 'shopify', checkoutDelayMs: 1_500 },
    port: 4112,
    slowStepMs: 1_000,
    alertAfterFailures: 2,
    runs: ['ok', 'ok', 'ok'],
  },
];

/** Every fixture origin in a JSON value, rewritten to the monitor's demo host. */
function rewriteUrls<T>(value: T, origin: string, host: string): T {
  return JSON.parse(JSON.stringify(value).split(origin).join(host)) as T;
}

function shiftIso(iso: string, deltaMs: number): string {
  return new Date(Date.parse(iso) + deltaMs).toISOString();
}

/** Moves a result's timestamps so it starts at `startAt`; durations stay as measured. */
function retime(result: RunResult, startAt: number): RunResult {
  const delta = startAt - Date.parse(result.startedAt);
  return {
    ...result,
    startedAt: shiftIso(result.startedAt, delta),
    finishedAt: shiftIso(result.finishedAt, delta),
    journeys: result.journeys.map((j) => ({
      ...j,
      startedAt: shiftIso(j.startedAt, delta),
      steps: j.steps.map((s) => ({ ...s, startedAt: shiftIso(s.startedAt, delta) })),
    })),
  };
}

const writeJson = async (file: string, data: unknown) => {
  await mkdir(path.dirname(path.join(outDir, file)), { recursive: true });
  await writeFile(path.join(outDir, file), JSON.stringify(data, null, 2) + '\n');
};

await rm(outDir, { recursive: true, force: true });
const scratch = await mkdtemp(path.join(tmpdir(), 'checkout-sentinel-demo-'));
const browser = await launchBrowser();
const hooks = await startWebhookReceiver();
const now = Math.floor(Date.now() / HOUR) * HOUR;
const monitors: unknown[] = [];
const alerts: Record<string, unknown>[] = [];

for (const plan of plans) {
  const origin = `http://127.0.0.1:${plan.port}`;
  let productPath = '';
  const runs: Record<string, unknown>[] = [];
  let state: AlertState = { health: 'unknown', consecutiveFailures: 0, slowSteps: [] };
  let healthChangedAt: string | null = null;

  for (const [index, variant] of plan.runs.entries()) {
    const store = await startFixtureStore({ ...plan.store, variant, port: plan.port });
    const runId = randomUUID();
    const artifactsDir = path.join(scratch, runId);
    let result: RunResult;
    try {
      productPath = new URL(store.productUrl).pathname;
      result = await runJourneys({
        url: store.productUrl,
        browser,
        artifactsDir,
        slowStepMs: plan.slowStepMs,
        runId,
      });
    } finally {
      await store.close();
    }
    const startAt = now - (plan.runs.length - 1 - index) * HOUR;
    result = rewriteUrls(retime(result, startAt), origin, plan.host);

    // Keep failure screenshots, drop traces (large, and not needed to read a run).
    const artifacts: Record<string, unknown>[] = [];
    for (const journey of result.journeys) {
      delete journey.trace;
      for (const step of journey.steps) {
        if (!step.screenshot) continue;
        const name = path.basename(step.screenshot);
        await mkdir(path.join(outDir, 'artifacts', runId), { recursive: true });
        await copyFile(
          path.resolve(artifactsDir, step.screenshot),
          path.join(outDir, 'artifacts', runId, name),
        );
        step.screenshot = name;
        artifacts.push({ name, kind: 'screenshot', device: journey.device, step: step.name });
      }
    }

    const failed = result.journeys.find((j) => j.status === 'failed');
    const summary = {
      id: runId,
      monitorId: plan.id,
      trigger: 'schedule',
      status: result.status,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      detectedPlatform: result.journeys[0]?.platform?.detected ?? null,
      failedStep: failed?.failedStep ?? null,
      error: result.error?.message ?? null,
    };
    runs.push(summary);
    await writeJson(`runs/${runId}.json`, { ...summary, artifacts, result });

    const alert = async (kind: 'failure' | 'recovery' | 'slow') => {
      const response = await fetch(hooks.url(`/${plan.id}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, monitor: plan.name, runId, status: result.status }),
      });
      alerts.push({
        id: randomUUID(),
        runId,
        monitorId: plan.id,
        monitorName: plan.name,
        kind,
        channelType: 'webhook',
        status: response.ok ? 'sent' : 'failed',
        responseStatus: response.status,
        error: null,
        createdAt: result.finishedAt,
        sentAt: result.finishedAt,
      });
    };
    const transition = evaluateTransition(state, result, plan.alertAfterFailures);
    for (const decision of transition.alerts) await alert(decision.kind);
    if (transition.healthChanged) healthChangedAt = result.finishedAt;
    state = transition.next;
    console.log(`${plan.id} #${index + 1} ${variant}: ${result.status}`);
  }

  const last = runs[runs.length - 1]!;
  const monitor = {
    id: plan.id,
    name: plan.name,
    url: `${plan.host}${productPath}`,
    platform: 'auto',
    devices: ['desktop', 'mobile'],
    schedule: '0 * * * *',
    timezone: 'UTC',
    slowStepMs: plan.slowStepMs,
    alertAfterFailures: plan.alertAfterFailures,
    alerts: [{ type: 'webhook', url: 'https://hooks.example/checkout-alerts', hasSecret: false }],
    enabled: true,
    createdAt: new Date(now - plan.runs.length * HOUR).toISOString(),
    updatedAt: new Date(now - plan.runs.length * HOUR).toISOString(),
    status: {
      health: state.health,
      consecutiveFailures: state.consecutiveFailures,
      slowSteps: state.slowSteps,
      lastRunId: last.id,
      lastRunStatus: last.status,
      lastRunAt: last.finishedAt,
      healthChangedAt,
    },
  };
  monitors.push(monitor);
  await writeJson(`monitors/${plan.id}.json`, monitor);
  await writeJson(`monitor-runs/${plan.id}.json`, { items: [...runs].reverse(), nextCursor: null });
}

alerts.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
await writeJson('monitors.json', monitors);
await writeJson('alerts.json', { items: alerts, nextCursor: null });
await writeJson('meta.json', { generatedAt: new Date().toISOString() });
await browser.close();
await hooks.close();
await rm(scratch, { recursive: true, force: true });
console.log(`Wrote ${outDir}`);
