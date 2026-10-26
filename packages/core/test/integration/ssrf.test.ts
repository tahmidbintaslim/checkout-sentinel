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

  it('lists a refused subresource in the step details and lets the step pass', async () => {
    const target = await store({ platform: 'shopify', loopbackSubresource: true });
    const loopback = () =>
      target.requests().filter((request) => request.host === `127.0.0.1:${port(target)}`);

    // Control, without a guard: the page really loads a script from 127.0.0.1.
    const unguarded = await run(target.productUrl.replace('127.0.0.1', 'localhost'), {});
    expect(unguarded.status).toBe('passed');
    expect(loopback().map((request) => request.path)).toContain('/analytics.js');
    const loopbackBefore = loopback().length;

    const result = await run(storeTestUrl(target), { targetGuard: guardFor(target) });
    expect(result.status).toBe('passed');
    const steps = result.journeys[0]?.steps ?? [];
    expect(steps.map((s) => s.status)).toEqual(Array(6).fill('passed'));
    const openProduct = steps[0];
    expect(openProduct?.message).toBeUndefined();
    expect(openProduct?.details.blockedRequests).toBe(
      `127.0.0.1:${port(target)} (127.0.0.1 is a loopback address (127.0.0.0/8))`,
    );
    // The proxy refused it before connecting: the store saw no request on 127.0.0.1.
    expect(loopback()).toHaveLength(loopbackBefore);
    expect(target.orderAttempts()).toBe(0);
  });

  it("reads a Shopify product's variants through the egress proxy, redirect hops included", async () => {
    const target = await store({
      platform: 'shopify',
      variant: 'variants',
      productEndpoint: 'redirect-to-loopback',
    });
    const loopback = () =>
      target.requests().filter((request) => request.host === `127.0.0.1:${port(target)}`);

    // Control, without a guard: /products/demo-tee.js really redirects to 127.0.0.1.
    const unguarded = await run(target.productUrl.replace('127.0.0.1', 'localhost'), {});
    expect(unguarded.status).toBe('passed');
    expect(loopback().map((request) => request.path)).toContain('/products/demo-tee.js');
    const loopbackBefore = loopback().length;

    const result = await run(storeTestUrl(target), { targetGuard: guardFor(target) });
    expect(result.status).toBe('passed');
    const find = result.journeys[0]?.steps.find((s) => s.name === 'find_add_to_cart');
    expect(find?.details).toMatchObject({
      variantId: '4302',
      // The endpoint's hop was refused, so the product JSON in the page was used.
      variantSource: 'product JSON in the page',
      blockedRequests: `127.0.0.1:${port(target)} (127.0.0.1 is a loopback address (127.0.0.0/8))`,
    });
    expect(loopback()).toHaveLength(loopbackBefore);
    expect(target.cartAdds().at(-1)).toEqual({ variantId: '4302', quantity: 1 });
  });

  it('keeps the message of a step that failed for another reason while a subresource was refused', async () => {
    const target = await store({
      platform: 'shopify',
      variant: 'checkout-404',
      loopbackSubresource: true,
    });
    const result = await run(storeTestUrl(target), { targetGuard: guardFor(target) });
    const journey = result.journeys[0];
    expect(journey?.failedStep).toBe('go_to_checkout');
    const step = journey?.steps.find((s) => s.name === 'go_to_checkout');
    // The 404 failed the step; the refused script on the 404 page did not.
    expect(step?.message).toBe('Checkout returned HTTP 404');
    expect(step?.details.blockedRequests).toContain(`127.0.0.1:${port(target)}`);
  });

  it("names the proxy's connection failure when the store's own host does not resolve", async () => {
    const target = await store({ platform: 'shopify' });
    const result = await run(storeTestUrl(target), {
      targetGuard: guardFor(target, resolveTo({})),
    });
    expect(result.status).toBe('failed');
    const openProduct = result.journeys[0]?.steps[0];
    expect(openProduct?.message).toBe(
      `Product page returned HTTP 502 (store.test:${port(target)}: the host name did not resolve)`,
    );
    expect(openProduct?.details).not.toHaveProperty('blockedRequests');
    expect(target.userAgents()).toEqual([]);
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
    const openProduct = result.journeys[0]?.steps[0];
    expect(openProduct?.message).toBe(
      `Blocked a request to rebind.test:${port(target)}: rebind.test resolves to a private or internal address (Product page returned HTTP 403)`,
    );
    // Nothing returned by GET /runs/:id may show where an internal name points.
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
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
