import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AlertChannel, DeviceName, RunResult } from '@checkout-sentinel/core';

export const requestedPlatform = pgEnum('requested_platform', ['auto', 'shopify', 'woocommerce']);
export const runStatus = pgEnum('run_status', ['running', 'passed', 'failed', 'error']);
export const runTrigger = pgEnum('run_trigger', ['schedule', 'manual']);
export const monitorHealth = pgEnum('monitor_health', ['unknown', 'passing', 'failing']);
export const alertKind = pgEnum('alert_kind', ['failure', 'recovery', 'slow']);
export const deliveryStatus = pgEnum('delivery_status', ['pending', 'sent', 'failed']);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const monitors = pgTable(
  'monitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    platform: requestedPlatform('platform').notNull().default('auto'),
    devices: jsonb('devices').$type<DeviceName[]>().notNull(),
    schedule: text('schedule').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    slowStepMs: integer('slow_step_ms').notNull(),
    alertAfterFailures: integer('alert_after_failures').notNull(),
    alerts: jsonb('alerts')
      .$type<AlertChannel[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
  },
  (table) => [index('monitors_created_at_idx').on(table.createdAt)],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    trigger: runTrigger('trigger').notNull(),
    status: runStatus('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    detectedPlatform: text('detected_platform'),
    /** Name of the first failed step across journeys, for list views without parsing result. */
    failedStep: text('failed_step'),
    error: text('error'),
    /** Full RunResult (schema version 1). */
    result: jsonb('result').$type<RunResult>(),
  },
  (table) => [
    index('runs_monitor_started_idx').on(table.monitorId, table.startedAt.desc()),
    // Retention reads old runs across all monitors, oldest first.
    index('runs_started_idx').on(table.startedAt),
    // The stale-run sweep only looks at running rows; this index holds just those.
    index('runs_running_started_idx')
      .on(table.startedAt)
      .where(sql`${table.status} = 'running'`),
  ],
);

/** One row per monitor: the alerting state machine's memory and the "latest status" view. */
export const monitorState = pgTable('monitor_state', {
  monitorId: uuid('monitor_id')
    .primaryKey()
    .references(() => monitors.id, { onDelete: 'cascade' }),
  health: monitorHealth('health').notNull().default('unknown'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  /** Slow steps currently over threshold, as "device:step" keys, so a slow alert fires once per breach. */
  slowSteps: jsonb('slow_steps')
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  lastRunId: uuid('last_run_id'),
  lastRunStatus: runStatus('last_run_status'),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  healthChangedAt: timestamp('health_changed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const alertDeliveries = pgTable(
  'alert_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    kind: alertKind('kind').notNull(),
    /** Index into monitors.alerts at send time. */
    channelIndex: integer('channel_index').notNull(),
    channelType: text('channel_type').notNull(),
    status: deliveryStatus('status').notNull().default('pending'),
    responseStatus: integer('response_status'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [
    // Idempotency: a retried job cannot send the same alert for the same run twice.
    uniqueIndex('alert_deliveries_run_kind_channel_uq').on(
      table.runId,
      table.kind,
      table.channelIndex,
    ),
  ],
);

export type MonitorRow = typeof monitors.$inferSelect;
export type NewMonitorRow = typeof monitors.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type MonitorStateRow = typeof monitorState.$inferSelect;
export type AlertDeliveryRow = typeof alertDeliveries.$inferSelect;
