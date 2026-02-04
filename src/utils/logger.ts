type LogLevel = 'info' | 'warn' | 'error' | 'debug';

// Patterns for sensitive data that should be masked in logs
const SENSITIVE_PATTERNS: RegExp[] = [
  // Slack bot tokens (xoxb-...)
  /xoxb-[\w-]+/gi,
  // Slack user tokens (xoxp-...)
  /xoxp-[\w-]+/gi,
  // Slack app tokens (xoxa-...)
  /xoxa-[\w-]+/gi,
  // API keys (sk-...)
  /sk-[a-zA-Z0-9]{20,}/gi,
  // Generic API key patterns
  /api[_-]?key["\s:=]+["']?[\w-]{20,}["']?/gi,
  // Encryption keys (64 char hex)
  /[a-f0-9]{64}/gi,
  // Bearer tokens
  /bearer\s+[\w.-]+/gi,
  // Basic auth
  /basic\s+[\w+/=]+/gi,
];

const MASK = "[REDACTED]";

/**
 * Sanitize a string by masking sensitive patterns
 */
function sanitizeString(str: string): string {
  let result = str;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, MASK);
  }
  return result;
}

/**
 * Deep sanitize an object, masking sensitive values
 */
function sanitizeObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === "string") {
    return sanitizeString(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }

  if (typeof obj === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Mask values of known sensitive keys entirely
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes("token") ||
        lowerKey.includes("secret") ||
        lowerKey.includes("password") ||
        lowerKey.includes("apikey") ||
        lowerKey.includes("api_key") ||
        lowerKey.includes("authorization") ||
        lowerKey.includes("credential")
      ) {
        sanitized[key] = MASK;
      } else {
        sanitized[key] = sanitizeObject(value);
      }
    }
    return sanitized;
  }

  return obj;
}

/**
 * Sanitize an error object for safe logging
 */
function sanitizeError(error: Error): { name: string; message: string; stack?: string } {
  return {
    name: error.name,
    message: sanitizeString(error.message),
    stack: error.stack ? sanitizeString(error.stack) : undefined,
  };
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatData(data: unknown): string {
  if (data instanceof Error) {
    return JSON.stringify(sanitizeError(data), null, 2);
  }
  return JSON.stringify(sanitizeObject(data), null, 2);
}

function log(level: LogLevel, message: string, data?: unknown): void {
  const timestamp = formatTimestamp();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

  if (data !== undefined) {
    console.log(`${prefix} ${message}`, formatData(data));
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export const logger = {
  info: (message: string, data?: unknown) => log('info', message, data),
  warn: (message: string, data?: unknown) => log('warn', message, data),
  error: (message: string, data?: unknown) => log('error', message, data),
  debug: (message: string, data?: unknown) => {
    if (process.env.DEBUG) {
      log('debug', message, data);
    }
  },
};
