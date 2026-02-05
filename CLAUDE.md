# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Changelog Bot - Multi-workspace Slack notification bot that monitors the `marckrenn/claude-code-changelog` repository for new releases and sends formatted notifications to multiple Slack workspaces. Uses Claude API to generate intelligent summaries in English and Korean.

## Commands

```bash
# Build TypeScript
pnpm run build

# Run the notification check (main entry point)
pnpm run notify

# Type checking only
pnpm run typecheck
```

## Architecture

```
src/
  index.ts              # Entry point: runs multi-workspace notification
  config/
    index.ts            # Environment variable validation and config loading (singleton)
  types/
    index.ts            # Core interfaces (TagInfo, ChangelogDiff, ChangeSummary)
    database.ts         # DB types (Workspace, CreateWorkspaceInput, UpdateWorkspaceInput)
  services/
    github.ts           # GitHub API: fetch tags, compare commits, get file content, CLI changelog
    claude.ts           # Anthropic API: generate summaries (en/ko) with XML prompts
    slack.ts            # Slack notifications: workspace-based threaded messages with rate limiting
  db/
    index.ts            # DB module exports
    redis.ts            # Upstash Redis client, distributed locks (SET NX EX + Lua)
    workspaces.ts       # Workspace CRUD with encrypted token storage
    state.ts            # Global state (last_checked_version, failed notifications tracking)
    metrics.ts          # Notification metrics (success/failure counts, timestamps)
  cache/
    index.ts            # Cache module exports
    summary-cache.ts    # Summary cache (Redis-backed, 7-day TTL)
  workers/
    notify-all.ts       # Multi-workspace notification orchestrator with retry logic
  utils/
    crypto.ts           # AES-256-GCM encryption for bot tokens
    logger.ts           # Console logger with sensitive data masking
    retry.ts            # Exponential backoff with jitter retry utility

api/oauth/              # Vercel API routes (OAuth installation)
  install.ts            # OAuth install redirect with language selection
  callback.ts           # OAuth callback handler with welcome message
api/cron/               # Vercel API routes (Scheduled tasks)
  notify.ts             # Manual notification trigger endpoint (requires CRON_SECRET)
```

## Key Behaviors

- Monitors `cc-prompt.md` and `cc-flags.md` files for changes
- Fetches Claude Code CLI changelog from `anthropics/claude-code` repository
- Uses Claude Haiku 4.5 to generate summaries in English or Korean
- Single-tier storage using Upstash Redis
- OAuth-based workspace installation

### Operational Stability

- **Distributed Locks**: Redis SET NX EX + Lua script prevents race conditions
- **Retry Logic**: Exponential backoff with jitter for transient failures (max 3 retries)
- **Failed Notification Tracking**: Auto-retry on next run (7-day TTL)
- **Rate Limiting**: 1.1s delay between Slack messages, concurrency limit of 10

### Security

- **Token Encryption**: AES-256-GCM for bot token storage
- **Sensitive Data Masking**: Auto-masks tokens/secrets in logs
- **Token Invalidation Detection**: Auto-deactivates workspaces with invalid tokens

## Environment Variables

| Variable                   | Required | Description                                    |
| -------------------------- | -------- | ---------------------------------------------- |
| `UPSTASH_REDIS_REST_URL`   | Yes      | Upstash Redis REST URL                         |
| `UPSTASH_REDIS_REST_TOKEN` | Yes      | Upstash Redis REST token                       |
| `SLACK_CLIENT_ID`          | Yes      | Slack App client ID                            |
| `SLACK_CLIENT_SECRET`      | Yes      | Slack App client secret                        |
| `ENCRYPTION_KEY`           | Yes      | 64-char hex key (32 bytes) for token encryption |
| `ANTHROPIC_API_KEY`        | Yes      | Anthropic API key                              |
| `CRON_SECRET`              | No*      | Secret for Vercel cron/manual trigger auth     |
| `GITHUB_TOKEN`             | No       | GitHub token (increases rate limit)            |
| `UPSTREAM_OWNER`           | No       | GitHub owner (default: `marckrenn`)            |
| `UPSTREAM_REPO`            | No       | GitHub repo (default: `claude-code-changelog`) |
| `CLI_REPO_OWNER`           | No       | CLI repo owner (default: `anthropics`)         |
| `CLI_REPO_NAME`            | No       | CLI repo name (default: `claude-code`)         |

## Database

Uses **Upstash Redis** only (serverless key-value store via Vercel Marketplace).

### Redis Key Structure

| Key Pattern                      | Type   | TTL       | Description                         |
| -------------------------------- | ------ | --------- | ----------------------------------- |
| `workspace:{teamId}`             | String | Permanent | Workspace data (JSON)               |
| `workspaces:active`              | Set    | Permanent | Active workspace teamIds            |
| `summary:{version}:{language}`   | String | 7 days    | Cached AI summaries                 |
| `state:{key}`                    | String | Permanent | Global state values                 |
| `state:failed:{teamId}`          | String | 7 days    | Failed notification tracking        |
| `lock:{name}`                    | String | 300s      | Distributed lock (UUID value)       |
| `metrics:{key}`                  | String | Permanent | Notification run metrics            |

## Workflow

```
User installs bot
  -> /api/oauth/install (OAuth start with language selection)
  -> User authorizes
  -> /api/oauth/callback (Workspace creation + welcome message)

Notification run (scheduled or triggered)
  -> Acquire distributed lock
  -> Retry previously failed notifications
  -> Check for new version
  -> Fetch changes (GitHub diffs + CLI changelog)
  -> Pre-generate summaries (Claude, cache-aware)
  -> Send to all workspaces (batch with concurrency limit)
  -> Record metrics and failures
  -> Release lock
```
