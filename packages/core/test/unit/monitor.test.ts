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

describe('stored alert channel references', () => {
  const READ_AT = '2026-10-26T10:00:00.000Z';

  it('lets a PATCH keep stored channels by index without sending their secrets', async () => {
    const { MonitorPatchSchema } = await import('@checkout-sentinel/core');
    const patch = MonitorPatchSchema.parse({
      alerts: [
        { type: 'stored', index: 1 },
        { type: 'webhook', url: 'https://ops.test/hook' },
      ],
      expectedUpdatedAt: READ_AT,
    });
    expect(patch.alerts).toEqual([
      { type: 'stored', index: 1 },
      { type: 'webhook', url: 'https://ops.test/hook' },
    ]);
  });

  it('rejects a stored channel referenced twice, a negative index and unknown fields', async () => {
    const { MonitorPatchSchema } = await import('@checkout-sentinel/core');
    const twice = MonitorPatchSchema.safeParse({
      alerts: [
        { type: 'stored', index: 0 },
        { type: 'stored', index: 0 },
      ],
      expectedUpdatedAt: READ_AT,
    });
    expect(twice.success).toBe(false);
    expect(twice.error?.issues.map((i) => i.path.join('.'))).toEqual(['alerts.1.index']);
    expect(MonitorPatchSchema.safeParse({ alerts: [{ type: 'stored', index: -1 }] }).success).toBe(
      false,
    );
    expect(
      MonitorPatchSchema.safeParse({
        alerts: [{ type: 'stored', index: 0, url: 'https://x.test' }],
      }).success,
    ).toBe(false);
  });

  it('needs the updatedAt the client read whenever it keeps stored channels', async () => {
    const { MonitorPatchSchema } = await import('@checkout-sentinel/core');
    const unversioned = MonitorPatchSchema.safeParse({ alerts: [{ type: 'stored', index: 0 }] });
    expect(unversioned.error?.issues.map((i) => i.path.join('.'))).toEqual(['expectedUpdatedAt']);
    expect(
      MonitorPatchSchema.safeParse({
        alerts: [{ type: 'stored', index: 0 }],
        expectedUpdatedAt: 'yesterday',
      }).success,
    ).toBe(false);
    // New channels only: no index to misread, so the precondition stays optional.
    expect(
      MonitorPatchSchema.safeParse({ alerts: [{ type: 'webhook', url: 'https://ops.test/hook' }] })
        .success,
    ).toBe(true);
    expect(MonitorPatchSchema.parse({ name: 'x', expectedUpdatedAt: READ_AT })).toEqual({
      name: 'x',
      expectedUpdatedAt: READ_AT,
    });
  });

  it('keeps field paths for invalid channels in a PATCH', async () => {
    const { MonitorPatchSchema } = await import('@checkout-sentinel/core');
    const result = MonitorPatchSchema.safeParse({
      alerts: [{ type: 'webhook', url: 'ftp://x.test' }],
    });
    expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual(['alerts.0.url']);
  });

  it('is not accepted when creating a monitor, which has nothing stored yet', () => {
    expect(
      MonitorSpecSchema.safeParse({
        name: 'x',
        url: 'https://s.test/p',
        alerts: [{ type: 'stored', index: 0 }],
      }).success,
    ).toBe(false);
  });
});
