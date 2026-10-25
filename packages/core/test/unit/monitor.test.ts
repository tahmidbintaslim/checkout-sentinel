import { describe, expect, it } from 'vitest';
import {
  MIN_SCHEDULE_INTERVAL_MINUTES,
  MonitorSpecSchema,
  cronIntervalMinutes,
  resolveDevices,
} from '@checkout-sentinel/core';

describe('MonitorSpecSchema', () => {
  it('fills defaults', () => {
    const spec = MonitorSpecSchema.parse({ name: 'Tee', url: 'https://s.test/products/tee' });
    expect(spec).toMatchObject({
      platform: 'auto',
      devices: ['desktop', 'mobile'],
      schedule: '*/15 * * * *',
      alertAfterFailures: 2,
      alerts: [],
      enabled: true,
    });
  });

  it('rejects non-http URLs', () => {
    expect(MonitorSpecSchema.safeParse({ name: 'x', url: 'file:///etc/passwd' }).success).toBe(
      false,
    );
    expect(MonitorSpecSchema.safeParse({ name: 'x', url: 'javascript:alert(1)' }).success).toBe(
      false,
    );
  });

  it('rejects invalid cron and schedules tighter than the minimum interval', () => {
    const base = { name: 'x', url: 'https://s.test/p' };
    expect(MonitorSpecSchema.safeParse({ ...base, schedule: 'every minute' }).success).toBe(false);
    const tooOften = MonitorSpecSchema.safeParse({ ...base, schedule: '* * * * *' });
    expect(tooOften.success).toBe(false);
    expect(JSON.stringify(tooOften.error?.issues)).toContain(
      `${MIN_SCHEDULE_INTERVAL_MINUTES} minutes`,
    );
    expect(MonitorSpecSchema.safeParse({ ...base, schedule: '0 * * * *' }).success).toBe(true);
  });

  it('validates alert channels', () => {
    const base = { name: 'x', url: 'https://s.test/p' };
    expect(
      MonitorSpecSchema.safeParse({
        ...base,
        alerts: [{ type: 'slack', url: 'https://hooks.slack.com/services/T/B/X' }],
      }).success,
    ).toBe(true);
    expect(
      MonitorSpecSchema.safeParse({ ...base, alerts: [{ type: 'email', url: 'a@b.c' }] }).success,
    ).toBe(false);
    expect(
      MonitorSpecSchema.safeParse({
        ...base,
        alerts: [{ type: 'webhook', url: 'https://x.test', secret: 'short' }],
      }).success,
    ).toBe(false);
  });
});

describe('cronIntervalMinutes', () => {
  it('finds the smallest gap', () => {
    expect(cronIntervalMinutes('*/15 * * * *')).toBe(15);
    expect(cronIntervalMinutes('0,2 * * * *')).toBe(2);
  });
});

describe('resolveDevices', () => {
  it('expands both and dedupes lists', () => {
    expect(resolveDevices('both')).toEqual(['desktop', 'mobile']);
    expect(resolveDevices('mobile')).toEqual(['mobile']);
    expect(resolveDevices(['mobile', 'mobile'])).toEqual(['mobile']);
  });
});

describe('MonitorPatchSchema', () => {
  it('keeps only the fields that were sent', async () => {
    const { MonitorPatchSchema } = await import('@checkout-sentinel/core');
    expect(MonitorPatchSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(MonitorPatchSchema.safeParse({ schedule: '* * * * *' }).success).toBe(false);
    expect(MonitorPatchSchema.safeParse({ unknownField: 1 }).success).toBe(false);
  });
});
