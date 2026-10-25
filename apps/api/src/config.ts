import { z } from 'zod';

const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  /** When set, every endpoint except /health, /metrics and /docs requires "Authorization: Bearer <token>". */
  API_TOKEN: z.string().min(16).optional(),
  MIGRATE_ON_BOOT: booleanFromEnv.default(true),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type ApiConfig = z.infer<typeof EnvSchema>;

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  // An empty variable means unset: compose forwards `${VAR:-}` as "", which
  // would otherwise fail optional fields' validation (e.g. min length, url).
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = EnvSchema.safeParse(set);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid API environment: ${issues}`);
  }
  return parsed.data;
}
