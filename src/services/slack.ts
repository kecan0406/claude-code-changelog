import { WebClient, type ChatPostMessageResponse } from "@slack/web-api";
import type {
  KnownBlock,
  SectionBlock,
  ContextBlock,
  MrkdwnElement,
} from "@slack/types";
import type { SlackMessage, ChangeSummary, Language } from "../types/index.js";
import type { Workspace } from "../types/database.js";
import { logger } from "../utils/logger.js";
import { GITHUB_DEFAULTS } from "./github.js";
import { withRetry } from "../utils/retry.js";
import { deactivateWorkspace } from "../db/workspaces.js";

// Slack error codes that indicate invalid/revoked tokens
const TOKEN_INVALID_ERRORS = [
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "token_expired",
  "not_authed",
  "missing_scope",
] as const;

/**
 * Check if an error indicates the bot token is invalid/revoked
 */
function isTokenInvalidError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return TOKEN_INVALID_ERRORS.some((code) => message.includes(code));
  }

  // Check for Slack API error format
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof (error as { data: unknown }).data === "object"
  ) {
    const data = (error as { data: { error?: string } }).data;
    if (typeof data?.error === "string") {
      return TOKEN_INVALID_ERRORS.some((code) => data.error === code);
    }
  }

  return false;
}

interface MessageStrings {
  released: string;
  cliChanges: string;
  flagChanges: string;
  promptChanges: string;
  changes: string;
  changelog: string;
  detailsInThread: string;
  viewDiff: string;
  added: string;
  removed: string;
  modified: string;
  counter: string;
}

const MESSAGES: Record<Language, MessageStrings> = {
  en: {
    released: "is out.",
    cliChanges: "CLI",
    flagChanges: "flag",
    promptChanges: "prompt",
    changes: "changes",
    changelog: "changelog",
    detailsInThread: "Details in thread",
    viewDiff: "Diff",
    added: "Added",
    removed: "Removed",
    modified: "Modified",
    counter: "",
  },
  ko: {
    released: "버전이 출시되었습니다.",
    cliChanges: "CLI",
    flagChanges: "플래그",
    promptChanges: "프롬프트",
    changes: "변경사항",
    changelog: "변경사항",
    detailsInThread: "자세한 내용은 스레드에서 확인하세요",
    viewDiff: "Diff",
    added: "추가됨",
    removed: "제거됨",
    modified: "수정됨",
    counter: "개",
  },
};

const REPO_PATHS = {
  CLI: `${GITHUB_DEFAULTS.CLI_REPO_OWNER}/${GITHUB_DEFAULTS.CLI_REPO_NAME}`,
  CHANGELOG: `${GITHUB_DEFAULTS.UPSTREAM_OWNER}/${GITHUB_DEFAULTS.UPSTREAM_REPO}`,
} as const;

// Delay between messages to respect Slack rate limits (1 msg/sec/channel for Tier 1)
const MESSAGE_DELAY_MS = 1100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ReplyBlockConfig {
  title: string;
  content: string;
  compareUrl: string;
  repoPath: string;
  language: Language;
}

function buildReplyBlocks(config: ReplyBlockConfig): KnownBlock[] {
  const msg = MESSAGES[config.language];
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${config.title}:*\n${config.content}` },
    } satisfies SectionBlock,
  ];

  if (config.compareUrl) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${msg.viewDiff}: <${config.compareUrl}|${config.repoPath}>`,
        } satisfies MrkdwnElement,
      ],
    } satisfies ContextBlock);
  }

  return blocks;
}

async function postMessage(
  client: WebClient,
  channelId: string,
  blocks: KnownBlock[],
  threadTs?: string,
): Promise<ChatPostMessageResponse> {
  const textFallback = extractTextFromBlocks(blocks);

  return withRetry(
    () =>
      client.chat.postMessage({
        channel: channelId,
        blocks,
        text: textFallback,
        thread_ts: threadTs,
      }),
    { maxAttempts: 3, baseDelayMs: 1000 },
  );
}

function extractTextFromBlocks(blocks: KnownBlock[]): string {
  for (const block of blocks) {
    if (block.type === "header" && block.text) {
      return block.text.text;
    }
    if (block.type === "section" && block.text) {
      return block.text.text;
    }
  }
  return "Slack notification";
}

