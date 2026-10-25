import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ApiTokenGuard } from './common/auth.guard.js';
import type { ApiConfig } from './config.js';
import { HealthController } from './health/health.controller.js';
import { InfraModule, type AppOptions } from './infra.module.js';
import { MetricsController } from './metrics/metrics.controller.js';
import { MonitorsController } from './monitors/monitors.controller.js';
import { MonitorsService } from './monitors/monitors.service.js';
import { RunsController } from './runs/runs.controller.js';

@Module({})
export class AppModule {
  static forConfig(config: ApiConfig, options: AppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        InfraModule.forConfig(config, options),
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.LOG_LEVEL,
            base: { service: 'checkout-sentinel-api' },
            redact: ['req.headers.authorization', 'req.headers.cookie'],
            autoLogging: {
              ignore: (req) => req.url === '/health' || req.url === '/metrics',
            },
          },
        }),
      ],
      controllers: [HealthController, MetricsController, MonitorsController, RunsController],
      providers: [MonitorsService, { provide: APP_GUARD, useClass: ApiTokenGuard }],
    };
  }
}
