// Cache abstraction. Uses Redis when REDIS_URL is set, else an in-process
// Map with TTL. Callers don't care which backend is active.
import { logger } from "./logger.js";

export interface Cache {
  get(key: string): Promise<string | null>;
  setex(key: string, ttlSeconds: number, value: string): Promise<void>;
}

class MemoryCache implements Cache {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return hit.value;
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}

class RedisCache implements Cache {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private client: any) {}
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }
  async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
    await this.client.setex(key, ttlSeconds, value);
  }
}

export async function createCache(redisUrl?: string): Promise<Cache> {
  if (!redisUrl) {
    logger.info("[cache] No REDIS_URL — using in-process cache");
    return new MemoryCache();
  }
  try {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await client.connect();
    logger.info("[cache] Connected to Redis");
    return new RedisCache(client);
  } catch (err) {
    logger.warn(`[cache] Redis unavailable (${(err as Error).message}) — falling back to memory`);
    return new MemoryCache();
  }
}
