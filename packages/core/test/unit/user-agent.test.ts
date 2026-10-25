import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEVICE_PROFILES, PROJECT_URL, VERSION, buildUserAgent } from '@checkout-sentinel/core';

describe('buildUserAgent', () => {
  it('keeps the browser prefix and identifies the tool with a URL', () => {
    const ua = buildUserAgent(DEVICE_PROFILES.mobile);
    expect(ua).toContain('Mobile Safari');
    expect(ua).toMatch(/checkout-sentinel\/\d+\.\d+\.\d+ \(\+https:\/\//);
    expect(ua).toContain(PROJECT_URL);
  });

  it('accepts a custom contact URL', () => {
    expect(buildUserAgent(DEVICE_PROFILES.desktop, 'https://ops.example.com/bot')).toMatch(
      /\(\+https:\/\/ops\.example\.com\/bot\)$/,
    );
  });
});

describe('VERSION', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
