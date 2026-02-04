import { WebClient, type ChatPostMessageResponse } from "@slack/web-api";
import type { SlackMessage, ChangeSummary, Language } from "../types/index.js";
import type { Workspace } from "../types/database.js";
import { logger } from "../utils/logger.js";

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

interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
  };
  elements?: Array<{
    type: string;
    text: string;
  }>;
}

async function postMessage(
  client: WebClient,
  channelId: string,
  blocks: SlackBlock[],
  threadTs?: string,
): Promise<ChatPostMessageResponse> {
  const textFallback = extractTextFromBlocks(blocks);

  return client.chat.postMessage({
    channel: channelId,
    blocks,
    text: textFallback,
    thread_ts: threadTs,
  });
}

function extractTextFromBlocks(blocks: SlackBlock[]): string {
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
): SlackBlock[] {
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
    },
  ];
}

function buildCliReplyBlocks(
  version: string,
  cliChanges: string[],
  compareUrl: string,
  language: Language,
): SlackBlock[] {
  const msg = MESSAGES[language];
  const changesText = cliChanges.map((c) => `• ${c}`).join("\n");

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Claude Code CLI ${version} ${msg.changelog}:*\n${changesText}`,
      },
    },
  ];

  if (compareUrl) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${msg.viewDiff}: <${compareUrl}|anthropics/claude-code>`,
        },
      ],
    });
  }

  return blocks;
}

function buildPromptReplyBlocks(
  version: string,
  promptChanges: string[],
  compareUrl: string,
  language: Language,
): SlackBlock[] {
  const msg = MESSAGES[language];
  const changesText = promptChanges.map((c) => `• ${c}`).join("\n");

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Claude Code ${version} ${msg.promptChanges} ${msg.changes}:*\n${changesText}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${msg.viewDiff}: <${compareUrl}|marckrenn/claude-code-changelog>`,
        },
      ],
    },
  ];
}

function buildFlagReplyBlocks(
  version: string,
  flagChanges: ChangeSummary["flagChanges"],
  compareUrl: string,
  language: Language,
): SlackBlock[] {
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

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Claude Code ${version} ${msg.flagChanges} ${msg.changes}:*\n${lines.join("\n")}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${msg.viewDiff}: <${compareUrl}|marckrenn/claude-code-changelog>`,
        },
      ],
    },
  ];
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

    if (message.summary.cliChanges.length > 0) {
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
      const flagBlocks = buildFlagReplyBlocks(
        message.version,
        message.summary.flagChanges,
        message.compareUrl,
        language,
      );
      await postMessage(client, workspace.channelId, flagBlocks, threadTs);
    }

    if (message.summary.promptChanges.length > 0) {
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

export async function sendNotificationToWorkspaces(
  workspaces: Workspace[],
  message: SlackMessage,
  summariesByLanguage: Map<Language, ChangeSummary>,
): Promise<NotificationResult[]> {
  const results: NotificationResult[] = [];

  for (const workspace of workspaces) {
    const summary = summariesByLanguage.get(workspace.language);

    if (!summary) {
      logger.warn(
        `No summary available for ${workspace.language}, skipping workspace ${workspace.teamName}`,
      );
      results.push({
        workspace,
        success: false,
        error: new Error(`No summary for language: ${workspace.language}`),
      });
      continue;
    }

    try {
      const workspaceMessage: SlackMessage = {
        ...message,
        summary,
      };

      await sendWorkspaceNotification(workspace, workspaceMessage);
      results.push({ workspace, success: true });
    } catch (error) {
      logger.error(`Failed to notify workspace ${workspace.teamName}`, error);
      results.push({
        workspace,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  return results;
}
