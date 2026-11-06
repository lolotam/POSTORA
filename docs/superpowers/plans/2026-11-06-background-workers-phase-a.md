# Background workers Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Publish now" and "Retry" answer in under a second with "submitted, publishing", and the real per-platform result arrives through Realtime; a lost request is still published by the scheduler, and no request publishes twice.

**Architecture:** The browser asks a new edge function `enqueue-post-publish` to record the request in the database (`request_immediate_publish` / `request_post_retry`, both already merged into this branch). The function then kicks `process-post` server-to-server inside `runInBackground` and returns 202 without waiting. `process-post` claims the post with a compare-and-set on `posts.publish_requested_at`; `process-scheduled-posts` picks up any request older than 30 seconds that nobody claimed, with the same compare-and-set, so a lost kick costs at most one scheduler tick.

**Tech Stack:** Deno edge functions (Supabase self-hosted), PostgREST RPC, React 18 + TanStack Query, Vitest, Deno test, SQL proof suites run by `scripts/db-harness.sh`.

**Spec:** `docs/superpowers/specs/2026-11-06-background-workers-design.md` (section "Phase A").

## Global Constraints

- Required reading before touching code: `ARCHITECTURE.md` sections 12-16 (edge function shape, `authenticateCaller`, Zod, sanitized errors), 23, 25 (restricted CORS: `handleRestrictedCorsOptions` / `restrictedJsonResponse` from `_shared/cors.ts`), 26-28 (no blind publish retry, bounded `waitUntil`, atomic claim), 41 (never grow `process-post/index.ts`; put new logic in helpers), and `AGENTS.md`.
- `scheduled_at` keeps meaning "when the owner scheduled it". Immediate publishes never write it (except "Publish now" on an already scheduled post, which the RPC already handles).
- TikTok review posts (`source = 'tiktok_review'`) are out of scope; the RPCs already refuse them.
- No new dependencies. No change to the public n8n API (`n8n-api`) in this phase.
- Every refusal path logs one `system_logs` row (AGENTS.md "every refusal logs"). Error text returned to the browser goes through `sanitizeErrorMessage`.
- Copy changes must exist in every locale file the existing toasts use (the i18n regression script fails otherwise).
- Never commit `graphify-out/`, logs, `.env*` or secrets. Commit with `git commit -- <paths>`.

## Debate (Codex `gpt-6-astra` high, 1 round) — verdict "rework", all accepted

| # | Finding | Resolution |
|---|---|---|
| 1 | Retry not durable: a lost kick leaves the post `failed` | `request_post_retry` moves it to `pending` + `publish_requested_at`; the scheduler sweeps it |
| 2 | `expected_status` claim allows a late second run after completion | Claim on `publish_requested_at` + status `pending/scheduled`; a completed post never matches |
| 3 | Orphan gap between insert and kick | The insert itself carries `publish_requested_at` (trigger pins it to `now()`) |
| 4 | Canvas inserts the post as `processing`, never swept | Canvas inserts `pending` + `publish_requested_at` |
| 5 | Retry-with-new-media sets `pending` client-side, breaking retry mode | Client keeps only the `media_file_ids` update; status comes from the RPC |
| 6 | Client deletes failed rows before the server accepts | The RPC deletes them in the same transaction that accepts |
| 7 | Retry of a partly published post republishes successes | The RPC drops every account with a `success` or `pending` row |
| 8 | `scheduled_at = now()` pollutes Calendar/Analytics/Board and fires `post.scheduled` | New column `publish_requested_at`; `scheduled_at` untouched for unscheduled posts |
| 9 | Realtime success toasts fire only on UPDATE | Toast on INSERT of a terminal row too, deduped by row id |
| 10 | Badge cleared by platform name too early | Clear only on the post's terminal status, 35-minute cap |

Follow-ups (not in this PR): early terminal aggregation in `partner_settle_platform_post`; n8n-api async opt-in; old PR #389 still open; Scheduled board may briefly show a retried, previously scheduled post.

## Done in this branch

