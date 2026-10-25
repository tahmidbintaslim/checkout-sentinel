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
