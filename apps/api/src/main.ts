import { Logger } from 'nestjs-pino';
import { createApp } from './bootstrap.js';
import { loadApiConfig } from './config.js';

const config = loadApiConfig();
const app = await createApp(config);
await app.listen(config.PORT, config.HOST);

const logger = app.get(Logger);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logger.log(`${signal} received: draining HTTP connections and closing Postgres and Redis`);
    // app.close() stops the HTTP server, then runs onApplicationShutdown hooks (InfraModule).
    app.close().then(
      () => {
        logger.log('shutdown complete');
        process.exit(0);
      },
      (error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}