- `supabase/migrations/20261106120000_publish_requests.sql`: `posts.publish_requested_at`, `posts_publish_requested_due_idx`, insert trigger `trg_posts_pin_publish_requested_at`, `request_immediate_publish(p_post_id, p_user_id) RETURNS timestamptz` (NULL when refused; returns the existing stamp when a retry is already queued), `request_post_retry(p_post_id, p_user_id, p_account_ids uuid[] DEFAULT NULL) RETURNS jsonb` (`{"status":"accepted","requested_at","account_ids","platforms"}` or `{"status":"refused","reason":"not_found"|"not_retryable"|"no_targets"}`), and the `metadata.retry_request = {requested_at, account_ids, platforms, prior_status}` marker.
- `supabase/tests/publish_requests.sql`, registered in `scripts/db-harness.sh`; passes locally.

---

### Task 1: Claim on the request stamp

**Files:**
- Modify: `supabase/functions/_shared/postProcessingClaim.ts`
- Test: `supabase/functions/_shared/postProcessingClaim.test.ts`

**Interfaces:**
- Produces: `claimPostForProcessing(supabase, postId, expectedScheduledAt?: string | null, expectedPublishRequestedAt?: string)`. When `expectedPublishRequestedAt` is a string it adds `.eq("publish_requested_at", v).in("status", SCHEDULER_CLAIMABLE_STATUSES)` and does NOT add any `scheduled_at` filter. When both are passed, the `publish_requested_at` branch wins (document this in the JSDoc). Existing branches unchanged.

- [ ] Write failing tests with the existing filter-recording stub: (a) request expectation records `["eq","publish_requested_at",v]` and `["in","status",["pending","scheduled"]]` and no `scheduled_at` filter; (b) existing null / string `scheduled_at` cases still record what they record today.
- [ ] Implement; run `deno test --allow-env --node-modules-dir=none --import-map=.github/deno/process-post-import-map.json supabase/functions/_shared/postProcessingClaim.test.ts`; commit.

### Task 2: process-post honours the request and the retry marker

**Files:**
- Create: `supabase/functions/_shared/publishRequest.ts`
- Test: `supabase/functions/_shared/publishRequest.test.ts`
- Modify: `supabase/functions/process-post/index.ts` (schema ~line 176, destructure ~1440, `refuseOnSpentWorker` ~1506, claim ~1655, targeting ~1800-1830, Instagram `isRetryRun` ~1984) — keep the diff in `index.ts` to wiring only.

**Interfaces:**
- Produces in `publishRequest.ts`:
  - `export interface RetryRequest { requestedAt: string; accountIds: string[]; platforms: string[] }`
  - `export function activeRetryRequest(post: { publish_requested_at?: string | null; metadata?: unknown }): RetryRequest | null` — returns the marker only when `metadata.retry_request.requested_at` and `post.publish_requested_at` are both parseable and `Date.parse` equal, and `account_ids` / `platforms` are non-empty string arrays; otherwise `null`.
- `ProcessPostSchema` gains `expected_publish_requested_at: z.string().max(64).optional()`.

- [ ] Write failing tests for `activeRetryRequest`: match (different ISO spellings of the same instant), stale marker (different instant) → null, missing/garbage marker → null, empty arrays → null.
- [ ] Implement the helper.
- [ ] Wire `index.ts`: destructure `expected_publish_requested_at`; `refuseOnSpentWorker({ resume, scheduled: typeof expectedScheduledAt === "string" || typeof expectedPublishRequestedAt === "string" })`; pass it as the 4th claim argument and add it to the two `claim_declined` log payloads; after the post is read, `const retryRequest = resume ? null : activeRetryRequest(post)`; when `retryRequest` and the body gave no `platforms` / `account_ids`, use the marker's lists as `overridePlatforms` / `overrideAccountIds`; replace the Instagram call with `const retryRun = isRetryRun(post.status, !!resume) || retryRequest !== null` computed once before the account loop.
- [ ] Run `deno check` + `deno test` for `supabase/functions/process-post/` with the CI import map (see `.github/workflows/ci.yml` step "Typecheck and test process-post"); commit.

