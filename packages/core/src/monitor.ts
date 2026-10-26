import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { DeviceNameSchema, RequestedPlatformSchema } from './schema.js';

/**
 * A monitor is a product URL checked on a schedule. The same schema validates the CLI's
 * YAML config and the API's request bodies, so a config file can be pushed to the API as is.
 */

/** Synthetic journeys add real items to real carts; checking more often than this is not polite. */
export const MIN_SCHEDULE_INTERVAL_MINUTES = 5;

export function cronIntervalMinutes(expression: string, tz = 'UTC'): number {
  const parsed = CronExpressionParser.parse(expression, { tz });
  let previous = parsed.next().getTime();
  let smallest = Number.POSITIVE_INFINITY;
  // Sample enough occurrences to catch irregular expressions such as "0,1 * * * *".
  for (let i = 0; i < 24; i += 1) {
    const next = parsed.next().getTime();
    smallest = Math.min(smallest, next - previous);
    previous = next;
  }
  return smallest / 60_000;
}

export const CronScheduleSchema = z.string().superRefine((value, ctx) => {
  let interval: number;
  try {
    interval = cronIntervalMinutes(value);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }
  if (interval < MIN_SCHEDULE_INTERVAL_MINUTES) {
    ctx.addIssue({
      code: 'custom',
      message: `Schedule runs every ${interval} minute(s); the minimum interval is ${MIN_SCHEDULE_INTERVAL_MINUTES} minutes`,
    });
  }
});

const HttpUrlSchema = z.url({ protocol: /^https?$/, error: 'Must be an http or https URL' });

const WebhookChannelSchema = z.object({
  type: z.literal('webhook'),
  url: HttpUrlSchema,
  /** When set, deliveries carry an X-Checkout-Sentinel-Signature HMAC-SHA256 header. */
  secret: z.string().min(16).optional(),
});

const SlackChannelSchema = z.object({
  type: z.literal('slack'),
  url: HttpUrlSchema,
});

export const AlertChannelSchema = z.discriminatedUnion('type', [
  WebhookChannelSchema,
  SlackChannelSchema,
]);
export type AlertChannel = z.infer<typeof AlertChannelSchema>;

/** Most alert channels one monitor may have. */
export const MAX_ALERT_CHANNELS = 10;

/**
 * In a PATCH, the channel stored at this index of the monitor's alert list (the order the API
 * returns it in), kept as it is. Slack URLs and webhook secrets are never returned, so this is
 * how a client keeps a channel it cannot send back in full.
 */
export const StoredChannelRefSchema = z
  .object({
    type: z.literal('stored'),
    index: z
      .number()
      .int()
      .min(0)
      .max(MAX_ALERT_CHANNELS - 1),
  })
  .strict();
export type StoredChannelRef = z.infer<typeof StoredChannelRefSchema>;

export const AlertChannelPatchSchema = z.discriminatedUnion('type', [
  WebhookChannelSchema,
  SlackChannelSchema,
  StoredChannelRefSchema,
]);
export type AlertChannelPatch = z.infer<typeof AlertChannelPatchSchema>;

export const TimeoutsSchema = z.object({
  /** Page loads (product page, checkout). */
  navigationMs: z.number().int().min(1_000).max(120_000).default(30_000),
  /** Waiting for elements, cart updates and other in-page work. */
  stepMs: z.number().int().min(500).max(120_000).default(15_000),
});
export type Timeouts = z.infer<typeof TimeoutsSchema>;

const fields = {
  name: z.string().trim().min(1).max(120),
  url: HttpUrlSchema,
  platform: RequestedPlatformSchema,
  devices: z.array(DeviceNameSchema).min(1).max(2),
  schedule: CronScheduleSchema,
  timezone: z.string().min(1),
  /** A passing step slower than this raises a slow-step alert. */
  slowStepMs: z.number().int().min(100).max(120_000),
  /** Consecutive failed runs before a failure alert; 2 filters one-off network blips. */
  alertAfterFailures: z.number().int().min(1).max(10),
  alerts: z.array(AlertChannelSchema).max(MAX_ALERT_CHANNELS),
  enabled: z.boolean(),
};

const alertsPatch = z
  .array(AlertChannelPatchSchema)
  .max(MAX_ALERT_CHANNELS)
  .superRefine((channels, ctx) => {
    const seen = new Set<number>();
    for (const [position, channel] of channels.entries()) {
      if (channel.type !== 'stored') continue;
      if (seen.has(channel.index)) {
        ctx.addIssue({
          code: 'custom',
          path: [position, 'index'],
          message: `Stored channel ${channel.index} is referenced more than once`,
        });
      }
      seen.add(channel.index);
    }
  });

export const MonitorSpecSchema = z.object({
  name: fields.name,
  url: fields.url,
  platform: fields.platform.default('auto'),
  devices: fields.devices.default(['desktop', 'mobile']),
  schedule: fields.schedule.default('*/15 * * * *'),
  timezone: fields.timezone.default('UTC'),
  slowStepMs: fields.slowStepMs.default(8_000),
  alertAfterFailures: fields.alertAfterFailures.default(2),
  alerts: fields.alerts.default([]),
  enabled: fields.enabled.default(true),
});
export type MonitorSpec = z.infer<typeof MonitorSpecSchema>;
export type MonitorSpecInput = z.input<typeof MonitorSpecSchema>;

/**
 * Partial update: only the fields sent change. No defaults, unlike MonitorSpecSchema.partial().
 * `alerts` replaces the whole list; its items may be stored channel references.
 */
export const MonitorPatchSchema = z
  .object({
    name: fields.name.optional(),
    url: fields.url.optional(),
    platform: fields.platform.optional(),
    devices: fields.devices.optional(),
    schedule: fields.schedule.optional(),
    timezone: fields.timezone.optional(),
    slowStepMs: fields.slowStepMs.optional(),
    alertAfterFailures: fields.alertAfterFailures.optional(),
    alerts: alertsPatch.optional(),
    enabled: fields.enabled.optional(),
  })
  .strict();
export type MonitorPatch = z.infer<typeof MonitorPatchSchema>;

export const MonitorsFileSchema = z.object({
  version: z.literal(1),
  defaults: z
    .object({
      timeouts: TimeoutsSchema.partial().optional(),
    })
    .optional(),
  monitors: z.array(MonitorSpecSchema).min(1),
});
export type MonitorsFile = z.infer<typeof MonitorsFileSchema>;
