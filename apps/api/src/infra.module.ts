import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  AlertDeliveryRepository,
  MonitorRepository,
  RunRepository,
  createDb,
  type DbHandle,
} from '@checkout-sentinel/db';
import { TargetGuard, targetPolicyFromEnv, type ResolveHost } from '@checkout-sentinel/core';
import { JourneyScheduler, createRedis } from '@checkout-sentinel/jobs';
import type { ApiConfig } from './config.js';
import { ApiMetrics } from './metrics/api-metrics.js';
import {
  API_CONFIG,
  API_METRICS,
  DB_HANDLE,
  DELIVERY_REPOSITORY,
  MONITOR_REPOSITORY,
  REDIS,
  RUN_REPOSITORY,
  SCHEDULER,
  TARGET_GUARD,
} from './tokens.js';

/** Overrides for tests; production uses the defaults. */
export interface AppOptions {
  /** Replaces the system DNS resolver used by the SSRF guard. */
  resolveHost?: ResolveHost;
}

@Global()
@Module({})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(SCHEDULER) private readonly scheduler: JourneyScheduler,
  ) {}

  static forConfig(config: ApiConfig, options: AppOptions = {}) {
    return {
      module: InfraModule,
      providers: [
        { provide: API_CONFIG, useValue: config },
        {
          provide: TARGET_GUARD,
          useFactory: () => {
            const logger = new Logger('TargetGuard');
            return new TargetGuard(targetPolicyFromEnv(config), {
              ...(options.resolveHost ? { resolve: options.resolveHost } : {}),
              // The 400 names the host only; operators get the address here.
              onDnsRefusal: ({ host, address, range }) => {
                logger.debug(`Refused ${host}: resolves to ${address} (${range})`);
              },
            });
          },
        },
        { provide: DB_HANDLE, useFactory: () => createDb(config.DATABASE_URL) },
        { provide: REDIS, useFactory: () => createRedis(config.REDIS_URL) },
        {
          provide: SCHEDULER,
          inject: [REDIS],
          useFactory: (redis: Redis) => new JourneyScheduler(redis),
        },
        {
          provide: MONITOR_REPOSITORY,
          inject: [DB_HANDLE],
          useFactory: (db: DbHandle) => new MonitorRepository(db.db),
        },
        {
          provide: RUN_REPOSITORY,
          inject: [DB_HANDLE],
          useFactory: (db: DbHandle) => new RunRepository(db.db),
        },
        {
          provide: DELIVERY_REPOSITORY,
          inject: [DB_HANDLE],
          useFactory: (db: DbHandle) => new AlertDeliveryRepository(db.db),
        },
        {
          provide: API_METRICS,
          inject: [DB_HANDLE],
          useFactory: (db: DbHandle) => new ApiMetrics(db),
        },
      ],
      exports: [
        API_CONFIG,
        DB_HANDLE,
        REDIS,
        SCHEDULER,
        MONITOR_REPOSITORY,
        RUN_REPOSITORY,
        DELIVERY_REPOSITORY,
        API_METRICS,
        TARGET_GUARD,
      ],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.scheduler.close();
    this.redis.disconnect();
    await this.db.close();
  }
}
