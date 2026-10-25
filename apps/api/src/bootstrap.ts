import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { VERSION } from '@checkout-sentinel/core';
import { createDb, runMigrations } from '@checkout-sentinel/db';
import { AppModule } from './app.module.js';
import { createValidationPipe } from './common/validation.js';
import type { ApiConfig } from './config.js';
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

/** Builds a fully configured app without listening, shared by main.ts and the e2e tests. */
export async function createApp(config: ApiConfig): Promise<INestApplication> {
  await migrateIfEnabled(config);
  const app = await NestFactory.create(AppModule.forConfig(config), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(createValidationPipe());
  app.use(app.get<ApiMetrics>(API_METRICS).middleware());

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('checkout-sentinel API')
      .setDescription(
        'Monitors, run history and latest status for synthetic add-to-cart and checkout journeys.',
      )
      .setVersion(VERSION)
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json' });
  return app;
}
