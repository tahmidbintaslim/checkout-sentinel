import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { MonitorSpec, RunResult } from '@checkout-sentinel/core';
import type { Database } from './client.js';
import {
  alertDeliveries,
  monitorState,
  monitors,
  runs,
  type AlertDeliveryRow,
  type MonitorRow,
  type MonitorStateRow,
  type RunRow,
} from './schema.js';

export type MonitorWithState = MonitorRow & { state: MonitorStateRow | null };

function specToRow(spec: Partial<MonitorSpec>) {
  return {
    ...(spec.name !== undefined ? { name: spec.name } : {}),
    ...(spec.url !== undefined ? { url: spec.url } : {}),
    ...(spec.platform !== undefined ? { platform: spec.platform } : {}),
    ...(spec.devices !== undefined ? { devices: spec.devices } : {}),
    ...(spec.schedule !== undefined ? { schedule: spec.schedule } : {}),
    ...(spec.timezone !== undefined ? { timezone: spec.timezone } : {}),
    ...(spec.slowStepMs !== undefined ? { slowStepMs: spec.slowStepMs } : {}),
    ...(spec.alertAfterFailures !== undefined
      ? { alertAfterFailures: spec.alertAfterFailures }
      : {}),
    ...(spec.alerts !== undefined ? { alerts: spec.alerts } : {}),
    ...(spec.enabled !== undefined ? { enabled: spec.enabled } : {}),
  };
}

export class MonitorRepository {
  constructor(private readonly db: Database) {}

  async create(spec: MonitorSpec): Promise<MonitorRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(monitors)
        .values({
          name: spec.name,
          url: spec.url,
          platform: spec.platform,
          devices: spec.devices,
          schedule: spec.schedule,
          timezone: spec.timezone,
          slowStepMs: spec.slowStepMs,
          alertAfterFailures: spec.alertAfterFailures,
          alerts: spec.alerts,
          enabled: spec.enabled,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      await tx.insert(monitorState).values({ monitorId: row.id });
      return row;
    });
  }

  async list(): Promise<MonitorWithState[]> {
    const rows = await this.db
      .select()
      .from(monitors)
      .leftJoin(monitorState, eq(monitorState.monitorId, monitors.id))
      .orderBy(desc(monitors.createdAt));
    return rows.map((r) => ({ ...r.monitors, state: r.monitor_state }));
  }

  async listEnabled(): Promise<MonitorRow[]> {
    return this.db.select().from(monitors).where(eq(monitors.enabled, true));
  }

  async get(id: string): Promise<MonitorWithState | null> {
    const [row] = await this.db
      .select()
      .from(monitors)
      .leftJoin(monitorState, eq(monitorState.monitorId, monitors.id))
      .where(eq(monitors.id, id));
    return row ? { ...row.monitors, state: row.monitor_state } : null;
  }

  async update(id: string, patch: Partial<MonitorSpec>): Promise<MonitorRow | null> {
    const values = specToRow(patch);
    if (Object.keys(values).length === 0) return this.get(id);
    const [row] = await this.db
      .update(monitors)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(monitors.id, id))
      .returning();
    return row ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(monitors)
      .where(eq(monitors.id, id))
      .returning({ id: monitors.id });
    return deleted.length > 0;
  }
}

export interface RunPage {
  items: RunRow[];
  /** Pass as `before` to get the next (older) page. */
  nextCursor: string | null;
}

export class RunRepository {
  constructor(private readonly db: Database) {}

