import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/client';
import { fakeApi, flushPromises, mountAt, sampleMonitor } from './helpers';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('monitors list', () => {
  it('shows each monitor with its status, platform, devices, schedule, last run and counts', async () => {
    const paused = sampleMonitor({
      id: '0b9e2f4c-1111-4222-8333-444455556666',
      name: 'Hoodie',
      url: 'http://127.0.0.1:4015/product/demo-hoodie/',
      platform: 'woocommerce',
      devices: ['mobile'],
      schedule: '0 * * * *',
      timezone: 'Asia/Bangkok',
      enabled: false,
      status: {
        health: 'unknown',
        consecutiveFailures: 0,
        slowSteps: [],
        lastRunId: null,
        lastRunStatus: null,
        lastRunAt: null,
        healthChangedAt: null,
      },
    });
    const api = fakeApi({ listMonitors: [sampleMonitor(), paused] });
    const { wrapper } = await mountAt('/', api);

    const rows = wrapper.findAll('tbody tr');
    expect(rows).toHaveLength(2);
    const first = rows[0]!.findAll('td').map((cell) => cell.text());
    expect(first[0]).toContain('Demo tee');
    expect(first[0]).toContain('http://127.0.0.1:4011/products/demo-tee');
    expect(first[1]).toBe('Failing');
    expect(first.slice(2, 5)).toEqual(['Detect', 'Desktop, Mobile', '*/15 * * * *']);
    expect(first[5]).toContain('Failed');
    expect(first.slice(6)).toEqual(['3', '1']);
    expect(rows[0]!.find('a').attributes('href')).toBe(
      '/monitors/6f1c1e2a-8a0b-4c55-9d43-0d3c1b2a7e10',
    );

    const second = rows[1]!.findAll('td').map((cell) => cell.text());
    expect(second[1]).toContain('No result yet');
    expect(second[1]).toContain('Paused');
    expect(second.slice(2, 4)).toEqual(['WooCommerce', 'Mobile']);
    expect(second[4]).toContain('Asia/Bangkok');
    expect(second[5]).toBe('Never');
  });

  it('invites the first monitor when there are none', async () => {
    const { wrapper } = await mountAt('/', fakeApi({ listMonitors: [] }));
    expect(wrapper.text()).toContain('No monitors yet');
    expect(wrapper.find('a[href="/monitors/new"]').exists()).toBe(true);
  });

  it('shows why the list could not load', async () => {
    const api = fakeApi({
      listMonitors: async () => {
        throw new ApiError(0, 'Cannot reach the API: Failed to fetch');
      },
    });
    const { wrapper } = await mountAt('/', api);
    expect(wrapper.get('[role="alert"]').text()).toContain('Cannot reach the API');
  });
});

describe('alert log', () => {
  const entry = {
    id: '11111111-1111-4111-8111-111111111111',
    runId: 'a3d1b2c4-0000-4000-8000-000000000001',
    monitorId: '6f1c1e2a-8a0b-4c55-9d43-0d3c1b2a7e10',
    monitorName: 'Demo tee',
    kind: 'failure' as const,
    channelType: 'webhook',
    status: 'failed' as const,
    responseStatus: 500,
    error: 'HTTP 500',
    createdAt: '2026-10-26T10:00:00.000Z',
    sentAt: null,
  };

  it('lists deliveries, filters by monitor and pages back', async () => {
    const api = fakeApi({
      listAlerts: async (query: { before?: string }) =>
        query.before
          ? {
              items: [
                {
                  ...entry,
                  id: '22222222-2222-4222-8222-222222222222',
                  kind: 'recovery',
                  status: 'sent',
                  error: null,
                  responseStatus: 204,
                },
              ],
              nextCursor: null,
            }
          : { items: [entry], nextCursor: entry.id },
      listMonitors: [sampleMonitor()],
    });
    const { wrapper, router } = await mountAt('/alerts', api);
    const cells = wrapper.findAll('tbody td').map((c) => c.text());
    expect(cells[1]).toBe('Demo tee');
    expect(cells[2]).toBe('Failure');
    expect(cells[3]).toBe('Webhook');
    expect(cells[4]).toContain('Failed');
    expect(cells[4]).toContain('HTTP 500');
    expect(wrapper.get('tbody a[href^="/runs/"]').text()).toBe('View run');

    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Older alerts')!
      .trigger('click');
    await flushPromises();
    expect(api.listAlerts).toHaveBeenLastCalledWith({
      limit: 25,
      monitorId: undefined,
      before: entry.id,
    });
    expect(wrapper.get('tbody').text()).toContain('Recovery');

    await wrapper.get('#alert-monitor-filter').setValue('6f1c1e2a-8a0b-4c55-9d43-0d3c1b2a7e10');
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({
      monitor: '6f1c1e2a-8a0b-4c55-9d43-0d3c1b2a7e10',
    });
    expect(api.listAlerts).toHaveBeenLastCalledWith({
      limit: 25,
      monitorId: '6f1c1e2a-8a0b-4c55-9d43-0d3c1b2a7e10',
      before: undefined,
    });
  });
});
