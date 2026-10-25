import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { readCart } from './cart.js';
import { collectPageSignals, describeSignals, detectPlatform } from './detect.js';
import { DEVICE_PROFILES, resolveDevices, type DeviceSelection } from './devices.js';
import { EgressProxy, targetOfUrl, type EgressEvent } from './egress-proxy.js';
import { TimeoutsSchema, type Timeouts } from './monitor.js';
import { StepRecorder } from './recorder.js';
import { installOrderGuard } from './safety.js';
import {
  RESULT_SCHEMA_VERSION,
  RunResultSchema,
  STEP_NAMES,
  type DeviceName,
  type Detection,
  type JourneyResult,
  type Platform,
  type RequestedPlatform,
  type RunResult,
  type StepName,
  type StepResult,
} from './schema.js';
import type { TargetGuard } from './ssrf.js';
import {
  CHECKOUT_TARGETS,
  addToCartStrategies,
  isCartAddRequest,
  matchesCheckoutUrl,
  type AddToCartStrategy,
} from './selectors.js';
import { buildUserAgent } from './user-agent.js';
import { TOOL_NAME, VERSION } from './version.js';

export interface RunOptions {
  url: string;
  platform?: RequestedPlatform;
  devices?: DeviceSelection | readonly DeviceName[];
  timeouts?: Partial<Timeouts>;
  /** A passing step slower than this is flagged as slow. */
  slowStepMs?: number;
  /** Where failure screenshots and traces go. Without it, no artifacts are written. */
  artifactsDir?: string;
  /** Reuse a browser (the worker keeps one per process). When omitted, one is launched and closed. */
  browser?: Browser;
  executablePath?: string;
  /** Fail a step when the page throws an uncaught exception during it, even if the journey works. */
  failOnPageErrors?: boolean;
  /** Contact URL placed in the user agent; defaults to the project URL. */
  userAgentContactUrl?: string;
  /** Called after each step, for progress output. */
  onStep?: (device: DeviceName, step: StepResult) => void;
  runId?: string;
  /**
   * SSRF protection. The product URL is checked (with DNS) before a browser is used, and
   * unless the guard allows private targets, every connection the journey opens goes through
   * an egress proxy that refuses private addresses, redirect hops included. Without a guard
   * the journey can reach any address (the CLI's default, since it runs on the user's machine).
   */
  targetGuard?: TargetGuard;
}

export const DEFAULT_SLOW_STEP_MS = 8_000;
/** How long a matched-but-hidden add-to-cart control may take to become visible. */
const HIDDEN_CONTROL_GRACE_MS = 2_000;
const POLL_INTERVAL_MS = 250;

/** A step failure with a merchant-readable message. Anything else thrown is reported as is. */
export class StepFailure extends Error {
  constructor(
    message: string,
    readonly details: StepResult['details'] = {},
  ) {
    super(message);
    this.name = 'StepFailure';
  }
}

interface JourneyState {
  page: Page;
  context: BrowserContext;
  origin: string;
  detection: Detection | null;
  platform: Platform;
  addToCart: { locator: Locator; strategy: AddToCartStrategy } | null;
  cartBefore: number | null;
  cartReadable: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}

function fileSafe(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '-');
}

