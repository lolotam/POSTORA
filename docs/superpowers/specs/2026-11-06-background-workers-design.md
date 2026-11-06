# Background workers for long-running operations

## Pipeline configuration (waleed-implementation-v2, approved 2026-11-06)

| Role | Model / owner |
|---|---|
| Spec | Orchestrator (Claude Opus 5.5) via `brainstorming` — done (this file) |
| Plan writing | Claude Opus 5.5 (`writing-plans`, per phase) |
| Plan debate | Codex astra 6 high (`gpt-6-astra`, enforced read-only), 1 round per phase; chain → OpenCode GLM 5.3 → Cursor Grok 4.6 high → advisor |
| Implementer | Cursor Grok 4.7 medium, subagent-driven, one worktree per slice; chain → Codex astra 6 high → OpenCode GLM 5.3 → orchestrator |
| SQL migrations | OpenCode Muse Spark 1.3 free → orchestrator (announced waiver) |
| Tests | agy Gemini 3.8 high → Muse Spark → Codex Sol 5.6 low → orchestrator; gated by `test-guard` |
| Review | `requesting-code-review` (orchestrator) + `@codex review` PR bot |
| Fix review / PR / bot findings | Orchestrator |
| Prod migration + deploy | Orchestrator via `ssh-contabo-mcp` + `docs/runbooks/deploy-edge-function.md` |

- **Tree:** worktree `F:\Dev\Worktrees\Postora_new\background-workers`, branch `feat/background-workers` (cut `--no-track` from `origin/main` @ `72e5af31`). Already created. Per-phase branches `feat/background-workers-a` … cut from it.
- **Web search:** no.
- **Lands as:** all five phases sequentially (A → B → C+D → C' → B'), each its own PR → migration applied before merge → merge → edge deploy → live verification; next phase starts only after the previous is verified in prod.
- **Authority:** Waleed granted standing authority (2026-11-06) for prod migrations, edge deploys and merges for these five phases. It does not cover secrets, deletions, paid services, or the TikTok review branch.
- **Pre-flight facts:** mem0 confirms an open follow-up "atomic retry claim in claimPostForProcessing" (fits Phase A). ARCHITECTURE.md §1, §12–16 read; §23, §26–28, §33, §36, §40–41, §45–46 to read at Phase A plan time.

## Context

Owner request (2026-11-06): long operations must run in the background by a worker. Clicking Send / Start / Retry responds immediately with "submitted, processing"; the real result arrives live (Realtime or polling). Never a fake green "done".

Owner chose all four scopes: (A) publish-now/retry, (B) AI image + caption/hashtags, (C) media processing + WhatsApp broadcast, (D) a generic jobs system. UX chosen: immediate toast + status badge that flips to success/failed.

Exploration found 15 blocking awaits in `src/` and an existing per-domain queue pattern (job table + SQL `claim_*` with `FOR UPDATE SKIP LOCKED` + drain edge function + pg_cron). pgmq is unused. `_shared/background.ts` provides `runInBackground` (`EdgeRuntime.waitUntil`).

**Design decision (honest):** do NOT move everything into one table. Reuse the two queues that already exist (posts, `ai_generation_jobs`); add ONE generic `background_jobs` table + worker only for domains that have no queue today. Unify at the client layer (`useBackgroundJob`, one submitted toast, one `JobStatusBadge`).

**Sub-5s pickup:** enqueue function writes the durable row, then kicks the worker server-to-server (`fetch` with service-role bearer, inside `runInBackground`) and returns 202 without awaiting. pg_cron (1 min) is only the safety net. A DB trigger with `net.http_post` was rejected as primary (`get_cron_secret()` exists only on prod DB, not provable in harness; flood vector).

ARCHITECTURE.md sections that govern this work: §1 (no dead modules), §12–16 (edge function shape, Zod, sanitized errors), §23 (RLS, grants, indexes, regenerated types), §26–28 (idempotency, bounded waitUntil, atomic claim), §36 (public n8n contract), §40–41 (never grow `process-post`).

Brainstorming path: architectural. The spec file `docs/superpowers/specs/2026-11-06-background-workers-design.md` and its commit happen after plan approval (plan mode forbids writing it now).

---

## Phase A — Publish now / retry become enqueue + kick (PR 1)

