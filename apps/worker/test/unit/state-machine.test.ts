import { describe, expect, it } from 'vitest';
import type { RunResult, TagId } from '@checkout-sentinel/core';
import { evaluateTransition, slowStepKeys, type AlertState } from '@checkout-sentinel/worker';

type Status = RunResult['status'];
const t = '2026-10-25T10:00:00.000Z';

function result(
  status: Status,
  slow: string[] = [],
  missing?: TagId[],
): Pick<RunResult, 'status' | 'journeys'> {
  return {
    status,
    journeys: [
      {
        device: 'mobile',
        status: status === 'failed' ? 'failed' : 'passed',
        startedAt: t,
        durationMs: 1,
        platform: null,
        ...(missing ? { tracking: { expected: ['ga4', 'meta'] as TagId[], missing } } : {}),
        steps: (['open_product', 'go_to_checkout'] as const).map((name) => ({
          name,
          status: 'passed' as const,
          startedAt: t,
          durationMs: 1,
          slow: slow.includes(name),
          details: {},
          consoleErrors: [],
          pageErrors: [],
          failedRequests: [],
        })),
      },
    ],
  };
}

const fresh: AlertState = {
  health: 'unknown',
  consecutiveFailures: 0,
  slowSteps: [],
  trackingMissing: [],
};

/** Feeds a sequence of run statuses through the machine and collects alert kinds. */
function replay(statuses: Status[], threshold: number, start: AlertState = fresh) {
  let state = start;
  const alerts: string[] = [];
  for (const status of statuses) {
    const transition = evaluateTransition(state, result(status), threshold);
    alerts.push(...transition.alerts.map((a) => a.kind));
    state = transition.next;
  }
  return { state, alerts };
}

describe('evaluateTransition', () => {
  it('does not alert when a new monitor starts passing', () => {
    expect(replay(['passed', 'passed'], 2)).toEqual({
      state: { health: 'passing', consecutiveFailures: 0, slowSteps: [], trackingMissing: [] },
      alerts: [],
    });
  });

  it('alerts once after the configured number of consecutive failures', () => {
    const { state, alerts } = replay(['passed', 'failed', 'failed', 'failed', 'failed'], 2);
    expect(alerts).toEqual(['failure']);
    expect(state).toMatchObject({ health: 'failing', consecutiveFailures: 4 });
  });

  it('ignores a single failure below the threshold', () => {
    expect(replay(['passed', 'failed', 'passed', 'failed', 'passed'], 2).alerts).toEqual([]);
  });

  it('alerts immediately with a threshold of 1, including on a brand new monitor', () => {
    expect(replay(['failed'], 1).alerts).toEqual(['failure']);
  });

  it('sends one recovery alert when a failing store passes again', () => {
    const { state, alerts } = replay(['failed', 'failed', 'passed', 'passed'], 2);
    expect(alerts).toEqual(['failure', 'recovery']);
    expect(state.health).toBe('passing');
  });

  it('cycles cleanly through repeated outages', () => {
    expect(replay(['failed', 'passed', 'failed', 'passed'], 1).alerts).toEqual([
      'failure',
      'recovery',
      'failure',
      'recovery',
    ]);
  });

  it('treats error runs as no information', () => {
    const failing: AlertState = {
      health: 'failing',
      consecutiveFailures: 3,
      slowSteps: [],
      trackingMissing: [],
    };
    const transition = evaluateTransition(failing, result('error'), 2);
    expect(transition).toEqual({ next: failing, healthChanged: false, alerts: [] });
    // An error between failures does not reset the counter either.
    expect(replay(['failed', 'error', 'failed'], 2).alerts).toEqual(['failure']);
  });

  it('alerts on a newly slow step once, and again only after it recovered', () => {
    let state: AlertState = {
      health: 'passing',
      consecutiveFailures: 0,
      slowSteps: [],
      trackingMissing: [],
    };
    const kinds: string[][] = [];
    for (const slow of [['go_to_checkout'], ['go_to_checkout'], [], ['go_to_checkout']]) {
      const transition = evaluateTransition(state, result('passed', slow), 2);
      kinds.push(transition.alerts.map((a) => `${a.kind}:${(a.slowSteps ?? []).join(',')}`));
      state = transition.next;
    }
    expect(kinds).toEqual([['slow:mobile:go_to_checkout'], [], [], ['slow:mobile:go_to_checkout']]);
  });

  it('keeps the slow set across failed runs so recovery does not re-alert a known slow step', () => {
    const start: AlertState = {
      health: 'passing',
      consecutiveFailures: 0,
      slowSteps: ['mobile:go_to_checkout'],
      trackingMissing: [],
    };
    const afterFail = evaluateTransition(start, result('failed'), 1).next;
    expect(afterFail.slowSteps).toEqual(['mobile:go_to_checkout']);
    const recovered = evaluateTransition(afterFail, result('passed', ['go_to_checkout']), 1);
    expect(recovered.alerts.map((a) => a.kind)).toEqual(['recovery']);
  });

  it('reports healthChanged only on real transitions', () => {
    expect(evaluateTransition(fresh, result('passed'), 2).healthChanged).toBe(true);
    const passing: AlertState = {
      health: 'passing',
      consecutiveFailures: 0,
      slowSteps: [],
      trackingMissing: [],
    };
    expect(evaluateTransition(passing, result('passed'), 2).healthChanged).toBe(false);
    expect(evaluateTransition(passing, result('failed'), 2).healthChanged).toBe(false);
  });
});

describe('tracking alerts', () => {
  it('alerts once when an expected tag stops firing, again only after it came back', () => {
    let state: AlertState = fresh;
    const kinds: string[][] = [];
    const runs: [Status, TagId[]][] = [
      ['passed', []],
      ['passed', ['meta']],
      ['passed', ['meta']],
      ['failed', []],
      ['passed', ['meta']],
      ['passed', []],
      ['passed', ['meta', 'ga4']],
    ];
    for (const [status, missing] of runs) {
      const transition = evaluateTransition(state, result(status, [], missing), 1);
      kinds.push(
        transition.alerts
          .filter((a) => a.kind === 'tracking')
          .map((a) => (a.trackingMissing ?? []).join(',')),
      );
      state = transition.next;
    }
    // The failed run keeps the known-missing set, so recovery does not re-alert meta.
    expect(kinds).toEqual([[], ['mobile:meta'], [], [], [], [], ['mobile:meta,mobile:ga4']]);
  });
});

describe('slowStepKeys', () => {
  it('keys slow steps by device and step', () => {
    expect(slowStepKeys(result('passed', ['open_product']) as RunResult)).toEqual([
      'mobile:open_product',
    ]);
  });
});
