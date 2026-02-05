import { timingSafeEqual } from "crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { runMultiWorkspaceNotification } from "../../src/workers/notify-all.js";
import { logger } from "../../src/utils/logger.js";

function secureCompare(a: string, b: string): boolean {
  // Use fixed-size buffers to prevent timing leaks from length differences
  const maxLen = Math.max(a.length, b.length);
  const bufA = Buffer.alloc(maxLen);
  const bufB = Buffer.alloc(maxLen);

  Buffer.from(a).copy(bufA);
  Buffer.from(b).copy(bufB);

  // Both length and content must match
  const lengthMatch = a.length === b.length;
  const contentMatch = timingSafeEqual(bufA, bufB);

  return lengthMatch && contentMatch;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only allow GET and POST methods
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // CRON_SECRET is required for all requests
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    logger.error("CRON_SECRET not configured");
    res.status(500).json({ error: "Internal server error" });
    return;
  }

  // Verify authentication via Bearer token
  // Vercel Cron automatically sends Authorization header with CRON_SECRET
  const authHeader = req.headers.authorization;
  const expectedHeader = `Bearer ${cronSecret}`;
  const isValidToken =
    authHeader && secureCompare(authHeader, expectedHeader);

  if (!isValidToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Validate request ID format to prevent log injection
  const vercelRequestId = req.headers["x-vercel-request-id"];
  const isValidRequestId =
    typeof vercelRequestId === "string" &&
    /^[a-zA-Z0-9-]{1,64}$/.test(vercelRequestId);
  const requestId = isValidRequestId ? vercelRequestId : crypto.randomUUID();

  try {
    logger.info("Notification trigger received", { requestId });
    await runMultiWorkspaceNotification();
    res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Notification failed", { requestId, error });
    res.status(500).json({ error: "Internal server error" });
  }
}