### Verified live bugs this fixes
- `src/pages/ScheduledPosts.tsx:460-495` writes `scheduled_at = now()` then invokes `process-post` with no `expected_scheduled_at`. `claimPostForProcessing` (`supabase/functions/_shared/postProcessingClaim.ts:36-61`) only applies the status guard on the string-expectation branch, so a cron tick in between claims the same post → double publish.
- `src/pages/CreatePost.tsx:551` inserts `status='pending', scheduled_at=null` and fire-and-forgets. The cron predicate (`process-scheduled-posts/index.ts:121-124`, `.not('scheduled_at','is',null)`) never sees it, so a lost invoke orphans the post.

### Rule (as implemented)
A publish request is durable before anything runs. `posts.publish_requested_at` records when the owner asked; `scheduled_at` keeps meaning "when the owner scheduled it" and is not changed for an unscheduled post, so Calendar, Analytics, the Scheduled board and the partner `post.scheduled` webhook are unaffected.

- Publish now: `request_immediate_publish(post, user)` stamps `publish_requested_at = now()` on an owner's `pending`/`scheduled` post and returns the stamp.
- Retry: `request_post_retry(post, user, account_ids?)` picks the targets on the server (failed results, never an account that succeeded or is pending; an Instagram account with a failed result stays eligible because process-post's retry guard skips whichever result is live), deletes only those failed results, moves the post to `pending` with a fresh `publish_requested_at`, and records `metadata.retry_request {requested_at, account_ids, platforms, prior_status}`. process-post uses that marker only while `requested_at` equals the row's `publish_requested_at`.
- One claim: `claimPostForProcessing` takes `expected_publish_requested_at`; the kick and the scheduler pass the same stamp, so exactly one run moves the post to `processing`.
- Recovery: process-scheduled-posts also sweeps requests older than 30 s that nobody claimed, so a lost kick costs at most one tick. A sweep whose call to process-post fails leaves the request queued for the next tick.
- A reschedule or unschedule drops a request nobody has claimed yet (trigger `trg_posts_drop_request_on_reschedule`, SECURITY DEFINER because the browser writes `scheduled_at` as `authenticated`); a queued retry keeps its request.

### New edge function `supabase/functions/enqueue-post-publish/`
- `index.ts` adapter (§12): restricted CORS, `authenticateCaller(req)`, strict Zod body `{ post_id: uuid, mode: 'publish_now'|'retry', account_ids?: uuid[] (retry only) }`, builds deps, calls `run()`.
- `run.ts`: calls the matching RPC; 404 `not_found` for a missing or another user's post; 409 `not_publishable` | `not_retryable` | `no_targets`; on accept, kicks process-post in `runInBackground` with `expected_publish_requested_at` and returns 202 `{ accepted: true, post_id, status: 'processing' }`. A 2xx, 409 or 503 kick response is silent; anything else, or a network error, writes one `publish_kick_failed` row. The kick never changes the response.
- Tests: `run.test.ts` (Deno) and `supabase/tests/publish_requests.sql` (harness).

### Modify
- New tiny adapter `src/features/publishing/infrastructure/enqueuePostPublish.ts` wrapping `supabase.functions.invoke('enqueue-post-publish')` (§11: no raw calls in pages).
- `src/pages/CreatePost.tsx:551-…`: replace direct invoke with adapter; keep `trackPublishingPost`; drop the `.then(...)` success toast (Realtime `useRealtimePostUpdates.tsx:147-170` already toasts per platform); use shared submitted toast.
- `src/pages/ScheduledPosts.tsx:460-495`: remove raw update + invoke; call adapter; toast "Submitted, publishing"; invalidate `['posts']`.
- `src/hooks/history/historyUtils.ts:89-95` `invokeProcessPost` → `requestPostRetry(postId, platforms, accountIds)` with `mode:'retry'`; the five call sites in `src/hooks/history/usePostRetry.ts:54/72/96/115/171` keep signatures; copy "Retry submitted".
- `src/hooks/useCanvasWorkflow.ts:292`: same adapter.
- `src/hooks/useRealtimePostUpdates.tsx:52-62`: replace the 60s auto-clear with clear-on-terminal (`completed|failed`, already handled at :224) plus a 35 min hard cap (aligned with `DEFERRAL_GIVE_UP_MS`); after 60s show "still publishing" copy instead of dropping the badge.
- Not changed (decided): `scheduledBoard.ts` (claim lands in ~1s, exclusion is YAGNI); `n8n-api` (public contract §36 → follow-up for async opt-in with a node release).

### Migration `supabase/migrations/20261106120000_publish_requests.sql`
- `posts.publish_requested_at timestamptz`, pinned to the database clock on insert; partial index `posts_publish_requested_due_idx` on due requests.
- `request_immediate_publish` and `request_post_retry`: SECURITY DEFINER, `search_path = public`, owner-scoped, TikTok review posts excluded, service_role only; a post an agent retry holds under a live action lease is not retryable.
- `publish_request_is_retry` helper and `trg_posts_drop_request_on_reschedule` (see Rule).

### Tests
- Deno: `enqueue-post-publish/run.test.ts`, `postProcessingClaim.test.ts`, `_shared/publishRequest.test.ts`, `process-scheduled-posts/dueRequests.test.ts`.
- SQL proof `supabase/tests/publish_requests.sql` (registered in `scripts/db-harness.sh`): the insert pin, both RPCs and their refusals, retry targets, the reschedule trigger as `authenticated` in its own transaction, grants and the index.
- Vitest: adapter test; `usePostRetry` asserts `mode:'retry'`; `useRealtimePostUpdates` terminal-clear + 35 min cap; `useCanvasWorkflow.errors.test.tsx` updated for accepted response.

### Pre-merge check
`grep scheduled_at supabase/functions/partner-api` — confirm no consumer treats non-null `scheduled_at` as "scheduled".

---

## Phase B — AI image generation becomes a job (PR 2)

- Extract provider chain from `supabase/functions/generate-image/index.ts` (~860-1010: Higgsfield branch, `getProviderApiKey`, `generateWithModel`, quota reserve/release, staging cleanup) into `generate-image/runImageGeneration.ts` exporting `runImageGeneration(deps, job)`.
- `generate-image/index.ts` with body `async: true` (sync default kept one release): insert `ai_generation_jobs` row `{ status:'queued', modality:'image', params }` BEFORE dispatch (today only after success at :951); kick `ai-image-worker`; return 202 `{ success:true, jobId, status:'queued' }`. Quota reservation moves to the worker (reserve at claim, release on failed attempt, as today).
- New `supabase/functions/ai-image-worker/` (`index.ts` cron-auth door like `process-store-events/index.ts`, `worker.ts`): RPC `claim_ai_image_jobs(p_limit int, p_lease interval)` modelled on `claim_store_events` (`supabase/migrations/20260928120000_store_events_worker.sql`); one job per tick within 50s budget; writes `succeeded`/`failed` fenced on `claim_token`.
- `supabase/functions/ai-generation-status/index.ts`: short-circuit worker-driven image jobs (`modality='image' AND provider_job_id IS NULL AND status IN ('queued','running')`) to "report the row", `pollAfterSeconds: 3` (today it would call Higgsfield with a null id).

### Migration `..._ai_image_jobs_worker.sql`
- `ALTER TABLE ai_generation_jobs ADD COLUMN IF NOT EXISTS claim_token uuid, claimed_at timestamptz, attempts int NOT NULL DEFAULT 0;`
- `claim_ai_image_jobs` SECURITY DEFINER, `search_path = public, pg_temp`, REVOKE from PUBLIC/anon/authenticated, GRANT service_role.
- Partial index `(created_at) WHERE status='queued' AND modality='image'`.
- `ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_generation_jobs;` (owner SELECT RLS exists at `20260820130000_higgsfield_oauth_and_generation.sql:85`).
- Cron `ai-image-worker` every minute, guarded `DO $$ cron.schedule $$` block as in `20261029180000_deferred_publishes.sql:140-158`.

### Frontend
- `src/hooks/useAiGenerationJob.ts`: add `postgres_changes` subscription on `ai_generation_jobs` `id=eq.${jobId}`; keep poll loop as fallback.
- `src/components/post/ImageGenerator.tsx:247`, `canvas/nodes/CaptionNode.tsx:103`, `canvas/nodes/MediaNode.tsx:141`, `src/hooks/useYouTubeThumbnails.tsx:119`: send `async:true`, consume `jobId` via `useAiGenerationJob` like `VideoGenerator.tsx:65`.

### Tests
Deno: `runImageGeneration.test.ts`, `ai-image-worker/worker.test.ts`, status short-circuit test. SQL proof `supabase/tests/ai_image_jobs_claim.sql` (disjoint claims, lease re-claim, attempts exhausted → failed, stale token writes nothing, cross-user SELECT denied, publication membership, cron idempotent without literal secret — copy `competitor_retention_cron.sql`). Vitest `useAiGenerationJob.test.ts`.

---

## Phase C+D — Generic `background_jobs` + first producer: WhatsApp broadcast chunks (PR 3)

### Migration `..._background_jobs.sql`
```
background_jobs(id uuid pk, user_id uuid not null → auth.users, kind text not null,
  payload jsonb not null default '{}',
  status text check in ('queued','running','succeeded','failed','cancelled'),
  attempts int default 0, max_attempts int default 3, run_after timestamptz default now(),
  claimed_at timestamptz, claim_token uuid, progress jsonb, result jsonb, error text,
  created_at, updated_at, finished_at)
```
- RLS on; owner SELECT for `authenticated`; no browser INSERT/UPDATE.
- `claim_background_jobs(p_kinds text[], p_limit int, p_lease interval) RETURNS SETOF background_jobs` — `claim_store_events` fence (exhaust → failed, claim due queued + expired leases, SKIP LOCKED, fresh token, attempts+1).
- `complete_background_job(p_id, p_token, p_status, p_result, p_error)` and `continue_background_job(p_id, p_token, p_payload, p_progress, p_run_after)`, both conditional on `(id, claim_token)`.
- `enqueue_background_job(p_user_id, p_kind, p_payload)` SECURITY DEFINER, service_role only, per-user cap 25 queued/running.
- Indexes `(run_after) WHERE status='queued'`, `(user_id, created_at DESC)`.
- `ALTER PUBLICATION supabase_realtime ADD TABLE public.background_jobs;`
- Cron `background-jobs-worker` every minute; nightly purge of terminal rows > 7 days.

### Worker `supabase/functions/background-jobs-worker/`
- `index.ts` cron-auth door; `worker.ts`: claims one job at a time (limit 1, lease 3 min) and runs it before claiming the next, until the 50s budget; a job is never leased before the worker can start it; handler returns `{done,result} | {continue,payloadPatch,progress,runAfter} | {failed,error,retryable}`; registry `handlers/index.ts` maps kind → handler.
- `_shared/backgroundJobs.ts`: `enqueueAndKick(admin, { userId, kind, payload })` — RPC + `runInBackground(fetch(worker URL, service role))`. Only place the kick lives.

### First kind `whatsapp_broadcast_chunk`
- `whatsapp-broadcast/handler.ts:87,128-175`: refactor send loop into `runBroadcastChunk(deps, { broadcastId, limit:150, budgetMs })` over existing `whatsapp_broadcast_recipients`. HTTP handler validates as today, `markSending`, `enqueueAndKick`, returns 202 `{ accepted:true, jobId, status:'sending' }`.
- Worker handler: small RPC `claim_broadcast_recipients` (`UPDATE … WHERE status='pending' LIMIT … FOR UPDATE SKIP LOCKED`), mark `sending` per recipient before the Meta call, `sent` only after a message id; expired lease + `sending` → `failed: "outcome unknown"` (copy `claim_whatsapp_scheduled_messages` step (b)). Pending remain → `continue` with `run_after=now()`; none → finalise with totals-based `finalStatus`.
- `src/hooks/useWhatsAppBroadcasts.ts:93-128`: return on 202; toast "Broadcast submitted"; bounded `refetchInterval` while any broadcast is `sending` (like `useCompetitorSyncStatus.ts:158`); `useBackgroundJob(jobId)` for progress.
- Add `whatsapp_broadcasts` to Realtime publication.

### Shared client layer `src/features/background-jobs/`
`domain/jobStatus.ts` (union, `isTerminal`), `infrastructure/backgroundJobsRepository.ts`, `ui/useBackgroundJob.ts` (`useQuery` + `postgres_changes` `id=eq.`, 3s refetch until terminal, 15 min cap), `ui/JobStatusBadge.tsx`, `ui/submittedToast.ts` (one copy), `index.ts`. Phase A's minimal toast moves here.

### Tests
SQL proof `supabase/tests/background_jobs.sql`; Deno `background-jobs-worker/worker.test.ts`, updated `whatsapp-broadcast/handler.test.ts` (202 path, no resend of `sent` rows, totals); Vitest `useBackgroundJob.test.ts`, `JobStatusBadge.test.tsx`.

---

## Phase C' — Media processing kinds (PR 4)
- Kinds: `video_derive` (`process-video`/`transcode-video`; budget already `WALL_CLOCK_BUDGET_MS=57_000` in `_shared/videoDerivation.ts:30`; `max_attempts=2`, retryable only on timeout), `image_tool` (wrap `_shared/aiImageJob.ts` start/resume; signed token in `progress.token`, continue via `run_after`), `external_media_import` (`cloudinary-upload` externalUrl path from `usePostForm.tsx:648`).
- `process-video`, `transcode-video`, `upscale-image`, `cloudinary-upload` accept `async:true` → enqueue + 202; sync kept one release.
- Frontend: `VideoCompressor.tsx:132`, `MediaCropper.tsx:342`, `TikTokPreCheck.tsx:600`, `ImageToolsDialog.tsx:548/602-625` (delete HEAD-poll), `BackgroundRemovalDialog.tsx:198`, `BatchImageToolsDialog.tsx:463` → `useBackgroundJob`; write `media_operations_history` row at enqueue (`processing`) so `useMediaOperationsHistory` shows the same truth.

## Phase B' — Text AI, brand scrape, admin loops (PR 5)
- Caption/hashtags/best-times usually finish in 5–20s. Recommendation: instrument duration in `system_logs` for two weeks; move to kind `ai_text` only if p95 > 20s. If adopted: `async:true` opt-in, worker calls `callAiChain` (`_shared/ai-fallback.ts`), `useBackgroundJob` in `CaptionSection.tsx:115`, `HashtagSuggestions.tsx:47`, `TextCaptionNode.tsx:68/94`, `BrandIntelligencePost.tsx:133`, `YouTubeAISuggestions.tsx:58`, `useContentGeneration.ts:26`, `BestTimeSuggestions.tsx:81`.
- `brand-scrape` (60–90s Apify, `useBrandScrape.ts:48`): kind `brand_scrape`, clear fit.
- Admin loops (`AdminTokenHealth.tsx:181/241/270/300`, `AdminUsers.tsx:331`, `AdminMediaCleanup.tsx:97`, `AdminSubscriptions.tsx:313`, `SyncAllButton.tsx:14`, `PlatformAccountsTab.tsx:128`): kind `admin_batch` `{ action }`, admin-only enqueue, progress counter.

---

## Deployment checklist (every PR)
1. `scripts/db-harness.sh` with the new suite registered (local/CI).
2. Apply migration on prod BEFORE merge via `ssh-contabo-mcp` psql (`docs/runbooks/deploy-edge-function.md` "Apply the migration before you merge"); confirm `SELECT jobname, schedule, active FROM cron.job`.
3. Merge backend; edge functions deploy per runbook (`git show <ref>:<path>` into the functions volume, SHA256 check, `docker compose up -d --no-deps functions`); verify OPTIONS probe and `[background] waitUntil path active` in logs.
4. Merge frontend (Dokploy auto on `main`); verify `pg_publication_tables` for `supabase_realtime`.
5. Regenerate `src/integrations/supabase/types.ts` (§23).
6. mem0 save + final report.

## Verification (end to end)
- Phase A: in the live app press Publish Now on a scheduled post → toast within <1s, badge `processing`, flips to success via Realtime; `posts.status` goes pending→processing→completed exactly once (check `platform_posts` count = accounts). Kill the kick (block the URL in a test) → cron publishes within about 90s (30s grace plus a one-minute tick), no duplicate.
- Phase B: generate image → 202 with `jobId`, `ai_generation_jobs` row `queued`→`running`→`succeeded`, image renders without reload.
- Phase C: broadcast to >150 recipients → 202, `whatsapp_broadcast_recipients` fill in chunks, counts update live, no recipient receives twice.
- Phase C': compress a video → dialog shows submitted → result appears; `media_operations_history` consistent.

## Risks
- `EdgeRuntime.waitUntil` on self-hosted runtime: if degraded, the kick fetch is still sent before the 2s cap; `process-post` does not read `req.signal`. Verify once in logs after PR 1.
- Kicked `process-post` runs under 150s worker semantics; Kong may log the kick connection as timed out — harmless.
- Realtime fan-out: new subscriptions must be filtered `id=eq.` / `user_id=eq.`; `useRealtimePostUpdates.tsx:82` currently subscribes to all `platform_posts` changes.
- Open: `n8n-api` `async:true` opt-in is a public-contract change → follow-up with the n8n node release process.
- Open: 3 min lease vs long `image_tool` tokens → handler must `continue` with `run_after`, not hold the lease.
