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

export const AlertChannelSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('webhook'),
    url: HttpUrlSchema,
    /** When set, deliveries carry an X-Checkout-Sentinel-Signature HMAC-SHA256 header. */
    secret: z.string().min(16).optional(),
  }),
  z.object({
    type: z.literal('slack'),
    url: HttpUrlSchema,
  }),
]);
export type AlertChannel = z.infer<typeof AlertChannelSchema>;

export const TimeoutsSchema = z.object({
  /** Page loads (product page, checkout). */
  navigationMs: z.number().int().min(1_000).max(120_000).default(30_000),
  /** Waiting for elements, cart updates and other in-page work. */
  stepMs: z.number().int().min(500).max(120_000).default(15_000),
});
export type Timeouts = z.infer<typeof TimeoutsSchema>;

export const MonitorSpecSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: HttpUrlSchema,
  platform: RequestedPlatformSchema.default('auto'),
  devices: z.array(DeviceNameSchema).min(1).max(2).default(['desktop', 'mobile']),
  schedule: CronScheduleSchema.default('*/15 * * * *'),
  timezone: z.string().default('UTC'),
  /** A passing step slower than this raises a slow-step alert. */
  slowStepMs: z.number().int().min(100).max(120_000).default(8_000),
  /** Consecutive failed runs before a failure alert; 2 filters one-off network blips. */
  alertAfterFailures: z.number().int().min(1).max(10).default(2),
  alerts: z.array(AlertChannelSchema).max(10).default([]),
  enabled: z.boolean().default(true),
});
export type MonitorSpec = z.infer<typeof MonitorSpecSchema>;
export type MonitorSpecInput = z.input<typeof MonitorSpecSchema>;

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
