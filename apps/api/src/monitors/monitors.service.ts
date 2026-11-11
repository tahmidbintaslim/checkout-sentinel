import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { MonitorPatch, MonitorSpec, TargetGuard } from '@checkout-sentinel/core';
import {
  StaleMonitorError,
  UnknownStoredChannelError,
  type MonitorRepository,
  type MonitorWithState,
} from '@checkout-sentinel/db';
import type { JourneyScheduler } from '@checkout-sentinel/jobs';
import { validationError } from '../common/validation.js';
import { MONITOR_REPOSITORY, SCHEDULER, TARGET_GUARD } from '../tokens.js';
import { findTargetIssues } from './targets.js';

@Injectable()
export class MonitorsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MonitorsService.name);

  constructor(
    @Inject(MONITOR_REPOSITORY) private readonly monitors: MonitorRepository,
    @Inject(SCHEDULER) private readonly scheduler: JourneyScheduler,
    @Inject(TARGET_GUARD) private readonly targets: TargetGuard,
  ) {}

  /**
   * Postgres is the source of truth for schedules. On boot, every monitor's BullMQ job
   * scheduler is re-upserted and orphans are removed, which repairs Redis after a flush or
   * a failed write between the two stores.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.targets.permissive) {
      this.logger.warn(
        'ALLOW_PRIVATE_TARGETS is on: monitors and alerts may point at private and internal addresses. Use it only for local development.',
      );
    }
    const all = await this.monitors.list();
    for (const monitor of all) await this.scheduler.sync(monitor);
    const removed = await this.scheduler.prune(new Set(all.map((m) => m.id)));
    this.logger.log(`Reconciled ${all.length} monitor schedule(s), removed ${removed} orphan(s)`);
  }

  list(workspaceId: string): Promise<MonitorWithState[]> {
    return this.monitors.list(workspaceId);
  }

  /** 404 for a monitor of another workspace too, so ids do not leak across workspaces. */
  async get(id: string, workspaceId: string): Promise<MonitorWithState> {
    const monitor = await this.monitors.get(id, workspaceId);
    if (!monitor) throw new NotFoundException(`Monitor ${id} not found`);
    return monitor;
  }

  /** Input-time SSRF check; the worker checks again at use time, since DNS can change. */
  private async assertTargetsAllowed(spec: MonitorPatch): Promise<void> {
    const issues = await findTargetIssues(this.targets, spec);
    if (issues.length > 0) throw validationError(issues);
  }

  async create(spec: MonitorSpec, workspaceId: string): Promise<MonitorWithState> {
    await this.assertTargetsAllowed(spec);
    const row = await this.monitors.create(spec, workspaceId);
    await this.scheduler.sync(row);
    return this.get(row.id, workspaceId);
  }

  async update(id: string, patch: MonitorPatch, workspaceId: string): Promise<MonitorWithState> {
    await this.assertTargetsAllowed(patch);
    const row = await this.monitors.update(id, patch, workspaceId).catch((error: unknown) => {
      if (error instanceof StaleMonitorError) {
        throw new ConflictException(
          `The monitor changed after expectedUpdatedAt (${patch.expectedUpdatedAt}); its updatedAt is now ${error.updatedAt.toISOString()}. Read it again and resend the change.`,
        );
      }
      if (!(error instanceof UnknownStoredChannelError)) throw error;
      throw validationError(
        error.positions.map((position) => ({
          path: `alerts.${position}.index`,
          message: `No stored alert channel at this index; the monitor has ${error.storedCount}`,
        })),
      );
    });
    if (!row) throw new NotFoundException(`Monitor ${id} not found`);
    await this.scheduler.sync(row);
    return this.get(id, workspaceId);
  }

  async remove(id: string, workspaceId: string): Promise<void> {
    const deleted = await this.monitors.delete(id, workspaceId);
    if (!deleted) throw new NotFoundException(`Monitor ${id} not found`);
    await this.scheduler.remove(id);
  }

  async runNow(id: string, workspaceId: string): Promise<{ jobId: string }> {
    await this.get(id, workspaceId);
    return { jobId: await this.scheduler.enqueueNow(id) };
  }
}
