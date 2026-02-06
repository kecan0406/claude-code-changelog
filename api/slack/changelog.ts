import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import type { IncomingMessage } from "http";
import type { KnownBlock } from "@slack/types";
import { verifySlackSignature } from "../../src/utils/slack-verify.js";
import { getWorkspaceByTeamId } from "../../src/db/workspaces.js";
import { getLastCheckedVersion } from "../../src/db/state.js";
import { summaryCache } from "../../src/cache/index.js";
import {
  getLatestTag,
  getChangelogDiff,
  getCliChangelog,
  findPreviousTag,
  GITHUB_DEFAULTS,
} from "../../src/services/github.js";
import { generateSummary } from "../../src/services/claude.js";
import { buildChangelogBlocks } from "../../src/services/slack.js";
import { logger } from "../../src/utils/logger.js";
import type { Language } from "../../src/types/index.js";

export const config = { api: { bodyParser: false } };

const MAX_BODY_SIZE = 10 * 1024;

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    req.on("data", (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function isValidTeamId(value: string): boolean {
  return /^T[A-Z0-9]{1,20}$/.test(value);
}

function isValidSlackResponseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.endsWith(".slack.com") && parsed.protocol === "https:"
    );
  } catch {
    return false;
  }
}

interface CommandStrings {
  generating: string;
  noData: string;
  error: string;
  notRegistered: string;
  timeout: string;
}

const COMMAND_MESSAGES: Record<Language, CommandStrings> = {
  en: {
    generating: "Generating changelog summary... This may take 10-20 seconds.",
    noData:
      "No changelog data is available yet. Please try again after a notification has been sent.",
    error: "Failed to generate changelog. Please try again later.",
    notRegistered:
      "This workspace is not registered. Please reinstall the app.",
    timeout: "Summary generation timed out. Please try again.",
  },
  ko: {
    generating:
      "변경사항 요약을 생성 중입니다... 10-20초 정도 소요될 수 있습니다.",
    noData:
      "아직 변경사항 데이터가 없습니다. 알림이 전송된 후 다시 시도해주세요.",
    error: "변경사항 생성에 실패했습니다. 나중에 다시 시도해주세요.",
    notRegistered:
      "이 워크스페이스는 등록되지 않았습니다. 앱을 다시 설치해주세요.",
    timeout: "요약 생성 시간이 초과되었습니다. 다시 시도해주세요.",
  },
};

const ASYNC_TIMEOUT_MS = 25_000;

function getGitHubConfig() {
  return {
    upstream: {
      upstreamOwner:
        process.env.UPSTREAM_OWNER || GITHUB_DEFAULTS.UPSTREAM_OWNER,
      upstreamRepo: process.env.UPSTREAM_REPO || GITHUB_DEFAULTS.UPSTREAM_REPO,
    },
    cli: {
      cliRepoOwner: GITHUB_DEFAULTS.CLI_REPO_OWNER,
      cliRepoName: GITHUB_DEFAULTS.CLI_REPO_NAME,
    },
  };
}

async function postToResponseUrl(
  responseUrl: string,
  blocks: KnownBlock[],
): Promise<void> {
  const textParts: string[] = [];
  for (const b of blocks) {
    if (b.type === "section" && "text" in b && b.text) {
      textParts.push(b.text.text);
    }
  }
  const textFallback = textParts.join("\n").slice(0, 200);

  const response = await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      response_type: "in_channel",
      replace_original: true,
      blocks,
      text: textFallback || "Changelog",
    }),
  });

  if (!response.ok) {
    throw new Error(
      `response_url POST failed: ${response.status} ${response.statusText}`,
    );
  }
}

