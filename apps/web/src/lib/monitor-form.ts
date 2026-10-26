import {
  MAX_ALERT_CHANNELS,
  MonitorPatchSchema,
  MonitorSpecSchema,
  cronIntervalMinutes,
  type AlertChannel,
  type AlertChannelPatch,
  type DeviceName,
  type MonitorPatch,
  type MonitorSpecInput,
  type RequestedPlatform,
} from '@checkout-sentinel/core/schemas';
import type { Monitor, RedactedChannel } from '../api/types';

/**
 * The create and edit form. Validation runs the API's own zod schemas (shared through
 * @checkout-sentinel/core/schemas) on the body the form is about to send, so the form accepts
 * and refuses exactly what the API does, field for field.
 */

export interface ChannelDraft {
  /** Stable key for list rendering. */
  key: number;
  /** stored: a channel the monitor already has, kept by index; new: entered in this form. */
  kind: 'stored' | 'new';
  type: 'webhook' | 'slack';
  /** For stored channels: their index in the monitor's alert list, and what the API shows. */
  storedIndex?: number;
  stored?: RedactedChannel;
  /** For new channels only. Stored channels never hold their URL or secret here. */
  url: string;
  secret: string;
}

export interface MonitorForm {
  name: string;
  url: string;
  platform: RequestedPlatform;
  devices: DeviceName[];
  schedule: string;
  timezone: string;
  /** Number inputs are kept as typed, so an empty or partial value can be reported. */
  slowStepMs: string;
  alertAfterFailures: string;
  enabled: boolean;
  alerts: ChannelDraft[];
}

/** Field path ("name", "alerts.1.url") to its first problem. */
export type FieldErrors = Record<string, string>;

export type PayloadResult<T> = { ok: true; payload: T } | { ok: false; errors: FieldErrors };

let nextKey = 1;

/** The API's defaults, read from the schema rather than repeated here. */
const DEFAULTS = MonitorSpecSchema.parse({ name: 'defaults', url: 'https://example.com/' });

export function emptyForm(): MonitorForm {
  return {
    name: '',
    url: '',
    platform: DEFAULTS.platform,
    devices: [...DEFAULTS.devices],
    schedule: DEFAULTS.schedule,
    timezone: DEFAULTS.timezone,
    slowStepMs: String(DEFAULTS.slowStepMs),
    alertAfterFailures: String(DEFAULTS.alertAfterFailures),
    enabled: DEFAULTS.enabled,
    alerts: [],
  };
}

export function formFromMonitor(monitor: Monitor): MonitorForm {
  return {
    name: monitor.name,
    url: monitor.url,
    platform: monitor.platform,
    devices: [...monitor.devices],
    schedule: monitor.schedule,
    timezone: monitor.timezone,
    slowStepMs: String(monitor.slowStepMs),
    alertAfterFailures: String(monitor.alertAfterFailures),
    enabled: monitor.enabled,
    alerts: monitor.alerts.map((channel, index) => ({
      key: nextKey++,
      kind: 'stored',
      type: channel.type,
      storedIndex: index,
      stored: channel,
      url: '',
      secret: '',
    })),
  };
}

export function addChannel(form: MonitorForm, type: ChannelDraft['type']): ChannelDraft | null {
  if (form.alerts.length >= MAX_ALERT_CHANNELS) return null;
  const draft: ChannelDraft = { key: nextKey++, kind: 'new', type, url: '', secret: '' };
  form.alerts.push(draft);
  return draft;
}

/** Whole numbers as typed; anything else becomes NaN, which the schema reports. */
function toNumber(value: string): number {
  return /^\s*-?\d+\s*$/.test(value) ? Number(value) : Number.NaN;
}

function newChannel(draft: ChannelDraft): AlertChannel {
  const url = draft.url.trim();
  if (draft.type === 'slack') return { type: 'slack', url };
  return draft.secret.length > 0
    ? { type: 'webhook', url, secret: draft.secret }
    : { type: 'webhook', url };
}

function channelPayload(draft: ChannelDraft): AlertChannelPatch {
  return draft.kind === 'stored'
    ? { type: 'stored', index: draft.storedIndex ?? -1 }
    : newChannel(draft);
}

interface Issue {
  code: string;
  path: PropertyKey[];
  message: string;
  origin?: string;
  expected?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
}

