import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  /** Concurrent journeys allowed against one store host, across all workers. */
  PER_STORE_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(1),
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9465),
  ARTIFACTS_DIR: z.string().default('./artifacts'),
  PUBLIC_BASE_URL: z.url().optional(),
  USER_AGENT_CONTACT_URL: z.url().optional(),
  ALERT_TIMEOUT_MS: z.coerce.number().int().min(500).default(10_000),
  NAVIGATION_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
  STEP_TIMEOUT_MS: z.coerce.number().int().min(500).default(15_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type WorkerConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  // An empty variable means unset: compose forwards `${VAR:-}` as "", which
  // would otherwise fail optional fields' validation (e.g. min length, url).
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = EnvSchema.safeParse(set);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid worker environment: ${issues}`);
  }
  return parsed.data;
}
