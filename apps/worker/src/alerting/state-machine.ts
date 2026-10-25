import type { RunResult } from '@checkout-sentinel/core';

/**
 * Alerting is driven by state changes, not by individual results, so a store that stays
 * broken for six hours produces one failure alert and one recovery alert, not 24 failures.
 *
 *   unknown/passing --(N consecutive failed runs)--> failing   => "failure" alert
 *   failing         --(one passed run)-------------> passing   => "recovery" alert
 *   any             --(passed run with a newly slow step)----> => "slow" alert
 *
 * Runs with status "error" (browser crash, invalid URL) say nothing about the store and do
 * not move the state or alert the merchant.
 */
export type Health = 'unknown' | 'passing' | 'failing';
export type AlertKind = 'failure' | 'recovery' | 'slow';

export interface AlertState {
  health: Health;
  consecutiveFailures: number;
  slowSteps: string[];
}

export interface AlertDecision {
  kind: AlertKind;
  /** For slow alerts: the "device:step" keys that crossed the threshold on this run. */
  slowSteps?: string[];
}

export interface Transition {
  next: AlertState;
  healthChanged: boolean;
  alerts: AlertDecision[];
}

export function slowStepKeys(result: RunResult): string[] {
  return result.journeys.flatMap((journey) =>
    journey.steps.filter((step) => step.slow).map((step) => `${journey.device}:${step.name}`),
  );
}

export function evaluateTransition(
  previous: AlertState,
  result: Pick<RunResult, 'status' | 'journeys'>,
  alertAfterFailures: number,
): Transition {
  if (result.status === 'error') {
    return { next: previous, healthChanged: false, alerts: [] };
  }

  if (result.status === 'failed') {
    const consecutiveFailures = previous.consecutiveFailures + 1;
    const crossing = previous.health !== 'failing' && consecutiveFailures >= alertAfterFailures;
    return {
      next: {
        health: crossing ? 'failing' : previous.health,
        consecutiveFailures,
        slowSteps: previous.slowSteps,
      },
      healthChanged: crossing,
      alerts: crossing ? [{ kind: 'failure' }] : [],
    };
  }

  const alerts: AlertDecision[] = [];
  const recovered = previous.health === 'failing';
  if (recovered) alerts.push({ kind: 'recovery' });

  const current = slowStepKeys(result as RunResult);
  const newlySlow = current.filter((key) => !previous.slowSteps.includes(key));
  if (newlySlow.length > 0) alerts.push({ kind: 'slow', slowSteps: newlySlow });

  return {
    next: { health: 'passing', consecutiveFailures: 0, slowSteps: current },
    healthChanged: previous.health !== 'passing',
    alerts,
  };
}
