import type { AlertChannel } from '@checkout-sentinel/core';
import type { MonitorRow, MonitorStateRow, MonitorWithState, RunRow } from '@checkout-sentinel/db';

/**
 * Webhook secrets are write-only and Slack webhook URLs are credentials, so neither is
 * returned in full. Clients that PATCH alerts send the complete list again, keeping a stored
 * channel with { "type": "stored", "index": <its position in this list> }.
 */
export function redactChannel(channel: AlertChannel) {
  if (channel.type === 'slack') {
    const url = new URL(channel.url);
    return { type: channel.type, url: `${url.origin}/...${channel.url.slice(-4)}` };
  }
  return { type: channel.type, url: channel.url, hasSecret: Boolean(channel.secret) };
}

export function toStatusDto(state: MonitorStateRow | null) {
  return {
    health: state?.health ?? 'unknown',
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    slowSteps: state?.slowSteps ?? [],
    lastRunId: state?.lastRunId ?? null,
    lastRunStatus: state?.lastRunStatus ?? null,
    lastRunAt: state?.lastRunAt?.toISOString() ?? null,
    healthChangedAt: state?.healthChangedAt?.toISOString() ?? null,
  };
}

export function toMonitorDto(monitor: MonitorRow | MonitorWithState) {
  return {
    id: monitor.id,
    name: monitor.name,
    url: monitor.url,
    platform: monitor.platform,
    devices: monitor.devices,
    schedule: monitor.schedule,
    timezone: monitor.timezone,
    slowStepMs: monitor.slowStepMs,
    alertAfterFailures: monitor.alertAfterFailures,
    alerts: monitor.alerts.map(redactChannel),
    enabled: monitor.enabled,
    createdAt: monitor.createdAt.toISOString(),
    updatedAt: monitor.updatedAt.toISOString(),
    status: toStatusDto('state' in monitor ? monitor.state : null),
  };
}

export function toRunSummaryDto(run: RunRow) {
  return {
    id: run.id,
    monitorId: run.monitorId,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    durationMs: run.durationMs,
    detectedPlatform: run.detectedPlatform,
    failedStep: run.failedStep,
    error: run.error,
  };
}
