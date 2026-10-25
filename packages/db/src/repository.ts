import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
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

  async listIds(): Promise<string[]> {
    const rows = await this.db.select({ id: monitors.id }).from(monitors);
    return rows.map((row) => row.id);
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

export interface LostRun {
  id: string;
  monitorId: string;
  startedAt: Date;
}

export interface DeletedRun {
  id: string;
  monitorId: string;
}

export class RunRepository {
  constructor(private readonly db: Database) {}

  async start(monitorId: string, trigger: 'schedule' | 'manual'): Promise<RunRow> {
    const [row] = await this.db.insert(runs).values({ monitorId, trigger }).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  /**
   * Stores the run's result. A run's final status is written once: if the row is no longer
   * "running" (the sweeper marked it lost, or it was deleted), nothing is written and null is
   * returned, so a result that arrives late cannot overwrite the sweep's verdict.
   */
  async finish(runId: string, result: RunResult): Promise<RunRow | null> {
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
      .where(and(eq(runs.id, runId), eq(runs.status, 'running')))
      .returning();
    return row ?? null;
  }

  /** Marks a run that threw as error. Like finish, it only changes a run that is still running. */
  async fail(runId: string, message: string): Promise<void> {
    await this.db
      .update(runs)
      .set({ status: 'error', finishedAt: new Date(), error: message })
      .where(and(eq(runs.id, runId), eq(runs.status, 'running')));
  }

  /**
   * Marks runs that are still "running" staleAfterMs after they started (database clock) as
   * error, oldest first. A row that a finishing worker holds locked is skipped, so its result
   * wins. monitor_state is not touched: an error says nothing about the store.
   */
  async markLost(staleAfterMs: number, error: string, limit = 1_000): Promise<LostRun[]> {
    const stale = this.db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.status, 'running'),
          lt(runs.startedAt, sql`now() - make_interval(secs => ${staleAfterMs / 1000})`),
        ),
      )
      .orderBy(runs.startedAt)
      .limit(limit)
      .for('update', { skipLocked: true });
    return this.db
      .update(runs)
      .set({ status: 'error', finishedAt: sql`now()`, error })
      .where(and(eq(runs.status, 'running'), inArray(runs.id, stale)))
      .returning({ id: runs.id, monitorId: runs.monitorId, startedAt: runs.startedAt });
  }

  /**
   * Deletes up to `limit` finished runs that started more than olderThanDays ago (database
   * clock), oldest first. Their alert deliveries go with them (foreign key cascade). These are
   * kept whatever their age:
   * - each monitor's latest run, so its history is never empty;
   * - the run monitor_state.last_run_id points at;
   * - the run behind each monitor's latest alert of each kind, so the delivery rows of the
   *   current state (for example the failure alert of an incident still open) stay;
   * - runs still "running"; the sweeper finishes those first.
   * Rows locked by a concurrent pass are skipped, so two passes never wait on each other.
   */
  async deleteExpired(olderThanDays: number, limit: number): Promise<DeletedRun[]> {
    const deleted = await this.db.execute<{ id: string; monitor_id: string }>(sql`
      delete from ${runs}
      where id in (
        select r.id
        from ${runs} r
        where r.started_at < now() - make_interval(days => ${olderThanDays})
          and r.status <> 'running'
          and exists (
            select 1 from ${runs} newer
            where newer.monitor_id = r.monitor_id
              and (newer.started_at, newer.id) > (r.started_at, r.id)
          )
          and r.id not in (
            select last_run_id from ${monitorState} where last_run_id is not null
          )
          and r.id not in (
            select distinct on (monitor_id, kind) run_id
            from ${alertDeliveries}
            order by monitor_id, kind, created_at desc, id desc
          )
        order by r.started_at
        limit ${limit}
        for update of r skip locked
      )
      returning id, monitor_id
    `);
    return deleted.rows.map((row) => ({ id: row.id, monitorId: row.monitor_id }));
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
