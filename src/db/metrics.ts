import { getRedis, KeyPrefix, buildKey } from "./redis.js";
import { logger } from "../utils/logger.js";

const METRICS_KEY_PREFIX = "metrics";

export interface NotificationMetrics {
  totalRuns: number;
  successfulNotifications: number;
  failedNotifications: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

function metricsKey(name: string): string {
  return buildKey(KeyPrefix.STATE, METRICS_KEY_PREFIX, name);
}

/**
 * Record a notification run's results
 */
export async function recordNotificationMetrics(
  successCount: number,
  failCount: number,
): Promise<void> {
  const redis = getRedis();
  const now = new Date().toISOString();

  try {
    const pipeline = redis.pipeline();

    // Increment counters
    pipeline.hincrby(metricsKey("notifications"), "total_runs", 1);
    pipeline.hincrby(metricsKey("notifications"), "success", successCount);
    pipeline.hincrby(metricsKey("notifications"), "failed", failCount);

    // Update timestamps
    pipeline.hset(metricsKey("notifications"), { last_run_at: now });

    if (successCount > 0) {
      pipeline.hset(metricsKey("notifications"), { last_success_at: now });
    }

    await pipeline.exec();

    logger.debug("Notification metrics recorded");
  } catch (error) {
    // Don't fail the main process for metrics errors
    logger.warn("Failed to record notification metrics", error);
  }
}

/**
 * Record an error for monitoring
 */
export async function recordError(errorMessage: string): Promise<void> {
  const redis = getRedis();
  const now = new Date().toISOString();

  try {
    await redis.hset(metricsKey("notifications"), {
      last_error_at: now,
      last_error: errorMessage.slice(0, 500), // Truncate long errors
    });
  } catch (error) {
    logger.warn("Failed to record error metric", error);
  }
}

/**
 * Get current notification metrics
 */
export async function getNotificationMetrics(): Promise<NotificationMetrics> {
  const redis = getRedis();

  try {
    const data = await redis.hgetall<Record<string, string>>(
      metricsKey("notifications"),
    );

    return {
      totalRuns: parseInt(data?.total_runs || "0", 10),
      successfulNotifications: parseInt(data?.success || "0", 10),
      failedNotifications: parseInt(data?.failed || "0", 10),
      lastRunAt: data?.last_run_at || null,
      lastSuccessAt: data?.last_success_at || null,
      lastErrorAt: data?.last_error_at || null,
      lastError: data?.last_error || null,
    };
  } catch (error) {
    logger.error("Failed to get notification metrics", error);
    return {
      totalRuns: 0,
      successfulNotifications: 0,
      failedNotifications: 0,
      lastRunAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
    };
  }
}

/**
 * Reset all metrics (for testing)
 */
export async function resetMetrics(): Promise<void> {
  const redis = getRedis();

  try {
    await redis.del(metricsKey("notifications"));
    logger.info("Metrics reset");
  } catch (error) {
    logger.error("Failed to reset metrics", error);
    throw error;
  }
}
