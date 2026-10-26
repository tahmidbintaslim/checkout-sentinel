import 'reflect-metadata';
import { Logger as NestLogger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { VERSION } from '@checkout-sentinel/core';
import { createDb, runMigrations } from '@checkout-sentinel/db';
import { AppModule } from './app.module.js';
import { createValidationPipe } from './common/validation.js';
import type { ApiConfig } from './config.js';
import {
  DEFAULT_DASHBOARD_DIR,
  apiPrefixAlias,
  dashboardHandler,
  hasDashboardBuild,
} from './dashboard/dashboard.js';
import type { AppOptions } from './infra.module.js';
import type { ApiMetrics } from './metrics/api-metrics.js';
import { API_METRICS } from './tokens.js';

export async function migrateIfEnabled(config: ApiConfig): Promise<void> {
  if (!config.MIGRATE_ON_BOOT) return;
  const handle = createDb(config.DATABASE_URL, { max: 1 });
  try {
    await runMigrations(handle);
  } finally {
    await handle.close();
  }
}

/** The dashboard directory to serve, or null when it is turned off or not built. */
export function dashboardDir(config: ApiConfig): string | null {
  const logger = new NestLogger('Dashboard');
  if (!config.DASHBOARD_ENABLED) {
    logger.log('DASHBOARD_ENABLED is false: the dashboard is not served');
    return null;
  }
  const dir = config.DASHBOARD_DIR ?? DEFAULT_DASHBOARD_DIR;
  if (!hasDashboardBuild(dir)) {
    const message = `No dashboard build in ${dir} (index.html missing): the dashboard is not served`;
    if (config.DASHBOARD_DIR) logger.warn(message);
    else logger.log(`${message}. Run pnpm build to build it.`);
    return null;
  }
  logger.log(`Serving the dashboard from ${dir}`);
  return dir;
}

/** Builds a fully configured app without listening, shared by main.ts and the e2e tests. */
export async function createApp(
  config: ApiConfig,
  options: AppOptions = {},
): Promise<INestApplication> {
  await migrateIfEnabled(config);
  const app = await NestFactory.create(AppModule.forConfig(config, options), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(createValidationPipe());
  // Order matters: the dashboard sees the path before the alias strips /api, and its files are
  // left out of the API's request metrics.
  const dashboard = dashboardDir(config);
  if (dashboard) app.use(dashboardHandler(dashboard));
  app.use(app.get<ApiMetrics>(API_METRICS).middleware());
  app.use(apiPrefixAlias());

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('checkout-sentinel API')
      .setDescription(
        'Monitors, run history and latest status for synthetic add-to-cart and checkout journeys.',
      )
      .setVersion(VERSION)
      // Every path below is also served without the prefix, as in v0.1.
      .addServer('/api')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json' });
  return app;
}
