import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  EXAMPLE_CONFIG,
  interpolateEnv,
  parseMonitorsFile,
} from '@checkout-sentinel/cli';

describe('parseMonitorsFile', () => {
  it('parses the example config written by init', () => {
    const config = parseMonitorsFile(EXAMPLE_CONFIG, {});
    expect(config.monitors).toHaveLength(2);
    expect(config.monitors[0]).toMatchObject({
      name: 'Bestseller (Shopify)',
      devices: ['mobile', 'desktop'],
      alerts: [{ type: 'slack' }],
    });
    expect(config.monitors[1]).toMatchObject({ platform: 'woocommerce', alertAfterFailures: 2 });
    expect(config.defaults?.timeouts).toEqual({ navigationMs: 30000, stepMs: 15000 });
  });

  it('reports every invalid field with its path', () => {
    const text = `version: 1
monitors:
  - name: ""
    url: not-a-url
    schedule: "* * * * *"
`;
    expect(() => parseMonitorsFile(text, {})).toThrow(ConfigError);
    try {
      parseMonitorsFile(text, {});
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('monitors.0.name');
      expect(message).toContain('monitors.0.url');
      expect(message).toContain('monitors.0.schedule');
    }
  });

  it('rejects YAML syntax errors', () => {
    expect(() => parseMonitorsFile('version: [1', {})).toThrow(/not valid YAML/);
  });
});

describe('interpolateEnv', () => {
  it('substitutes variables and fails loudly on unset ones', () => {
    expect(interpolateEnv('url: ${HOOK}', { HOOK: 'https://x.test' })).toBe('url: https://x.test');
    expect(() => interpolateEnv('a: ${A} b: ${B}', {})).toThrow('A, B');
  });
});

describe('parseMonitorsFile interpolation', () => {
  it('interpolates values but not comments', () => {
    const text = `# uses \${NOT_SET} in a comment
version: 1
monitors:
  - name: x
    url: \${STORE_URL}
`;
    const config = parseMonitorsFile(text, { STORE_URL: 'https://s.test/p' });
    expect(config.monitors[0]?.url).toBe('https://s.test/p');
  });
});
