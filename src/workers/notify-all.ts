import {
  getLatestTag,
  getChangelogDiff,
  getCliChangelog,
  GITHUB_DEFAULTS,
} from "../services/github.js";
import { generateSummary } from "../services/claude.js";
import { sendNotificationToWorkspaces } from "../services/slack.js";
import { summaryCache } from "../cache/index.js";
import {
  getActiveWorkspaces,
  getLastCheckedVersion,
  setLastCheckedVersion,
  setLastNotificationTime,
} from "../db/index.js";
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

function findPreviousTag(currentTag: string): string {
  const match = currentTag.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return currentTag;

  const [, major, minor, patch] = match;
  const patchNum = parseInt(patch, 10);

  if (patchNum > 0) {
    return `${currentTag.startsWith("v") ? "v" : ""}${major}.${minor}.${patchNum - 1}`;
  }

  return currentTag;
}

export async function runMultiWorkspaceNotification(): Promise<void> {
  logger.info("Starting multi-workspace notification check");

  const config = loadMultiWorkspaceConfig();

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

  const [diff, cliResult] = await Promise.all([
    getChangelogDiff(
      {
        upstreamOwner: config.upstreamOwner,
        upstreamRepo: config.upstreamRepo,
      },
      fromVersion,
      latestTag.name,
    ),
    getCliChangelog(
      {
        cliRepoOwner: config.cliRepoOwner,
        cliRepoName: config.cliRepoName,
      },
      latestTag.name,
    ),
  ]);

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

  // Validate that at least English summary exists for the placeholder
  const placeholderSummary = summariesByLanguage.get("en");
  if (!placeholderSummary) {
    logger.error("Failed to generate English summary, cannot proceed");
    return;
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

  // Log results
  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  logger.info(
    `Notification complete: ${successCount} success, ${failCount} failed`,
  );

  if (failCount > 0) {
    for (const result of results.filter((r) => !r.success)) {
      logger.error(
        `Failed workspace: ${result.workspace.teamName} - ${result.error?.message}`,
      );
    }
  }

  // Update last checked version and notification time
  await setLastCheckedVersion(latestTag.name);
  await setLastNotificationTime();

  logger.info("Multi-workspace notification completed successfully");
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
