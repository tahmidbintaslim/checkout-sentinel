import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startFixtureStore,
  type FixturePlatform,
  type FixtureStore,
  type FixtureStoreOptions,
} from '@checkout-sentinel/fixtures';
import {
  RunResultSchema,
  installOrderGuard,
  launchBrowser,
  runJourneys,
  type RunOptions,
  type RunResult,
  type StepName,
} from '@checkout-sentinel/core';

// Every journey here runs against a local fixture store; nothing leaves 127.0.0.1.
let browser: Browser;
let artifactsDir: string;
const stores: FixtureStore[] = [];

beforeAll(async () => {
  browser = await launchBrowser();
  artifactsDir = await mkdtemp(path.join(tmpdir(), 'checkout-sentinel-it-'));
});

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await browser?.close();
  await rm(artifactsDir, { recursive: true, force: true });
});

async function store(options: FixtureStoreOptions): Promise<FixtureStore> {
  const started = await startFixtureStore(options);
  stores.push(started);
  return started;
}

async function run(target: FixtureStore, options: Partial<RunOptions> = {}): Promise<RunResult> {
  const result = await runJourneys({
    url: target.productUrl,
    browser,
    devices: 'both',
    artifactsDir,
    timeouts: { stepMs: 3_000, navigationMs: 10_000 },
    ...options,
  });
  expect(RunResultSchema.safeParse(result).success).toBe(true);
  // The journey must never reach order placement on any fixture.
  expect(target.orderAttempts()).toBe(0);
  return result;
}

function stepStatuses(result: RunResult, device: 'desktop' | 'mobile') {
  const journey = result.journeys.find((j) => j.device === device);
  return Object.fromEntries(journey?.steps.map((s) => [s.name, s.status]) ?? []) as Record<
    StepName,
    string
  >;
}

const ALL_PASSED = {
  open_product: 'passed',
  find_add_to_cart: 'passed',
  add_to_cart: 'passed',
  verify_cart: 'passed',
  go_to_checkout: 'passed',
  checkout_renders: 'passed',
};

describe.each<[Exclude<FixturePlatform, 'generic'>]>([['shopify'], ['woocommerce']])(
  '%s fixture store',
  (platform) => {
    it('passes the full journey on desktop and mobile', async () => {
      const target = await store({ platform });
      const result = await run(target);
      expect(result.status).toBe('passed');
      expect(result.summary).toMatchObject({ journeys: 2, passed: 2, failed: 0 });
      for (const journey of result.journeys) {
        expect(journey.platform).toMatchObject({ detected: platform, used: platform });
        expect(journey.trace).toBeUndefined();
      }
      expect(stepStatuses(result, 'desktop')).toEqual(ALL_PASSED);
      expect(stepStatuses(result, 'mobile')).toEqual(ALL_PASSED);
      const verify = result.journeys[0]?.steps.find((s) => s.name === 'verify_cart');
      expect(verify?.details).toMatchObject({ cartBefore: 0, cartAfter: 1 });
    });

    it('identifies itself with a polite user agent', async () => {
      const target = await store({ platform });
      await run(target, { devices: 'desktop' });
      const agents = target.userAgents();
      expect(agents.length).toBeGreaterThan(0);
      for (const agent of agents) {
        expect(agent).toMatch(
          /checkout-sentinel\/0\.1\.0 \(\+https:\/\/github\.com\/tahmidbintaslim\/checkout-sentinel\)/,
        );
      }
    });

    it('fails only the mobile journey when add to cart is hidden on mobile', async () => {
      const target = await store({ platform, variant: 'mobile-hidden' });
      const result = await run(target);
      expect(result.status).toBe('failed');
      expect(stepStatuses(result, 'desktop')).toEqual(ALL_PASSED);
      const mobile = result.journeys.find((j) => j.device === 'mobile');
      expect(mobile?.failedStep).toBe('find_add_to_cart');
      const failed = mobile?.steps.find((s) => s.name === 'find_add_to_cart');
      expect(failed?.message).toMatch(/hidden or disabled at this viewport/);
      expect(mobile?.steps.slice(2).every((s) => s.status === 'skipped')).toBe(true);
      // Failure artifacts are written to disk.
      expect(failed?.screenshot && existsSync(failed.screenshot)).toBe(true);
      expect(mobile?.trace && existsSync(mobile.trace)).toBe(true);
    });

    it('fails at add_to_cart when the cart endpoint returns 500', async () => {
      const target = await store({ platform, variant: 'cart-500' });
      const result = await run(target, { devices: 'desktop' });
      const journey = result.journeys[0];
      expect(journey?.failedStep).toBe('add_to_cart');
      const step = journey?.steps.find((s) => s.name === 'add_to_cart');
      expect(step?.message).toBe('Cart add request returned HTTP 500');
      expect(step?.failedRequests).toContainEqual(
        expect.objectContaining({ kind: 'http_error', status: 500 }),
      );
    });

    it('fails at go_to_checkout when checkout returns 404', async () => {
      const target = await store({ platform, variant: 'checkout-404' });
      const result = await run(target, { devices: 'mobile' });
      const journey = result.journeys[0];
      expect(journey?.failedStep).toBe('go_to_checkout');
      expect(journey?.steps.find((s) => s.name === 'go_to_checkout')?.message).toBe(
        'Checkout returned HTTP 404',
      );
      expect(stepStatuses(result, 'mobile').verify_cart).toBe('passed');
    });

    it('flags slow steps without failing the run', async () => {
      const target = await store({ platform, checkoutDelayMs: 700 });
      const result = await run(target, { devices: 'desktop', slowStepMs: 500 });
      expect(result.status).toBe('passed');
      const slow = result.journeys[0]?.steps.filter((s) => s.slow).map((s) => s.name);
      expect(slow).toContain('go_to_checkout');
      expect(result.summary.slowSteps).toBeGreaterThanOrEqual(1);
    });
  },
);