/** Plain wording for the schema's generic messages; custom messages are kept as they are. */
function messageFor(issue: Issue): string {
  const field = issue.path.join('.');
  switch (issue.code) {
    case 'invalid_type':
      if (issue.expected === 'number' || issue.expected === 'int') return 'Enter a whole number';
      return 'Required';
    case 'too_small':
      if (issue.origin === 'array') {
        return field === 'devices' ? 'Choose at least one device' : `Add at least ${issue.minimum}`;
      }
      if (issue.origin === 'string') {
        return Number(issue.minimum) <= 1
          ? 'Required'
          : `Must be at least ${issue.minimum} characters`;
      }
      return `Must be at least ${issue.minimum}`;
    case 'too_big':
      if (issue.origin === 'array') return `At most ${issue.maximum}`;
      if (issue.origin === 'string') return `Must be at most ${issue.maximum} characters`;
      return `Must be at most ${issue.maximum}`;
    default:
      return issue.message;
  }
}

export function errorsFromIssues(issues: readonly Issue[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const path = issue.path.map(String).join('.');
    errors[path] ??= messageFor(issue);
  }
  return errors;
}

export function toCreatePayload(form: MonitorForm): PayloadResult<MonitorSpecInput> {
  const payload: MonitorSpecInput = {
    name: form.name,
    url: form.url.trim(),
    platform: form.platform,
    devices: [...form.devices],
    schedule: form.schedule.trim(),
    timezone: form.timezone.trim(),
    slowStepMs: toNumber(form.slowStepMs),
    alertAfterFailures: toNumber(form.alertAfterFailures),
    enabled: form.enabled,
    alerts: form.alerts.filter((draft) => draft.kind === 'new').map(newChannel),
  };
  const parsed = MonitorSpecSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, errors: errorsFromIssues(parsed.error.issues) };
  return { ok: true, payload: { ...payload, name: parsed.data.name } };
}

function sameDevices(a: readonly DeviceName[], b: readonly DeviceName[]): boolean {
  return a.length === b.length && a.every((device) => b.includes(device));
}

function alertsUnchanged(form: MonitorForm, monitor: Monitor): boolean {
  return (
    form.alerts.length === monitor.alerts.length &&
    form.alerts.every(
      (draft, position) => draft.kind === 'stored' && draft.storedIndex === position,
    )
  );
}

/** A PATCH body with only the fields that differ from the monitor as loaded. */
export function toUpdatePayload(form: MonitorForm, monitor: Monitor): PayloadResult<MonitorPatch> {
  const payload: Record<string, unknown> = {};
  const name = form.name.trim();
  if (name !== monitor.name) payload.name = form.name;
  if (form.url.trim() !== monitor.url) payload.url = form.url.trim();
  if (form.platform !== monitor.platform) payload.platform = form.platform;
  if (!sameDevices(form.devices, monitor.devices)) payload.devices = [...form.devices];
  if (form.schedule.trim() !== monitor.schedule) payload.schedule = form.schedule.trim();
  if (form.timezone.trim() !== monitor.timezone) payload.timezone = form.timezone.trim();
  const slowStepMs = toNumber(form.slowStepMs);
  if (slowStepMs !== monitor.slowStepMs) payload.slowStepMs = slowStepMs;
  const alertAfterFailures = toNumber(form.alertAfterFailures);
  if (alertAfterFailures !== monitor.alertAfterFailures) {
    payload.alertAfterFailures = alertAfterFailures;
  }
  if (form.enabled !== monitor.enabled) payload.enabled = form.enabled;
  if (!alertsUnchanged(form, monitor)) {
    payload.alerts = form.alerts.map(channelPayload);
    // The list replaces the one this form loaded, and its stored indexes point into that one.
    payload.expectedUpdatedAt = monitor.updatedAt;
  }

  const parsed = MonitorPatchSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, errors: errorsFromIssues(parsed.error.issues) };
  return { ok: true, payload: payload as MonitorPatch };
}

/** A hint under the schedule field, or null when the expression does not parse. */
export function describeSchedule(expression: string): string | null {
  let minutes: number;
  try {
    minutes = cronIntervalMinutes(expression.trim());
  } catch {
    return null;
  }
  if (!Number.isFinite(minutes)) return null;
  const gap =
    minutes >= 60 && minutes % 60 === 0
      ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
      : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `Shortest gap between runs: ${gap}`;
}
