import { Octokit } from "@octokit/rest";
import type { TagInfo } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";

export const GITHUB_DEFAULTS = {
  CLI_REPO_OWNER: "anthropics",
  CLI_REPO_NAME: "claude-code",
} as const;

let octokitClient: Octokit | null = null;

function getOctokit(): Octokit {
  if (!octokitClient) {
    // Use GitHub token if available (increases rate limit from 60/hr to 5000/hr)
    const auth = process.env.GITHUB_TOKEN;
    octokitClient = auth ? new Octokit({ auth }) : new Octokit();
  }
  return octokitClient;
}

/** @internal */
export function _resetOctokitClient(): void {
  octokitClient = null;
}

export interface GitHubConfig {
  cliRepoOwner: string;
  cliRepoName: string;
}

export async function getLatestRelease(
  config: Pick<GitHubConfig, "cliRepoOwner" | "cliRepoName">,
): Promise<TagInfo | null> {
  const octokit = getOctokit();

  return withRetry(async () => {
    try {
      const { data: release } = await octokit.repos.getLatestRelease({
        owner: config.cliRepoOwner,
        repo: config.cliRepoName,
      });
      return {
        name: release.tag_name,
        commitSha: release.target_commitish,
        date: release.published_at || new Date().toISOString(),
      };
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        logger.warn("No releases found in repository");
        return null;
      }
      logger.error("Failed to fetch latest release", error);
      throw error;
    }
  });
}

export interface CliChangelogResult {
  changes: string[];
  compareUrl: string;
}

export async function getCliChangelog(
  config: Pick<GitHubConfig, "cliRepoOwner" | "cliRepoName">,
  version: string,
): Promise<CliChangelogResult> {
  const octokit = getOctokit();

  return withRetry(async () => {
    logger.info(`Fetching CLI changelog for version ${version}`);

    const { data } = await octokit.repos.getContent({
      owner: config.cliRepoOwner,
      repo: config.cliRepoName,
      path: "CHANGELOG.md",
      ref: "main",
    });

    if (!("content" in data) || data.encoding !== "base64") {
      throw new Error("Unexpected response format for CHANGELOG.md");
    }

    const content = Buffer.from(data.content, "base64").toString("utf-8");
    const changes = parseChangelogSection(content, version);

    const compareUrl = `https://github.com/${config.cliRepoOwner}/${config.cliRepoName}/releases/tag/${version}`;

    logger.info(`Found ${changes.length} CLI changes for ${version}`);

    return { changes, compareUrl };
  });
}

function parseChangelogSection(content: string, version: string): string[] {
  const versionPattern = version.replace(/^v/, "");
  const sectionRegex = new RegExp(
    `^## \\[?${escapeRegExp(versionPattern)}\\]?.*?$`,
    "m",
  );

  const match = content.match(sectionRegex);
  if (!match) {
    logger.debug(`Version section not found for ${version}`);
    return [];
  }

  const startIndex = (match.index ?? 0) + match[0].length;
  const nextSectionMatch = content.slice(startIndex).match(/^## \[?\d+\.\d+/m);
  const endIndex = nextSectionMatch
    ? startIndex + (nextSectionMatch.index ?? 0)
    : content.length;

  const sectionContent = content.slice(startIndex, endIndex);

  const bulletPoints = sectionContent
    .split("\n")
    .filter((line) => line.match(/^[-*]\s+/))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0);

  return bulletPoints;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findPreviousTag(currentTag: string): string {
  const match = currentTag.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return currentTag;

  const [, major, minor, patch] = match;
  const patchNum = parseInt(patch, 10);

  if (patchNum > 0) {
    return `${currentTag.startsWith("v") ? "v" : ""}${major}.${minor}.${patchNum - 1}`;
  }

  return currentTag;
}
