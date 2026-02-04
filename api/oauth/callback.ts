import type { VercelRequest, VercelResponse } from "@vercel/node";
import { WebClient } from "@slack/web-api";
import { createWorkspace } from "../../src/db/workspaces.js";
import { sendWelcomeMessage } from "../../src/services/slack.js";
import type { Language } from "../../src/types/index.js";
import { logger } from "../../src/utils/logger.js";

const SLACK_OAUTH_ACCESS_URL = "https://slack.com/api/oauth.v2.access";

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: {
    id: string;
    name: string;
  };
  authed_user?: {
    id: string;
  };
  incoming_webhook?: {
    channel: string;
    channel_id: string;
    configuration_url: string;
    url: string;
  };
}

interface StatePayload {
  language?: Language;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const { code, state, error } = req.query;

  // Handle OAuth errors
  if (error) {
    logger.error("OAuth error", { error: String(error) });
    res.redirect(`/install-error?error=${encodeURIComponent(String(error))}`);
    return;
  }

  if (!code || typeof code !== "string") {
    res.redirect("/install-error?error=missing_code");
    return;
  }

  // Validate required environment variables
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    logger.error("Missing SLACK_CLIENT_ID or SLACK_CLIENT_SECRET");
    res.redirect("/install-error?error=server_configuration");
    return;
  }

  try {
    // Parse state to get language preference
    let language: Language = "en";
    if (state && typeof state === "string") {
      try {
        const payload: StatePayload = JSON.parse(
          Buffer.from(state, "base64").toString("utf-8"),
        );
        if (payload.language === "ko") {
          language = "ko";
        }
      } catch {
        // Ignore state parsing errors, use default language
      }
    }

    // Exchange code for access token
    const redirectUri = getRedirectUri(req);

    const tokenResponse = await fetch(SLACK_OAUTH_ACCESS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    // Validate HTTP status code before parsing JSON
    if (!tokenResponse.ok) {
      logger.error("OAuth token request failed", {
        status: tokenResponse.status,
        statusText: tokenResponse.statusText,
      });
      res.redirect(
        `/install-error?error=oauth_request_failed&status=${tokenResponse.status}`,
      );
      return;
    }

    const tokenData = (await tokenResponse.json()) as SlackOAuthResponse;

    if (!tokenData.ok) {
      logger.error("Slack OAuth failed", { error: tokenData.error });
      res.redirect(
        `/install-error?error=${encodeURIComponent(tokenData.error || "unknown")}`,
      );
      return;
    }

    // Validate required fields
    if (!tokenData.access_token || !tokenData.team) {
      logger.error("Missing required fields in OAuth response");
      res.redirect("/install-error?error=invalid_response");
      return;
    }

    // Get the default channel to post to
    // If incoming_webhook is present, use that channel
    // Otherwise, we'll need to prompt the user or use a default
    let channelId = tokenData.incoming_webhook?.channel_id;

    if (!channelId) {
      // Try to find the default channel using conversations.list
      const client = new WebClient(tokenData.access_token);
      try {
        const channels = await client.conversations.list({
          types: "public_channel",
          limit: 100,
        });

        // Look for #general or the first available channel
        const generalChannel = channels.channels?.find(
          (ch) => ch.name === "general" && ch.is_member,
        );
        const firstJoinedChannel = channels.channels?.find(
          (ch) => ch.is_member,
        );

        channelId = generalChannel?.id || firstJoinedChannel?.id;
      } catch (err) {
        logger.error("Failed to list channels", err);
      }
    }

    if (!channelId) {
      logger.error("Could not determine channel to post to");
      res.redirect("/install-error?error=no_channel");
      return;
    }

    // Save workspace to database
    const workspace = await createWorkspace({
      teamId: tokenData.team.id,
      teamName: tokenData.team.name,
      botToken: tokenData.access_token,
      channelId,
      language,
    });

    logger.info(
      `Workspace installed: ${workspace.teamName} (${workspace.teamId})`,
    );

    // Send welcome message
    try {
      await sendWelcomeMessage(workspace);
    } catch (err) {
      logger.error("Failed to send welcome message", err);
      // Don't fail the installation if welcome message fails
    }

    // Redirect to success page
    const successParams = new URLSearchParams({
      team: tokenData.team.name,
      lang: language,
    });

    res.redirect(`/install-success?${successParams.toString()}`);
  } catch (err) {
    logger.error("OAuth callback error", err);
    res.redirect("/install-error?error=internal_error");
  }
}

function getRedirectUri(req: VercelRequest): string {
  const host = req.headers.host || "localhost:3000";
  const protocol = host.includes("localhost") ? "http" : "https";
  return `${protocol}://${host}/api/oauth/callback`;
}
