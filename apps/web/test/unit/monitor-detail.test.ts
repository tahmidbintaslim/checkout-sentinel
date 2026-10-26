import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunSummary } from '../../src/api/types';
import { fakeApi, flushPromises, mountAt, sampleMonitor, sampleRun } from './helpers';

const ID = '6f1c1e2a-8a0b-4c55-9d43-0d3c1b2a7e10';

function summary(id: string, status: RunSummary['status']): RunSummary {
  return {
    id,
    monitorId: ID,
    trigger: 'manual',
    status,
    startedAt: '2026-10-26T10:00:00.000Z',
    finishedAt: status === 'running' ? null : '2026-10-26T10:00:03.000Z',
    durationMs: status === 'running' ? null : 2830,
    detectedPlatform: 'shopify',
    failedStep: status === 'failed' ? 'find_add_to_cart' : null,
    error: null,
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('monitor detail', () => {
  it('shows the latest result per device, settings, run history and pages through it', async () => {
    const api = fakeApi({
      getMonitor: sampleMonitor(),
      listRuns: async (_id: string, query: { before?: string }) =>
        query.before
          ? { items: [summary('00000000-0000-4000-8000-0000000000b0', 'passed')], nextCursor: null }
          : {
              items: [summary('a3d1b2c4-0000-4000-8000-000000000001', 'failed')],
              nextCursor: 'c1',
            },
      listAlerts: { items: [], nextCursor: null },
      getRun: sampleRun(),
    });
    const { wrapper } = await mountAt(`/monitors/${ID}`, api);

    expect(wrapper.get('h1').text()).toBe('Demo tee');
    const device = wrapper.get('[data-device="mobile"]').text();
    expect(device).toContain('Failed');
    expect(device).toContain('Failed at find add to cart');
    expect(wrapper.text()).toContain('Webhook: https://ops.example/hook (signed)');
    expect(wrapper.get('tbody').text()).toContain('Find add to cart');

    const older = wrapper.findAll('button').find((b) => b.text() === 'Older runs');
    await older!.trigger('click');
    await flushPromises();
    expect(api.listRuns).toHaveBeenLastCalledWith(ID, { limit: 10, before: 'c1' });
    expect(wrapper.get('tbody').text()).toContain('Passed');
  });

  it('queues a run with Run now and reports when it finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let runs = [summary('a3d1b2c4-0000-4000-8000-000000000001', 'failed')];
    const api = fakeApi({
      getMonitor: sampleMonitor(),
      listRuns: async () => ({ items: runs, nextCursor: null }),
      listAlerts: { items: [], nextCursor: null },
      getRun: sampleRun(),
      runNow: { jobId: '7' },
    });
    const { wrapper } = await mountAt(`/monitors/${ID}`, api);

    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Run now')!
      .trigger('click');
    await flushPromises();
    expect(api.runNow).toHaveBeenCalledWith(ID);
    const status = () => wrapper.get('[role="status"].run-status').text();
    expect(status()).toContain('Run queued');

    runs = [summary('00000000-0000-4000-8000-0000000000c0', 'running'), ...runs];
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(status()).toBe('The run is in progress.');

    runs = [summary('00000000-0000-4000-8000-0000000000c0', 'passed'), ...runs.slice(1)];
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(status()).toBe('The run passed.');
  });

  it('waits for the queued run on the newest page only', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const newest = Array.from({ length: 10 }, (_, i) =>
      summary(`00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, 'error'),
    );
    const api = fakeApi({
      getMonitor: sampleMonitor(),
      listRuns: async (_id: string, query: { before?: string }) =>
        query.before
          ? { items: [summary('00000000-0000-4000-8000-000000000200', 'error')], nextCursor: null }
          : { items: newest, nextCursor: 'c1' },
      listAlerts: { items: [], nextCursor: null },
      getRun: sampleRun(),
      runNow: { jobId: '9' },
    });
    const { wrapper } = await mountAt(`/monitors/${ID}`, api);
    const button = (text: string) => wrapper.findAll('button').find((b) => b.text() === text)!;
    const status = () => wrapper.get('[role="status"].run-status').text();

    await button('Run now').trigger('click');
    await flushPromises();
    expect(status()).toContain('Run queued');
    // The older page holds finished runs the page had not seen; none of them is the new run.
    await button('Older runs').trigger('click');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(status()).toContain('Run queued');
  });

  it('writes the platform the way its maker does', async () => {
    const api = fakeApi({
      getMonitor: sampleMonitor({ platform: 'woocommerce' }),
      listRuns: { items: [], nextCursor: null },
      listAlerts: { items: [], nextCursor: null },
      getRun: sampleRun(),
    });
    const { wrapper } = await mountAt(`/monitors/${ID}`, api);
    const settings = wrapper.get('section[aria-labelledby="settings-title"]').text();
    expect(settings).toContain('WooCommerce');
    expect(settings).not.toContain('woocommerce');
  });

  it('never reports a finished run next to an older latest result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const oldRun = 'a3d1b2c4-0000-4000-8000-000000000001';
    const newRun = '00000000-0000-4000-8000-0000000000d0';
    // The API commits a run's result and the monitor's state together. Here the commit lands
    // while the page is reading the monitor, between that read and the run list.
    let committed = false;
    let commitDuringNextMonitorRead = false;
    const api = fakeApi({
      getMonitor: async () => {
        const state = committed ? newRun : oldRun;
        if (commitDuringNextMonitorRead) committed = true;
        return sampleMonitor({
          status: { ...sampleMonitor().status, lastRunId: state, lastRunStatus: 'failed' },
        });
      },
      listRuns: async () => ({
        items: committed
          ? [summary(newRun, 'passed'), summary(oldRun, 'failed')]
          : [summary(oldRun, 'failed')],
        nextCursor: null,
      }),
      listAlerts: { items: [], nextCursor: null },
      getRun: async (id: string) =>
        id === newRun
          ? sampleRun({
              id,
              status: 'passed',
              result: {
                ...sampleRun().result!,
                journeys: [{ ...sampleRun().result!.journeys[0]!, status: 'passed' }],
              },
            })
          : sampleRun(),
      runNow: { jobId: '8' },
    });
    const { wrapper } = await mountAt(`/monitors/${ID}`, api);
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Run now')!
      .trigger('click');
    await flushPromises();

    commitDuringNextMonitorRead = true;
    for (let tick = 0; tick < 3; tick += 1) {
      await vi.advanceTimersByTimeAsync(2_000);
      await flushPromises();
      if (wrapper.get('[role="status"].run-status').text() === 'The run passed.') {
        expect(wrapper.get('[data-device="mobile"]').text()).toContain('Passed');
        return;
      }
    }
    throw new Error('the page never reported the finished run');
  });

  it('deletes only after the confirmation', async () => {
    const api = fakeApi({
      getMonitor: sampleMonitor(),
      listRuns: { items: [], nextCursor: null },
      listAlerts: { items: [], nextCursor: null },
      getRun: sampleRun(),
      deleteMonitor: undefined,
      listMonitors: [],
    });
    const { wrapper, router } = await mountAt(`/monitors/${ID}`, api);
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Delete')!
      .trigger('click');
    await flushPromises();
    expect(api.deleteMonitor).not.toHaveBeenCalled();
    const confirm = wrapper.findAll('button').find((b) => b.text() === 'Delete monitor')!;
    expect(document.activeElement).toBe(confirm.element);
    await confirm.trigger('click');
    await flushPromises();
    expect(api.deleteMonitor).toHaveBeenCalledWith(ID);
    expect(router.currentRoute.value.path).toBe('/');
  });
});
