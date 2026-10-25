import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Limits concurrent journeys per store host across every worker process, so scaling
 * workers out never means hitting one merchant harder. Implemented as N Redis lock slots
 * (SET NX PX) per host, released with a compare-and-delete script.
 */
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export interface HeldLock {
  release(): Promise<void>;
}

export class StoreLock {
  constructor(
    private readonly redis: Redis,
    private readonly slotsPerHost: number,
    private readonly ttlMs: number,
    private readonly prefix = 'checkout-sentinel:store-lock',
  ) {}

  async acquire(storeUrl: string): Promise<HeldLock | null> {
    const host = new URL(storeUrl).host.toLowerCase();
    const token = randomUUID();
    for (let slot = 0; slot < this.slotsPerHost; slot += 1) {
      const key = `${this.prefix}:${host}:${slot}`;
      const ok = await this.redis.set(key, token, 'PX', this.ttlMs, 'NX');
      if (ok === 'OK') {
        return {
          release: async () => {
            await this.redis.eval(RELEASE, 1, key, token);
          },
        };
      }
    }
    return null;
  }
}
