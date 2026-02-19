import { GITHUB_DEFAULTS } from "../services/github.js";

export interface AppConfig {
  // Redis
  upstashRedisRestUrl: string;
  upstashRedisRestToken: string;

  // Slack OAuth
  slackClientId: string;
  slackClientSecret: string;

  // Security
  encryptionKey: string;

  // Anthropic
  anthropicApiKey: string;

  // GitHub (with defaults)
  cliRepoOwner: string;
  cliRepoName: string;

  // GitHub API (optional - increases rate limit from 60/hr to 5000/hr)
  githubToken: string | null;

  // Slack Signing Secret (optional - required for slash commands)
  slackSigningSecret: string | null;
}

interface EnvValidation {
  key: string;
  envVar: string;
  required: boolean;
  defaultValue?: string;
}

const ENV_VALIDATIONS: EnvValidation[] = [
  {
    key: "upstashRedisRestUrl",
    envVar: "UPSTASH_REDIS_REST_URL",
    required: true,
  },
  {
    key: "upstashRedisRestToken",
    envVar: "UPSTASH_REDIS_REST_TOKEN",
    required: true,
  },
  { key: "slackClientId", envVar: "SLACK_CLIENT_ID", required: true },
  { key: "slackClientSecret", envVar: "SLACK_CLIENT_SECRET", required: true },
  { key: "encryptionKey", envVar: "ENCRYPTION_KEY", required: true },
  { key: "anthropicApiKey", envVar: "ANTHROPIC_API_KEY", required: true },
  {
    key: "cliRepoOwner",
    envVar: "CLI_REPO_OWNER",
    required: false,
    defaultValue: GITHUB_DEFAULTS.CLI_REPO_OWNER,
  },
  {
    key: "cliRepoName",
    envVar: "CLI_REPO_NAME",
    required: false,
    defaultValue: GITHUB_DEFAULTS.CLI_REPO_NAME,
  },
  { key: "githubToken", envVar: "GITHUB_TOKEN", required: false },
  {
    key: "slackSigningSecret",
    envVar: "SLACK_SIGNING_SECRET",
    required: false,
  },
];

let cachedConfig: AppConfig | null = null;

/**
 * Load and validate all environment variables
 * Call this at application startup to fail fast on missing config
 * @throws Error if required environment variables are missing
 */
export function loadConfig(): AppConfig {
  const missing: string[] = [];
  const config: Record<string, string> = {};

  for (const validation of ENV_VALIDATIONS) {
    const value = process.env[validation.envVar];

    if (!value && validation.required) {
      missing.push(validation.envVar);
    } else {
      config[validation.key] = value || validation.defaultValue || "";
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  // Convert empty optional fields to null
  if (!config.githubToken) {
    config.githubToken = null as unknown as string;
  }
  if (!config.slackSigningSecret) {
    config.slackSigningSecret = null as unknown as string;
  }

  // Validate encryption key format (should be 64 hex chars for 32 bytes)
  if (!/^[a-f0-9]{64}$/i.test(config.encryptionKey)) {
    throw new Error(
      "ENCRYPTION_KEY must be a 64-character hexadecimal string (32 bytes)",
    );
  }

  cachedConfig = config as unknown as AppConfig;
  return cachedConfig;
}

/**
 * Get the cached configuration
 * @throws Error if loadConfig() hasn't been called
 */
export function getConfig(): AppConfig {
  if (!cachedConfig) {
    throw new Error("Configuration not loaded. Call loadConfig() first.");
  }
  return cachedConfig;
}

/**
 * Check if configuration has been loaded
 */
export function isConfigLoaded(): boolean {
  return cachedConfig !== null;
}

/**
 * Reset cached configuration (useful for testing)
 */
export function resetConfig(): void {
  cachedConfig = null;
}
