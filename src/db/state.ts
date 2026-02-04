import { getRedis, KeyPrefix, buildKey } from "./redis.js";
import { logger } from "../utils/logger.js";

export interface GlobalState {
  key: string;
  value: string;
  updatedAt: Date;
}

function stateKey(key: string): string {
  return buildKey(KeyPrefix.STATE, key);
}

export async function getGlobalState(key: string): Promise<string | null> {
  try {
    const redis = getRedis();
    const value = await redis.get<string>(stateKey(key));
    return value;
  } catch (error) {
    logger.error(`Failed to get global state for key: ${key}`, error);
    throw error;
  }
}

export async function setGlobalState(
  key: string,
  value: string,
): Promise<GlobalState> {
  try {
    const redis = getRedis();
    await redis.set(stateKey(key), value);

    logger.debug(`Global state set: ${key}`);
    return {
      key,
      value,
      updatedAt: new Date(),
    };
  } catch (error) {
    logger.error(`Failed to set global state for key: ${key}`, error);
    throw error;
  }
}

export async function deleteGlobalState(key: string): Promise<boolean> {
  try {
    const redis = getRedis();
    const deleted = await redis.del(stateKey(key));
    return deleted > 0;
  } catch (error) {
    logger.error(`Failed to delete global state for key: ${key}`, error);
    throw error;
  }
}

export async function getAllGlobalState(): Promise<GlobalState[]> {
  try {
    const redis = getRedis();
    // Scan for all state keys
    const pattern = buildKey(KeyPrefix.STATE, "*");
    const keys: string[] = [];

    let cursor = "0";
    do {
      const result = await redis.scan(cursor, { match: pattern, count: 100 });
      cursor = String(result[0]);
      keys.push(...result[1]);
    } while (cursor !== "0");

    if (keys.length === 0) {
      return [];
    }

    const values = await redis.mget<(string | null)[]>(...keys);
    const now = new Date();

    return keys.map((fullKey, index) => ({
      key: fullKey.replace(`${KeyPrefix.STATE}:`, ""),
      value: values[index] ?? "",
      updatedAt: now, // Redis doesn't store update time, use current
    }));
  } catch (error) {
    logger.error("Failed to get all global state", error);
    throw error;
  }
}

// Convenience functions for common state keys
export const StateKeys = {
  LAST_CHECKED_VERSION: "last_checked_version",
  LAST_NOTIFICATION_TIME: "last_notification_time",
} as const;

export async function getLastCheckedVersion(): Promise<string | null> {
  return getGlobalState(StateKeys.LAST_CHECKED_VERSION);
}

export async function setLastCheckedVersion(version: string): Promise<void> {
  await setGlobalState(StateKeys.LAST_CHECKED_VERSION, version);
}

export async function getLastNotificationTime(): Promise<Date | null> {
  const value = await getGlobalState(StateKeys.LAST_NOTIFICATION_TIME);
  return value ? new Date(value) : null;
}

export async function setLastNotificationTime(
  time: Date = new Date(),
): Promise<void> {
  await setGlobalState(StateKeys.LAST_NOTIFICATION_TIME, time.toISOString());
}
