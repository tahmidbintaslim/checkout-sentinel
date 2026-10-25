import type { NextFunction, Request, Response } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { DbHandle } from '@checkout-sentinel/db';

export class ApiMetrics {
  readonly registry = new Registry();

  readonly requests = new Counter({
    name: 'checkout_sentinel_api_requests_total',
    help: 'HTTP requests by method, matched route and status code',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [this.registry],
  });

  readonly latency = new Histogram({
    name: 'checkout_sentinel_api_request_duration_seconds',
    help: 'HTTP request latency by matched route',
    labelNames: ['method', 'route'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });

  constructor(db: DbHandle) {
    collectDefaultMetrics({ register: this.registry });
    new Gauge({
      name: 'checkout_sentinel_monitors',
      help: 'Monitors by enabled flag and current health (read from Postgres at scrape time)',
      labelNames: ['enabled', 'health'] as const,
      registers: [this.registry],
      async collect() {
        this.reset();
        const { rows } = await db.pool.query<{
          enabled: boolean;
          health: string | null;
          count: string;
        }>(
          `select m.enabled, coalesce(s.health::text, 'unknown') as health, count(*)::text as count
             from monitors m left join monitor_state s on s.monitor_id = m.id
            group by 1, 2`,
        );
        for (const row of rows) {
          this.set(
            { enabled: String(row.enabled), health: row.health ?? 'unknown' },
            Number(row.count),
          );
        }
      },
    });
  }

  /** Express middleware; labels by the matched route pattern to keep cardinality bounded. */
  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const stop = this.latency.startTimer();
      res.on('finish', () => {
        const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
        stop({ method: req.method, route });
        this.requests.inc({ method: req.method, route, status: String(res.statusCode) });
      });
      next();
    };
  }
}
