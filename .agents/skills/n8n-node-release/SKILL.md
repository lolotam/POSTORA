---
name: n8n-node-release
description: Release a new version of the Postora n8n community node (npm package n8n-nodes-postora). Use when publishing, releasing, or version-bumping the n8n node, creating a GitHub release for it, or verifying that a publish reached npm. Covers the version bump, the required gates, the release tag, and post-publish verification.
---

# Releasing the Postora n8n community node

Prerequisite: the two local copies are already in sync and the vendored Postora-side
copy is committed. Those rules live in the root `AGENTS.md` and are not repeated here.

## Release process

For a production n8n node change, bump the standalone package version in
`F:\N8N\Postora-n8n-community-node` (`package.json`), run `npx tsc --noEmit` +
`npm test` + `npm run build`, commit, push to `main`, create a GitHub release tag
(`gh release create vX.Y.Z ...` — the repo's `publish.yml` workflow triggers on
release `created`, not on tag push alone), and verify
`npm view n8n-nodes-postora version` after the publish workflow completes.

## Deployment model

GitHub releases in `https://github.com/lolotam/postora-n8n-community-node.git`
trigger the npm publishing workflow (`.github/workflows/publish.yml`); users or
hosted n8n instances receive the node by installing/updating the published npm
package.

## Node capabilities snapshot (as of v1.1.11, 2026-07-03 — verify against source)

Post → Create supports Media Source = None/URL/Binary Data/Media File ID (the last
posts an already-uploaded file by UUID via `media_file_ids`, no re-upload);
Media → Upload supports the same three sources plus SSRF-hardened URL downloading
(`safeFetchAndStage`/`fetchFollowingSafeRedirects` — every redirect hop is validated
before being followed; see that repo's README "Known limit" note on DNS rebinding).
Backend: `supabase/functions/n8n-api/index.ts` has `handleGetMediaById`
(`GET /api/v1/media/:id`, ownership-scoped, non-enumerable 404) backing the Media
File ID source.

**Always run the jest suite (`__tests__/Postora.node.test.ts`) before releasing.**
