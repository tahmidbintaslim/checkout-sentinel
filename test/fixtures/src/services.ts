import { Redis } from 'ioredis';
import pg from 'pg';

/**
 * End-to-end tests need Postgres and Redis. They read TEST_DATABASE_URL and TEST_REDIS_URL
 * (CI sets both from service containers) and skip, with the reason printed, when either is
 * unreachable, so `pnpm test` still works on a laptop without them.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://sentinel:sentinel@127.0.0.1:5432/checkout_sentinel_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';

async function probePostgres(url: string): Promise<string | null> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query('select 1');
    return null;
  } catch (error) {
    return `Postgres unreachable at ${new URL(url).host}: ${(error as Error).message}`;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function probeRedis(url: string): Promise<string | null> {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.ping();
    return null;
  } catch (error) {
    return `Redis unreachable at ${new URL(url).host}: ${(error as Error).message}`;
  } finally {
    client.disconnect();
  }
}

export interface ServiceAvailability {
  available: boolean;
  reason: string | null;
  databaseUrl: string;
  redisUrl: string;
}

export async function probeTestServices(): Promise<ServiceAvailability> {
  const reasons = (
    await Promise.all([probePostgres(TEST_DATABASE_URL), probeRedis(TEST_REDIS_URL)])
  ).filter((reason): reason is string => reason !== null);
  const reason = reasons.length > 0 ? reasons.join('; ') : null;
  if (reason) console.warn(`[e2e] skipping: ${reason}`);
  return {
    available: reason === null,
    reason,
    databaseUrl: TEST_DATABASE_URL,
    redisUrl: TEST_REDIS_URL,
  };
}

/** Empties every checkout-sentinel table (the test database only). */
export async function truncateAll(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('truncate table alert_deliveries, runs, monitor_state, monitors cascade');
  } finally {
    await client.end();
  }
}
