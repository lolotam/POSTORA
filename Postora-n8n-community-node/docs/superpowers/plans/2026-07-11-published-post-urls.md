# Published Post URLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return per-platform published post URLs from immediate `Post -> Create` executions.

**Architecture:** After a successful immediate create request, the n8n node reads the returned post ID and fetches the existing status endpoint. It retains the create response envelope while replacing its stale `post` record with the status record containing `platform_results`. Scheduled posts keep their existing response and a status lookup failure is reported in output instead of masking a successful create.

**Tech Stack:** TypeScript, n8n Workflow SDK, Jest, npm, GitHub Actions, npm registry.

---

### Task 1: Add regression coverage

**Files:**
- Modify: `__tests__/Postora.node.test.ts`

- [ ] Add a test for immediate post creation that returns a pending create record followed by a completed status record with two `post_url` values.
- [ ] Assert the node makes `POST /api/v1/post`, then `GET /api/v1/post/<id>`, preserves `scheduled: false`, and returns the fresh `post.platform_results` array.
- [ ] Add a scheduled-post test asserting there is only one POST request and the original scheduled response is returned.
- [ ] Add a status-request failure test asserting the create response remains successful and contains `post_status_lookup_error`.
- [ ] Run `npm test` and confirm the tests fail before implementation.

### Task 2: Enrich immediate create output

**Files:**
- Modify: `nodes/Postora/Postora.node.ts`

- [ ] Capture the create response from `POST /api/v1/post`.
- [ ] For a non-scheduled response with `post.id`, issue `GET /api/v1/post/:id`.
- [ ] Replace the create response's `post` property with the returned status post while preserving the outer create-response fields.
- [ ] On a status lookup error, keep the create response and add `post_status_lookup_error`.
- [ ] Run `npm test` and confirm all tests pass.

### Task 3: Document and package the behavior

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] Document that immediate `Post -> Create` output includes `post.platform_results[].post_url` when available and that scheduled posts require `Post -> Get Status` after publication.
- [ ] Bump the package version from `1.1.12` to `1.1.13` with npm metadata kept in sync.

### Task 4: Build, review, synchronize, and release

**Files:**
- Modify: `dist/nodes/Postora/Postora.node.js`
- Modify: `dist/nodes/Postora/Postora.node.js.map`
- Mirror: corresponding source, tests, README, package metadata, lockfile, and dist files in `F:/Postora_new/Postora-n8n-community-node`

- [ ] Run `npx tsc --noEmit`, `npm test`, and `npm run build`.
- [ ] Run clean-code, test, and documentation guard reviews.
- [ ] Copy release files into the vendored Postora app node, then verify both repository diffs while leaving unrelated work untouched.
- [ ] Commit and push this repository's `main` branch, then commit the vendored-copy changes on the Postora app's current branch and push it.
- [ ] Create GitHub release `v1.1.13` and verify the publish workflow and npm package version.
