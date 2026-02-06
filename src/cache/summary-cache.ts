import { getRedis, KeyPrefix, buildKey } from "../db/redis.js";
import { logger } from "../utils/logger.js";
import type { ChangeSummary, Language } from "../types/index.js";

const CACHE_DEFAULTS = {
  TTL_DAYS: 7,
} as const;

const SUPPORTED_LANGUAGES: Language[] = ["en", "ko"];

function summaryKey(version: string, language: Language): string {
  return buildKey(KeyPrefix.SUMMARY, version, language);
}

function hasSubstantialContent(summary: ChangeSummary): boolean {
  return (
    summary.cliChanges.length > 0 ||
    summary.promptChanges.length > 0 ||
    summary.flagChanges.added.length > 0 ||
    summary.flagChanges.removed.length > 0 ||
    summary.flagChanges.modified.length > 0
  );
}

export interface SummaryCacheOptions {
  ttlDays?: number;
}

export class SummaryCache {
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

  async set(
    version: string,
    language: Language,
    summary: ChangeSummary,
    options: SummaryCacheOptions = {},
  ): Promise<void> {
    if (!hasSubstantialContent(summary)) {
      logger.warn(
        `Skipping cache for ${version}:${language} - no substantial content`,
      );
      return;
    }

    const { ttlDays = CACHE_DEFAULTS.TTL_DAYS } = options;
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

  async getAll(version: string): Promise<Map<Language, ChangeSummary>> {
    const results = new Map<Language, ChangeSummary>();

    try {
      const redis = getRedis();
      const keys = SUPPORTED_LANGUAGES.map((lang) => summaryKey(version, lang));
      const values = await redis.mget<(ChangeSummary | null)[]>(...keys);

      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (value) {
          results.set(SUPPORTED_LANGUAGES[i], value);
        }
      }
    } catch (error) {
      logger.error(`Failed to get all summaries for ${version}`, error);
    }

    return results;
  }

  async pregenerate(
    version: string,
    generateFn: (language: Language) => Promise<ChangeSummary>,
  ): Promise<Map<Language, ChangeSummary>> {
    const results = new Map<Language, ChangeSummary>();

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

    logger.info(`Generating summaries for ${version}: ${missing.join(", ")}`);

    const generatePromises = missing.map(async (lang) => {
      try {
        const summary = await generateFn(lang);
        await this.set(version, lang, summary);
        results.set(lang, summary);
        logger.info(`Generated and cached summary for ${version}:${lang}`);
      } catch (error) {
        logger.error(
          `Failed to generate summary for ${version}:${lang}`,
          error,
        );
      }
    });

    await Promise.all(generatePromises);

    return results;
  }

  async hasAllLanguages(version: string): Promise<boolean> {
    const existing = await this.getAll(version);
    return existing.size === SUPPORTED_LANGUAGES.length;
  }

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

  getSupportedLanguages(): Language[] {
    return [...SUPPORTED_LANGUAGES];
  }
}

// Singleton instance
export const summaryCache = new SummaryCache();
