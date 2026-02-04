import { getRedis, KeyPrefix, buildKey } from "../db/redis.js";
import { logger } from "../utils/logger.js";
import type { ChangeSummary, Language } from "../types/index.js";

const SUPPORTED_LANGUAGES: Language[] = ["en", "ko"];

function summaryKey(version: string, language: Language): string {
  return buildKey(KeyPrefix.SUMMARY, version, language);
}

export interface SummaryCacheOptions {
  ttlDays?: number;
}

/**
 * Summary cache using Upstash Redis only (simplified from 2-tier)
 */
export class SummaryCache {
  /**
   * Get cached summary
   */
  async get(
    version: string,
    language: Language,
  ): Promise<ChangeSummary | null> {
    const key = summaryKey(version, language);

    try {
      const redis = getRedis();
      const cached = await redis.get<ChangeSummary>(key);

      if (cached) {
        logger.debug(`Cache hit: ${key}`);
        return cached;
      }

      return null;
    } catch (error) {
      logger.error(`Failed to get cached summary for ${key}`, error);
      return null;
    }
  }

  /**
   * Set cached summary with TTL
   */
  async set(
    version: string,
    language: Language,
    summary: ChangeSummary,
    options: SummaryCacheOptions = {},
  ): Promise<void> {
    const { ttlDays = 7 } = options;
    const key = summaryKey(version, language);
    const ttlSeconds = ttlDays * 24 * 60 * 60;

    try {
      const redis = getRedis();
      await redis.set(key, summary, { ex: ttlSeconds });
      logger.info(`Cached summary stored: ${key}`);
    } catch (error) {
      logger.error(`Failed to cache summary for ${key}`, error);
      throw error;
    }
  }

  /**
   * Get summaries for all languages for a version
   */
  async getAll(version: string): Promise<Map<Language, ChangeSummary>> {
    const results = new Map<Language, ChangeSummary>();

    try {
      const redis = getRedis();
      const keys = SUPPORTED_LANGUAGES.map((lang) => summaryKey(version, lang));
      const values = await redis.mget<(ChangeSummary | null)[]>(...keys);

      values.forEach((value, index) => {
        if (value) {
          results.set(SUPPORTED_LANGUAGES[index], value);
        }
      });
    } catch (error) {
      logger.error(`Failed to get all summaries for ${version}`, error);
    }

    return results;
  }

  /**
   * Pre-generate and cache summaries for all languages
   * Called when a new version is detected
   */
  async pregenerate(
    version: string,
    generateFn: (language: Language) => Promise<ChangeSummary>,
  ): Promise<Map<Language, ChangeSummary>> {
    const results = new Map<Language, ChangeSummary>();

    // Check what we already have cached
    const existing = await this.getAll(version);
    const missing: Language[] = [];

    for (const lang of SUPPORTED_LANGUAGES) {
      const cached = existing.get(lang);
      if (cached) {
        results.set(lang, cached);
        logger.info(`Using cached summary for ${version}:${lang}`);
      } else {
        missing.push(lang);
      }
    }

    if (missing.length === 0) {
      return results;
    }

    // Generate summaries for missing languages in parallel
    logger.info(`Generating summaries for ${version}: ${missing.join(", ")}`);

    const generatePromises = missing.map(async (lang) => {
      try {
        const summary = await generateFn(lang);
        await this.set(version, lang, summary);
        results.set(lang, summary);
        logger.info(`Generated and cached summary for ${version}:${lang}`);
      } catch (error) {
        logger.error(`Failed to generate summary for ${version}:${lang}`, error);
      }
    });

    await Promise.all(generatePromises);

    return results;
  }

  /**
   * Check if summaries exist for all supported languages
   */
  async hasAllLanguages(version: string): Promise<boolean> {
    const existing = await this.getAll(version);
    return existing.size === SUPPORTED_LANGUAGES.length;
  }

  /**
   * Delete cached summary
   */
  async delete(version: string, language: Language): Promise<boolean> {
    const key = summaryKey(version, language);

    try {
      const redis = getRedis();
      const deleted = await redis.del(key);
      if (deleted > 0) {
        logger.debug(`Deleted cached summary: ${key}`);
      }
      return deleted > 0;
    } catch (error) {
      logger.error(`Failed to delete cached summary: ${key}`, error);
      return false;
    }
  }

  /**
   * Check if summary exists
   */
  async exists(version: string, language: Language): Promise<boolean> {
    const key = summaryKey(version, language);

    try {
      const redis = getRedis();
      const exists = await redis.exists(key);
      return exists === 1;
    } catch (error) {
      logger.error(`Failed to check cache existence: ${key}`, error);
      return false;
    }
  }

  /**
   * Get list of supported languages
   */
  getSupportedLanguages(): Language[] {
    return [...SUPPORTED_LANGUAGES];
  }
}

// Singleton instance
export const summaryCache = new SummaryCache();
