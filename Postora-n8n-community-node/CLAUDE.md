# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

n8n community node package (`n8n-nodes-postora`) for the Postora social media publishing platform. Publishes content to 10 platforms: Facebook, Instagram, TikTok, Twitter/X, LinkedIn, Pinterest, YouTube, Threads, Bluesky, Reddit. Current version: `1.1.11`.

## Sibling copy — keep both in sync

This repo (`https://github.com/lolotam/postora-n8n-community-node.git`) is the **only** place to push commits and cut releases from — its `.github/workflows/publish.yml` triggers `npm publish` on GitHub release `created`, publishing `n8n-nodes-postora`.

A second, vendored copy of this source lives inside the main Postora app repo at `F:\Postora_new\Postora-n8n-community-node` (plain files, no nested `.git`). Any change to `nodes/`, `__tests__/`, `README.md`, `package.json`, or `dist/` here must be copied there too and committed on that repo's current feature branch — see `F:\Postora_new\CLAUDE.md`'s "n8n community node workflow" section for the exact steps. Never publish npm from the vendored copy.

## Commands

- `npm run build` — Compile TypeScript to `dist/` and copy icons via gulp
- `npm run dev` — TypeScript watch mode (`tsc --watch`)
- `npm run lint` — Type-check only (`tsc --noEmit`)
- `npm test` — Run the jest suite (`__tests__/Postora.node.test.ts`)

Run `npx tsc --noEmit`, `npm test`, and `npm run build` before every commit that touches `nodes/` or `credentials/`. No ESLint/Prettier configured.

## Architecture

Standard n8n community node pattern with two source files:

- **`credentials/PostoraApi.credentials.ts`** — Implements `ICredentialType`. Defines `apiKey` (header-based `x-api-key` auth) and `baseUrl` (defaults to `https://api.postora.cloud/functions/v1/n8n-api`).
- **`nodes/Postora/Postora.node.ts`** — Implements `INodeType`. Single node with resource/operation routing:
  - **Resource: Post** → Operations: Create, Get Status, List
  - **Resource: Media** → Operations: Upload

The `execute` method iterates over input items, dispatches to resource/operation handlers, and collects results. Supports `continueOnFail`. Properties use `displayOptions` to conditionally show fields per resource/operation — note `mediaSource` is defined three times (Story-only, FB/IG-feed, other-platforms) with the same `name`, following the same pattern already used for `caption`.

The `getAccounts` load-options method fetches accounts filtered by the currently selected platform via `getCurrentNodeParameter('platform')`.

### Media Source options (Post → Create and Media → Upload)

Both operations support three sources, each independently validated:
- **Binary Data** — reads an n8n binary property via `readBinaryOrThrow()`, which wraps `assertBinaryData`/`getBinaryDataBuffer` and turns n8n's own storage-lookup failures (`Could not find any entity of type "BinaryDataFile"`, usually caused by pinned/stale test data) into an actionable message instead of the raw internal error.
- **URL** — Post → Create sends the URL to the backend to download server-side. Media → Upload instead downloads the URL **on the n8n host** via `safeFetchAndStage()` / `fetchFollowingSafeRedirects()`, which validates scheme + host (rejecting private/loopback/link-local/reserved IPv4 and IPv6 targets via `isPrivateOrReservedHost()`) on the original URL **and on every redirect hop, before that hop is requested** — a URL can't be used to reach an internal service via a redirect. Known residual limit: this checks the hostname/IP as written, not where DNS actually resolves it (no DNS-rebinding protection) — see the README's "Known limit" note.
- **Media File ID** — looks up UUID(s) previously returned by Media → Upload via the backend's `GET /api/v1/media/:id` (ownership-scoped, non-enumerable 404) and re-attaches them without re-uploading. Client-side UUID validation (`isValidUuid`) rejects obviously-wrong input (e.g. a pasted URL) before hitting the network; backend re-validates independently.

Backward compatibility: workflows saved before v1.1.7 set only `binaryPropertyName` with no `uploadMediaSource` — `execute()` detects that and defaults to the binary source.

## Build Output

TypeScript compiles to `dist/`. Gulp copies `nodes/**/*.{png,svg}` to `dist/nodes/`. The `package.json` `n8n` field declares the credential and node entry points from `dist/`. `dist/` is committed to this repo (not gitignored) — always rebuild and stage it alongside source changes.

## API Endpoints

All calls go to `{baseUrl}/api/v1/...` with `x-api-key` header:
- `GET /accounts` — List accounts (optional `?platform=` filter)
- `POST /post` — Create post (body: caption, platforms, account_ids, media_urls, media_file_ids, media_base64, scheduled_at, platform-specific fields)
- `GET /post/{id}` — Get post status
- `GET /posts?limit=&status=` — List posts
- `POST /upload-media` (aliased `/media/upload`) — Multipart file upload
- `GET /media/{id}` — Look up a previously-uploaded media file by UUID (ownership-scoped)

All of these are implemented in the main Postora repo's `supabase/functions/n8n-api/index.ts` — this repo only calls them, it doesn't implement them.
