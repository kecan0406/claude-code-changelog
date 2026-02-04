import { Octokit } from "@octokit/rest";
import type { TagInfo, ChangelogDiff, FileDiff } from "../types/index.js";
import { logger } from "../utils/logger.js";

const TARGET_FILES = ["cc-prompt.md", "cc-flags.md"];

export const GITHUB_DEFAULTS = {
  UPSTREAM_OWNER: "marckrenn",
  UPSTREAM_REPO: "claude-code-changelog",
  CLI_REPO_OWNER: "anthropics",
  CLI_REPO_NAME: "claude-code",
} as const;

let octokitClient: Octokit | null = null;

function getOctokit(): Octokit {
  if (!octokitClient) {
    octokitClient = new Octokit();
  }
  return octokitClient;
}

/** @internal */
export function _resetOctokitClient(): void {
  octokitClient = null;
}

export interface GitHubConfig {
  upstreamOwner: string;
  upstreamRepo: string;
  cliRepoOwner: string;
  cliRepoName: string;
}

export async function getLatestTag(
  config: Pick<GitHubConfig, "upstreamOwner" | "upstreamRepo">,
): Promise<TagInfo | null> {
  const octokit = getOctokit();

  try {
    const { data: tags } = await octokit.repos.listTags({
      owner: config.upstreamOwner,
      repo: config.upstreamRepo,
      per_page: 1,
    });

    if (tags.length === 0) {
      logger.warn("No tags found in repository");
      return null;
    }

    const tag = tags[0];

    const { data: commit } = await octokit.repos.getCommit({
      owner: config.upstreamOwner,
      repo: config.upstreamRepo,
      ref: tag.commit.sha,
    });

    return {
      name: tag.name,
      commitSha: tag.commit.sha,
      date: commit.commit.committer?.date || new Date().toISOString(),
    };
  } catch (error) {
    logger.error("Failed to fetch latest tag", error);
    throw error;
  }
}

export async function getChangelogDiff(
  config: Pick<GitHubConfig, "upstreamOwner" | "upstreamRepo">,
  fromVersion: string,
  toVersion: string,
): Promise<ChangelogDiff> {
  const octokit = getOctokit();

  try {
    const { data: comparison } = await octokit.repos.compareCommits({
      owner: config.upstreamOwner,
      repo: config.upstreamRepo,
      base: fromVersion,
      head: toVersion,
    });

    const relevantFiles = (comparison.files || [])
      .filter((file) => TARGET_FILES.includes(file.filename))
      .map(
        (file): FileDiff => ({
          filename: file.filename,
          patch: file.patch || "",
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
        }),
      );

    const compareUrl = `https://github.com/${config.upstreamOwner}/${config.upstreamRepo}/compare/${fromVersion}...${toVersion}`;

    logger.info(`Found ${relevantFiles.length} relevant file changes`);

    return {
      fromVersion,
      toVersion,
      files: relevantFiles,
      compareUrl,
    };
  } catch (error) {
    logger.error("Failed to fetch changelog diff", error);
    throw error;
  }
}

export async function getFileContent(
  config: Pick<GitHubConfig, "upstreamOwner" | "upstreamRepo">,
  version: string,
  filename: string,
): Promise<string> {
  const octokit = getOctokit();

  try {
    const { data } = await octokit.repos.getContent({
      owner: config.upstreamOwner,
      repo: config.upstreamRepo,
      path: filename,
      ref: version,
    });

    if ("content" in data && data.encoding === "base64") {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }

    throw new Error(`Unexpected response format for ${filename}`);
  } catch (error) {
    logger.error(`Failed to fetch ${filename} at ${version}`, error);
    throw error;
  }
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

  try {
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
  } catch (error) {
    logger.warn(`Failed to fetch CLI changelog for ${version}`, error);
    return { changes: [], compareUrl: "" };
  }
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