async function postErrorToResponseUrl(
  responseUrl: string,
  text: string,
): Promise<void> {
  try {
    const response = await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: "ephemeral",
        replace_original: true,
        text,
      }),
    });
    if (!response.ok) {
      logger.warn(
        `Error response_url POST failed: ${response.status} ${response.statusText}`,
      );
    }
  } catch (e) {
    logger.error("Failed to post error to response_url", e);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function generateAndRespond(
  responseUrl: string,
  version: string,
  language: Language,
): Promise<void> {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const ghConfig = getGitHubConfig();
  const fromVersion = findPreviousTag(version);

  const [diff, cliResult] = await Promise.all([
    getChangelogDiff(ghConfig.upstream, fromVersion, version),
    getCliChangelog(ghConfig.cli, version),
  ]);

  const summary = await generateSummary(
    anthropicApiKey,
    language,
    diff,
    cliResult.changes,
  );

  await summaryCache.set(version, language, summary);

  const blocks = buildChangelogBlocks({
    version,
    summary,
    compareUrl: diff.compareUrl,
    cliCompareUrl: cliResult.compareUrl,
    language,
  });

  await postToResponseUrl(responseUrl, blocks);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    logger.error("SLACK_SIGNING_SECRET not configured");
    res.status(500).json({ error: "Internal server error" });
    return;
  }

  try {
    const rawBody = await readRawBody(req);

    const timestamp = req.headers["x-slack-request-timestamp"] as string;
    const signature = req.headers["x-slack-signature"] as string;

    if (!timestamp || !signature) {
      res.status(401).json({ error: "Missing signature headers" });
      return;
    }

    if (!verifySlackSignature(signingSecret, rawBody, timestamp, signature)) {
      logger.warn("Slack signature verification failed");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const params = new URLSearchParams(rawBody);
    const teamId = params.get("team_id");
    const responseUrl = params.get("response_url");

    if (!teamId || !isValidTeamId(teamId)) {
      res
        .status(200)
        .json({ response_type: "ephemeral", text: "Error: invalid team_id" });
      return;
    }

    const workspace = await getWorkspaceByTeamId(teamId);
    if (!workspace) {
      res.status(200).json({
        response_type: "ephemeral",
        text: COMMAND_MESSAGES.en.notRegistered,
      });
      return;
    }

    const language = workspace.language;
    const msg = COMMAND_MESSAGES[language];
    const ghConfig = getGitHubConfig();

    // Determine current version
    let version = await getLastCheckedVersion();

    if (!version) {
      const latestTag = await getLatestTag(ghConfig.upstream);
      if (!latestTag) {
        res.status(200).json({ response_type: "ephemeral", text: msg.noData });
        return;
      }
      version = latestTag.name;
    }

    // Try cache first
    const cachedSummary = await summaryCache.get(version, language);

    if (cachedSummary) {
      logger.info(`/changelog cache hit for ${version}:${language}`);

      const fromVersion = findPreviousTag(version);
      const compareUrl = `https://github.com/${ghConfig.upstream.upstreamOwner}/${ghConfig.upstream.upstreamRepo}/compare/${fromVersion}...${version}`;
      const cliCompareUrl = `https://github.com/${ghConfig.cli.cliRepoOwner}/${ghConfig.cli.cliRepoName}/releases/tag/${version}`;

      const blocks = buildChangelogBlocks({
        version,
        summary: cachedSummary,
        compareUrl,
        cliCompareUrl,
        language,
      });

      res.status(200).json({
        response_type: "in_channel",
        blocks,
        text: `Claude Code ${version} changelog`,
      });
      return;
    }

    // Cache miss: return immediate response and continue async
    logger.info(
      `/changelog cache miss for ${version}:${language}, generating async`,
    );

    if (!responseUrl || !isValidSlackResponseUrl(responseUrl)) {
      res
        .status(200)
        .json({ response_type: "in_channel", text: msg.generating });
      return;
    }

    res.status(200).json({ response_type: "in_channel", text: msg.generating });

    // Use waitUntil to keep the function alive after response is sent
    waitUntil(
      withTimeout(
        generateAndRespond(responseUrl, version, language),
        ASYNC_TIMEOUT_MS,
      ).catch(async (error) => {
        logger.error("/changelog async generation failed", error);
        const errorMsg =
          error instanceof Error && error.message === "Timeout"
            ? msg.timeout
            : msg.error;
        await postErrorToResponseUrl(responseUrl, errorMsg);
      }),
    );
  } catch (error) {
    logger.error("/changelog handler failed", error);
    res.status(200).json({
      response_type: "ephemeral",
      text: "An error occurred. Please try again later.",
    });
  }
}