function stepOf(result: RunResult, device: 'desktop' | 'mobile', name: StepName) {
  return result.journeys.find((j) => j.device === device)?.steps.find((s) => s.name === name);
}

describe('variant selection', () => {
  it('Shopify: chooses the first available variant in the theme picker when the default is sold out', async () => {
    const target = await store({ platform: 'shopify', variant: 'variants' });
    const result = await run(target);
    expect(result.status).toBe('passed');
    for (const device of ['desktop', 'mobile'] as const) {
      expect(stepStatuses(result, device)).toEqual(ALL_PASSED);
      expect(stepOf(result, device, 'find_add_to_cart')?.details).toMatchObject({
        variant: 'S / White',
        variantId: '4302',
        variantSelectedBy: 'theme options',
        variantSource: '/products/demo-tee.js',
        availableVariants: 2,
        totalVariants: 4,
      });
    }
    // One item of the chosen variant per journey, never more than one.
    expect(target.cartAdds()).toEqual([
      { variantId: '4302', quantity: 1 },
      { variantId: '4302', quantity: 1 },
    ]);
  });

  it('Shopify: keeps the variant named in the URL when it is available', async () => {
    const target = await store({ platform: 'shopify', variant: 'variants' });
    const result = await run(target, {
      url: `${target.productUrl}?variant=4303`,
      devices: 'desktop',
    });
    expect(result.status).toBe('passed');
    expect(stepOf(result, 'desktop', 'find_add_to_cart')?.details).toMatchObject({
      variant: 'M / Black',
      variantId: '4303',
    });
    expect(target.cartAdds()).toEqual([{ variantId: '4303', quantity: 1 }]);
  });

  it('Shopify: reads the product JSON in the page when /products/<handle>.js does not answer', async () => {
    const target = await store({
      platform: 'shopify',
      variant: 'variants',
      productEndpoint: false,
    });
    const result = await run(target, { devices: 'desktop' });
    expect(result.status).toBe('passed');
    expect(stepOf(result, 'desktop', 'find_add_to_cart')?.details).toMatchObject({
      variantId: '4302',
      variantSource: 'product JSON in the page',
    });
  });

  it('Shopify: sets the form hidden id when the theme picker is not one it recognises', async () => {
    const target = await store({
      platform: 'shopify',
      variant: 'variants',
      variantPickers: 'custom',
    });
    const result = await run(target);
    expect(result.status).toBe('passed');
    for (const device of ['desktop', 'mobile'] as const) {
      expect(stepOf(result, device, 'find_add_to_cart')?.details).toMatchObject({
        variantId: '4302',
        variantSelectedBy: 'hidden input',
      });
    }
    expect(target.cartAdds().map((add) => add.variantId)).toEqual(['4302', '4302']);
  });

  it('Shopify: fails with "no available variant" when every variant is sold out', async () => {
    const target = await store({ platform: 'shopify', variant: 'variants-sold-out' });
    const result = await run(target);
    expect(result.status).toBe('failed');
    for (const device of ['desktop', 'mobile'] as const) {
      const journey = result.journeys.find((j) => j.device === device);
      expect(journey?.failedStep).toBe('find_add_to_cart');
      const find = stepOf(result, device, 'find_add_to_cart');
      expect(find?.message).toBe('No available variant: all 4 variants are sold out');
      expect(find?.details).toMatchObject({ availableVariants: 0, totalVariants: 4 });
      expect(journey?.steps.slice(2).every((s) => s.status === 'skipped')).toBe(true);
    }
    expect(target.cartAdds()).toEqual([]);
  });

  it('Shopify: a product without options needs no choice', async () => {
    const target = await store({ platform: 'shopify' });
    const result = await run(target, { devices: 'desktop' });
    expect(result.status).toBe('passed');
    const details = stepOf(result, 'desktop', 'find_add_to_cart')?.details ?? {};
    expect(details).not.toHaveProperty('variant');
    expect(target.cartAdds()).toEqual([{ variantId: '4242', quantity: 1 }]);
  });

  it('WooCommerce: chooses the first variation in stock and waits for the button to enable', async () => {
    const target = await store({ platform: 'woocommerce', variant: 'variants' });
    const result = await run(target);
    expect(result.status).toBe('passed');
    for (const device of ['desktop', 'mobile'] as const) {
      expect(stepStatuses(result, device)).toEqual(ALL_PASSED);
      expect(stepOf(result, device, 'find_add_to_cart')?.details).toMatchObject({
        variant: 'Size: Small, Color: Grey',
        variantId: '102',
        variantSelectedBy: 'theme options',
        variantSource: 'data-product_variations',
        availableVariants: 2,
        totalVariants: 3,
      });
    }
    expect(target.cartAdds()).toEqual([
      { variantId: '102', quantity: 1 },
      { variantId: '102', quantity: 1 },
    ]);
  });

  it('WooCommerce: tries combinations in order when variations load over AJAX', async () => {
    const target = await store({
      platform: 'woocommerce',
      variant: 'variants',
      ajaxVariations: true,
    });
    const result = await run(target, { devices: 'desktop' });
    expect(result.status).toBe('passed');
    expect(stepOf(result, 'desktop', 'find_add_to_cart')?.details).toMatchObject({
      variant: 'Size: Small, Color: Grey',
      variantId: '102',
      variantSource: 'wc-ajax=get_variation',
    });
    expect(target.cartAdds()).toEqual([{ variantId: '102', quantity: 1 }]);
  });

  it("WooCommerce: waits for WooCommerce's show_variation when the preselected default is out of stock", async () => {
    // WooCommerce 9.8 and later set variation_id at once and update the button 300 ms later,
    // so the button still says "unavailable" (Small / Blue) right after Grey is chosen.
    const target = await store({
      platform: 'woocommerce',
      variant: 'variants',
      wooDefaultAttributes: { attribute_pa_size: 'small', attribute_pa_color: 'blue' },
    });
    const result = await run(target);
    expect(result.status).toBe('passed');
    for (const device of ['desktop', 'mobile'] as const) {
      expect(stepOf(result, device, 'find_add_to_cart')?.details).toMatchObject({
        variant: 'Size: Small, Color: Grey',
        variantId: '102',
        strategy: 'woo-single-add-to-cart-button',
      });
    }
    expect(target.cartAdds()).toEqual([
      { variantId: '102', quantity: 1 },
      { variantId: '102', quantity: 1 },
    ]);
  });

  it('WooCommerce: over AJAX, a combination tried after an out of stock one is judged on its own answer', async () => {
    const target = await store({
      platform: 'woocommerce',
      variant: 'variants',
      ajaxVariations: true,
      wooInStock: [102],
    });
    const result = await run(target);
    expect(result.status).toBe('passed');
    for (const device of ['desktop', 'mobile'] as const) {
      expect(stepOf(result, device, 'find_add_to_cart')?.details).toMatchObject({
        variant: 'Size: Small, Color: Grey',
        variantId: '102',
        variantSource: 'wc-ajax=get_variation',
      });
    }
    expect(target.cartAdds()).toEqual([
      { variantId: '102', quantity: 1 },
      { variantId: '102', quantity: 1 },
    ]);
  });

  it('WooCommerce: over AJAX, starts from a preselected default that is out of stock', async () => {
    const target = await store({
      platform: 'woocommerce',
      variant: 'variants',
      ajaxVariations: true,
      wooInStock: [102],
      wooDefaultAttributes: { attribute_pa_size: 'small', attribute_pa_color: 'blue' },
    });
    const result = await run(target, { devices: 'desktop' });
    expect(result.status).toBe('passed');
    expect(stepOf(result, 'desktop', 'find_add_to_cart')?.details).toMatchObject({
      variant: 'Size: Small, Color: Grey',
      variantId: '102',
    });
    expect(target.cartAdds()).toEqual([{ variantId: '102', quantity: 1 }]);
  });

  it.each([[false], [true]])(
    "WooCommerce: a theme's own variation script without WooCommerce's events (AJAX %s)",
    async (ajaxVariations) => {
      const target = await store({
        platform: 'woocommerce',
        variant: 'variants',
        variationScript: 'theme',
        ajaxVariations,
        wooInStock: [102],
        wooDefaultAttributes: { attribute_pa_size: 'small', attribute_pa_color: 'blue' },
      });
      const result = await run(target, {
        devices: 'desktop',
        timeouts: { stepMs: 10_000, navigationMs: 10_000 },
      });
      expect(result.status).toBe('passed');
      expect(stepOf(result, 'desktop', 'find_add_to_cart')?.details).toMatchObject({
        variant: 'Size: Small, Color: Grey',
        variantId: '102',
      });
      expect(target.cartAdds()).toEqual([{ variantId: '102', quantity: 1 }]);
    },
  );

  it('WooCommerce: waits for a slow variation lookup instead of calling the product sold out', async () => {
    const target = await store({
      platform: 'woocommerce',
      variant: 'variants',
      ajaxVariations: true,
      variationLookupDelayMs: 2_500,
    });
    const result = await run(target, {
      devices: 'desktop',
      timeouts: { stepMs: 15_000, navigationMs: 10_000 },
    });
    expect(result.status).toBe('passed');
    expect(stepOf(result, 'desktop', 'find_add_to_cart')?.details).toMatchObject({
      variant: 'Size: Small, Color: Grey',
      variantId: '102',
    });
    expect(target.cartAdds()).toEqual([{ variantId: '102', quantity: 1 }]);
  });

  it('WooCommerce: a lookup that does not answer within the step is not reported as sold out', async () => {
    const target = await store({
      platform: 'woocommerce',
      variant: 'variants',
      ajaxVariations: true,
      variationLookupDelayMs: 6_000,
    });
    const result = await run(target, { devices: 'desktop' });
    expect(result.journeys[0]?.failedStep).toBe('find_add_to_cart');
    const find = stepOf(result, 'desktop', 'find_add_to_cart');
    expect(find?.message).toBe(
      'The variation lookup did not answer within the step timeout (0 of 4 option combinations answered out of stock)',
    );
    expect(find?.details).toMatchObject({ combinationsTried: 1, combinationsOutOfStock: 0 });
    expect(target.cartAdds()).toEqual([]);
  });

  it('WooCommerce: a class-disabled button counts as disabled for every strategy', async () => {
    // Attributes drawn as radio buttons are not chosen, so the button keeps its class
    // "disabled". The generic strategy finds the same button by its name, "Add to cart".
    const target = await store({
      platform: 'woocommerce',
      variant: 'variants',
      wooAttributeInputs: 'radio',
    });
    const result = await run(target);
    expect(result.status).toBe('failed');
    for (const device of ['desktop', 'mobile'] as const) {
      const journey = result.journeys.find((j) => j.device === device);
      expect(journey?.failedStep).toBe('find_add_to_cart');
      expect(stepOf(result, device, 'find_add_to_cart')?.message).toBe(
        'Add-to-cart control exists (button.single_add_to_cart_button) but is hidden or disabled at this viewport',
      );
    }
    expect(target.cartAdds()).toEqual([]);
  });

  it('WooCommerce: fails with "no available variant" when every variation is out of stock', async () => {
    const target = await store({ platform: 'woocommerce', variant: 'variants-sold-out' });
    const result = await run(target);
    expect(result.status).toBe('failed');
    for (const device of ['desktop', 'mobile'] as const) {
      const journey = result.journeys.find((j) => j.device === device);
      expect(journey?.failedStep).toBe('find_add_to_cart');
      expect(stepOf(result, device, 'find_add_to_cart')?.message).toBe(
        'No available variant: all 3 variations are out of stock',
      );
    }
    expect(target.cartAdds()).toEqual([]);
  });

  it('WooCommerce: fails with "no available variant" over AJAX when no combination is in stock', async () => {
    const target = await store({
      platform: 'woocommerce',
      variant: 'variants-sold-out',
      ajaxVariations: true,
    });
    const result = await run(target, { devices: 'desktop' });
    expect(result.journeys[0]?.failedStep).toBe('find_add_to_cart');
    expect(stepOf(result, 'desktop', 'find_add_to_cart')?.message).toBe(
      'No available variant: none of the 4 option combinations is in stock',
    );
    expect(target.cartAdds()).toEqual([]);
  });
});

