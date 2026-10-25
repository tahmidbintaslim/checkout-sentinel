import type { RunResult } from '@checkout-sentinel/core';
import type { AlertDecision } from './state-machine.js';

export interface AlertContext {
  monitor: { id: string; name: string; url: string };
  runId: string;
  result: RunResult;
  decision: AlertDecision;
  /** Base URL of the API, for links back to the run. Optional. */
  publicBaseUrl?: string;
}

export interface FailureSummary {
  device: string;
  step: string;
  message: string;
}

export function failureSummaries(result: RunResult): FailureSummary[] {
  return result.journeys.flatMap((journey) => {
    const step = journey.steps.find((s) => s.status === 'failed');
    return step ? [{ device: journey.device, step: step.name, message: step.message ?? '' }] : [];
  });
}

export const WEBHOOK_EVENT = 'checkout_sentinel.alert';
export const WEBHOOK_PAYLOAD_VERSION = 1;

/** Generic webhook body. Versioned separately from the run result it summarizes. */
export function webhookPayload(context: AlertContext): Record<string, unknown> {
  const { monitor, runId, result, decision } = context;
  return {
    event: WEBHOOK_EVENT,
    version: WEBHOOK_PAYLOAD_VERSION,
    kind: decision.kind,
    monitor,
    run: {
      id: runId,
      status: result.status,
      startedAt: result.startedAt,
      durationMs: result.durationMs,
      failures: failureSummaries(result),
      slowSteps: decision.slowSteps ?? [],
      ...(context.publicBaseUrl ? { url: `${context.publicBaseUrl}/runs/${runId}` } : {}),
    },
    occurredAt: result.finishedAt,
  };
}

function headline(context: AlertContext): string {
  const name = context.monitor.name;
  switch (context.decision.kind) {
    case 'failure':
      return `Checkout journey failing: ${name}`;
    case 'recovery':
      return `Checkout journey recovered: ${name}`;
    case 'slow':
      return `Checkout journey slow: ${name}`;
  }
}

/** Slack incoming webhook body (mrkdwn text; works without a Slack app). */
export function slackPayload(context: AlertContext): { text: string } {
  const lines = [`*${headline(context)}*`, context.monitor.url];
  if (context.decision.kind === 'failure') {
    for (const failure of failureSummaries(context.result)) {
      lines.push(`- ${failure.device}: \`${failure.step}\` ${failure.message}`);
    }
  }
  if (context.decision.kind === 'slow') {
    lines.push(`Slow steps: ${(context.decision.slowSteps ?? []).join(', ')}`);
  }
  if (context.publicBaseUrl) lines.push(`${context.publicBaseUrl}/runs/${context.runId}`);
  return { text: lines.join('\n') };
}
