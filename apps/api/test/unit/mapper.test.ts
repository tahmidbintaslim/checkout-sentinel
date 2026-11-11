import { describe, expect, it } from 'vitest';
import {
  clerkFrontendHost,
  dashboardCsp,
  loadApiConfig,
  redactChannel,
} from '@checkout-sentinel/api';

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

  it('reads the dashboard and artifacts settings', () => {
    expect(loadApiConfig({ DATABASE_URL: 'postgres://x' })).toMatchObject({
      ARTIFACTS_DIR: './artifacts',
      DASHBOARD_ENABLED: true,
    });
    expect(loadApiConfig({ DATABASE_URL: 'postgres://x' }).DASHBOARD_DIR).toBeUndefined();
    expect(
      loadApiConfig({
        DATABASE_URL: 'postgres://x',
        ARTIFACTS_DIR: '/data/artifacts',
        DASHBOARD_ENABLED: 'false',
        DASHBOARD_DIR: '/app/web',
      }),
    ).toMatchObject({
      ARTIFACTS_DIR: '/data/artifacts',
      DASHBOARD_ENABLED: false,
      DASHBOARD_DIR: '/app/web',
    });
    expect(() => loadApiConfig({ DATABASE_URL: 'postgres://x', DASHBOARD_ENABLED: 'no' })).toThrow(
      /DASHBOARD_ENABLED/,
    );
  });

  it('rejects short API tokens and a missing DATABASE_URL', () => {
    expect(() => loadApiConfig({ DATABASE_URL: 'postgres://x', API_TOKEN: 'short' })).toThrow(
      /API_TOKEN/,
    );
    expect(() => loadApiConfig({})).toThrow(/DATABASE_URL/);
  });

  it('needs the publishable key and allowed origins with Clerk', () => {
    expect(() =>
      loadApiConfig({ DATABASE_URL: 'postgres://x', CLERK_SECRET_KEY: 'sk_test_x' }),
    ).toThrow(/CLERK_AUTHORIZED_PARTIES/);
    expect(
      loadApiConfig({
        DATABASE_URL: 'postgres://x',
        CLERK_SECRET_KEY: 'sk_test_x',
        CLERK_PUBLISHABLE_KEY: 'pk_test_abc',
        CLERK_AUTHORIZED_PARTIES: 'https://a.example, https://b.example',
      }).CLERK_AUTHORIZED_PARTIES,
    ).toEqual(['https://a.example', 'https://b.example']);
  });

  it('allows Clerk in the dashboard CSP only for the host its key names', () => {
    const key = `pk_test_${Buffer.from('happy-cat-1.clerk.accounts.dev$').toString('base64')}`;
    expect(clerkFrontendHost(key)).toBe('happy-cat-1.clerk.accounts.dev');
    expect(
      clerkFrontendHost(`pk_test_${Buffer.from('x; script-src *$').toString('base64')}`),
    ).toBeNull();
    expect(dashboardCsp('happy-cat-1.clerk.accounts.dev')).toContain(
      "script-src 'self' https://challenges.cloudflare.com https://happy-cat-1.clerk.accounts.dev;",
    );
    expect(dashboardCsp()).toContain("style-src 'self';");
  });

  it('refuses the public scanner without Turnstile keys', () => {
    expect(() => loadApiConfig({ DATABASE_URL: 'postgres://x', SCANNER_ENABLED: 'true' })).toThrow(
      /TURNSTILE/,
    );
    expect(
      loadApiConfig({
        DATABASE_URL: 'postgres://x',
        SCANNER_ENABLED: 'true',
        TURNSTILE_SITE_KEY: 'site',
        TURNSTILE_SECRET_KEY: 'secret',
      }),
    ).toMatchObject({ SCANNER_ENABLED: true, SCAN_RATE_LIMIT_PER_HOUR: 5, SCAN_QUEUE_LIMIT: 20 });
  });

  it('treats empty variables as unset (compose passes ${VAR:-} as "")', () => {
    const config = loadApiConfig({ DATABASE_URL: 'postgres://x', API_TOKEN: '', LOG_LEVEL: '' });
    expect(config.API_TOKEN).toBeUndefined();
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('blocks private targets unless ALLOW_PRIVATE_TARGETS is set', () => {
    expect(loadApiConfig({ DATABASE_URL: 'postgres://x' }).ALLOW_PRIVATE_TARGETS).toBe(false);
    expect(
      loadApiConfig({ DATABASE_URL: 'postgres://x', ALLOW_PRIVATE_TARGETS: '' })
        .ALLOW_PRIVATE_TARGETS,
    ).toBe(false);
    const local = loadApiConfig({
      DATABASE_URL: 'postgres://x',
      ALLOW_PRIVATE_TARGETS: '1',
      ALLOWED_TARGET_PORTS: '8443,8080',
      ALLOWED_TARGET_HOSTS: 'alerts.internal',
    });
    expect(local).toMatchObject({
      ALLOW_PRIVATE_TARGETS: true,
      ALLOWED_TARGET_PORTS: [8443, 8080],
      ALLOWED_TARGET_HOSTS: ['alerts.internal'],
    });
    expect(() =>
      loadApiConfig({ DATABASE_URL: 'postgres://x', ALLOW_PRIVATE_TARGETS: 'on' }),
    ).toThrow(/ALLOW_PRIVATE_TARGETS/);
  });
});