describe('JavaScript errors', () => {
  it('Shopify: an app script that throws before the AJAX handler binds breaks add to cart', async () => {
    const target = await store({ platform: 'shopify', variant: 'js-error' });
    const result = await run(target, { devices: 'desktop' });
    const journey = result.journeys[0];
    expect(result.status).toBe('failed');
    expect(journey?.failedStep).toBe('verify_cart');
    expect(journey?.steps.find((s) => s.name === 'verify_cart')?.message).toMatch(
      /Cart did not change/,
    );
    const pageErrors = journey?.steps.flatMap((s) => s.pageErrors) ?? [];
    expect(pageErrors.some((e) => /reading 'init'/.test(e.message))).toBe(true);
  });

  it('WooCommerce: a throwing script that does not break checkout is reported, not failed', async () => {
    const target = await store({ platform: 'woocommerce', variant: 'js-error' });
    const result = await run(target, { devices: 'desktop' });
    expect(result.status).toBe('passed');
    const pageErrors = result.journeys[0]?.steps.flatMap((s) => s.pageErrors) ?? [];
    expect(pageErrors.length).toBeGreaterThan(0);
  });

  it('WooCommerce: failOnPageErrors turns that into a failure', async () => {
    const target = await store({ platform: 'woocommerce', variant: 'js-error' });
    const result = await run(target, { devices: 'desktop', failOnPageErrors: true });
    expect(result.status).toBe('failed');
    expect(result.journeys[0]?.failedStep).toBe('open_product');
    expect(result.journeys[0]?.steps[0]?.message).toMatch(/uncaught exception/);
  });
});

