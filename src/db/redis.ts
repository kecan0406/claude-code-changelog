import { Redis } from "@upstash/redis";
import { logger } from "../utils/logger.js";

let redisClient: Redis | null = null;

function getConnectionConfig(): { url: string; token: string } {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required",
    );
  }

  return { url, token };
}

export function getRedis(): Redis {
  if (!redisClient) {
    const { url, token } = getConnectionConfig();
    redisClient = new Redis({ url, token });
  }
  return redisClient;
}

export async function testConnection(): Promise<boolean> {
  try {
    const redis = getRedis();
    const testKey = "test:connection";
    await redis.set(testKey, "ok", { ex: 10 });
    const result = await redis.get(testKey);
    await redis.del(testKey);
    return result === "ok";
  } catch (error) {
    logger.error("Redis connection test failed", error);
    return false;
  }
}

// Key prefixes for different data types
export const KeyPrefix = {
  WORKSPACE: "workspace",
  WORKSPACES_ACTIVE: "workspaces:active",
  SUMMARY: "summary",
  STATE: "state",
} as const;

// Helper to build keys
export function buildKey(...parts: string[]): string {
  return parts.join(":");
}

// Distributed lock implementation
const LOCK_PREFIX = "lock";

/**
 * Acquire a distributed lock using Redis SET NX EX pattern
 * @param lockKey - The lock identifier (without prefix)
 * @param ttlSeconds - Lock expiration time in seconds (default: 300)
 * @returns Lock value (UUID) if acquired, null if lock is held by another process
 */
export async function acquireLock(
  lockKey: string,
  ttlSeconds = 300,
): Promise<string | null> {
  const redis = getRedis();
  const key = buildKey(LOCK_PREFIX, lockKey);
  const lockValue = crypto.randomUUID();

  try {
    // SET key value NX EX ttl - only sets if key doesn't exist
    const result = await redis.set(key, lockValue, { nx: true, ex: ttlSeconds });

    if (result === "OK") {
      logger.debug(`Lock acquired: ${lockKey}`);
      return lockValue;
    }

    logger.debug(`Lock not acquired (already held): ${lockKey}`);
    return null;
  } catch (error) {
    logger.error(`Failed to acquire lock: ${lockKey}`, error);
    throw error;
  }
}

/**
 * Release a distributed lock (only if we own it)
 * Uses Lua script for atomic check-and-delete to prevent race conditions
 * @param lockKey - The lock identifier (without prefix)
 * @param lockValue - The value returned from acquireLock
 * @returns true if released, false if lock was not owned or already expired
 */
export async function releaseLock(
  lockKey: string,
  lockValue: string,
): Promise<boolean> {
  const redis = getRedis();
  const key = buildKey(LOCK_PREFIX, lockKey);

  try {
    // Lua script for atomic check-and-delete
    // Only deletes if the current value matches (we own the lock)
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const result = await redis.eval(script, [key], [lockValue]);
    const released = result === 1;

    if (released) {
      logger.debug(`Lock released: ${lockKey}`);
    } else {
      logger.warn(`Lock release failed (not owner or expired): ${lockKey}`);
    }

    return released;
  } catch (error) {
    logger.error(`Failed to release lock: ${lockKey}`, error);
    throw error;
  }
}
