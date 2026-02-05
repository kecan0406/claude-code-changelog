import { createHmac, timingSafeEqual } from "crypto";

const MAX_TIMESTAMP_DIFF_SECONDS = 300; // 5 minutes

/**
 * Verify Slack request signature using HMAC-SHA256.
 * Prevents replay attacks by checking timestamp freshness.
 *
 * @see https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(
  signingSecret: string,
  rawBody: string,
  timestamp: string,
  signature: string,
): boolean {
  // Replay attack prevention: reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  const requestTimestamp = parseInt(timestamp, 10);

  if (isNaN(requestTimestamp)) {
    return false;
  }

  if (Math.abs(now - requestTimestamp) > MAX_TIMESTAMP_DIFF_SECONDS) {
    return false;
  }

  // Compute expected signature
  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", signingSecret);
  hmac.update(baseString);
  const expectedSignature = `v0=${hmac.digest("hex")}`;

  // Timing-safe comparison (consistent with secureCompare in api/cron/notify.ts)
  const expectedBuf = Buffer.from(expectedSignature);
  const actualBuf = Buffer.from(signature);
  const maxLen = Math.max(expectedBuf.length, actualBuf.length);
  const padExpected = Buffer.alloc(maxLen);
  const padActual = Buffer.alloc(maxLen);
  expectedBuf.copy(padExpected);
  actualBuf.copy(padActual);

  const lengthMatch = expectedBuf.length === actualBuf.length;
  const contentMatch = timingSafeEqual(padExpected, padActual);

  return lengthMatch && contentMatch;
}
