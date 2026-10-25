import { describe, expect, it } from 'vitest';
import { loadConfig } from '@checkout-sentinel/worker';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://x' })).toMatchObject({
      WORKER_CONCURRENCY: 2,
      PER_STORE_CONCURRENCY: 1,
      METRICS_PORT: 9465,
    });
  });

  it('treats empty variables as unset (compose passes ${VAR:-} as "")', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://x',
      PUBLIC_BASE_URL: '',
      USER_AGENT_CONTACT_URL: '',
    });
    expect(config.PUBLIC_BASE_URL).toBeUndefined();
    expect(config.USER_AGENT_CONTACT_URL).toBeUndefined();
  });

  it('still rejects a malformed URL', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://x', PUBLIC_BASE_URL: 'not a url' }),
    ).toThrow(/PUBLIC_BASE_URL/);
  });

  it('defaults housekeeping to a 5 minute interval and 30 days of run history', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(config).toMatchObject({ HOUSEKEEPING_INTERVAL_MS: 300_000, RUN_RETENTION_DAYS: 30 });
    // Unset means "derive from the timeouts" (see staleRunThreshold).
    expect(config.RUN_STALE_AFTER_MS).toBeUndefined();
    expect(
      loadConfig({ DATABASE_URL: 'postgres://x', RUN_STALE_AFTER_MS: '' }).RUN_STALE_AFTER_MS,
    ).toBeUndefined();
  });

  it('rejects a housekeeping interval longer than Node timers allow', () => {
    expect(
      loadConfig({ DATABASE_URL: 'postgres://x', HOUSEKEEPING_INTERVAL_MS: '2147483647' })
        .HOUSEKEEPING_INTERVAL_MS,
    ).toBe(2_147_483_647);
    // 30 days: setInterval would replace it with 1 ms and run passes back to back.
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://x', HOUSEKEEPING_INTERVAL_MS: '2592000000' }),
    ).toThrow(/HOUSEKEEPING_INTERVAL_MS: must be at most 2147483647/);
  });

  it('accepts 0 to turn off housekeeping or retention, and rejects values too small to be safe', () => {
    expect(
      loadConfig({
        DATABASE_URL: 'postgres://x',
        HOUSEKEEPING_INTERVAL_MS: '0',
        RUN_RETENTION_DAYS: '0',
        RUN_STALE_AFTER_MS: '1200000',
      }),
    ).toMatchObject({
      HOUSEKEEPING_INTERVAL_MS: 0,
      RUN_RETENTION_DAYS: 0,
      RUN_STALE_AFTER_MS: 1_200_000,
    });
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://x', HOUSEKEEPING_INTERVAL_MS: '500' }),
    ).toThrow(/HOUSEKEEPING_INTERVAL_MS/);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', RUN_STALE_AFTER_MS: '5000' })).toThrow(
      /RUN_STALE_AFTER_MS/,
    );
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', RUN_RETENTION_DAYS: '-1' })).toThrow(
      /RUN_RETENTION_DAYS/,
    );
  });

  it('keeps private targets blocked unless ALLOW_PRIVATE_TARGETS is set', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://x' })).toMatchObject({
      ALLOW_PRIVATE_TARGETS: false,
      ALLOWED_TARGET_PORTS: [],
      ALLOWED_TARGET_HOSTS: [],
    });
    expect(
      loadConfig({
        DATABASE_URL: 'postgres://x',
        ALLOW_PRIVATE_TARGETS: 'true',
        ALLOWED_TARGET_PORTS: '8443',
        ALLOWED_TARGET_HOSTS: 'alerts.internal',
      }),
    ).toMatchObject({
      ALLOW_PRIVATE_TARGETS: true,
      ALLOWED_TARGET_PORTS: [8443],
      ALLOWED_TARGET_HOSTS: ['alerts.internal'],
    });
    expect(loadConfig({ DATABASE_URL: 'postgres://x', ALLOW_PRIVATE_TARGETS: '' })).toMatchObject({
      ALLOW_PRIVATE_TARGETS: false,
    });
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://x', ALLOWED_TARGET_PORTS: 'eighty' }),
    ).toThrow(/ALLOWED_TARGET_PORTS/);
  });
});