function buildMainMessageBlocks(
  version: string,
  summary: ChangeSummary,
  language: Language,
): KnownBlock[] {
  const msg = MESSAGES[language];

  const cliCount = summary.cliChanges.length;
  const flagCount =
    summary.flagChanges.added.length +
    summary.flagChanges.removed.length +
    summary.flagChanges.modified.length;
  const promptCount = summary.promptChanges.length;

  const changeParts: string[] = [];
  const c = msg.counter;
  if (cliCount > 0) changeParts.push(`${cliCount}${c} ${msg.cliChanges}`);
  if (flagCount > 0) changeParts.push(`${flagCount}${c} ${msg.flagChanges}`);
  if (promptCount > 0) changeParts.push(`${promptCount}${c} ${msg.promptChanges}`);

  let countsText: string;
  if (changeParts.length === 0) {
    countsText = "";
  } else {
    countsText = `${changeParts.join(", ")} ${msg.changes}.`;
  }

  const mainText = `*Claude Code ${version}* ${msg.released}`;
  const bodyText = countsText
    ? `${countsText}\n${msg.detailsInThread}`
    : msg.detailsInThread;

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${mainText}\n${bodyText}`,
      },
    } satisfies SectionBlock,
  ];
}

function buildCliReplyBlocks(
  version: string,
  cliChanges: string[],
  compareUrl: string,
  language: Language,
): KnownBlock[] {
  const msg = MESSAGES[language];
  return buildReplyBlocks({
    title: `Claude Code CLI ${version} ${msg.changelog}`,
    content: cliChanges.map((c) => `• ${c}`).join("\n"),
    compareUrl,
    repoPath: REPO_PATHS.CLI,
    language,
  });
}

function buildPromptReplyBlocks(
  version: string,
  promptChanges: string[],
  compareUrl: string,
  language: Language,
): KnownBlock[] {
  const msg = MESSAGES[language];
  return buildReplyBlocks({
    title: `Claude Code ${version} ${msg.promptChanges} ${msg.changes}`,
    content: promptChanges.map((c) => `• ${c}`).join("\n"),
    compareUrl,
    repoPath: REPO_PATHS.CHANGELOG,
    language,
  });
}

function buildFlagReplyBlocks(
  version: string,
  flagChanges: ChangeSummary["flagChanges"],
  compareUrl: string,
  language: Language,
): KnownBlock[] {
  const msg = MESSAGES[language];
  const lines: string[] = [];

  if (flagChanges.added.length > 0) {
    lines.push(`*${msg.added}:* ${flagChanges.added.join(", ")}`);
  }
  if (flagChanges.removed.length > 0) {
    lines.push(`*${msg.removed}:* ${flagChanges.removed.join(", ")}`);
  }
  if (flagChanges.modified.length > 0) {
    lines.push(`*${msg.modified}:* ${flagChanges.modified.join(", ")}`);
  }

  return buildReplyBlocks({
    title: `Claude Code ${version} ${msg.flagChanges} ${msg.changes}`,
    content: lines.join("\n"),
    compareUrl,
    repoPath: REPO_PATHS.CHANGELOG,
    language,
  });
}

export async function sendWorkspaceNotification(
  workspace: Workspace,
  message: SlackMessage,
): Promise<void> {
  const client = new WebClient(workspace.botToken);
  const language = workspace.language;

  try {
    logger.info(
      `Sending notification to workspace ${workspace.teamName} (${workspace.teamId}) for ${message.version}`,
    );

    const mainBlocks = buildMainMessageBlocks(
      message.version,
      message.summary,
      language,
    );
    const mainResult = await postMessage(
      client,
      workspace.channelId,
      mainBlocks,
    );

    if (!mainResult.ts) {
      throw new Error("Failed to get thread timestamp from Slack response");
    }
    const threadTs = mainResult.ts;

    // Send thread replies with rate limit delay
    if (message.summary.cliChanges.length > 0) {
      await delay(MESSAGE_DELAY_MS);
      const cliBlocks = buildCliReplyBlocks(
        message.version,
        message.summary.cliChanges,
        message.cliCompareUrl,
        language,
      );
      await postMessage(client, workspace.channelId, cliBlocks, threadTs);
    }

    const hasFlags =
      message.summary.flagChanges.added.length > 0 ||
      message.summary.flagChanges.removed.length > 0 ||
      message.summary.flagChanges.modified.length > 0;

    if (hasFlags) {
      await delay(MESSAGE_DELAY_MS);
      const flagBlocks = buildFlagReplyBlocks(
        message.version,
        message.summary.flagChanges,
        message.compareUrl,
        language,
      );
      await postMessage(client, workspace.channelId, flagBlocks, threadTs);
    }

    if (message.summary.promptChanges.length > 0) {
      await delay(MESSAGE_DELAY_MS);
      const promptBlocks = buildPromptReplyBlocks(
        message.version,
        message.summary.promptChanges,
        message.compareUrl,
        language,
      );
      await postMessage(client, workspace.channelId, promptBlocks, threadTs);
    }

    logger.info(`Notification sent to workspace ${workspace.teamName}`);
  } catch (error) {
    // Auto-deactivate workspace if token is invalid
    if (isTokenInvalidError(error)) {
      logger.warn(
        `Token invalid for workspace ${workspace.teamName}, deactivating`,
      );
      try {
        await deactivateWorkspace(workspace.teamId);
      } catch (deactivateError) {
        logger.error(
          `Failed to deactivate workspace ${workspace.teamId}`,
          deactivateError,
        );
      }
    }

    logger.error(
      `Failed to send notification to workspace ${workspace.teamName}`,
      error,
    );
    throw error;
  }
}

export async function sendWelcomeMessage(workspace: Workspace): Promise<void> {
  const client = new WebClient(workspace.botToken);
  const language = workspace.language;

  const welcomeMessages: Record<Language, { title: string; body: string }> = {
    en: {
      title: "Claude Code Changelog Bot installed!",
      body: "You will receive notifications when new Claude Code versions are released.\n\nLanguage: English",
    },
    ko: {
      title: "Claude Code Changelog Bot이 설치되었습니다!",
      body: "새로운 Claude Code 버전이 출시되면 알림을 받게 됩니다.\n\n언어: 한국어",
    },
  };

  const msg = welcomeMessages[language];

  try {
    await client.chat.postMessage({
      channel: workspace.channelId,
      text: msg.title,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${msg.title}*\n\n${msg.body}`,
          },
        },
      ],
    });

    logger.info(`Welcome message sent to workspace ${workspace.teamName}`);
  } catch (error) {
    logger.error(
      `Failed to send welcome message to workspace ${workspace.teamName}`,
      error,
    );
    throw error;
  }
}

