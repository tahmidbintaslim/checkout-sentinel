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
});
