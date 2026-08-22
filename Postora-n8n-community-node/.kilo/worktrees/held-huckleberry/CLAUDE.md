# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

n8n community node package (`n8n-nodes-postora`) for the Postora social media publishing platform. Publishes content to 10 platforms: Facebook, Instagram, TikTok, Twitter/X, LinkedIn, Pinterest, YouTube, Threads, Bluesky, Reddit.

## Commands

- `npm run build` — Compile TypeScript to `dist/` and copy icons via gulp
- `npm run dev` — TypeScript watch mode (`tsc --watch`)
- `npm run lint` — Type-check only (`tsc --noEmit`)

No test framework is configured. No ESLint/Prettier.

## Architecture

Standard n8n community node pattern with two source files:

- **`credentials/PostoraApi.credentials.ts`** — Implements `ICredentialType`. Defines `apiKey` (header-based `x-api-key` auth) and `baseUrl` (defaults to `https://api.postora.cloud/functions/v1/n8n-api`).
- **`nodes/Postora/Postora.node.ts`** — Implements `INodeType`. Single node with resource/operation routing:
  - **Resource: Post** → Operations: Create, Get Status, List
  - **Resource: Media** → Operations: Upload
  - **Resource: Account** → Operations: List

The `execute` method iterates over input items, dispatches to resource/operation handlers, and collects results. Supports `continueOnFail`. Properties use `displayOptions` to conditionally show fields per resource/operation.

The `getAccounts` load-options method fetches accounts filtered by the currently selected platform via `getCurrentNodeParameter('platform')`.

## Build Output

TypeScript compiles to `dist/`. Gulp copies `nodes/**/*.{png,svg}` to `dist/nodes/`. The `package.json` `n8n` field declares the credential and node entry points from `dist/`.

## API Endpoints

All calls go to `{baseUrl}/api/v1/...` with `x-api-key` header:
- `GET /accounts` — List accounts (optional `?platform=` filter)
- `POST /post` — Create post (body: caption, platforms, account_ids, media_urls, scheduled_at, platform-specific fields)
- `GET /post/{id}` — Get post status
- `GET /posts?limit=&status=` — List posts
- `POST /media/upload` — Multipart file upload