async function findAddToCart(
  page: Page,
  platform: Platform,
  timeoutMs: number,
): Promise<{ locator: Locator; strategy: AddToCartStrategy; hiddenMatches: number }> {
  const strategies = addToCartStrategies(platform);
  const started = Date.now();
  let hiddenSince: number | null = null;
  let hiddenStrategy: AddToCartStrategy | null = null;

  while (true) {
    let hiddenCount = 0;
    for (const strategy of strategies) {
      const locator =
        strategy.kind === 'css'
          ? page.locator(strategy.selector)
          : page.getByRole('button', { name: strategy.name });
      const count = await locator.count();
      for (let i = 0; i < count; i += 1) {
        const candidate = locator.nth(i);
        if ((await candidate.isVisible()) && (await candidate.isEnabled())) {
          return { locator: candidate, strategy, hiddenMatches: hiddenCount };
        }
        hiddenCount += 1;
        hiddenStrategy ??= strategy;
      }
    }

    const now = Date.now();
    if (hiddenCount > 0) hiddenSince ??= now;
    const hiddenTooLong = hiddenSince !== null && now - hiddenSince >= HIDDEN_CONTROL_GRACE_MS;
    if (hiddenTooLong || now - started >= timeoutMs) {
      if (hiddenStrategy) {
        throw new StepFailure(
          `Add-to-cart control exists (${hiddenStrategy.description}) but is hidden or disabled at this viewport`,
          { hiddenMatches: hiddenCount, strategy: hiddenStrategy.id },
        );
      }
      throw new StepFailure('No add-to-cart control found on the product page', {
        strategiesTried: strategies.map((s) => s.id).join(', '),
      });
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function waitForCartCount(
  state: JourneyState,
  timeoutMs: number,
): Promise<{ count: number | null; source: string }> {
  const deadline = Date.now() + timeoutMs;
  let reading = await readCart(state.context.request, state.origin, state.platform);
  while (
    reading.count !== null &&
    reading.count <= (state.cartBefore ?? 0) &&
    Date.now() < deadline
  ) {
    await sleep(500);
    reading = await readCart(state.context.request, state.origin, state.platform);
  }
  return reading;
}

type StepBody = (state: JourneyState) => Promise<{
  details?: StepResult['details'];
  message?: string;
  status?: 'passed' | 'skipped';
}>;

function buildSteps(
  options: Required<Pick<RunOptions, 'url'>> & ResolvedOptions,
): Record<StepName, StepBody> {
  const { timeouts, requestedPlatform } = options;
  return {
    async open_product(state) {
      const response = await state.page.goto(options.url, {
        waitUntil: 'domcontentloaded',
        timeout: timeouts.navigationMs,
      });
      if (!response) throw new StepFailure('Product page did not return a response');
      const finalUrl = state.page.url();
      const details = { httpStatus: response.status(), finalUrl };
      if (response.status() >= 400) {
        throw new StepFailure(`Product page returned HTTP ${response.status()}`, details);
      }
      if (new URL(finalUrl).pathname === '/password') {
        throw new StepFailure('Store is password protected (redirected to /password)', details);
      }
      // Third-party scripts can hold the load event open; detection only needs the DOM.
      await state.page
        .waitForLoadState('load', { timeout: Math.min(timeouts.navigationMs, 10_000) })
        .catch(() => undefined);
      const signals = await collectPageSignals(state.page, response.headers());
      const outcome = detectPlatform(signals);
      state.platform = requestedPlatform === 'auto' ? outcome.platform : requestedPlatform;
      state.detection = {
        detected: outcome.platform,
        used: state.platform,
        confidence: outcome.confidence,
        signals: describeSignals(outcome.signals),
      };
      return {
        details: {
          ...details,
          detectedPlatform: outcome.platform,
          platformUsed: state.platform,
          confidence: outcome.confidence,
        },
      };
    },

    async find_add_to_cart(state) {
      const found = await findAddToCart(state.page, state.platform, timeouts.stepMs);
      state.addToCart = { locator: found.locator, strategy: found.strategy };
      return {
        details: { strategy: found.strategy.id, matched: found.strategy.description },
      };
    },

    async add_to_cart(state) {
      if (!state.addToCart) throw new StepFailure('No add-to-cart control to click');
      const before = await readCart(state.context.request, state.origin, state.platform);
      state.cartBefore = before.count;
      state.cartReadable = before.count !== null;

      const cartResponse = state.page
        .waitForResponse(
          (response) => {
            const request = response.request();
            return isCartAddRequest(response.url(), request.method(), request.postData());
          },
          { timeout: timeouts.stepMs },
        )
        .catch(() => null);
      await state.addToCart.locator.click({ timeout: timeouts.stepMs });
      const response = await cartResponse;
      await state.page
        .waitForLoadState('domcontentloaded', { timeout: timeouts.navigationMs })
        .catch(() => undefined);

      const details: StepResult['details'] = {
        cartBefore: before.count,
        cartRequestSeen: response !== null,
      };
      if (response) {
        details.cartRequestStatus = response.status();
        details.cartRequestUrl = response.url();
        if (response.status() >= 400) {
          throw new StepFailure(`Cart add request returned HTTP ${response.status()}`, details);
        }
      }
      return { details };
    },

    async verify_cart(state) {
      const reading = await waitForCartCount(state, timeouts.stepMs);
      const details = {
        cartBefore: state.cartBefore,
        cartAfter: reading.count,
        source: reading.source,
      };
      if (reading.count === null) {
        if (state.platform === 'unknown') {
          return {
            status: 'skipped',
            message: 'No known cart API on this store; cart contents were not verified',
            details,
          };
        }
        throw new StepFailure(`Could not read the cart (${reading.source})`, details);
      }
      if (reading.count <= (state.cartBefore ?? 0)) {
        throw new StepFailure(
          `Cart did not change after clicking add to cart (${state.cartBefore ?? 0} -> ${reading.count} items)`,
          details,
        );
      }
      return { details };
    },

    async go_to_checkout(state) {
      const target = CHECKOUT_TARGETS[state.platform];
      const response = await state.page.goto(new URL(target.path, state.origin).toString(), {
        waitUntil: 'domcontentloaded',
        timeout: timeouts.navigationMs,
      });
      const details = {
        httpStatus: response?.status() ?? null,
        finalUrl: state.page.url(),
      };
      if (!response) throw new StepFailure('Checkout did not return a response', details);
      if (response.status() >= 400) {
        throw new StepFailure(`Checkout returned HTTP ${response.status()}`, details);
      }
      return { details };
    },

    async checkout_renders(state) {
      const finalUrl = state.page.url();
      const finalPath = new URL(finalUrl).pathname;
      if (/\/cart\/?$/.test(finalPath)) {
        throw new StepFailure(
          'Checkout redirected back to the cart (the cart may have been emptied or checkout is blocked)',
          { finalUrl },
        );
      }
      if (!matchesCheckoutUrl(state.platform, finalUrl)) {
        throw new StepFailure(`Checkout ended on an unexpected URL: ${finalUrl}`, { finalUrl });
      }
      const markers = CHECKOUT_TARGETS[state.platform].markers;
      try {
        await state.page.locator(markers).first().waitFor({
          state: 'visible',
          timeout: timeouts.stepMs,
        });
      } catch {
        throw new StepFailure('Checkout page loaded but no checkout form or email field rendered', {
          finalUrl,
          markers,
        });
      }
      return { details: { finalUrl } };
    },
  };
}

interface ResolvedOptions {
  requestedPlatform: RequestedPlatform;
  timeouts: Timeouts;
  slowStepMs: number;
}

/** At most this many blocked requests are listed in one step's details. */
const MAX_BLOCKED_LISTED = 10;

/**
 * Folds the egress proxy's events for one step into its result. Every blocked request is
 * listed in the details. A failed step's message also names a block or connection failure,
 * which Chromium would otherwise report only as a tunnel or HTTP error, but only one that can
 * have failed the step: on a main-frame navigation of this step (redirect hops included) or
 * on the store's own host and port, which the cart reads use. A refused image, script or
 * frame does not fail a step, so it does not replace the step's own message either.
 */
function applyEgressEvents(
  status: StepResult['status'],
  message: string | undefined,
  details: StepResult['details'],
  events: readonly EgressEvent[],
  causes: ReadonlySet<string>,
): string | undefined {
  const blocked = events.filter((event) => event.outcome === 'blocked');
  if (blocked.length > 0) {
    const listed = blocked.slice(0, MAX_BLOCKED_LISTED).map((e) => `${e.target} (${e.reason})`);
    if (blocked.length > MAX_BLOCKED_LISTED) {
      listed.push(`and ${blocked.length - MAX_BLOCKED_LISTED} more`);
    }
    details.blockedRequests = listed.join('; ');
  }
  if (status !== 'failed') return message;
  const blockedCause = blocked.find((event) => causes.has(event.target));
  if (blockedCause) {
    return `Blocked a request to ${blockedCause.target}: ${blockedCause.reason}${message ? ` (${message})` : ''}`;
  }
  const failedCause = events.find(
    (event) => event.outcome === 'failed' && causes.has(event.target),
  );
  if (failedCause) {
    return `${message ?? 'Step failed'} (${failedCause.target}: ${failedCause.reason})`;
  }
  return message;
}

async function runJourney(
  browser: Browser,
  device: DeviceName,
  runId: string,
  options: RunOptions & ResolvedOptions,
  egress?: EgressProxy,
): Promise<JourneyResult> {
  const profile = DEVICE_PROFILES[device];
  const startedAt = new Date();
  const context = await browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    userAgent: buildUserAgent(profile, options.userAgentContactUrl),
    locale: 'en-US',
    // A service worker could answer from cache and hide a broken origin.
    serviceWorkers: 'block',
    ...(egress ? { proxy: { server: egress.url } } : {}),
  });
  context.setDefaultTimeout(options.timeouts.stepMs);
  context.setDefaultNavigationTimeout(options.timeouts.navigationMs);

  const recorder = new StepRecorder();
  await installOrderGuard(context);

  const tracing = options.artifactsDir !== undefined;
  if (tracing) await context.tracing.start({ screenshots: true, snapshots: true });

  const page = await context.newPage();
  recorder.attach(page);
  // Where the main frame navigated during the current step, redirect hops included. With the
  // store's own target, these are the connections whose refusal can fail a step.
  const storeTarget = targetOfUrl(options.url);
  const causes = new Set<string>();
  const resetCauses = () => {
    causes.clear();
    if (storeTarget) causes.add(storeTarget);
  };
  if (egress) {
    page.on('request', (request) => {
      if (!request.isNavigationRequest()) return;
      try {
        if (request.frame() !== page.mainFrame()) return;
      } catch {
        // Playwright has no frame for service worker requests; those are not navigations here.
        return;
      }
      const target = targetOfUrl(request.url());
      if (target) causes.add(target);
    });
  }
  const state: JourneyState = {
    page,
    context,
    origin: new URL(options.url).origin,
    detection: null,
    platform: options.requestedPlatform === 'auto' ? 'unknown' : options.requestedPlatform,
    addToCart: null,
    cartBefore: null,
    cartReadable: false,
  };

  const steps = buildSteps(options);
  const results: StepResult[] = [];
  let failedStep: StepName | undefined;
  const artifactBase = tracing
    ? path.join(options.artifactsDir as string, fileSafe(runId))
    : undefined;
  if (artifactBase) await mkdir(artifactBase, { recursive: true });

  // Events from context setup (browser background traffic) belong to no step.
  egress?.take();

  let trace: string | undefined;
  try {
    for (const name of STEP_NAMES) {
      const stepStarted = new Date();
      if (failedStep) {
        results.push({
          name,
          status: 'skipped',
          startedAt: stepStarted.toISOString(),
          durationMs: 0,
          slow: false,
          message: `Skipped because ${failedStep} failed`,
          details: {},
          consoleErrors: [],
          pageErrors: [],
          failedRequests: [],
        });
        continue;
      }

      recorder.begin(name);
      resetCauses();
      const t0 = performance.now();
      let status: StepResult['status'] = 'passed';
      let message: string | undefined;
      let details: StepResult['details'] = {};
      try {
        const outcome = await steps[name](state);
        details = outcome.details ?? {};
        message = outcome.message;
        status = outcome.status ?? 'passed';
      } catch (error) {
        status = 'failed';
        message = errorMessage(error);
        if (error instanceof StepFailure) details = error.details;
      }
      const durationMs = Math.round(performance.now() - t0);
      const events = recorder.take(name);
      if (egress) {
        message = applyEgressEvents(status, message, details, egress.take(), causes);
      }
      if (status === 'passed' && options.failOnPageErrors && events.pageErrors.length > 0) {
        status = 'failed';
        message = `Page threw ${events.pageErrors.length} uncaught exception(s): ${events.pageErrors[0]?.message ?? ''}`;
      }

      const result: StepResult = {
        name,
        status,
        startedAt: stepStarted.toISOString(),
        durationMs,
        slow: status === 'passed' && durationMs > options.slowStepMs,
        ...(message !== undefined ? { message } : {}),
        details,
        ...events,
      };

      if (status === 'failed') {
        failedStep = name;
        if (artifactBase) {
          const screenshot = path.join(artifactBase, `${device}-${name}.png`);
          try {
            await page.screenshot({ path: screenshot, timeout: 10_000 });
            result.screenshot = screenshot;
          } catch {
            // A crashed page cannot be captured; the trace still has the timeline.
          }
        }
      }
      results.push(result);
      options.onStep?.(device, result);
    }
  } finally {
    if (tracing) {
      if (failedStep && artifactBase) {
        trace = path.join(artifactBase, `${device}-trace.zip`);
        await context.tracing.stop({ path: trace }).catch(() => {
          trace = undefined;
        });
      } else {
        await context.tracing.stop().catch(() => undefined);
      }
    }
    await context.close().catch(() => undefined);
  }

  return {
    device,
    status: failedStep ? 'failed' : 'passed',
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    platform: state.detection,
    ...(failedStep ? { failedStep } : {}),
    steps: results,
    ...(trace ? { trace } : {}),
  };
}

function summarize(journeys: JourneyResult[]): RunResult['summary'] {
  return {
    journeys: journeys.length,
    passed: journeys.filter((j) => j.status === 'passed').length,
    failed: journeys.filter((j) => j.status === 'failed').length,
    slowSteps: journeys.reduce((sum, j) => sum + j.steps.filter((s) => s.slow).length, 0),
  };
}

/**
 * Runs the product -> cart -> checkout journey once per device, one after another, each in
 * its own fresh browser context (clean cookies and cart). Journeys never run in parallel
 * against the same store, and nothing on the checkout page is filled in or submitted.
 */
export async function runJourneys(options: RunOptions): Promise<RunResult> {
  const runId = options.runId ?? randomUUID();
  const startedAt = new Date();
  const requestedPlatform = options.platform ?? 'auto';
  const resolved: ResolvedOptions = {
    requestedPlatform,
    timeouts: TimeoutsSchema.parse(options.timeouts ?? {}),
    slowStepMs: options.slowStepMs ?? DEFAULT_SLOW_STEP_MS,
  };
  const devices = resolveDevices(options.devices ?? 'both');

  const finish = (journeys: JourneyResult[], error?: string): RunResult => {
    const finishedAt = new Date();
    const summary = summarize(journeys);
    const result: RunResult = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      tool: { name: TOOL_NAME, version: VERSION },
      runId,
      url: options.url,
      requestedPlatform,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      status: error ? 'error' : summary.failed > 0 ? 'failed' : 'passed',
      ...(error ? { error: { message: error } } : {}),
      summary,
      journeys,
    };
    // Validating our own output keeps the published schema honest.
    return RunResultSchema.parse(result);
  };

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(options.url);
  } catch {
    return finish([], `Invalid URL: ${options.url}`);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return finish([], `Only http and https URLs are supported, got ${parsedUrl.protocol}`);
  }

  const guard = options.targetGuard;
  if (guard) {
    // DNS may have changed since the URL was accepted; this is the use-time check. A name that
    // does not resolve is left to the journey, which then fails at open_product like any
    // shopper would, instead of being reported as a run error.
    const verdict = await guard.checkUrl(parsedUrl, 'store');
    if (!verdict.allowed) return finish([], `Target blocked: ${verdict.reason}`);
  }

  let browser = options.browser;
  const ownsBrowser = browser === undefined;
  try {
    browser ??= await launchBrowser({
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    });
  } catch (error) {
    return finish([], `Browser failed to launch: ${errorMessage(error)}`);
  }

  const journeys: JourneyResult[] = [];
  let egress: EgressProxy | undefined;
  try {
    if (guard && !guard.permissive) {
      egress = await EgressProxy.start(guard, { connectTimeoutMs: resolved.timeouts.navigationMs });
    }
    for (const device of devices) {
      journeys.push(await runJourney(browser, device, runId, { ...options, ...resolved }, egress));
    }
  } catch (error) {
    return finish(journeys, `Journey aborted: ${errorMessage(error)}`);
  } finally {
    await egress?.close().catch(() => undefined);
    if (ownsBrowser) await browser.close().catch(() => undefined);
  }
  return finish(journeys);
}
