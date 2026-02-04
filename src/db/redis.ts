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