describe('platform handling', () => {
  it('uses the requested platform over detection', async () => {
    const target = await store({ platform: 'shopify' });
    const result = await run(target, { devices: 'desktop', platform: 'woocommerce' });
    expect(result.journeys[0]?.platform).toMatchObject({
      detected: 'shopify',
      used: 'woocommerce',
    });
    expect(result.status).toBe('failed');
  });

  it('falls back to the accessible name on an unknown platform and skips cart verification', async () => {
    const target = await store({ platform: 'generic' });
    const result = await run(target, { devices: 'desktop' });
    const journey = result.journeys[0];
    expect(result.status).toBe('passed');
    expect(journey?.platform?.detected).toBe('unknown');
    const find = journey?.steps.find((s) => s.name === 'find_add_to_cart');
    expect(find?.details.strategy).toBe('generic-button-name');
    expect(stepStatuses(result, 'desktop').verify_cart).toBe('skipped');
  });

  it('reports an error status for an invalid URL without launching a browser', async () => {
    const result = await runJourneys({ url: 'ftp://example.test/file' });
    expect(result.status).toBe('error');
    expect(result.error?.message).toMatch(/http and https/);
    expect(result.journeys).toEqual([]);
  });
});

describe('order guard', () => {
  it('aborts order placement requests and lets ordinary requests through', async () => {
    const target = await store({ platform: 'shopify' });
    const context = await browser.newContext();
    await installOrderGuard(context);
    const page = await context.newPage();
    await page.goto(target.productUrl);
    const outcome = await page.evaluate(async () => {
      const attempt = async (url: string) => {
        try {
          const response = await fetch(url, { method: 'POST' });
          return response.status;
        } catch {
          return 'blocked';
        }
      };
      return {
        processing: await attempt('/checkouts/cn/fixture-checkout-xyz/processing'),
        cartAdd: await attempt('/cart/add.js'),
      };
    });
    await context.close();
    expect(outcome).toEqual({ processing: 'blocked', cartAdd: 200 });
    expect(target.orderAttempts()).toBe(0);
  });
});
