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

// ===== Constants & Types =====

const TOKEN_INVALID_ERRORS = [
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "token_expired",
  "not_authed",
  "missing_scope",
] as const;

interface MessageStrings {
  released: string;
  changelog: string;
  detailsInThread: string;
  viewDiff: string;
}

const MESSAGES: Record<Language, MessageStrings> = {
  en: {
    released: "is out.",
    changelog: "changelog",
    detailsInThread: "Details in thread",
    viewDiff: "Diff",
  },
  ko: {
    released: "버전이 출시되었습니다.",
    changelog: "변경사항",
    detailsInThread: "자세한 내용은 스레드에서 확인하세요",
    viewDiff: "Diff",
  },
};

const REPO_PATH = `${GITHUB_DEFAULTS.CLI_REPO_OWNER}/${GITHUB_DEFAULTS.CLI_REPO_NAME}`;

const MESSAGE_DELAY_MS = 1100;

const CONCURRENCY_LIMIT = 10;

export interface NotificationResult {
  workspace: Workspace;
  success: boolean;
  error?: Error;
}

// ===== Low-level Utilities =====

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTokenInvalidError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return TOKEN_INVALID_ERRORS.some((code) => message.includes(code));
  }

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

// ===== Block Builders =====

function formatCountsText(summary: ChangeSummary, language: Language): string {
  const cliCount = summary.cliChanges.length;

  if (language === "ko") {
    return cliCount > 0 ? `CLI ${cliCount}건.` : "CLI 없음.";
  }

  return cliCount > 0 ? `${cliCount} CLI changes.` : "no CLI changes.";
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

function buildMainMessageBlocks(
  version: string,
  summary: ChangeSummary,
  language: Language,
  options?: { includeThreadHint?: boolean },
): KnownBlock[] {
  const msg = MESSAGES[language];
  const includeThreadHint = options?.includeThreadHint !== false;

  const countsText = formatCountsText(summary, language);
  const mainText = `*Claude Code ${version}* ${msg.released}`;

  const bodyParts = [countsText];
  if (summary.summary) {
    bodyParts.push(summary.summary);
  }
  if (includeThreadHint) {
    bodyParts.push(msg.detailsInThread);
  }
  const text = `${mainText}\n\n${bodyParts.join("\n\n")}`;

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text,
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
    repoPath: REPO_PATH,
    language,
  });
}

// ===== Message Posting =====

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

// ===== High-level Orchestration =====

export async function postThreadedChangelog(
  botToken: string,
  channelId: string,
  version: string,
  summary: ChangeSummary,
  cliCompareUrl: string,
  language: Language,
): Promise<void> {
  const client = new WebClient(botToken);

  const mainBlocks = buildMainMessageBlocks(version, summary, language);
  const mainResult = await postMessage(client, channelId, mainBlocks);

  if (!mainResult.ts) {
    throw new Error("Failed to get thread timestamp from Slack response");
  }
  const threadTs = mainResult.ts;

  if (summary.cliChanges.length > 0) {
    await delay(MESSAGE_DELAY_MS);
    const cliBlocks = buildCliReplyBlocks(
      version,
      summary.cliChanges,
      cliCompareUrl,
      language,
    );
    await postMessage(client, channelId, cliBlocks, threadTs);
  }
}

export async function sendWorkspaceNotification(
  workspace: Workspace,
  message: SlackMessage,
): Promise<void> {
  try {
    logger.info(
      `Sending notification to workspace ${workspace.teamName} (${workspace.teamId}) for ${message.version}`,
    );

    await postThreadedChangelog(
      workspace.botToken,
      workspace.channelId,
      message.version,
      message.summary,
      message.cliCompareUrl,
      workspace.language,
    );

    logger.info(`Notification sent to workspace ${workspace.teamName}`);
  } catch (error) {
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

  return settledResults.map((result) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return {
      workspace: { teamId: "unknown", teamName: "unknown" } as Workspace,
      success: false,
      error:
        result.reason instanceof Error
          ? result.reason
          : new Error(String(result.reason)),
    };
  });
}
