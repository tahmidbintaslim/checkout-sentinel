import { describe, expect, it } from 'vitest';
import { loadApiConfig, redactChannel } from '@checkout-sentinel/api';

describe('redactChannel', () => {
  it('masks Slack webhook URLs and hides webhook secrets', () => {
    expect(
      redactChannel({ type: 'slack', url: 'https://hooks.slack.com/services/T1/B2/abcdefgh' }),
    ).toEqual({
      type: 'slack',
      url: 'https://hooks.slack.com/...efgh',
    });
    expect(
      redactChannel({ type: 'webhook', url: 'https://ops.test/h', secret: 'x'.repeat(16) }),
    ).toEqual({
      type: 'webhook',
      url: 'https://ops.test/h',
      hasSecret: true,
    });
  });
});

describe('loadApiConfig', () => {
  it('applies defaults and parses booleans', () => {
    const config = loadApiConfig({ DATABASE_URL: 'postgres://x', MIGRATE_ON_BOOT: 'false' });
    expect(config).toMatchObject({
      PORT: 3000,
      MIGRATE_ON_BOOT: false,
      REDIS_URL: 'redis://localhost:6379',
    });
  });

  it('rejects short API tokens and a missing DATABASE_URL', () => {
    expect(() => loadApiConfig({ DATABASE_URL: 'postgres://x', API_TOKEN: 'short' })).toThrow(
      /API_TOKEN/,
    );
    expect(() => loadApiConfig({})).toThrow(/DATABASE_URL/);
  });
});
