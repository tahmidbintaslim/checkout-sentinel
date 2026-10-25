import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';

export const JOURNEY_QUEUE = 'checkout-journeys';

export const JourneyJobSchema = z.object({
  monitorId: z.uuid(),
  trigger: z.enum(['schedule', 'manual']),
});
export type JourneyJob = z.infer<typeof JourneyJobSchema>;

export function schedulerId(monitorId: string): string {
  return `monitor:${monitorId}`;
}

/** BullMQ needs maxRetriesPerRequest: null on connections used by workers (blocking commands). */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  // A journey that fails is a result, not an exception. Only infrastructure errors (browser
  // crash, database down) throw, and those get one retry.
  attempts: 2,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { count: 1_000, age: 7 * 24 * 3600 },
  removeOnFail: { count: 5_000, age: 30 * 24 * 3600 },
};

export interface SchedulableMonitor {
  id: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
}

/** API-side handle on the queue: keeps one BullMQ job scheduler per enabled monitor. */
export class JourneyScheduler {
  readonly queue: Queue<JourneyJob>;

  constructor(private readonly connection: Redis) {
    this.queue = new Queue<JourneyJob>(JOURNEY_QUEUE, {
      connection,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }

  /** Idempotent: creates, updates or removes the scheduler to match the monitor. */
  async sync(monitor: SchedulableMonitor): Promise<void> {
    if (!monitor.enabled) {
      await this.remove(monitor.id);
      return;
    }
    await this.queue.upsertJobScheduler(
      schedulerId(monitor.id),
      { pattern: monitor.schedule, tz: monitor.timezone },
      {
        name: 'journey',
        data: { monitorId: monitor.id, trigger: 'schedule' },
        opts: DEFAULT_JOB_OPTIONS,
      },
    );
  }

  async remove(monitorId: string): Promise<void> {
    await this.queue.removeJobScheduler(schedulerId(monitorId));
  }

  /** Drops schedulers whose monitor no longer exists (for example after a database restore). */
  async prune(knownMonitorIds: ReadonlySet<string>): Promise<number> {
    let removed = 0;
    for (const scheduler of await this.queue.getJobSchedulers()) {
      const id = scheduler.key.replace(/^monitor:/, '');
      if (!knownMonitorIds.has(id)) {
        await this.queue.removeJobScheduler(scheduler.key);
        removed += 1;
      }
    }
    return removed;
  }

  async enqueueNow(monitorId: string): Promise<string> {
    const job = await this.queue.add('journey', { monitorId, trigger: 'manual' });
    if (!job.id) throw new Error('queue returned a job without an id');
    return job.id;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.connection.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
