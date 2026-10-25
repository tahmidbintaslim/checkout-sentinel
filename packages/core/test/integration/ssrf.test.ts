import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startFixtureStore,
  type FixtureStore,
  type FixtureStoreOptions,
} from '@checkout-sentinel/fixtures';
import {
  RunResultSchema,
  STRICT_TARGET_POLICY,
  TargetGuard,
  launchBrowser,
  runJourneys,
  type ResolveHost,
  type RunOptions,
  type RunResult,
} from '@checkout-sentinel/core';

// The guard is on in every test here (the API and worker default). Fixture stores listen on
// 127.0.0.1, which the guard refuses, so "store.test" stands in for a public store: it is an
// allowed host that the fake resolver points at the fixture. Nothing is resolved through real
// DNS and nothing leaves 127.0.0.1.
let browser: Browser;
const stores: FixtureStore[] = [];

beforeAll(async () => {
  browser = await launchBrowser();
});

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await browser?.close();
});

async function store(options: FixtureStoreOptions): Promise<FixtureStore> {
  const started = await startFixtureStore(options);
  stores.push(started);
  return started;
}

const port = (target: FixtureStore) => Number(new URL(target.origin).port);

const resolveTo =
  (answers: Record<string, string | string[]>): ResolveHost =>
  async (hostname) => {
    const answer = answers[hostname];
    if (answer === undefined) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    }
    return (Array.isArray(answer) ? answer : [answer]).map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }));
  };

/** The guard as a hosted deployment would configure it, plus store.test for the fixture. */
function guardFor(target: FixtureStore, resolve?: ResolveHost): TargetGuard {
  return new TargetGuard(
    { allowPrivate: false, allowedHosts: ['store.test'], allowedPorts: [port(target)] },
    { resolve: resolve ?? resolveTo({ 'store.test': '127.0.0.1' }) },
  );
}

const storeTestUrl = (target: FixtureStore) => target.productUrl.replace('127.0.0.1', 'store.test');

async function run(url: string, options: Partial<RunOptions>): Promise<RunResult> {
  const result = await runJourneys({
    url,
    browser,
    devices: 'mobile',
    timeouts: { stepMs: 3_000, navigationMs: 10_000 },
    ...options,
  });
  expect(RunResultSchema.safeParse(result).success).toBe(true);
  return result;
}

describe('SSRF guard in the browser journey', () => {
  it.each([['shopify'], ['woocommerce']] as const)(
    'a %s store on an allowed host passes the whole journey through the egress proxy',
    async (platform) => {
      const target = await store({ platform });
      const result = await run(storeTestUrl(target), { targetGuard: guardFor(target) });
      expect(result.status).toBe('passed');
      const steps = result.journeys[0]?.steps ?? [];
      expect(steps.map((s) => s.status)).toEqual(Array(6).fill('passed'));
      // Cart reads go through the same proxy, so the cart was verified, not skipped.
      expect(steps.find((s) => s.name === 'verify_cart')?.details.cartAfter).toBe(1);
      expect(steps.some((s) => 'blockedRequests' in s.details)).toBe(false);
      expect(target.orderAttempts()).toBe(0);
    },
  );

  it('blocks a product page that redirects the browser to 127.0.0.1', async () => {
    const target = await store({ platform: 'shopify', variant: 'redirect-to-loopback' });

    // Control, without a guard: the fixture really redirects, and the browser follows it.
    const unguarded = await run(target.productUrl.replace('127.0.0.1', 'localhost'), {});
    expect(unguarded.journeys[0]?.steps[0]).toMatchObject({
      status: 'passed',
      details: { finalUrl: target.productUrl, httpStatus: 200 },
    });

    const result = await run(storeTestUrl(target), { targetGuard: guardFor(target) });
    expect(result.status).toBe('failed');
    const journey = result.journeys[0];
    expect(journey?.failedStep).toBe('open_product');
    const openProduct = journey?.steps[0];
    expect(openProduct?.message).toMatch(
      new RegExp(
        `^Blocked a request to 127\\.0\\.0\\.1:${port(target)}: 127\\.0\\.0\\.1 is a loopback address`,
      ),
    );
    expect(openProduct?.details.blockedRequests).toContain(`127.0.0.1:${port(target)}`);
    // The proxy's own answer is what the browser saw; the product page never loaded.
    expect(openProduct?.details.finalUrl).toBe(target.productUrl);
    expect(openProduct?.details.httpStatus).toBe(403);
    expect(journey?.steps.slice(1).every((s) => s.status === 'skipped')).toBe(true);
  });

  it('refuses a private product URL before using the browser', async () => {
    const target = await store({ platform: 'shopify' });
    const result = await run(target.productUrl, {
      targetGuard: new TargetGuard(STRICT_TARGET_POLICY),
    });
    expect(result.status).toBe('error');
    expect(result.error?.message).toBe(
      'Target blocked: 127.0.0.1 is a loopback address (127.0.0.0/8)',
    );
    expect(result.journeys).toEqual([]);
    expect(target.userAgents()).toEqual([]);
  });

  it('refuses a name that resolved to a public address when checked and to 127.0.0.1 when the browser connects', async () => {
    const target = await store({ platform: 'shopify' });
    let calls = 0;
    const rebinding: ResolveHost = async (hostname) => {
      if (hostname !== 'rebind.test') return resolveTo({})(hostname);
      calls += 1;
      return [{ address: calls === 1 ? '93.184.215.14' : '127.0.0.1', family: 4 }];
    };
    const guard = new TargetGuard({ allowedPorts: [port(target)] }, { resolve: rebinding });
    const result = await run(target.productUrl.replace('127.0.0.1', 'rebind.test'), {
      targetGuard: guard,
    });
    // The use-time check saw the public answer; the connection saw 127.0.0.1 and was refused.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe('failed');
    expect(result.journeys[0]?.steps[0]?.message).toContain(
      'rebind.test resolves to 127.0.0.1, a loopback address',
    );
    expect(target.userAgents()).toEqual([]);
  });

  it('lets private targets through when the guard allows them (local development)', async () => {
    const target = await store({ platform: 'woocommerce' });
    const result = await run(target.productUrl, {
      targetGuard: new TargetGuard({ allowPrivate: true }),
    });
    expect(result.status).toBe('passed');
  });
});
