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
  types/
    index.ts            # Core interfaces (TagInfo, ChangelogDiff, ChangeSummary)
    database.ts         # DB types (Workspace, CreateWorkspaceInput, UpdateWorkspaceInput)
  services/
    github.ts           # GitHub API: fetch tags, compare commits, get file content
    claude.ts           # Anthropic API: generate summaries (en/ko)
    slack.ts            # Slack notifications: workspace-based threaded messages
  db/
    redis.ts            # Upstash Redis client and helpers
    workspaces.ts       # Workspace CRUD (Redis-backed)
    state.ts            # Global state (last_checked_version)
  cache/
    summary-cache.ts    # Summary cache (Redis-backed, 7-day TTL)
  workers/
    notify-all.ts       # Multi-workspace notification worker
  utils/
    crypto.ts           # AES-256-GCM encryption for bot tokens
    logger.ts           # Console logger with timestamps

api/oauth/              # Vercel API routes (OAuth installation)
  install.ts            # OAuth install redirect
  callback.ts           # OAuth callback handler
```

## Key Behaviors

- Monitors `cc-prompt.md` and `cc-flags.md` files for changes
- Uses Claude Haiku to generate summaries in English or Korean
- Single-tier storage using Upstash Redis
- OAuth-based workspace installation

## Environment Variables

| Variable                   | Required | Description                                    |
| -------------------------- | -------- | ---------------------------------------------- |
| `UPSTASH_REDIS_REST_URL`   | Yes      | Upstash Redis REST URL                         |
| `UPSTASH_REDIS_REST_TOKEN` | Yes      | Upstash Redis REST token                       |
| `SLACK_CLIENT_ID`          | Yes      | Slack App client ID                            |
| `SLACK_CLIENT_SECRET`      | Yes      | Slack App client secret                        |
| `ENCRYPTION_KEY`           | Yes      | 32-byte hex key for token encryption           |
| `ANTHROPIC_API_KEY`        | Yes      | Anthropic API key                              |
| `UPSTREAM_OWNER`           | No       | GitHub owner (default: `marckrenn`)            |
| `UPSTREAM_REPO`            | No       | GitHub repo (default: `claude-code-changelog`) |

## Database

Uses **Upstash Redis** only (serverless key-value store via Vercel Marketplace).

### Redis Key Structure

- `workspace:{teamId}` - Workspace data (JSON, permanent)
- `workspaces:active` - Set of active workspace teamIds
- `summary:{version}:{language}` - Cached summaries (7-day TTL)
- `state:{key}` - Global state values (permanent)
