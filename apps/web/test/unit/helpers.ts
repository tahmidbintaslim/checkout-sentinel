import { flushPromises, mount, type ComponentMountingOptions } from '@vue/test-utils';
import { vi } from 'vitest';
import { defineComponent, h, type Component } from 'vue';
import { RouterView, createMemoryHistory } from 'vue-router';
import type { ApiClient } from '../../src/api/client';
import type { Monitor, RunDetail } from '../../src/api/types';
import { apiKey } from '../../src/composables/api';
import { createAppRouter } from '../../src/router';

export type FakeApi = { [K in keyof ApiClient]: ReturnType<typeof vi.fn> };

/** An API client whose every method is a mock; tests set the answers they need. */
export function fakeApi(overrides: Partial<Record<keyof ApiClient, unknown>> = {}): FakeApi {
  const reject = (name: string) =>
    vi.fn(async () => {
      throw new Error(`unexpected call: ${name}`);
    });
  const api = {
    listMonitors: reject('listMonitors'),
    getMonitor: reject('getMonitor'),
    createMonitor: reject('createMonitor'),
    updateMonitor: reject('updateMonitor'),
    deleteMonitor: reject('deleteMonitor'),
    runNow: reject('runNow'),
    listRuns: reject('listRuns'),
    getRun: reject('getRun'),
    listAlerts: reject('listAlerts'),
    getArtifact: reject('getArtifact'),
  } as FakeApi;
  for (const [name, impl] of Object.entries(overrides)) {
    api[name as keyof ApiClient] =
      typeof impl === 'function' ? vi.fn(impl as never) : vi.fn(async () => impl);
  }
  return api;
}

/** Mounts the real router at `path`, so views get their route params as in the app. */
export async function mountAt(path: string, api: FakeApi) {
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const Root = defineComponent({ render: () => h(RouterView) });
  const wrapper = mount(Root, {
    attachTo: document.body,
    global: { plugins: [router], provide: { [apiKey as symbol]: api } },
  });
  await flushPromises();
  return { wrapper, router };
}

export function mountWithApi<C extends Component>(
  component: C,
  api: FakeApi,
  options: ComponentMountingOptions<C> = {},
) {
  const router = createAppRouter(createMemoryHistory());
  return mount(component, {
    ...options,
    global: { plugins: [router], provide: { [apiKey as symbol]: api }, ...options.global },
  } as ComponentMountingOptions<C>);
}

const at = '2026-10-26T10:00:00.000Z';

export function sampleMonitor(overrides: Partial<Monitor> = {}): Monitor {
  return {
    id: '6f1c1e2a-8a0b-4c55-9d43-0d3c1b2a7e10',
    name: 'Demo tee',
    url: 'http://127.0.0.1:4011/products/demo-tee',
    platform: 'auto',
    devices: ['desktop', 'mobile'],
    schedule: '*/15 * * * *',
    timezone: 'UTC',
    slowStepMs: 8000,
    alertAfterFailures: 2,
    alerts: [{ type: 'webhook', url: 'https://ops.example/hook', hasSecret: true }],
    enabled: true,
    createdAt: at,
    updatedAt: at,
    status: {
      health: 'failing',
      consecutiveFailures: 3,
      slowSteps: ['desktop:checkout_renders'],
      lastRunId: 'a3d1b2c4-0000-4000-8000-000000000001',
      lastRunStatus: 'failed',
      lastRunAt: at,
      healthChangedAt: at,
    },
    ...overrides,
  };
}

/** A stored run in the API's shape: mobile fails at find_add_to_cart, with a screenshot. */
export function sampleRun(overrides: Partial<RunDetail> = {}): RunDetail {
  const step = (name: string, offsetMs: number, durationMs: number, extra = {}) => ({
    name,
    status: 'passed',
    startedAt: new Date(Date.parse(at) + offsetMs).toISOString(),
    durationMs,
    slow: false,
    details: {},
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    ...extra,
  });
  return {
    id: 'a3d1b2c4-0000-4000-8000-000000000001',
    monitorId: '6f1c1e2a-8a0b-4c55-9d43-0d3c1b2a7e10',
    trigger: 'manual',
    status: 'failed',
    startedAt: at,
    finishedAt: at,
    durationMs: 2_830,
    detectedPlatform: 'shopify',
    failedStep: 'find_add_to_cart',
    error: null,
    artifacts: [
      {
        name: 'mobile-find_add_to_cart.png',
        kind: 'screenshot',
        device: 'mobile',
        step: 'find_add_to_cart',
      },
      { name: 'mobile-trace.zip', kind: 'trace', device: 'mobile' },
    ],
    result: {
      schemaVersion: 1,
      tool: { name: 'checkout-sentinel', version: '0.1.0' },
      runId: 'a3d1b2c4-0000-4000-8000-000000000001',
      url: 'http://127.0.0.1:4011/products/demo-tee',
      requestedPlatform: 'auto',
      startedAt: at,
      finishedAt: at,
      durationMs: 2_830,
      status: 'failed',
      summary: { journeys: 1, passed: 0, failed: 1, slowSteps: 0 },
      journeys: [
        {
          device: 'mobile',
          status: 'failed',
          startedAt: at,
          durationMs: 2_540,
          platform: { detected: 'shopify', used: 'shopify', confidence: 'high', signals: [] },
          failedStep: 'find_add_to_cart',
          steps: [
            step('open_product', 0, 121, { details: { httpStatus: 200 } }),
            step('find_add_to_cart', 121, 2_110, {
              status: 'failed',
              message: 'Add-to-cart control exists but is hidden or disabled at this viewport',
              consoleErrors: [
                { text: 'Uncaught TypeError: x is undefined', location: 'theme.js:12' },
              ],
              failedRequests: [
                {
                  url: 'http://127.0.0.1:4011/cart/add.js',
                  method: 'POST',
                  resourceType: 'fetch',
                  kind: 'http_error',
                  status: 500,
                },
              ],
              screenshot: '/data/artifacts/m/r/mobile-find_add_to_cart.png',
            }),
            step('add_to_cart', 2_231, 0, {
              status: 'skipped',
              message: 'Skipped because find_add_to_cart failed',
            }),
          ],
          trace: '/data/artifacts/m/r/mobile-trace.zip',
        },
      ],
    } as RunDetail['result'],
    ...overrides,
  };
}

export { flushPromises };
