import { z } from 'zod';
import { TargetPolicyEnvSchema } from '@checkout-sentinel/core';

const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const EnvSchema = TargetPolicyEnvSchema.extend({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  /** When set, every endpoint except /health, /metrics and /docs requires "Authorization: Bearer <token>". */
  API_TOKEN: z.string().min(16).optional(),
  MIGRATE_ON_BOOT: booleanFromEnv.default(true),
  /**
   * The worker's artifacts directory (screenshots and traces), read by GET /runs/:id/artifacts.
   * Same default as the worker; with separate containers, mount the same volume on both.
   */
  ARTIFACTS_DIR: z.string().min(1).default('./artifacts'),
  /** Serve the dashboard (the apps/web build) at /. */
  DASHBOARD_ENABLED: booleanFromEnv.default(true),
  /** Directory of the built dashboard. Default: apps/web/dist in this repository. */
  DASHBOARD_DIR: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /**
   * Hosted sign-in with Clerk. With a secret key (or the PEM public key in CLERK_JWT_KEY, for
   * verification without network calls) the API accepts Clerk session tokens; each user's
   * active organization, or the user when none is active, is a workspace.
   */
  CLERK_SECRET_KEY: z.string().min(1).optional(),
  CLERK_JWT_KEY: z.string().min(1).optional(),
  /** The dashboard loads Clerk with this key; required with Clerk. */
  CLERK_PUBLISHABLE_KEY: z
    .string()
    .regex(/^pk_(test|live)_/, 'Must be a Clerk publishable key')
    .optional(),
  /** Origins the dashboard is served from, comma-separated (the token's azp). Required with Clerk. */
  CLERK_AUTHORIZED_PARTIES: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .optional(),
  /** Public scanner: POST /scans and GET /scans/:id without the API token. Off by default. */
  SCANNER_ENABLED: booleanFromEnv.default(false),
  /** Cloudflare Turnstile keys; required with the scanner, since every scan runs a browser. */
  TURNSTILE_SITE_KEY: z.string().min(1).optional(),
  TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
  /** Scans one client address may start per hour. */
  SCAN_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(1_000).default(5),
  /** Scans waiting or running at once, across all clients; more are refused with 503. */
  SCAN_QUEUE_LIMIT: z.coerce.number().int().min(1).max(10_000).default(20),
  /** Reverse proxies in front of the API, so the client address comes from X-Forwarded-For. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
}).superRefine((env, ctx) => {
  const clerk = Boolean(env.CLERK_SECRET_KEY || env.CLERK_JWT_KEY);
  if (clerk && (!env.CLERK_PUBLISHABLE_KEY || !env.CLERK_AUTHORIZED_PARTIES?.length)) {
    ctx.addIssue({
      code: 'custom',
      path: ['CLERK_AUTHORIZED_PARTIES'],
      message: 'Clerk needs CLERK_PUBLISHABLE_KEY and CLERK_AUTHORIZED_PARTIES',
    });
  }
  if (env.SCANNER_ENABLED && (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY)) {
    ctx.addIssue({
      code: 'custom',
      path: ['TURNSTILE_SECRET_KEY'],
      message: 'SCANNER_ENABLED needs TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY',
    });
  }
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
