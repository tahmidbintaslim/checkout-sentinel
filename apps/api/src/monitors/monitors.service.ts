import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { MonitorPatch, MonitorSpec } from '@checkout-sentinel/core';
import type { MonitorRepository, MonitorWithState } from '@checkout-sentinel/db';
import type { JourneyScheduler } from '@checkout-sentinel/jobs';
import { MONITOR_REPOSITORY, SCHEDULER } from '../tokens.js';

@Injectable()
export class MonitorsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MonitorsService.name);

  constructor(
    @Inject(MONITOR_REPOSITORY) private readonly monitors: MonitorRepository,
    @Inject(SCHEDULER) private readonly scheduler: JourneyScheduler,
  ) {}

  /**
   * Postgres is the source of truth for schedules. On boot, every monitor's BullMQ job
   * scheduler is re-upserted and orphans are removed, which repairs Redis after a flush or
   * a failed write between the two stores.
   */
  async onApplicationBootstrap(): Promise<void> {
    const all = await this.monitors.list();
    for (const monitor of all) await this.scheduler.sync(monitor);
    const removed = await this.scheduler.prune(new Set(all.map((m) => m.id)));
    this.logger.log(`Reconciled ${all.length} monitor schedule(s), removed ${removed} orphan(s)`);
  }

  list(): Promise<MonitorWithState[]> {
    return this.monitors.list();
  }

  async get(id: string): Promise<MonitorWithState> {
    const monitor = await this.monitors.get(id);
    if (!monitor) throw new NotFoundException(`Monitor ${id} not found`);
    return monitor;
  }

  async create(spec: MonitorSpec): Promise<MonitorWithState> {
    const row = await this.monitors.create(spec);
    await this.scheduler.sync(row);
    return this.get(row.id);
  }

  async update(id: string, patch: MonitorPatch): Promise<MonitorWithState> {
    const row = await this.monitors.update(id, patch);
    if (!row) throw new NotFoundException(`Monitor ${id} not found`);
    await this.scheduler.sync(row);
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.monitors.delete(id);
    if (!deleted) throw new NotFoundException(`Monitor ${id} not found`);
    await this.scheduler.remove(id);
  }

  async runNow(id: string): Promise<{ jobId: string }> {
    await this.get(id);
    return { jobId: await this.scheduler.enqueueNow(id) };
  }
}
