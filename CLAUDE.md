# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Changelog Bot - Multi-workspace Slack notification bot that monitors two GitHub repositories for Claude Code release changes and sends formatted notifications to multiple Slack workspaces. Uses Claude API to generate intelligent summaries in English and Korean.

## Commands

```bash
pnpm run build       # Build TypeScript
pnpm run notify      # Run the notification check (main entry point)
pnpm run typecheck   # Type checking only
```

## Architecture

### Dual Execution Contexts

The project runs in two distinct modes:

1. **CLI / GitHub Actions** (`src/index.ts` -> `workers/notify-all.ts`): Scheduled hourly via GitHub Actions (`.github/workflows/changelog-notify.yml`). Acquires a distributed lock, checks for new versions, pre-generates summaries for all languages, and batch-sends to all workspaces.

2. **Vercel Serverless** (`api/`): Handles OAuth installation (`api/oauth/`), Slack slash commands (`api/slack/commands.ts` for `/changelog-lang`, `api/slack/changelog.ts` for `/changelog`), and manual triggers (`api/cron/notify.ts`). Functions are constrained to 256MB memory and 30s max duration (`vercel.json`).

### Dual Source Monitoring

The bot monitors two separate GitHub repositories:

- **`marckrenn/claude-code-changelog`**: Tracks `cc-prompt.md` (system prompt) and `cc-flags.md` (feature flags) changes between version tags. Changes are fetched via GitHub compare API.
- **`anthropics/claude-code`**: Fetches CLI changelog (`CHANGELOG.md`) for the corresponding version section.

Both are merged into a single `ChangeSummary` for each notification.

### AI Summary Generation (`services/claude.ts`)

Uses Claude Haiku 4.5 with `tool_use` for structured output. The `submit_changelog_summary` tool forces the model to return a typed `ChangeSummary` object. Prompt templates and tool descriptions are defined per-language (en/ko) with XML-formatted input. Korean output is validated via Hangul character ratio check (`utils/language.ts`).

### Notification Flow (`services/slack.ts`)

Notifications are posted as threaded Slack messages: main message with version + AI summary, then thread replies for CLI changes, flag changes, and prompt changes. Rate limited at 1.1s between messages, with 10-workspace concurrency batching.

### Caching & State

- **Summary Cache** (`cache/summary-cache.ts`): Redis-backed, 7-day TTL, keyed by `{version}:{language}`. Pre-generated during notification runs, consumed by slash commands and retries.
- **Global State** (`db/state.ts`): `last_checked_version` tracks the latest processed version. Failed notifications are tracked per-workspace with retry counts (max 3, 7-day TTL).
- **Distributed Lock** (`db/redis.ts`): `SET NX EX` + Lua script `EVAL` for atomic release. Prevents concurrent notification runs.

### Security

- Bot tokens stored with AES-256-GCM encryption (`utils/crypto.ts`)
- Logger auto-masks tokens/secrets in output (`utils/logger.ts`)
- Invalid tokens trigger automatic workspace deactivation

## Environment Variables

| Variable                   | Required | Description                                     |
| -------------------------- | -------- | ----------------------------------------------- |
| `UPSTASH_REDIS_REST_URL`   | Yes      | Upstash Redis REST URL                          |
| `UPSTASH_REDIS_REST_TOKEN` | Yes      | Upstash Redis REST token                        |
| `SLACK_CLIENT_ID`          | Yes      | Slack App client ID                             |
| `SLACK_CLIENT_SECRET`      | Yes      | Slack App client secret                         |
| `ENCRYPTION_KEY`           | Yes      | 64-char hex key (32 bytes) for token encryption |
| `ANTHROPIC_API_KEY`        | Yes      | Anthropic API key                               |
| `SLACK_SIGNING_SECRET`     | No\*     | Required for slash commands                     |
| `CRON_SECRET`              | No\*     | Required for Vercel cron/manual trigger auth    |
| `GITHUB_TOKEN`             | No       | Increases rate limit from 60/hr to 5000/hr      |

## Database

Uses **Upstash Redis** only (serverless key-value store).

### Redis Key Structure

| Key Pattern                    | Type   | TTL       | Description                   |
| ------------------------------ | ------ | --------- | ----------------------------- |
| `workspace:{teamId}`           | String | Permanent | Workspace data (JSON)         |
| `workspaces:active`            | Set    | Permanent | Active workspace teamIds      |
| `summary:{version}:{language}` | String | 7 days    | Cached AI summaries           |
| `state:{key}`                  | String | Permanent | Global state values           |
| `state:failed:{teamId}`        | String | 7 days    | Failed notification tracking  |
| `lock:{name}`                  | String | 300s      | Distributed lock (UUID value) |
| `metrics:{key}`                | String | Permanent | Notification run metrics      |
