import {
  getLatestTag,
  getChangelogDiff,
  getCliChangelog,
  findPreviousTag,
  GITHUB_DEFAULTS,
} from "../services/github.js";
import { generateSummary } from "../services/claude.js";
import {
  sendNotificationToWorkspaces,
  sendWorkspaceNotification,
} from "../services/slack.js";
import { summaryCache } from "../cache/index.js";
import {
  getActiveWorkspaces,
  getLastCheckedVersion,
  setLastCheckedVersion,
  setLastNotificationTime,
  acquireLock,
  releaseLock,
  addFailedWorkspace,
  getFailedWorkspaces,
  removeFailedWorkspace,
} from "../db/index.js";
import { recordNotificationMetrics, recordError } from "../db/metrics.js";
import { logger } from "../utils/logger.js";
import type { ChangelogDiff, Language, ChangeSummary } from "../types/index.js";

export interface MultiWorkspaceConfig {
  upstreamOwner: string;
  upstreamRepo: string;
  cliRepoOwner: string;
  cliRepoName: string;
  anthropicApiKey: string;
}

function loadMultiWorkspaceConfig(): MultiWorkspaceConfig {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }

  return {
    upstreamOwner: process.env.UPSTREAM_OWNER || GITHUB_DEFAULTS.UPSTREAM_OWNER,
    upstreamRepo: process.env.UPSTREAM_REPO || GITHUB_DEFAULTS.UPSTREAM_REPO,
    cliRepoOwner: GITHUB_DEFAULTS.CLI_REPO_OWNER,
    cliRepoName: GITHUB_DEFAULTS.CLI_REPO_NAME,
    anthropicApiKey,
  };
}

function isNewerVersion(current: string, last: string | null): boolean {
  if (!last) return true;

  const parseVersion = (v: string) => {
    const match = v.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return [0, 0, 0];
    return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
  };

  const [curMajor, curMinor, curPatch] = parseVersion(current);
  const [lastMajor, lastMinor, lastPatch] = parseVersion(last);

  if (curMajor !== lastMajor) return curMajor > lastMajor;
  if (curMinor !== lastMinor) return curMinor > lastMinor;
  return curPatch > lastPatch;
}

const NOTIFICATION_LOCK_KEY = "notification";
const NOTIFICATION_LOCK_TTL = 300; // 5 minutes

export async function runMultiWorkspaceNotification(): Promise<void> {
  logger.info("Starting multi-workspace notification check");

  // Acquire distributed lock to prevent race conditions
  const lockValue = await acquireLock(
    NOTIFICATION_LOCK_KEY,
    NOTIFICATION_LOCK_TTL,
  );

  if (!lockValue) {
    logger.info("Another notification process is running, skipping");
    return;
  }

  try {
    await executeNotification();
  } finally {
    // Release lock, but don't fail if release fails (TTL will handle it)
    try {
      await releaseLock(NOTIFICATION_LOCK_KEY, lockValue);
    } catch (releaseError) {
      logger.error(
        "Failed to release lock, will auto-expire after TTL",
        releaseError,
      );
    }
  }
}

