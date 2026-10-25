import { createServer, type Server } from 'node:http';
import type { WorkerMetrics } from './metrics.js';

/** Tiny HTTP server for Prometheus scraping and container health checks. */
export function startMetricsServer(
  metrics: WorkerMetrics,
  port: number,
  isHealthy: () => Promise<boolean>,
): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.url === '/metrics') {
        res.writeHead(200, { 'content-type': metrics.registry.contentType });
        res.end(await metrics.registry.metrics());
        return;
      }
      if (req.url === '/healthz') {
        const healthy = await isHealthy();
        res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: healthy ? 'ok' : 'unhealthy' }));
        return;
      }
      res.writeHead(404).end();
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
