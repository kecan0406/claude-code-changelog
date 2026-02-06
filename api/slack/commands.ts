import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { IncomingMessage } from "http";
import { verifySlackSignature } from "../../src/utils/slack-verify.js";
import {
  getWorkspaceByTeamId,
  updateWorkspace,
} from "../../src/db/workspaces.js";
import { logger } from "../../src/utils/logger.js";
import type { Language } from "../../src/types/index.js";

export const config = { api: { bodyParser: false } };

const VALID_LANGUAGES: readonly Language[] = ["en", "ko"] as const;

const LANGUAGE_LABELS: Record<Language, string> = {
  en: "English",
  ko: "한국어",
};

function isValidLanguage(value: string): value is Language {
  return VALID_LANGUAGES.includes(value as Language);
}

const MAX_BODY_SIZE = 10 * 1024; // 10KB

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

function slackResponse(
  text: string,
  type: "in_channel" | "ephemeral" = "in_channel",
): { response_type: string; text: string } {
  return { response_type: type, text };
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
    // Read raw body for signature verification
    const rawBody = await readRawBody(req);

    // Verify Slack signature
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

    // Parse URL-encoded body
    const params = new URLSearchParams(rawBody);
    const teamId = params.get("team_id");
    const text = (params.get("text") || "").trim().toLowerCase();

    if (!teamId || !isValidTeamId(teamId)) {
      res
        .status(200)
        .json(slackResponse("Error: invalid team_id", "ephemeral"));
      return;
    }

    const workspace = await getWorkspaceByTeamId(teamId);

    if (!workspace) {
      res
        .status(200)
        .json(
          slackResponse(
            "This workspace is not registered. Please reinstall the app.",
            "ephemeral",
          ),
        );
      return;
    }

    // No argument: show current language
    if (!text) {
      const label = LANGUAGE_LABELS[workspace.language];
      const message =
        workspace.language === "ko"
          ? `현재 알림 언어: ${label}`
          : `Current notification language: ${label}`;
      res.status(200).json(slackResponse(message));
      return;
    }

    // Validate language argument
    if (!isValidLanguage(text)) {
      res
        .status(200)
        .json(
          slackResponse(
            `Invalid language. Use: ${VALID_LANGUAGES.join(", ")}`,
            "ephemeral",
          ),
        );
      return;
    }

    // Update language
    await updateWorkspace(teamId, { language: text });

    const successMessage =
      text === "ko"
        ? `알림 언어가 ${LANGUAGE_LABELS[text]}로 변경되었습니다.`
        : `Notification language changed to ${LANGUAGE_LABELS[text]}.`;

    logger.info(`Language updated for team ${teamId}: ${text}`);
    res.status(200).json(slackResponse(successMessage));
  } catch (error) {
    logger.error("Slash command handler failed", error);
    res
      .status(200)
      .json(
        slackResponse(
          "An error occurred. Please try again later.",
          "ephemeral",
        ),
      );
  }
}
