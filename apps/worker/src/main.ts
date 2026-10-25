import { loadConfig } from './config.js';
import { startWorker } from './worker.js';

const running = await startWorker(loadConfig());

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    running.logger.info({ signal }, 'signal received');
    // Docker sends SIGKILL after its stop timeout (30s in docker-compose.yml).
    running.shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        running.logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}