### Task 3: The scheduler sweeps unclaimed requests

**Files:**
- Modify: `supabase/functions/process-scheduled-posts/index.ts` (selection ~118-124, loop ~154, kick body ~298, failure mark ~326-335)
- Create + test: a small pure helper in the same folder, e.g. `dueRequests.ts` with `mergeDuePosts(scheduled, requested)` → `Array<{ post, expectation: { kind: "scheduled", value } | { kind: "requested", value } }>`, deduped by id with the `scheduled` entry winning.

- [ ] Write failing Deno tests for `mergeDuePosts` (dedupe, order kept, kind/value carried).
- [ ] Add a second select with the same columns plus `publish_requested_at`: `.in('status', ['pending','scheduled']).not('publish_requested_at','is',null).lte('publish_requested_at', new Date(Date.now() - 30_000).toISOString())`, excluding `source = 'tiktok_review'` (`.or('source.is.null,source.neq.tiktok_review')`).
- [ ] Kick body: `{ post_id, expected_scheduled_at }` or `{ post_id, expected_publish_requested_at }` by kind. The failure mark filters on the same column the kind names. Counts and logs keep their current shape.
- [ ] Add the new test file to the CI deno test step if that step does not already cover the folder; commit.

### Task 4: `enqueue-post-publish` edge function

**Files:**
- Create: `supabase/functions/enqueue-post-publish/index.ts` (adapter only), `run.ts` (logic behind a deps seam, like `audience-sheets-sync`), `run.test.ts`
- Modify: `.github/workflows/ci.yml` (add `deno check` of `index.ts` and `deno test` of the folder to the process-post step), `supabase/config.toml` only if sibling browser-called functions declare `verify_jwt` there.

**Interfaces:**
- Body (Zod, strict): `{ post_id: uuid, mode: "publish_now" | "retry", account_ids?: uuid[] (1..50, retry only) }`.
- `run(deps, { callerId, body })` → `{ status: number, body: object }`. Deps: `requestImmediatePublish(postId, userId)`, `requestPostRetry(postId, userId, accountIds?)`, `readPostStatus(postId, userId)` → `string | null`, `kick(payload)` → `Promise<void>`, `logRefusal(row)`.
- Responses: 202 `{ accepted: true, post_id, status: "processing" }` on accept (also when publish_now finds the post already `processing`: `{ accepted: true, post_id, status: "processing", already: true }`, no kick); 404 `{ error: "not_found" }` for a missing or another user's post (same body for both); 409 `{ error: "not_publishable" | "not_retryable" | "no_targets" }`.
- Kick: `await runInBackground("kick process-post", () => fetch(\`${SUPABASE_URL}/functions/v1/process-post\`, { method: "POST", headers: { Authorization: \`Bearer ${SERVICE_ROLE_KEY}\`, "Content-Type": "application/json" }, body: JSON.stringify({ post_id, expected_publish_requested_at }), signal: AbortSignal.timeout(150_000) }))`. Read the response body fully. A 2xx, 409 or 503 response is silent. Any other status, or a network error, writes one sanitized `system_logs` row `{ level: "warn", category: "post", source: "enqueue-post-publish", message: "publish_kick_failed", metadata: { post_id, status } }`. The kick never changes the HTTP response.

- [ ] Write failing `run.test.ts`: publish_now accepted → 202 + kick payload carries the RPC's timestamp; RPC NULL + status processing → 202 already, no kick; RPC NULL + other status → 409; RPC NULL + no row → 404; retry accepted → 202 + kick carries `requested_at`; retry refusals map to 404/409/409; a kick that rejects still returns 202; account_ids on publish_now → 400.
- [ ] Implement `run.ts`, then `index.ts` (`handleRestrictedCorsOptions`, `authenticateCaller(req)`, Zod parse → 400 with sanitized message, deps from a service-role client).
- [ ] Run deno check/test; commit.

### Task 5: Frontend adapter and call sites

