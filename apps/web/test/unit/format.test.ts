import { describe, expect, it } from 'vitest';
import { formatDuration, relativeTime, stepLabel } from '../../src/lib/format';

describe('formatDuration', () => {
  it('matches the CLI: milliseconds under a second, then seconds with two decimals', () => {
    expect(formatDuration(640)).toBe('640 ms');
    expect(formatDuration(2_540)).toBe('2.54 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
    expect(formatDuration(null)).toBe('');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  it('says how long ago something happened', () => {
    expect(relativeTime('2026-10-26T11:59:58Z', now)).toBe('just now');
    expect(relativeTime('2026-10-26T11:55:00Z', now)).toBe('5 minutes ago');
    expect(relativeTime('2026-10-26T09:00:00Z', now)).toBe('3 hours ago');
    expect(relativeTime('2026-10-24T12:00:00Z', now)).toBe('2 days ago');
    expect(relativeTime(null, now)).toBe('never');
  });
});

describe('stepLabel', () => {
  it('turns step names into words', () => {
    expect(stepLabel('find_add_to_cart')).toBe('Find add to cart');
    expect(stepLabel('checkout_renders')).toBe('Checkout renders');
  });
});
