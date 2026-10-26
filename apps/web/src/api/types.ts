import type {
  DeviceName,
  RequestedPlatform,
  RunResult,
  StepName,
} from '@checkout-sentinel/core/schemas';

/** Response shapes of the checkout-sentinel API, as apps/api/src/monitors/monitor.mapper.ts writes them. */

export type Health = 'unknown' | 'passing' | 'failing';
export type RunStatus = 'running' | 'passed' | 'failed' | 'error';

export interface MonitorStatus {
  health: Health;
  consecutiveFailures: number;
  /** "device:step" keys of passing steps currently over the slow threshold. */
  slowSteps: string[];
  lastRunId: string | null;
  lastRunStatus: RunStatus | null;
  lastRunAt: string | null;
  healthChangedAt: string | null;
}

/** Slack URLs come back masked and webhook secrets not at all. */
export type RedactedChannel =
  { type: 'slack'; url: string } | { type: 'webhook'; url: string; hasSecret: boolean };

export interface Monitor {
  id: string;
  name: string;
  url: string;
  platform: RequestedPlatform;
  devices: DeviceName[];
  schedule: string;
  timezone: string;
  slowStepMs: number;
  alertAfterFailures: number;
  alerts: RedactedChannel[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  status: MonitorStatus;
}

export interface RunSummary {
  id: string;
  monitorId: string;
  trigger: 'schedule' | 'manual';
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  detectedPlatform: string | null;
  failedStep: StepName | null;
  error: string | null;
}

export interface RunArtifact {
  name: string;
  kind: 'screenshot' | 'trace';
  device: DeviceName;
  step?: StepName;
}

export interface RunDetail extends RunSummary {
  artifacts: RunArtifact[];
  /** Null while the run is still running, or when it ended without a result (worker lost). */
  result: RunResult | null;
}

export interface Page<T> {
  items: T[];
  /** Pass as `before` for the next, older page. */
  nextCursor: string | null;
}

export interface AlertEntry {
  id: string;
  runId: string;
  monitorId: string;
  monitorName: string;
  kind: 'failure' | 'recovery' | 'slow';
  channelType: string;
  status: 'pending' | 'sent' | 'failed';
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface ValidationIssue {
  /** Dotted path into the request body, for example "alerts.0.url". */
  path: string;
  message: string;
}
