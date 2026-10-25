import type { AlertChannel, TargetGuard } from '@checkout-sentinel/core';
import type { ValidationIssue } from '../common/validation.js';

/**
 * Checks every URL in a monitor body against the SSRF guard (with DNS) and returns one issue
 * per refused URL, using the same paths as schema validation ("url", "alerts.1.url").
 */
export async function findTargetIssues(
  guard: TargetGuard,
  spec: { url?: string | undefined; alerts?: AlertChannel[] | undefined },
): Promise<ValidationIssue[]> {
  const checks: Array<Promise<ValidationIssue | null>> = [];
  if (spec.url !== undefined) {
    const url = spec.url;
    checks.push(
      guard
        .checkUrl(url, 'store')
        .then((verdict) => (verdict.allowed ? null : { path: 'url', message: verdict.reason })),
    );
  }
  for (const [index, channel] of (spec.alerts ?? []).entries()) {
    checks.push(
      guard
        .checkUrl(channel.url, channel.type)
        .then((verdict) =>
          verdict.allowed ? null : { path: `alerts.${index}.url`, message: verdict.reason },
        ),
    );
  }
  return (await Promise.all(checks)).filter((issue): issue is ValidationIssue => issue !== null);
}