**Files:**
- Create: `src/features/publishing/infrastructure/enqueuePostPublish.ts` (+ `__tests__/enqueuePostPublish.test.ts`)
- Modify: `src/pages/CreatePost.tsx` (~532-600), `src/pages/ScheduledPosts.tsx` (`handlePublishNow` ~460), `src/hooks/history/historyUtils.ts`, `src/hooks/history/usePostRetry.ts`, `src/hooks/useCanvasWorkflow.ts` (~242-330) + `src/hooks/__tests__/useCanvasWorkflow.errors.test.tsx`, existing tests of those hooks.

**Interfaces:**
- `enqueuePostPublish({ postId, mode, accountIds? }): Promise<{ accepted: true; alreadyRunning: boolean } | { accepted: false; reason: "not_found" | "not_publishable" | "not_retryable" | "no_targets" | "error"; message?: string }>` wrapping `supabase.functions.invoke("enqueue-post-publish")`.

- [ ] Adapter + tests (202, 409 reasons, network error).
- [ ] CreatePost: insert immediate posts with `publish_requested_at: new Date().toISOString()` (the trigger pins it), call the adapter with `publish_now`, keep `trackPublishingPost`, show one "Submitted, publishing" toast; drop the old `.then` result toasts (Realtime toasts the per-platform result).
- [ ] ScheduledPosts: remove the raw `scheduled_at` update and the direct invoke; call the adapter; toast; invalidate `['posts']`.
- [ ] History retry: every retry path calls the adapter with `mode: "retry"`; single-platform retry passes `[accountId]`; the account-picker retry passes the chosen accounts (it may still write `metadata.selected_account_ids`); remove `deletePlatformPost` / `deleteFailedPlatformPosts` / `takeFailedRetryRows` calls from retry paths and delete helpers that become unused (ARCHITECTURE §1); retry-with-new-media keeps the `media_file_ids` update and drops `status: "pending"`.
- [ ] Canvas: insert the post as `pending` with `publish_requested_at`, do not pre-insert `platform_posts`, call the adapter, return "submitted" instead of counting results; update its error test.
- [ ] Run `npx vitest run` for the touched tests; commit.

### Task 6: Realtime badge and toasts

**Files:**
- Modify: `src/hooks/useRealtimePostUpdates.tsx` + its test (create `src/hooks/__tests__/useRealtimePostUpdates.test.tsx` if none).

- [ ] Replace the 60-second auto-clear with: clear when the post reaches `completed` or `failed` (posts channel), hard cap 35 minutes; after 60 seconds the badge copy becomes "still publishing".
- [ ] Toast on `platform_posts` INSERT of a terminal row (`success` / `failed`) as well as UPDATE, deduped by row id.
- [ ] Remove the platform-name-based clear.
- [ ] Tests: terminal clear, cap, INSERT toast once, no clear on a single platform row. Commit.

### Task 7: Types, gates, review

- [ ] Regenerate `src/integrations/supabase/types.ts` for the new column and both RPCs (hand-edit in the generated shape if the generator cannot reach a database; mirror existing RPC entries).
- [ ] Gates: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, the i18n regression script, deno check/test per CI, `scripts/db-harness.sh` in `supabase/postgres:17.6.1.158`.
- [ ] `clean-code-guard` on production code, `test-guard` on tests, `requesting-code-review`.

## Deployment

1. Apply the migration on production through `ssh-contabo-mcp` psql before the merge; verify both functions, grants and the column.
2. Merge; Dokploy "Edge Functions Sync" deploys `main` every 2 minutes. Verify the volume SHA256 of the changed functions, an OPTIONS probe on `enqueue-post-publish`, and the `[background] waitUntil` log line.
3. Frontend deploys on the `main` push.

## Verification

- Publish now on a scheduled post: toast under 1 s, badge `processing`, flips via Realtime; `posts.status` pending → processing → completed once; `platform_posts` count equals accounts.
- Retry a partly failed post: only failed accounts get new rows.
- Block the kick (temporarily wrong URL in a test) → the scheduler publishes within about 90 s, once.
