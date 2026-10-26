import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export interface HeldLock {
  release(): Promise<void>;
}

/**
 * One Redis lock key (SET NX PX). The release is a compare-and-delete, so a holder whose TTL
 * ran out cannot delete a lock someone else took since.
 */
export async function acquireRedisLock(
  redis: Redis,
  key: string,
  ttlMs: number,
): Promise<HeldLock | null> {
  const token = randomUUID();
  const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (ok !== 'OK') return null;
  return {
    release: async () => {
      await redis.eval(RELEASE, 1, key, token);
    },
  };
}

/**
 * Limits concurrent journeys per store host across every worker process, so scaling
 * workers out never means hitting one merchant harder. Implemented as N Redis lock slots
 * per host.
 */
export class StoreLock {
  constructor(
    private readonly redis: Redis,
    private readonly slotsPerHost: number,
    private readonly ttlMs: number,
    private readonly prefix = 'checkout-sentinel:store-lock',
  ) {}

  async acquire(storeUrl: string): Promise<HeldLock | null> {
    const host = new URL(storeUrl).host.toLowerCase();
    for (let slot = 0; slot < this.slotsPerHost; slot += 1) {
      const lock = await acquireRedisLock(this.redis, `${this.prefix}:${host}:${slot}`, this.ttlMs);
      if (lock) return lock;
    }
    return null;
  }
}