async function executeNotification(): Promise<void> {
  const config = loadMultiWorkspaceConfig();

  // Retry previously failed notifications first
  await retryPreviouslyFailedNotifications();

  // Get latest tag
  const latestTag = await getLatestTag({
    upstreamOwner: config.upstreamOwner,
    upstreamRepo: config.upstreamRepo,
  });

  if (!latestTag) {
    logger.info("No tags found, exiting");
    return;
  }

  logger.info(`Latest tag: ${latestTag.name}`);

  // Check if this is a new version (using DB state)
  const lastCheckedVersion = await getLastCheckedVersion();

  if (!isNewerVersion(latestTag.name, lastCheckedVersion)) {
    logger.info(
      `No new version. Current: ${latestTag.name}, Last checked: ${lastCheckedVersion}`,
    );
    return;
  }

  logger.info(
    `New version detected: ${lastCheckedVersion || "none"} -> ${latestTag.name}`,
  );

  // Get active workspaces
  const workspaces = await getActiveWorkspaces();

  if (workspaces.length === 0) {
    logger.info("No active workspaces found");
    await setLastCheckedVersion(latestTag.name);
    return;
  }

  logger.info(`Found ${workspaces.length} active workspace(s)`);

  // Get changelog diff
  const fromVersion = lastCheckedVersion || findPreviousTag(latestTag.name);

  const diff = await getChangelogDiff(
    {
      upstreamOwner: config.upstreamOwner,
      upstreamRepo: config.upstreamRepo,
    },
    fromVersion,
    latestTag.name,
  );

  let cliResult: { changes: string[]; compareUrl: string };
  try {
    cliResult = await getCliChangelog(
      {
        cliRepoOwner: config.cliRepoOwner,
        cliRepoName: config.cliRepoName,
      },
      latestTag.name,
    );
  } catch {
    logger.warn(
      `CLI changelog fetch failed for ${latestTag.name}, proceeding without CLI data`,
    );
    cliResult = { changes: [], compareUrl: "" };
  }

  const hasPromptOrFlagChanges = diff.files.length > 0;
  const hasCliChanges = cliResult.changes.length > 0;

  if (!hasPromptOrFlagChanges && !hasCliChanges) {
    logger.info("No relevant changes found (CLI, prompt, or flag)");
    await setLastCheckedVersion(latestTag.name);
    return;
  }

  // Pre-generate summaries for all languages
  const summariesByLanguage = await pregenerateSummaries(
    config.anthropicApiKey,
    latestTag.name,
    diff,
    cliResult.changes,
  );

  // Validate that at least one summary exists
  if (summariesByLanguage.size === 0) {
    const errorMsg = "Failed to generate any summaries, cannot proceed";
    logger.error(errorMsg);
    await recordError(errorMsg);
    return;
  }

  // Use English summary as placeholder, or fallback to any available
  const placeholderSummary =
    summariesByLanguage.get("en") || summariesByLanguage.values().next().value;

  if (!placeholderSummary) {
    logger.error("No valid summary available, cannot proceed");
    return;
  }

  // Log if we're using a fallback
  if (!summariesByLanguage.get("en")) {
    logger.warn("English summary not available, using fallback");
  }

  // Send notifications to all workspaces
  const results = await sendNotificationToWorkspaces(
    workspaces,
    {
      version: latestTag.name,
      summary: placeholderSummary,
      compareUrl: diff.compareUrl,
      cliCompareUrl: cliResult.compareUrl,
    },
    summariesByLanguage,
  );

  // Log results and track failures
  const successCount = results.filter((r) => r.success).length;
  const failedResults = results.filter((r) => !r.success);
  const failCount = failedResults.length;

  logger.info(
    `Notification complete: ${successCount} success, ${failCount} failed`,
  );

  // Record metrics
  await recordNotificationMetrics(successCount, failCount);

  // Record failed workspaces for retry
  for (const result of failedResults) {
    logger.error(
      `Failed workspace: ${result.workspace.teamName} - ${result.error?.message}`,
    );

    try {
      await addFailedWorkspace({
        teamId: result.workspace.teamId,
        version: latestTag.name,
        reason: result.error?.message || "Unknown error",
        timestamp: new Date().toISOString(),
        retryCount: 0,
      });
    } catch (recordError) {
      logger.error(
        `Failed to record failure for workspace ${result.workspace.teamId}`,
        recordError,
      );
    }
  }

  // Clear successful workspaces from failed list (if they were retried)
  for (const result of results.filter((r) => r.success)) {
    try {
      await removeFailedWorkspace(result.workspace.teamId);
    } catch {
      // Ignore errors when removing non-existent entries
    }
  }

  // Update last checked version and notification time
  await setLastCheckedVersion(latestTag.name);
  await setLastNotificationTime();

  logger.info("Notification completed successfully");
}

