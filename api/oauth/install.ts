import type { VercelRequest, VercelResponse } from "@vercel/node";

const SLACK_OAUTH_URL = "https://slack.com/oauth/v2/authorize";
const REQUIRED_SCOPES = ["chat:write", "channels:read"];

export default function handler(req: VercelRequest, res: VercelResponse): void {
  const clientId = process.env.SLACK_CLIENT_ID;

  if (!clientId) {
    res.status(500).json({ error: "SLACK_CLIENT_ID is not configured" });
    return;
  }

  // Get language preference from query params (default: en)
  const language = req.query.lang === "ko" ? "ko" : "en";

  // Store language in state for callback
  const state = Buffer.from(JSON.stringify({ language })).toString("base64");

  const redirectUri = getRedirectUri(req);

  const params = new URLSearchParams({
    client_id: clientId,
    scope: REQUIRED_SCOPES.join(","),
    redirect_uri: redirectUri,
    state,
  });

  const authUrl = `${SLACK_OAUTH_URL}?${params.toString()}`;

  res.redirect(authUrl);
}

function getRedirectUri(req: VercelRequest): string {
  const host = req.headers.host || "localhost:3000";
  const protocol = host.includes("localhost") ? "http" : "https";
  return `${protocol}://${host}/api/oauth/callback`;
}
