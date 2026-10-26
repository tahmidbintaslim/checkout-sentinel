import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { pino } from 'pino';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, loadApiConfig } from '@checkout-sentinel/api';
import { launchBrowser } from '@checkout-sentinel/core';
import {
  probeTestServices,
  startFixtureStore,
  truncateAll,
  type FixtureStore,
} from '@checkout-sentinel/fixtures';
import { JourneyScheduler, createRedis } from '@checkout-sentinel/jobs';
import { loadConfig, startWorker, type RunningWorker } from '@checkout-sentinel/worker';

const services = await probeTestServices();
const TOKEN = 'e2e-dashboard-token-0123456789';
const webRoot = fileURLToPath(new URL('../../', import.meta.url));
/** How long to wait for the page to show what the API already has. */
const UI = { timeout: 10_000 };

describe.skipIf(!services.available)(
  'dashboard end to end (built SPA, API, worker, Chromium)',
  () => {
    let dashboard: string;
    let artifacts: string;
    let app: Awaited<ReturnType<typeof createApp>>;
    let base: string;
    let worker: RunningWorker;
    let redis: ReturnType<typeof createRedis>;
    let scheduler: JourneyScheduler;
    let healthy: FixtureStore;
    let broken: FixtureStore;
    let browser: Browser;
    let page: Page;
    const pageProblems: string[] = [];

    beforeAll(async () => {
      // The SPA is built from the current sources, as pnpm build does, into this test's own
      // directory, so the test never serves a stale build.
      dashboard = await mkdtemp(path.join(tmpdir(), 'checkout-sentinel-spa-'));
      await build({
        root: webRoot,
        configFile: path.join(webRoot, 'vite.config.ts'),
        logLevel: 'warn',
        build: { outDir: dashboard, emptyOutDir: true },
      });
      artifacts = await mkdtemp(path.join(tmpdir(), 'checkout-sentinel-dashboard-artifacts-'));

      redis = createRedis(services.redisUrl);
      scheduler = new JourneyScheduler(redis);
      await scheduler.queue.obliterate({ force: true });
      healthy = await startFixtureStore({ platform: 'shopify' });
      broken = await startFixtureStore({ platform: 'shopify', variant: 'mobile-hidden' });

      // Fixture stores listen on 127.0.0.1, so both services allow private targets.
      app = await createApp(
        loadApiConfig({
          DATABASE_URL: services.databaseUrl,
          REDIS_URL: services.redisUrl,
          API_TOKEN: TOKEN,
          LOG_LEVEL: 'silent',
          DASHBOARD_DIR: dashboard,
          ARTIFACTS_DIR: artifacts,
          ALLOW_PRIVATE_TARGETS: 'true',
        }),
      );
      await truncateAll(services.databaseUrl);
      await app.listen(0, '127.0.0.1');
      base = await app.getUrl();
      worker = await startWorker(
        loadConfig({
          DATABASE_URL: services.databaseUrl,
          REDIS_URL: services.redisUrl,
          METRICS_PORT: '0',
          ARTIFACTS_DIR: artifacts,
          STEP_TIMEOUT_MS: '3000',
          HOUSEKEEPING_INTERVAL_MS: '0',
          LOG_LEVEL: 'silent',
          ALLOW_PRIVATE_TARGETS: 'true',
        }),
        pino({ level: 'silent' }),
      );

      browser = await launchBrowser();
      page = await browser.newPage();
      page.on('pageerror', (error) => pageProblems.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        // A CSP violation in the dashboard is reported here as an error. The 401 before the
        // token is entered is expected.
        if (message.type() === 'error' && !message.text().includes('401')) {
          pageProblems.push(`console: ${message.text()}`);
        }
      });
    });

    afterAll(async () => {
      await browser?.close();
      await worker?.shutdown();
      await app?.close();
      await scheduler?.queue.obliterate({ force: true }).catch(() => undefined);
      await scheduler?.close();
      redis?.disconnect();
      await Promise.all([healthy?.close(), broken?.close()]);
      for (const dir of [dashboard, artifacts]) {
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    });

    async function createMonitor(name: string, url: string) {
      await page.getByRole('link', { name: 'New monitor' }).first().click();
      await page.getByLabel('Name', { exact: true }).fill(name);
      await page.getByLabel('Product URL').fill(url);
      // One device keeps the journey short.
      await page.getByLabel('Desktop').uncheck();
      await page.getByRole('button', { name: 'Create monitor' }).click();
      await page.getByRole('heading', { level: 1, name }).waitFor();
    }

    it('asks for the token, creates a monitor through the form and shows the Run now result', async () => {
      await page.goto(`${base}/`);
      await page.getByText('The API needs a token').waitFor();
      await page.getByLabel('API token').fill(TOKEN);
      await page.getByRole('button', { name: 'Save token' }).click();
      await page.getByText('No monitors yet').waitFor();

      await createMonitor('Fixture tee', healthy.productUrl);
      expect(page.url()).toMatch(/\/monitors\/[0-9a-f-]{36}$/);
      await page.getByText('No runs yet').waitFor();

      await page.getByRole('button', { name: 'Run now' }).click();
      await page.getByText('Run queued').waitFor();
      await page.getByText('The run passed.').waitFor({ timeout: 60_000 });

      await expect
        .poll(() => page.locator('[data-device="mobile"]').textContent(), UI)
        .toContain('Passed');
      const history = page.locator('tbody tr');
      await expect.poll(() => history.count(), UI).toBe(1);
      expect(await history.first().textContent()).toContain('Manual');

      await history.first().getByRole('link').click();
      await page.getByRole('heading', { level: 1, name: /^Run of / }).waitFor();
      const steps = page.locator('li.step');
      expect(await steps.locator('h3').allTextContents()).toEqual([
        'Open product',
        'Find add to cart',
        'Add to cart',
        'Verify cart',
        'Go to checkout',
        'Checkout renders',
      ]);
      expect(new Set(await steps.locator('.step-head .badge').allTextContents())).toEqual(
        new Set(['Passed']),
      );

      // A full page load of the list keeps the token for this tab and shows the new health.
      await page.goto(`${base}/`);
      const row = page.locator('tbody tr', { hasText: 'Fixture tee' });
      await expect.poll(() => row.locator('td').nth(1).textContent(), UI).toContain('Passing');
      expect(pageProblems).toEqual([]);
    });

    it('shows a failed step with its message and the screenshot the worker took', async () => {
      // The token entered in the first test stays in this tab's sessionStorage.
      await page.goto(`${base}/`);
      await createMonitor('Hidden button', broken.productUrl);
      await page.getByRole('button', { name: 'Run now' }).click();
      await page.getByText('The run failed.').waitFor({ timeout: 60_000 });

      await page.locator('tbody tr').first().getByRole('link').click();
      const failed = page.locator('li.step[data-step="find_add_to_cart"]');
      await failed.waitFor();
      expect(await failed.textContent()).toContain('hidden or disabled at this viewport');
      const screenshot = failed.locator('img');
      await screenshot.waitFor();
      // Fetched with the bearer token from GET /api/runs/:id/artifacts/:name.
      expect(await screenshot.getAttribute('src')).toMatch(/^blob:/);
      await expect
        .poll(() => screenshot.evaluate((img: HTMLImageElement) => img.naturalWidth), UI)
        .toBeGreaterThan(0);
      expect(await page.getByRole('button', { name: 'Download Mobile trace' }).count()).toBe(1);
      expect(pageProblems).toEqual([]);
    });
  },
);