const MAX_RETRIES = 3;

/**
 * Retry previously failed notifications at the start of each run
 * Fetches cached summaries for failed versions and retries delivery
 */
async function retryPreviouslyFailedNotifications(): Promise<void> {
  const failedWorkspaces = await getFailedWorkspaces();

  if (failedWorkspaces.length === 0) {
    return;
  }

  logger.info(
    `Found ${failedWorkspaces.length} previously failed notification(s) to retry`,
  );

  const workspaces = await getActiveWorkspaces();
  const workspaceMap = new Map(workspaces.map((w) => [w.teamId, w]));

  // Group failures by version to minimize cache lookups
  const failuresByVersion = new Map<string, typeof failedWorkspaces>();
  for (const failed of failedWorkspaces) {
    const existing = failuresByVersion.get(failed.version) || [];
    existing.push(failed);
    failuresByVersion.set(failed.version, existing);
  }

  for (const [version, failures] of failuresByVersion) {
    // Get cached summaries for this version
    const summariesByLanguage = await summaryCache.getAll(version);

    if (summariesByLanguage.size === 0) {
      logger.warn(
        `No cached summaries for version ${version}, skipping ${failures.length} retry(s)`,
      );
      // Remove these failures since we can't retry without summaries
      for (const failed of failures) {
        await removeFailedWorkspace(failed.teamId);
      }
      continue;
    }

    // Build compare URLs for this version
    const config = loadMultiWorkspaceConfig();
    const compareUrl = `https://github.com/${config.upstreamOwner}/${config.upstreamRepo}/compare/${version}`;
    const cliCompareUrl = `https://github.com/${config.cliRepoOwner}/${config.cliRepoName}/releases/tag/${version}`;

    for (const failed of failures) {
      if (failed.retryCount >= MAX_RETRIES) {
        logger.warn(
          `Workspace ${failed.teamId} exceeded max retries (${MAX_RETRIES}), removing`,
        );
        await removeFailedWorkspace(failed.teamId);
        continue;
      }

      const workspace = workspaceMap.get(failed.teamId);
      if (!workspace) {
        logger.debug(`Workspace ${failed.teamId} no longer active, removing`);
        await removeFailedWorkspace(failed.teamId);
        continue;
      }

      let effectiveSummary = summariesByLanguage.get(workspace.language);

      if (!effectiveSummary) {
        // Try fallback to any available language
        const fallbackSummary = summariesByLanguage.values().next().value as
          | ChangeSummary
          | undefined;
        if (!fallbackSummary) {
          logger.warn(
            `No summary for ${workspace.language} and no fallback, skipping`,
          );
          continue;
        }
        logger.info(
          `Using fallback summary for ${workspace.teamName} (${workspace.language})`,
        );
        effectiveSummary = fallbackSummary;
      }

      try {
        await sendWorkspaceNotification(workspace, {
          version,
          summary: effectiveSummary,
          compareUrl,
          cliCompareUrl,
        });

        logger.info(`Retry successful for workspace ${workspace.teamName}`);
        await removeFailedWorkspace(failed.teamId);
      } catch (error) {
        logger.error(`Retry failed for workspace ${workspace.teamName}`, error);

        await addFailedWorkspace({
          ...failed,
          retryCount: failed.retryCount + 1,
          timestamp: new Date().toISOString(),
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

async function pregenerateSummaries(
  apiKey: string,
  version: string,
  diff: ChangelogDiff,
  cliChanges: string[],
): Promise<Map<Language, ChangeSummary>> {
  const generateFn = async (language: Language): Promise<ChangeSummary> => {
    return generateSummary(apiKey, language, diff, cliChanges);
  };

  return summaryCache.pregenerate(version, generateFn);
}
