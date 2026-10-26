import { describe, expect, it } from 'vitest';
import type { Monitor } from '../../src/api/types';
import {
  addChannel,
  describeSchedule,
  emptyForm,
  formFromMonitor,
  toCreatePayload,
  toUpdatePayload,
} from '../../src/lib/monitor-form';

const stored: Monitor = {
  id: '6f1c1e2a-8a0b-4c55-9d43-0d3c1b2a7e10',
  name: 'Bestseller',
  url: 'https://store.example/products/tee',
  platform: 'shopify',
  devices: ['mobile'],
  schedule: '*/10 * * * *',
  timezone: 'Europe/Berlin',
  slowStepMs: 6000,
  alertAfterFailures: 3,
  alerts: [
    { type: 'slack', url: 'https://hooks.slack.com/...XYZ1' },
    { type: 'webhook', url: 'https://ops.example/hook', hasSecret: true },
  ],
  enabled: true,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  status: {
    health: 'unknown',
    consecutiveFailures: 0,
    slowSteps: [],
    lastRunId: null,
    lastRunStatus: null,
    lastRunAt: null,
    healthChangedAt: null,
  },
};

describe('emptyForm', () => {
  it('starts from the API defaults', () => {
    expect(emptyForm()).toMatchObject({
      platform: 'auto',
      devices: ['desktop', 'mobile'],
      schedule: '*/15 * * * *',
      timezone: 'UTC',
      slowStepMs: '8000',
      alertAfterFailures: '2',
      enabled: true,
      alerts: [],
    });
  });
});

describe('toCreatePayload', () => {
  it('builds the body the API expects', () => {
    const form = emptyForm();
    form.name = '  Hoodie ';
    form.url = 'https://shop.example/product/hoodie/';
    form.devices = ['mobile'];
    addChannel(form, 'webhook');
    form.alerts[0]!.url = 'https://ops.example/hook';
    form.alerts[0]!.secret = 'sixteen-chars-secret';
    addChannel(form, 'slack');
    form.alerts[1]!.url = 'https://hooks.slack.com/services/T/B/X';
    expect(toCreatePayload(form)).toEqual({
      ok: true,
      payload: {
        name: 'Hoodie',
        url: 'https://shop.example/product/hoodie/',
        platform: 'auto',
        devices: ['mobile'],
        schedule: '*/15 * * * *',
        timezone: 'UTC',
        slowStepMs: 8000,
        alertAfterFailures: 2,
        enabled: true,
        alerts: [
          { type: 'webhook', url: 'https://ops.example/hook', secret: 'sixteen-chars-secret' },
          { type: 'slack', url: 'https://hooks.slack.com/services/T/B/X' },
        ],
      },
    });
  });

  it('reports the same problems the API would, by field', () => {
    const form = emptyForm();
    form.name = '   ';
    form.url = 'javascript:alert(1)';
    form.devices = [];
    form.schedule = '* * * * *';
    form.slowStepMs = '';
    form.alertAfterFailures = '11';
    addChannel(form, 'webhook');
    form.alerts[0]!.url = 'https://ops.example/hook';
    form.alerts[0]!.secret = 'short';
    const result = toCreatePayload(form);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual({
      name: 'Required',
      url: 'Must be an http or https URL',
      devices: 'Choose at least one device',
      schedule: 'Schedule runs every 1 minute(s); the minimum interval is 5 minutes',
      slowStepMs: 'Enter a whole number',
      alertAfterFailures: 'Must be at most 10',
      'alerts.0.secret': 'Must be at least 16 characters',
    });
  });

  it('leaves out an empty webhook secret', () => {
    const form = emptyForm();
    form.name = 'x';
    form.url = 'https://s.test/p';
    addChannel(form, 'webhook');
    form.alerts[0]!.url = 'https://ops.example/hook';
    const result = toCreatePayload(form);
    expect(result.ok && result.payload.alerts).toEqual([
      { type: 'webhook', url: 'https://ops.example/hook' },
    ]);
  });
});

describe('formFromMonitor and toUpdatePayload', () => {
  it('shows stored channels without their credentials', () => {
    const form = formFromMonitor(stored);
    expect(
      form.alerts.map((c) => ({ kind: c.kind, storedIndex: c.storedIndex, url: c.url })),
    ).toEqual([
      { kind: 'stored', storedIndex: 0, url: '' },
      { kind: 'stored', storedIndex: 1, url: '' },
    ]);
    expect(form.alerts.every((c) => c.url === '' && c.secret === '')).toBe(true);
    expect(form.alerts.map((c) => c.stored)).toEqual(stored.alerts);
  });

  it('sends only what changed, and no alerts when the channels stay as they are', () => {
    const form = formFromMonitor(stored);
    expect(toUpdatePayload(form, stored)).toEqual({ ok: true, payload: {} });
    form.name = 'Renamed';
    form.slowStepMs = '7000';
    form.enabled = false;
    expect(toUpdatePayload(form, stored)).toEqual({
      ok: true,
      payload: { name: 'Renamed', slowStepMs: 7000, enabled: false },
    });
  });

  it('keeps stored channels by index when channels are removed or added', () => {
    const form = formFromMonitor(stored);
    form.alerts.splice(0, 1);
    addChannel(form, 'slack');
    form.alerts[1]!.url = 'https://hooks.slack.com/services/T/B/NEW';
    expect(toUpdatePayload(form, stored)).toEqual({
      ok: true,
      payload: {
        alerts: [
          { type: 'stored', index: 1 },
          { type: 'slack', url: 'https://hooks.slack.com/services/T/B/NEW' },
        ],
      },
    });
    form.alerts.splice(0, 2);
    expect(toUpdatePayload(form, stored)).toEqual({ ok: true, payload: { alerts: [] } });
  });

  it('reports channel errors at their position in the list', () => {
    const form = formFromMonitor(stored);
    addChannel(form, 'slack');
    form.alerts[2]!.url = 'not a url';
    const result = toUpdatePayload(form, stored);
    expect(result).toEqual({
      ok: false,
      errors: { 'alerts.2.url': 'Must be an http or https URL' },
    });
  });
});

describe('describeSchedule', () => {
  it('explains the gap between runs, or nothing for an invalid expression', () => {
    expect(describeSchedule('*/15 * * * *')).toBe('Shortest gap between runs: 15 minutes');
    expect(describeSchedule('0 * * * *')).toBe('Shortest gap between runs: 1 hour');
    expect(describeSchedule('0 */6 * * *')).toBe('Shortest gap between runs: 6 hours');
    expect(describeSchedule('0,90 * * * *')).toBeNull();
    expect(describeSchedule('not cron')).toBeNull();
  });
});
