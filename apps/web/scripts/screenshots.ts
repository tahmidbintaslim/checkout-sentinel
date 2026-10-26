/**
 * Takes the dashboard screenshots in docs/images/ from real runs against the local fixture
 * stores: it starts the API (serving apps/web/dist), a worker and the fixture stores, creates
 * monitors, runs them, and captures pages in light and dark mode with Playwright.
 *
 *   pnpm build
 *   pnpm --filter @checkout-sentinel/web screenshots
 *
 * It uses the e2e test database and Redis DB (TEST_DATABASE_URL, TEST_REDIS_URL) and empties
 * them, like the e2e tests do. Never point it at real data.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { pino } from 'pino';
import { createApp, loadApiConfig } from '@checkout-sentinel/api';
import { launchBrowser } from '@checkout-sentinel/core';
import {
  TEST_DATABASE_URL,
  TEST_REDIS_URL,
  startFixtureStore,
  startWebhookReceiver,
  truncateAll,
} from '@checkout-sentinel/fixtures';
import { JourneyScheduler, createRedis } from '@checkout-sentinel/jobs';
import { loadConfig, startWorker } from '@checkout-sentinel/worker';

const TOKEN = 'screenshot-token-0123456789';
const webRoot = fileURLToPath(new URL('../', import.meta.url));
const dashboardDir = path.join(webRoot, 'dist');
const outDir = path.resolve(webRoot, '../../docs/images');

if (!existsSync(path.join(dashboardDir, 'index.html'))) {
  console.error(`No dashboard build in ${dashboardDir}. Run pnpm build first.`);
  process.exit(2);
}

const artifacts = await mkdtemp(path.join(tmpdir(), 'checkout-sentinel-screenshots-'));
const redis = createRedis(TEST_REDIS_URL);
const scheduler = new JourneyScheduler(redis);
await scheduler.queue.obliterate({ force: true });

const stores = {
  tee: await startFixtureStore({ platform: 'shopify' }),
  hoodie: await startFixtureStore({ platform: 'woocommerce' }),
  hidden: await startFixtureStore({ platform: 'shopify', variant: 'mobile-hidden' }),
  slow: await startFixtureStore({ platform: 'shopify', checkoutDelayMs: 1_500 }),
};
const hooks = await startWebhookReceiver();

const app = await createApp(
  loadApiConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    API_TOKEN: TOKEN,
    LOG_LEVEL: 'silent',
    DASHBOARD_DIR: dashboardDir,
    ARTIFACTS_DIR: artifacts,
    ALLOW_PRIVATE_TARGETS: 'true',
  }),
);
await truncateAll(TEST_DATABASE_URL);
await app.listen(0, '127.0.0.1');
const base = await app.getUrl();
const worker = await startWorker(
  loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    METRICS_PORT: '0',
    ARTIFACTS_DIR: artifacts,
    STEP_TIMEOUT_MS: '3000',
    HOUSEKEEPING_INTERVAL_MS: '0',
    LOG_LEVEL: 'silent',
    ALLOW_PRIVATE_TARGETS: 'true',
  }),
  pino({ level: 'silent' }),
);

async function api<T>(method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

interface Created {
  id: string;
}
interface RunPage {
  items: Array<{ id: string; status: string }>;
}

async function runAndWait(monitorId: string, runsBefore: number): Promise<string> {
  await api('POST', `/monitors/${monitorId}/runs`);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const page = await api<RunPage>('GET', `/monitors/${monitorId}/runs?limit=20`);
    const latest = page.items[0];
    if (page.items.length > runsBefore && latest && latest.status !== 'running') return latest.id;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`run of ${monitorId} did not finish`);
}

const webhook = (name: string) => ({
  type: 'webhook',
  url: hooks.url(`/${name}`),
  secret: 'screenshot-signing-secret',
});

try {
  const clearance = await api<Created>('POST', '/monitors', {
    name: 'Clearance socks',
    url: stores.tee.productUrl,
    devices: ['desktop'],
    schedule: '0 6 * * *',
    enabled: false,
  });
  const slow = await api<Created>('POST', '/monitors', {
    name: 'Gift card',
    url: stores.slow.productUrl,
    devices: ['desktop'],
    schedule: '0 * * * *',
    slowStepMs: 1_000,
    alerts: [webhook('gift-card')],
  });
  const hidden = await api<Created>('POST', '/monitors', {
    name: 'Summer tee, new theme',
    url: stores.hidden.productUrl,
    devices: ['mobile'],
    schedule: '*/10 * * * *',
    alertAfterFailures: 1,
    alerts: [webhook('summer-tee')],
  });
  const hoodie = await api<Created>('POST', '/monitors', {
    name: 'Winter hoodie',
    url: stores.hoodie.productUrl,
    platform: 'woocommerce',
    schedule: '*/30 * * * *',
    timezone: 'Europe/Berlin',
  });
  const tee = await api<Created>('POST', '/monitors', {
    name: 'Bestseller tee',
    url: stores.tee.productUrl,
    alerts: [webhook('bestseller')],
  });
  void clearance;

  for (const monitor of [tee, hoodie, slow]) await runAndWait(monitor.id, 0);
  await runAndWait(hidden.id, 0);
  const failedRun = await runAndWait(hidden.id, 1);
  await hooks.waitFor(2, 30_000);

  await mkdir(outDir, { recursive: true });
  const browser = await launchBrowser();
  const shoot = async (
    theme: 'light' | 'dark',
    route: string,
    file: string,
    ready: (page: Page) => Promise<void>,
    fullPage = false,
  ) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      colorScheme: theme,
      deviceScaleFactor: 1,
    });
    await context.addInitScript((token: string) => {
      sessionStorage.setItem('checkout-sentinel.api-token', token);
    }, TOKEN);
    const page = await context.newPage();
    await page.goto(`${base}${route}`);
    await ready(page);
    await page.screenshot({ path: path.join(outDir, file), fullPage });
    await context.close();
    console.log(`wrote docs/images/${file}`);
  };

  await shoot('light', '/', 'dashboard-monitors-light.png', async (page) => {
    await page.locator('tbody tr').nth(4).waitFor();
  });
  await shoot('dark', `/monitors/${hidden.id}`, 'dashboard-monitor-dark.png', async (page) => {
    await page.locator('tbody tr').nth(1).waitFor();
    await page.locator('[data-device="mobile"]').waitFor();
  });
  await shoot(
    'light',
    `/runs/${failedRun}`,
    'dashboard-run-light.png',
    async (page) => {
      await page.locator('li.step[data-step="find_add_to_cart"] img').waitFor();
      await page.waitForFunction(
        () => (document.querySelector('li.step img') as HTMLImageElement | null)?.naturalWidth,
      );
    },
    true,
  );
  await browser.close();
} finally {
  await worker.shutdown();
  await app.close();
  await scheduler.queue.obliterate({ force: true }).catch(() => undefined);
  await scheduler.close();
  redis.disconnect();
  await Promise.all([...Object.values(stores).map((store) => store.close()), hooks.close()]);
  await rm(artifacts, { recursive: true, force: true });
}