export interface NotificationResult {
  workspace: Workspace;
  success: boolean;
  error?: Error;
}

const CONCURRENCY_LIMIT = 10;

/**
 * Process items in batches with concurrency limit
 */
async function processInBatches<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(processor));
    results.push(...batchResults);
  }

  return results;
}

export async function sendNotificationToWorkspaces(
  workspaces: Workspace[],
  message: SlackMessage,
  summariesByLanguage: Map<Language, ChangeSummary>,
): Promise<NotificationResult[]> {
  const processor = async (
    workspace: Workspace,
  ): Promise<NotificationResult> => {
    const summary = summariesByLanguage.get(workspace.language);

    if (!summary) {
      logger.warn(
        `No summary available for ${workspace.language}, skipping workspace ${workspace.teamName}`,
      );
      return {
        workspace,
        success: false,
        error: new Error(`No summary for language: ${workspace.language}`),
      };
    }

    try {
      const workspaceMessage: SlackMessage = {
        ...message,
        summary,
      };

      await sendWorkspaceNotification(workspace, workspaceMessage);
      return { workspace, success: true };
    } catch (error) {
      logger.error(`Failed to notify workspace ${workspace.teamName}`, error);
      return {
        workspace,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  };

  const settledResults = await processInBatches(
    workspaces,
    processor,
    CONCURRENCY_LIMIT,
  );

  // Extract values from settled results (processor never throws)
  return settledResults.map((result) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    // This should never happen since processor catches all errors
    return {
      workspace: { teamId: "unknown", teamName: "unknown" } as Workspace,
      success: false,
      error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
    };
  });
}