  async start(monitorId: string, trigger: 'schedule' | 'manual'): Promise<RunRow> {
    const [row] = await this.db.insert(runs).values({ monitorId, trigger }).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async finish(runId: string, result: RunResult): Promise<RunRow> {
    const failedStep = result.journeys.find((j) => j.failedStep)?.failedStep ?? null;
    const [row] = await this.db
      .update(runs)
      .set({
        status: result.status,
        finishedAt: new Date(result.finishedAt),
        durationMs: result.durationMs,
        detectedPlatform: result.journeys.find((j) => j.platform)?.platform?.detected ?? null,
        failedStep,
        error: result.error?.message ?? null,
        result,
      })
      .where(eq(runs.id, runId))
      .returning();
    if (!row) throw new Error(`run ${runId} not found`);
    return row;
  }

  async fail(runId: string, message: string): Promise<void> {
    await this.db
      .update(runs)
      .set({ status: 'error', finishedAt: new Date(), error: message })
      .where(eq(runs.id, runId));
  }

  async get(runId: string): Promise<RunRow | null> {
    const [row] = await this.db.select().from(runs).where(eq(runs.id, runId));
    return row ?? null;
  }

  /** Newest first, keyset-paginated on started_at. The heavy result column is left out. */
  async listForMonitor(monitorId: string, limit: number, before?: Date): Promise<RunPage> {
    const rows = await this.db
      .select({
        id: runs.id,
        monitorId: runs.monitorId,
        trigger: runs.trigger,
        status: runs.status,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
        durationMs: runs.durationMs,
        detectedPlatform: runs.detectedPlatform,
        failedStep: runs.failedStep,
        error: runs.error,
        result: sql<null>`null`,
      })
      .from(runs)
      .where(and(eq(runs.monitorId, monitorId), before ? lt(runs.startedAt, before) : undefined))
      .orderBy(desc(runs.startedAt))
      .limit(limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? last.startedAt.toISOString() : null,
    };
  }
}

export interface StateUpdate {
  health: MonitorStateRow['health'];
  consecutiveFailures: number;
  slowSteps: string[];
  lastRunId: string;
  lastRunStatus: NonNullable<MonitorStateRow['lastRunStatus']>;
  lastRunAt: Date;
  healthChanged: boolean;
}

export class StateRepository {
  constructor(private readonly db: Database) {}

  /**
   * Runs fn with the monitor's state row locked (SELECT ... FOR UPDATE), so two runs of the
   * same monitor finishing together cannot both decide to alert.
   */
  async withLockedState<T>(
    monitorId: string,
    fn: (state: MonitorStateRow) => Promise<{ update: StateUpdate; value: T }>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.insert(monitorState).values({ monitorId }).onConflictDoNothing();
      const [state] = await tx
        .select()
        .from(monitorState)
        .where(eq(monitorState.monitorId, monitorId))
        .for('update');
      if (!state) throw new Error(`monitor_state for ${monitorId} missing`);
      const { update, value } = await fn(state);
      await tx
        .update(monitorState)
        .set({
          health: update.health,
          consecutiveFailures: update.consecutiveFailures,
          slowSteps: update.slowSteps,
          lastRunId: update.lastRunId,
          lastRunStatus: update.lastRunStatus,
          lastRunAt: update.lastRunAt,
          ...(update.healthChanged ? { healthChangedAt: update.lastRunAt } : {}),
          updatedAt: new Date(),
        })
        .where(eq(monitorState.monitorId, monitorId));
      return value;
    });
  }
}

export class AlertDeliveryRepository {
  constructor(private readonly db: Database) {}

  /** Returns null when this (run, kind, channel) was already claimed: the alert is a duplicate. */
  async claim(input: {
    monitorId: string;
    runId: string;
    kind: AlertDeliveryRow['kind'];
    channelIndex: number;
    channelType: string;
  }): Promise<AlertDeliveryRow | null> {
    const [row] = await this.db
      .insert(alertDeliveries)
      .values(input)
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  async markSent(id: string, responseStatus: number): Promise<void> {
    await this.db
      .update(alertDeliveries)
      .set({ status: 'sent', responseStatus, sentAt: new Date() })
      .where(eq(alertDeliveries.id, id));
  }

  async markFailed(id: string, error: string, responseStatus?: number): Promise<void> {
    await this.db
      .update(alertDeliveries)
      .set({ status: 'failed', error, responseStatus: responseStatus ?? null })
      .where(eq(alertDeliveries.id, id));
  }

  async listForMonitor(monitorId: string, limit = 50): Promise<AlertDeliveryRow[]> {
    return this.db
      .select()
      .from(alertDeliveries)
      .where(eq(alertDeliveries.monitorId, monitorId))
      .orderBy(desc(alertDeliveries.createdAt))
      .limit(limit);
  }
}
