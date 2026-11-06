# Background workers Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Delegated implementers (Codex / Grok / OpenCode / Antigravity): read `ARCHITECTURE.md` before touching any file.** Nothing loads it for you. The sections that bind this plan are listed under Global Constraints.

**Goal:** "Generate image" answers in under a second with 202 `queued`. The image arrives later through Realtime, with polling as the fallback. The UI never shows a fake "done". No generation charges quota twice or produces two images. MCP and n8n keep their synchronous contract.

**Architecture:**
- **Shared chain.** The provider chain moves out of `generate-image` into `generate-image/runImageGeneration.ts` as `runImageGeneration(deps, job)`. The sync path and the new worker both call it.
  - **One deadline.** A single absolute deadline flows through reference preparation, every provider call and cleanup.
  - **No refund on an unknown outcome.** A Higgsfield call whose outcome is unknown is neither refunded nor followed by a fallback.
- **Enqueue.** On `async: true`, `generate-image` first runs every existing gate: auth, subscription, rate limit and the `api_logs` row. Then one `SECURITY DEFINER` RPC, `enqueue_ai_image_job`, writes the job row and its private payload row in one transaction. Finally the function kicks `ai-image-worker` inside `runInBackground` and returns 202 `{ success: true, jobId, status: "queued" }`.
- **Worker.** `ai-image-worker` is a cron-auth door that answers 202 at once and works inside `runInBackground`.
  - It claims jobs through `claim_ai_image_jobs`: `FOR UPDATE SKIP LOCKED`, a lease, a fresh `claim_token`, and a per-user cap of 2 running jobs under a per-user advisory lock.
  - It stamps `dispatched_at` before the first billable call.
  - It writes the terminal state through `complete_ai_image_job`, fenced on `claim_token`.
- **Interrupted jobs.** A dispatched job whose worker died is failed and never re-run.
- **Status.** `ai-generation-status` answers worker image jobs before its provider and timeout branches. A failed database read is a retryable 503, never "not found" or "expired".
- **Frontend.** `useAiGenerationJob` and the four callers share one watcher. It subscribes to `postgres_changes` and polls as the fallback. It has at most one read in flight, an overall deadline timer, and a timeout on each read.

**Tech Stack:** Deno edge functions (self-hosted Supabase edge runtime, `workerTimeoutMs` 150 s), PostgREST RPC, pg_cron + pg_net, Supabase Realtime `postgres_changes`, React 18, Vitest, Deno test, SQL proof suites run by `scripts/db-harness.sh`.

**Spec:** `docs/superpowers/specs/2026-11-06-background-workers-design.md` (section "Phase B").

**Required reading before code:** `ARCHITECTURE.md` §1 (zero dead modules), §12 (index.ts is an adapter), §13-§14 (no body `user_id` except after service-role auth), §15 (Zod), §16 (sanitized errors), §17 (no secret logging), §23 (RLS + policies + cross-user denial tests, `SECURITY DEFINER` with `search_path`, regenerate types), §24 (service-role key backend only), §25 (CORS), §26 (timeouts; never blindly retry a billable side effect), §27 (`waitUntil` only for bounded work, state persisted), §28 (atomic claim, duplicate prevention, attempt state), §35 (no cosmetic refactors), §36 (backward compatibility: n8n/MCP), §38 (quota server-side), §40 (shared-code rule), §41 (`process-post` untouched).

## Global Constraints

- **Sync stays the default for one release.** A body without `async: true` keeps today's statuses, bodies and `X-RateLimit-*` headers. Task 2 pins that with a characterization test of the real handler *before* any code moves. Callers that rely on it:
  - n8n `POST /api/v1/ai/image` (`n8n-api/index.ts:2641`, handled by `serviceProxy.ts:375-403`). It answers `200 {success, image_url, description}` for a hosted image and `201 {success, media_file_id, url, description}` for an inline one (`serviceProxy.ts:367,401`).
  - MCP `generate_image` (`mcp/index.ts:603-616`), which goes through n8n.

  Two deliberate sync changes are allowed. Both are bug fixes from the debate (B1), and both are pinned by the tests:
  1. A Higgsfield call with an unknown outcome is no longer refunded and followed by a fallback. It answers `{ success: false, error_code: "ai_outcome_unknown", message }`.
  2. A Higgsfield image that was produced but whose bookkeeping insert failed is still returned. It is no longer refunded and discarded.
- **The extraction is a move.** Allowed edits while moving: the dependency-injection seams in Task 3, the deadline budget (B2), the Higgsfield outcome classification (B1), and the two type errors that `deno check` reports today (`generate-image/index.ts:268` `Uint8Array<ArrayBufferLike>`, `:981` `aspectRatio` possibly undefined).
- **Never charge quota twice or produce two images.**
  - Quota reserve and release stay per platform-Higgsfield candidate.
  - Quota is released only on a confirmed refusal, which is the rule at `20260820130000_higgsfield_oauth_and_generation.sql:153`.
  - An unknown outcome ends the job, with no release and no fallback.
  - A job whose `dispatched_at` is set is never claimed again.
- **Heavy bytes stay off the published row.** Reference data and `data:` results live in `ai_image_job_payloads`, which is private and not published. `ai_generation_jobs.params` carries scalars plus `reference_urls`: the https references, kept there so the media-retention sweep keeps protecting them (B8).
- **§40 placement.** The chain is image-generation policy (quota, BYO limits, model chain), so it stays in `generate-image/`, not `_shared/`. `ai-image-worker` belongs to the same feature and imports `../generate-image/*`. Precedent: `ai-knowledge-excel-worker/index.ts:3-4` imports `../ai-knowledge-ingest/*`.
- **The migration carries no `BEGIN`/`COMMIT`.** The SQL proof re-applies it with `\ir` twice in one transaction.
- **Copy:** no new `t()` keys. The i18n gate (`npm run check:i18n`) checks keys only.
- Never commit `graphify-out/`, logs, `.env*` or secrets. Commit with `git commit -- <paths>`.
- Every command runs from the worktree: `cd /f/Dev/Worktrees/Postora_new/background-workers && ...`. Deno: `/f/Dev/Runtimes/deno-bin/bin/deno.exe` (CI: `deno`). The generate-image graph typechecks without the process-post import map.
- New Deno test files start with `// deno-lint-ignore-file no-import-prefix` and import `https://deno.land/std@0.208.0/assert/mod.ts`, as `generate-image/modelChoice.test.ts:1-2` does.

## Debate verdicts (Codex, 1 round on 537fe765) — 9/9 accepted

| ID | Verdict | Change made / reason |
|---|---|---|
| B1 | ACCEPTED (scoped to Higgsfield) | `McpError` gains `outcome: "rejected" \| "unknown"` (`_shared/higgsfield-mcp.ts`). The Higgsfield port throws `ProviderOutcomeUnknownError` for any failure of the `generate_image` call that is not a definitive rejection. Examples: the timeout at `higgsfield-mcp.ts:164`, a 5xx, no response, or no output URL. The runner then does not release and does not fall back, and returns `outcome_unknown`. Test: one reserve, zero releases, no second provider call (Task 3). The direct-key providers (OpenAI/Google/Vercel) keep falling back on a timeout. They reserve no user quota (`index.ts:973-990`), and the timed-out response is discarded, so the user is never charged and never shown two images. Only the platform pays twice. |
| B2 | ACCEPTED | A `CallBudget { deadlineMs, now(), signal(ms) }` is threaded through `fetchReference`, OpenAI, Google (the signal is taken *after* the references are read), Vercel (new `timeoutMs` argument, `vercelGateway.ts:78-83`), the Higgsfield client (new `withDeadline`, every `post` capped at the time left) and staging cleanup. Each candidate needs `PROVIDER_MIN_MS[provider]` of time left or it is skipped. The save reserve is explicit: `jobDeadline = lifetime 150 s − saveReserve 10 s`. Tests: slow references; a fallback that starts near the end. |
| B3 | ACCEPTED | `loadOwnedJob` and `answerWorkerImageJob` (`ai-generation-status/workerImageJob.ts`) check `error` on both reads and return 503 `retryable: true`. 404 is only answered for a row that is really missing. This also fixes the existing job read (`index.ts:27-34`) for video. Tests drive those two functions, which hold the handler's actual reads, with a fake client that returns DB errors. |
| B4 | ACCEPTED | New `enqueue_ai_image_job` RPC (`SECURITY DEFINER`, service_role only) writes the job and payload in one transaction. The claim only takes rows that have a payload, and branch (e) fails orphans as `ai_payload_missing`. The worker's requeue path is removed (YAGNI). The old wording that "W6 ends the requeue" is gone. Test W14: an orphan older than a healthy job; the healthy job is still claimed. |
| B5 | ACCEPTED | `claim_ai_image_jobs(p_limit, p_lease, p_max_per_user DEFAULT 2)` takes `pg_advisory_xact_lock` per user and skips a candidate whose user already has 2 running worker jobs. The BYO check in the chain (`checkByoGenerationLimits`) still runs before each BYO dispatch for the combined video+image count. Test W15: three jobs for one user and one for another; the first claim returns 2 + 1. |
| B6 | ACCEPTED | `poll` returns at once if a read is in flight. `schedule` always clears the previous timer. The immediate re-poll in `finally` clears the timer first. Test: a Realtime event during a pending read, then `running`, with at most 1 read in flight and no extra read. |
| B7 | ACCEPTED | The watcher starts one `MAX_POLL_MS` deadline timer at subscribe time, and each read races a 20 s `READ_TIMEOUT_MS`. Test: an `invoke` that never settles still ends the wait as `timeout` and removes the channel. |
| B8 | ACCEPTED | `enqueue` copies the https reference URLs into `params.reference_urls`. Non-terminal job `params` are already scanned by the sweep (`media_retention.sql:326-330`, `strpos` match). Test: a new protected fixture in `supabase/tests/media_retention.sql` whose only reference is a queued worker job made by `enqueue_ai_image_job`. |
| B9 | ACCEPTED | The route and replies are corrected in Verification 7. New Task 2 moves the handler body into `generate-image/handler.ts` (a pure move) and pins the real handler without `async` before the extraction: statuses, bodies, rate-limit headers, and no `enqueue_ai_image_job` call. |

## Decisions with evidence

| # | Decision | Evidence |
|---|---|---|
| D1 | Today a job row is written only after a Higgsfield success. Phase B writes it at enqueue. | `generate-image/index.ts:951`; `:973-990` write no row |
| D2 | Because three columns are NOT NULL or CHECK-constrained, the enqueue writes placeholders (`provider='postora'`, `model_id = requested ?? 'auto'`, `credential_source='platform'`). `complete_ai_image_job` overwrites them with what actually ran. | `20260820130000_higgsfield_oauth_and_generation.sql` (table DDL) |
| D3 | The table has owner-only SELECT. The worker writes as service role, with `user_id` taken from the claimed row. | the `ai_generation_jobs_owner_select` policy in the same migration; §13/§14 |
| D4 | A worker job is `modality='image' AND params->>'worker'='true'`. | Video rows carry `provider_job_id` (`generate-video/index.ts:84-89`); sync rows have no marker (`generate-image/index.ts:951`) |
| D5 | `ai-generation-status` answers worker jobs before its 30-minute branch, which refunds every `platform` row. | `ai-generation-status/index.ts:36-51` |
| D6 | The per-user concurrency for worker jobs is enforced at claim (B5). The BYO hourly count stays the same as sync because a BYO success is written back as `credential_source='byo'`, and sync also writes a row only on success. | `_shared/higgsfield-rate-limit.ts:11-35`; `generate-image/index.ts:951` |
| D7 | Lease 3 min, longer than the 150 s worker lifetime. Claim only with ≥ 100 s of lifetime left. All provider work ends by `start + 140 s`, which leaves 10 s to save. | `process-post/deferredPublish.ts:175`, `process-post/index.ts:175`, `docs/runbooks/deploy-edge-function.md` |
| D8 | Both the worker door and the kick return before the work ends: 202, then `runInBackground`. | `_shared/aiImageJob.ts:1-3` (~60 s gateway limit), `_shared/background.ts` |
| D9 | The kick uses the service-role bearer, which `verifyCronAuth` accepts. Add `[functions.ai-image-worker] verify_jwt = false`. | `_shared/cron-auth.ts:64`; `supabase/config.toml:56-58` |
| D10 | Callers keep receiving `data:` URLs. The YouTube thumbnail is persisted, and a signed URL would expire. | `useYouTubeThumbnails.tsx:119-131`, `YouTubeSettings.tsx:787`, `MediaNode.tsx:145-157` |
| D11 | `useAiGenerationJob` keeps its fields for `VideoGenerator` and adds `errorCode`. | `src/components/post/VideoGenerator.tsx:24,65` |
| D12 | No "reserve at claim": quota is metered only for platform Higgsfield candidates. | `generate-image/index.ts:908-913` |

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `supabase/migrations/20261107120000_ai_image_jobs_worker.sql` | Create | Columns, index, payload table, `enqueue_ai_image_job`, `claim_ai_image_jobs`, `complete_ai_image_job`, Realtime, two crons |
| `supabase/tests/ai_image_jobs_worker.sql` | Create | SQL proof W1-W15 |
| `supabase/tests/media_retention.sql` | Modify | B8 fixture: a queued worker job's reference is protected |
| `scripts/db-harness.sh` | Modify | Register the new suite |
| `supabase/functions/generate-image/handler.ts` (+ `handler.test.ts`) | Create (moved from index.ts) | Request handler with injected clients; characterization test |
| `supabase/functions/generate-image/index.ts` | Rewrite | `serve` adapter over `handler.ts` |
| `supabase/functions/generate-image/imageFailure.ts` (+ test) | Create | `describeImageFailure` |
| `supabase/functions/generate-image/callBudget.ts` (+ test) | Create | One absolute deadline: `budgetSignal`, `NotEnoughTimeError` |
| `supabase/functions/generate-image/runImageGeneration.ts` (+ test) | Create | Prompt, chain, providers, Higgsfield outcome classification, runner |
| `supabase/functions/generate-image/asyncJob.ts` (+ test) | Create | Enqueue args and the worker kick |
| `supabase/functions/_shared/higgsfield-mcp.ts` | Modify | `McpError.outcome`; `withDeadline` |
| `supabase/functions/_shared/vercelGateway.ts` (+ test) | Modify | `vercelGenerateImage(..., timeoutMs = 50_000)` |
| `supabase/functions/ai-image-worker/{worker,deps,index}.ts` (+ `worker.test.ts`) | Create | Worker |
| `supabase/functions/ai-generation-status/workerImageJob.ts` (+ test), `index.ts` | Create / Modify | DB-checked reads and the worker short-circuit |
| `supabase/config.toml` | Modify | `verify_jwt = false` for the worker |
| `src/lib/aiGenerationJobWatcher.ts` (+ test) | Create | Watcher, `awaitAiGenerationJob`, `resolveAiImageResponse` |
| `src/hooks/useAiGenerationJob.ts` (+ test) | Modify / Create | Hook over the watcher |
| `src/components/post/ImageGenerator.tsx`, `src/components/canvas/nodes/{CaptionNode,MediaNode}.tsx`, `src/hooks/useYouTubeThumbnails.tsx` (+ test) | Modify | `async: true` callers |
| `src/integrations/supabase/types.ts` | Modify | Columns, table, three RPCs |
| `.github/workflows/ci.yml` | Modify | New step |

---

### Task 1: Migration and SQL proofs

**Files:**
- Create: `supabase/migrations/20261107120000_ai_image_jobs_worker.sql`, `supabase/tests/ai_image_jobs_worker.sql`
- Modify: `scripts/db-harness.sh` (add `  ai_image_jobs_worker.sql` after `  publish_requests.sql`, line 141), `supabase/tests/media_retention.sql`

**Interfaces (consumed by Tasks 4-6):**
- `enqueue_ai_image_job(p_user_id uuid, p_model_id text, p_params jsonb, p_references jsonb) RETURNS uuid`
- `claim_ai_image_jobs(p_limit integer DEFAULT 1, p_lease interval DEFAULT '3 minutes', p_max_per_user integer DEFAULT 2) RETURNS SETOF ai_generation_jobs`
- `complete_ai_image_job(p_job_id uuid, p_claim_token uuid, p_status text, p_result_url text, p_result_data_url text, p_error text, p_provider text, p_model_id text, p_credential_source text, p_params jsonb) RETURNS boolean`
- Columns `claim_token`, `claimed_at`, `dispatched_at`, `attempts`. Table `ai_image_job_payloads`.

- [ ] **Step 1: Write the failing proof** `supabase/tests/ai_image_jobs_worker.sql`:

```sql
-- ============================================================================
-- supabase/tests/ai_image_jobs_worker.sql
-- Phase B (migration 20261107120000_ai_image_jobs_worker.sql).
-- One transaction, labelled ASSERTs, ROLLBACK, sentinel last.
--   W1  the migration applies twice; each cron exists once
--   W2  claims return distinct jobs, oldest first
--   W3  a claim sets running, a fresh token, claimed_at, attempts+1
--   W4  an expired, undispatched lease is re-claimed with a NEW token
--   W5  an expired, dispatched lease fails as ai_interrupted, never re-claimed
--   W6  an expired lease with attempts >= 3 fails as ai_attempts_exhausted
--   W7  a job queued > 15 minutes times out as ai_queue_timeout
--   W8  complete with a stale token writes nothing and returns false
--   W9  complete with the live token writes job + payload once
--   W10 video rows and sync image rows are never claimed
--   W11 owner-only SELECT; authenticated cannot read payloads or run the RPCs
--   W12 jobs are in supabase_realtime, payloads are not
--   W13 cron commands resolve the secret at run time
--   W14 an orphan (no payload) older than a healthy job neither blocks it nor survives
--   W15 at most p_max_per_user running worker jobs per user; other users unaffected
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE _cron_before AS SELECT jobname, schedule, command FROM cron.job;

\ir ../migrations/20261107120000_ai_image_jobs_worker.sql
\ir ../migrations/20261107120000_ai_image_jobs_worker.sql

DO $t$
DECLARE
  u_a uuid := 'b1b1b1b1-1111-4111-8111-b1b1b1b1b1b1';
  u_b uuid := 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
  u_c uuid := 'b3b3b3b3-3333-4333-8333-b3b3b3b3b3b3';
  j1 uuid; j2 uuid; j3 uuid; orphan uuid; healthy uuid;
  r1 public.ai_generation_jobs; r2 public.ai_generation_jobs;
  tok uuid; n int; ok boolean;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'ai-image-worker-a@example.invalid'),
    (u_b, 'ai-image-worker-b@example.invalid'),
    (u_c, 'ai-image-worker-c@example.invalid');

  j1 := public.enqueue_ai_image_job(u_a, NULL, '{"prompt":"a"}',
          '[{"url":"data:image/png;base64,AAAA","type":"style","priority":1}]');
  UPDATE public.ai_generation_jobs SET created_at = now() - interval '2 minutes' WHERE id = j1;
  j2 := public.enqueue_ai_image_job(u_a, 'gpt-image-1', '{"prompt":"b"}', '[]');
  UPDATE public.ai_generation_jobs SET created_at = now() - interval '1 minute' WHERE id = j2;
  ASSERT (SELECT provider = 'postora' AND model_id = 'auto' AND credential_source = 'platform' AND status = 'queued'
            AND params->>'worker' = 'true' FROM public.ai_generation_jobs WHERE id = j1), 'enqueue writes placeholders + marker';
  ASSERT (SELECT model_id FROM public.ai_generation_jobs WHERE id = j2) = 'gpt-image-1', 'enqueue keeps the requested model';
  ASSERT EXISTS (SELECT 1 FROM public.ai_image_job_payloads WHERE job_id = j1), 'enqueue writes the payload in the same call';

  INSERT INTO public.ai_generation_jobs (user_id, provider, model_id, modality, credential_source, status, provider_job_id, params)
  VALUES (u_a, 'higgsfield', 'v', 'video', 'platform', 'queued', 'pj-1', '{}');
  INSERT INTO public.ai_generation_jobs (user_id, provider, model_id, modality, credential_source, status, result_url, params)
  VALUES (u_a, 'higgsfield', 'i', 'image', 'platform', 'succeeded', 'https://x.invalid/i.png', '{"prompt":"s"}');

  -- W2/W3
  SELECT * INTO r1 FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  SELECT * INTO r2 FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  ASSERT r1.id = j1 AND r2.id = j2, 'W2: oldest first, distinct jobs';
  ASSERT r1.status = 'running' AND r1.claim_token IS NOT NULL AND r1.claimed_at IS NOT NULL AND r1.attempts = 1, 'W3';
  SELECT count(*) INTO n FROM public.claim_ai_image_jobs(5, interval '3 minutes');
  ASSERT n = 0, 'W10: video and sync rows are never claimed';

  -- W4
  tok := r1.claim_token;
  UPDATE public.ai_generation_jobs SET claimed_at = now() - interval '4 minutes' WHERE id = j1;
  SELECT * INTO r1 FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  ASSERT r1.id = j1 AND r1.claim_token <> tok AND r1.attempts = 2, 'W4';

  -- W8
  SELECT public.complete_ai_image_job(j1, tok, 'succeeded', 'https://x.invalid/stale.png', NULL, NULL, 'google', 'm', 'platform', '{}') INTO ok;
  ASSERT ok IS FALSE AND (SELECT status FROM public.ai_generation_jobs WHERE id = j1) = 'running', 'W8';

  -- W9
  SELECT public.complete_ai_image_job(j1, r1.claim_token, 'succeeded', NULL, 'data:image/png;base64,BBBB', NULL,
    'google', 'gemini-2.5-flash-image', 'platform', '{"description":"ok"}') INTO ok;
  ASSERT ok, 'W9: live token completes';
  ASSERT (SELECT status = 'succeeded' AND provider = 'google' AND claim_token IS NULL AND params->>'worker' = 'true'
            FROM public.ai_generation_jobs WHERE id = j1), 'W9: job written, marker kept';
  ASSERT (SELECT reference_images = '[]'::jsonb AND result_data_url = 'data:image/png;base64,BBBB'
            FROM public.ai_image_job_payloads WHERE job_id = j1), 'W9: payload written, references cleared';
  SELECT public.complete_ai_image_job(j1, r1.claim_token, 'failed', NULL, NULL, 'x', NULL, NULL, NULL, '{}') INTO ok;
  ASSERT ok IS FALSE, 'W9: completes once';

  -- W5
  UPDATE public.ai_generation_jobs SET dispatched_at = now() - interval '4 minutes', claimed_at = now() - interval '4 minutes' WHERE id = j2;
  SELECT count(*) INTO n FROM public.claim_ai_image_jobs(5, interval '3 minutes');
  ASSERT n = 0 AND (SELECT status = 'failed' AND params->>'error_code' = 'ai_interrupted' FROM public.ai_generation_jobs WHERE id = j2), 'W5';

  -- W6
  j3 := public.enqueue_ai_image_job(u_a, NULL, '{"prompt":"c"}', '[]');
  UPDATE public.ai_generation_jobs SET status = 'running', claimed_at = now() - interval '4 minutes', attempts = 3,
         claim_token = gen_random_uuid() WHERE id = j3;
  PERFORM public.claim_ai_image_jobs(5, interval '3 minutes');
  ASSERT (SELECT status = 'failed' AND params->>'error_code' = 'ai_attempts_exhausted' FROM public.ai_generation_jobs WHERE id = j3), 'W6';

  -- W7
  j3 := public.enqueue_ai_image_job(u_a, NULL, '{"prompt":"d"}', '[]');
  UPDATE public.ai_generation_jobs SET created_at = now() - interval '16 minutes' WHERE id = j3;
  PERFORM public.claim_ai_image_jobs(1, interval '3 minutes');
  ASSERT (SELECT status = 'timeout' AND params->>'error_code' = 'ai_queue_timeout' FROM public.ai_generation_jobs WHERE id = j3), 'W7';

  -- W14: orphan older than a healthy job (rows inserted directly; enqueue can no longer make one)
  INSERT INTO public.ai_generation_jobs (user_id, provider, model_id, modality, credential_source, status, params, created_at)
  VALUES (u_b, 'postora', 'auto', 'image', 'platform', 'queued', '{"worker":true}', now() - interval '5 minutes')
  RETURNING id INTO orphan;
  healthy := public.enqueue_ai_image_job(u_b, NULL, '{"prompt":"h"}', '[]');
  SELECT * INTO r1 FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  ASSERT r1.id = healthy, 'W14: the healthy job is claimed despite the older orphan';
  ASSERT (SELECT status = 'failed' AND params->>'error_code' = 'ai_payload_missing' FROM public.ai_generation_jobs WHERE id = orphan),
    'W14: the orphan is settled as failed';

  -- W15: per-user cap (sequential claims; the advisory lock serialises concurrent ones the same way)
  PERFORM public.enqueue_ai_image_job(u_c, NULL, '{"prompt":"c1"}', '[]');
  PERFORM public.enqueue_ai_image_job(u_c, NULL, '{"prompt":"c2"}', '[]');
  PERFORM public.enqueue_ai_image_job(u_c, NULL, '{"prompt":"c3"}', '[]');
  SELECT count(*) INTO n FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  SELECT count(*) INTO n FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  SELECT count(*) INTO n FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  ASSERT (SELECT count(*) FROM public.ai_generation_jobs WHERE user_id = u_c AND status = 'running') = 2, 'W15: cap of 2 per user';
  ASSERT n = 0, 'W15: the third claim finds nothing for the capped user';
  healthy := public.enqueue_ai_image_job(u_b, NULL, '{"prompt":"other"}', '[]');
  SELECT * INTO r1 FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  ASSERT r1.id = healthy, 'W15: another user is not blocked by the capped user';

  -- W12
  ASSERT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'ai_generation_jobs'), 'W12a';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'ai_image_job_payloads'), 'W12b';

  -- W11 grants
  ASSERT NOT has_function_privilege('authenticated', 'public.enqueue_ai_image_job(uuid, text, jsonb, jsonb)', 'EXECUTE'), 'W11 enqueue';
  ASSERT NOT has_function_privilege('authenticated', 'public.claim_ai_image_jobs(integer, interval, integer)', 'EXECUTE'), 'W11 claim';
  ASSERT NOT has_function_privilege('anon', 'public.claim_ai_image_jobs(integer, interval, integer)', 'EXECUTE'), 'W11 claim anon';
  ASSERT NOT has_function_privilege('authenticated',
    'public.complete_ai_image_job(uuid, uuid, text, text, text, text, text, text, text, jsonb)', 'EXECUTE'), 'W11 complete';
  ASSERT has_function_privilege('service_role', 'public.claim_ai_image_jobs(integer, interval, integer)', 'EXECUTE'), 'W11 service_role';
  ASSERT NOT has_table_privilege('authenticated', 'public.ai_image_job_payloads', 'SELECT'), 'W11 payloads';

  -- W1/W13
  ASSERT (SELECT count(*) FROM cron.job WHERE jobname = 'ai-image-worker') = 1, 'W1 worker cron once';
  ASSERT (SELECT count(*) FROM cron.job WHERE jobname = 'purge-ai-image-payloads') = 1, 'W1 purge cron once';
  ASSERT (SELECT schedule FROM cron.job WHERE jobname = 'ai-image-worker') = '* * * * *', 'W13 schedule';
  ASSERT (SELECT position('get_cron_secret()' in command) > 0 AND position('Bearer ' in command) > 0
            AND command !~ '''[A-Za-z0-9_-]{24,}''' AND command !~ '[A-Za-z0-9_-]{40,}'
            AND position('/functions/v1/ai-image-worker' in command) > 0
          FROM cron.job WHERE jobname = 'ai-image-worker'), 'W13 no literal secret';
  ASSERT NOT EXISTS (SELECT jobname, schedule, command FROM _cron_before EXCEPT SELECT jobname, schedule, command FROM cron.job),
    'W13 other jobs unchanged';
END
$t$;

-- W11 RLS
SELECT set_config('request.jwt.claims', '{"sub":"b3b3b3b3-3333-4333-8333-b3b3b3b3b3b3","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', 'b3b3b3b3-3333-4333-8333-b3b3b3b3b3b3', true);
SET LOCAL ROLE authenticated;
DO $rls$ BEGIN
  ASSERT (SELECT count(*) FROM public.ai_generation_jobs WHERE user_id <> 'b3b3b3b3-3333-4333-8333-b3b3b3b3b3b3') = 0,
    'W11: a user sees no one else''s jobs';
  ASSERT (SELECT count(*) FROM public.ai_generation_jobs) = 3, 'W11: a user sees their own jobs';
END $rls$;
RESET ROLE;

ROLLBACK;
\echo '=== ai_image_jobs_worker: ALL CHECKS PASSED ==='
```

- [ ] **Step 2: Add the B8 fixture to `supabase/tests/media_retention.sql`.**
  - Append `'11111111-1111-4111-8111-11111111113f'` as the 26th element of `protected` (lines 122-147). It is unused today: `grep -c 11111111113f` returns 0.
  - Add `PERFORM pg_temp.mfile(protected[26], u_a);` beside `protected[25]` (line 186).
  - After the `protected[23]` insert (line 309-312), add:

```sql
  -- A queued background image job references this file only through its
  -- reference_urls; the sweep must treat it as in use (Phase B, B8).
  PERFORM public.enqueue_ai_image_job(u_a, NULL,
    jsonb_build_object('prompt', 'p', 'reference_urls',
      jsonb_build_array((SELECT file_path FROM public.media_files WHERE id = protected[26]))),
    jsonb_build_array(jsonb_build_object('url', (SELECT file_path FROM public.media_files WHERE id = protected[26]))));
```

  The existing `FOREACH fid IN ARRAY protected` assertion (line 357-360) then proves the file is not expired. The reset at line 333 (`WHERE id = ANY (protected)`) covers it too.

- [ ] **Step 3: Run the harness; it fails** (the migration is missing): `cd /f/Dev/Worktrees/Postora_new/background-workers && bash scripts/db-harness.sh`.

- [ ] **Step 4: Write the migration** `supabase/migrations/20261107120000_ai_image_jobs_worker.sql`:

```sql
-- Phase B: AI image generation as a background job.
-- Applied by hand on production BEFORE the functions merge; re-applied twice inside one
-- transaction by supabase/tests/ai_image_jobs_worker.sql, so it stays idempotent with no BEGIN/COMMIT.

ALTER TABLE public.ai_generation_jobs
  ADD COLUMN IF NOT EXISTS claim_token   uuid,
  ADD COLUMN IF NOT EXISTS claimed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts      integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.ai_generation_jobs.dispatched_at IS
  'Set by ai-image-worker just before the first billable call. A job with this set is never re-run: its outcome is indeterminate.';

CREATE INDEX IF NOT EXISTS ai_generation_jobs_image_worker_queue_idx
  ON public.ai_generation_jobs (created_at)
  WHERE modality = 'image' AND status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS ai_generation_jobs_image_worker_user_running_idx
  ON public.ai_generation_jobs (user_id)
  WHERE modality = 'image' AND status = 'running';

CREATE TABLE IF NOT EXISTS public.ai_image_job_payloads (
  job_id           uuid PRIMARY KEY REFERENCES public.ai_generation_jobs(id) ON DELETE CASCADE,
  reference_images jsonb NOT NULL DEFAULT '[]'::jsonb,
  result_data_url  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_image_job_payloads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_image_job_payloads FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_image_job_payloads TO service_role;

-- One transaction: a job row can never exist without its payload.
CREATE OR REPLACE FUNCTION public.enqueue_ai_image_job(
  p_user_id uuid, p_model_id text, p_params jsonb, p_references jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_params IS NULL OR jsonb_typeof(p_params) <> 'object' THEN
    RAISE EXCEPTION 'enqueue_ai_image_job: user and params object are required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.ai_generation_jobs (user_id, provider, model_id, modality, credential_source, status, params)
  VALUES (p_user_id, 'postora', COALESCE(NULLIF(p_model_id, ''), 'auto'), 'image', 'platform', 'queued',
          p_params || jsonb_build_object('worker', true))
  RETURNING id INTO v_id;
  INSERT INTO public.ai_image_job_payloads (job_id, reference_images)
  VALUES (v_id, COALESCE(p_references, '[]'::jsonb));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_ai_image_jobs(
  p_limit integer DEFAULT 1,
  p_lease interval DEFAULT interval '3 minutes',
  p_max_per_user integer DEFAULT 2
) RETURNS SETOF public.ai_generation_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cand record;
  v_row public.ai_generation_jobs;
  v_running integer;
  v_claimed integer := 0;
BEGIN
  -- (a) Dispatched, lease expired: indeterminate. Fail, never re-run, never release.
  WITH done AS (
    UPDATE public.ai_generation_jobs
       SET status = 'failed', error = 'The generation was interrupted before it finished. Please try again.',
           params = params || jsonb_build_object('error_code', 'ai_interrupted'), claim_token = NULL, updated_at = now()
     WHERE modality = 'image' AND params->>'worker' = 'true'
       AND status = 'running' AND dispatched_at IS NOT NULL AND claimed_at < now() - p_lease
    RETURNING id)
  UPDATE public.ai_image_job_payloads SET reference_images = '[]'::jsonb WHERE job_id IN (SELECT id FROM done);

  -- (b) Never dispatched, out of attempts.
  WITH done AS (
    UPDATE public.ai_generation_jobs
       SET status = 'failed', error = 'Image generation could not be started. Please try again.',
           params = params || jsonb_build_object('error_code', 'ai_attempts_exhausted'), claim_token = NULL, updated_at = now()
     WHERE modality = 'image' AND params->>'worker' = 'true'
       AND status = 'running' AND dispatched_at IS NULL AND claimed_at < now() - p_lease AND attempts >= 3
    RETURNING id)
  UPDATE public.ai_image_job_payloads SET reference_images = '[]'::jsonb WHERE job_id IN (SELECT id FROM done);

  -- (c) Queued too long (worker down). Nothing was reserved.
  WITH done AS (
    UPDATE public.ai_generation_jobs
       SET status = 'timeout', error = 'Image generation did not start in time. Please try again.',
           params = params || jsonb_build_object('error_code', 'ai_queue_timeout'), updated_at = now()
     WHERE modality = 'image' AND params->>'worker' = 'true'
       AND status = 'queued' AND created_at < now() - interval '15 minutes'
    RETURNING id)
  UPDATE public.ai_image_job_payloads SET reference_images = '[]'::jsonb WHERE job_id IN (SELECT id FROM done);

  -- (e) Orphans: a queued worker row with no payload can never run. enqueue_ai_image_job
  -- makes this impossible; this keeps a hand-written or legacy row from lingering.
  UPDATE public.ai_generation_jobs j
     SET status = 'failed', error = 'Image generation could not be started. Please try again.',
         params = j.params || jsonb_build_object('error_code', 'ai_payload_missing'), updated_at = now()
   WHERE j.modality = 'image' AND j.params->>'worker' = 'true' AND j.status = 'queued'
     AND NOT EXISTS (SELECT 1 FROM public.ai_image_job_payloads p WHERE p.job_id = j.id);

  -- (d) Claim, oldest first, at most p_max_per_user running jobs per user. The per-user
  -- advisory lock serialises concurrent claimers for one user, so each sees the other's
  -- committed claim (READ COMMITTED: every statement takes a fresh snapshot).
  IF p_limit IS NULL OR p_limit <= 0 THEN
    RETURN;
  END IF;
  FOR v_cand IN
    SELECT j.id, j.user_id
      FROM public.ai_generation_jobs j
     WHERE j.modality = 'image' AND j.params->>'worker' = 'true'
       AND EXISTS (SELECT 1 FROM public.ai_image_job_payloads p WHERE p.job_id = j.id)
       AND (j.status = 'queued'
            OR (j.status = 'running' AND j.dispatched_at IS NULL AND j.claimed_at < now() - p_lease AND j.attempts < 3))
     ORDER BY j.created_at
     FOR UPDATE OF j SKIP LOCKED
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('claim_ai_image_jobs:' || v_cand.user_id::text, 0));
    SELECT count(*) INTO v_running
      FROM public.ai_generation_jobs r
     WHERE r.user_id = v_cand.user_id AND r.modality = 'image' AND r.params->>'worker' = 'true'
       AND r.status = 'running' AND r.id <> v_cand.id;
    CONTINUE WHEN v_running >= p_max_per_user;

    UPDATE public.ai_generation_jobs
       SET status = 'running', claim_token = gen_random_uuid(), claimed_at = now(),
           attempts = attempts + 1, updated_at = now()
     WHERE id = v_cand.id
    RETURNING * INTO v_row;
    RETURN NEXT v_row;
    v_claimed := v_claimed + 1;
    EXIT WHEN v_claimed >= p_limit;   -- stop before fetching (and locking) one row too many
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_ai_image_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_status text,
  p_result_url text DEFAULT NULL,
  p_result_data_url text DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_provider text DEFAULT NULL,
  p_model_id text DEFAULT NULL,
  p_credential_source text DEFAULT NULL,
  p_params jsonb DEFAULT '{}'::jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_status NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'complete_ai_image_job: invalid terminal status %', p_status USING ERRCODE = '22023';
  END IF;
  UPDATE public.ai_generation_jobs
     SET status = p_status, result_url = p_result_url, error = p_error,
         provider = COALESCE(p_provider, provider), model_id = COALESCE(p_model_id, model_id),
         credential_source = COALESCE(p_credential_source, credential_source),
         params = params || COALESCE(p_params, '{}'::jsonb), claim_token = NULL, updated_at = now()
   WHERE id = p_job_id AND claim_token = p_claim_token AND status = 'running'
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN false;
  END IF;
  UPDATE public.ai_image_job_payloads
     SET reference_images = '[]'::jsonb, result_data_url = p_result_data_url
   WHERE job_id = p_job_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_ai_image_job(uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_ai_image_jobs(integer, interval, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_ai_image_job(uuid, uuid, text, text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_ai_image_job(uuid, text, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_ai_image_jobs(integer, interval, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_ai_image_job(uuid, uuid, text, text, text, text, text, text, text, jsonb) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'ai_generation_jobs') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_generation_jobs';
  END IF;
END
$$;

DO $do_cron_ai_image$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR to_regprocedure('public.get_cron_secret()') IS NULL THEN
    RAISE NOTICE 'pg_cron or get_cron_secret() missing; ai-image-worker crons not scheduled';
    RETURN;
  END IF;
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('ai-image-worker', 'purge-ai-image-payloads');
  PERFORM cron.schedule('ai-image-worker', '* * * * *', $cron$
    SELECT net.http_post(
      url := 'https://api.postora.cloud/functions/v1/ai-image-worker',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || get_cron_secret()),
      body := '{}'::jsonb
    );
  $cron$);
  PERFORM cron.schedule('purge-ai-image-payloads', '17 * * * *', $cron$
    DELETE FROM public.ai_image_job_payloads WHERE created_at < now() - interval '24 hours';
  $cron$);
END
$do_cron_ai_image$;
```

`FOR UPDATE ... SKIP LOCKED` in a `FOR` loop locks rows as the cursor fetches them. The `EXIT` right after the last claim stops fetching, so only the rows visited are locked; skipped candidates of a capped user stay locked until the transaction ends, which is one short RPC. Two claimers for the same user hold different row locks and serialise on the advisory lock, so they cannot deadlock.

- [ ] **Step 5: The harness is green.** Expect `=== ai_image_jobs_worker: ALL CHECKS PASSED ===` and the existing `media_retention` sentinel.
- [ ] **Step 6: Commit** `git commit -m "feat(ai-image): enqueue, claim, fence and realtime for background image jobs" -- supabase/migrations/20261107120000_ai_image_jobs_worker.sql supabase/tests/ai_image_jobs_worker.sql supabase/tests/media_retention.sql scripts/db-harness.sh` (run `git add` on the new files first).

---

### Task 2: Pin the sync contract of the real handler (B9)

**Files:**
- Create: `supabase/functions/generate-image/handler.ts`, `handler.test.ts`
- Rewrite: `supabase/functions/generate-image/index.ts`

**Interfaces:**
- Produces:

```ts
export interface GenerateImageHandlerDeps {
  admin: any;                                   // service-role client
  userClient(authHeader: string): any;           // anon client carrying the caller's JWT
  serviceRoleCallerUserId(req: Request): Promise<string | null>;
}
export async function handleGenerateImageRequest(req: Request, deps: GenerateImageHandlerDeps): Promise<Response>;
```

- [ ] **Step 1: Make the pure move.**
  - Run `git mv supabase/functions/generate-image/index.ts supabase/functions/generate-image/handler.ts`.
  - In `handler.ts`, delete the `serve` import (line 1) and change `serve(async (req) => {` (line 751) to `export async function handleGenerateImageRequest(req: Request, deps: GenerateImageHandlerDeps): Promise<Response> {`, closing with `}` instead of `});`.
  - Replace the two `createClient(...)` blocks in the handler (`:766-776`) with `const supabaseClient = deps.userClient(authHeader); const supabaseAdmin = deps.admin;`, and `serviceRoleCallerUserId(req)` with `deps.serviceRoleCallerUserId(req)`.
  - In the catch (`:1047-1056`), use `deps.admin` and `deps.userClient(\`Bearer ${token}\`)`.
  - Remove the `createClient` and `serviceRoleCallerUserId` imports from `handler.ts`; both are now unused there (`deno lint` flags them).
  - Nothing else changes. The new `index.ts`:

```ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { serviceRoleCallerUserId } from "../_shared/auth-helper.ts";
import { handleGenerateImageRequest } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
serve((req) =>
  handleGenerateImageRequest(req, {
    admin: createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""),
    userClient: (authHeader) =>
      createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: authHeader } } }),
    serviceRoleCallerUserId,
  }));
```

- [ ] **Step 2: Write the characterization test** `handler.test.ts`. It runs against the moved, not yet extracted handler, and must pass **before** Task 3 starts. It is offline: a recording fake client and a stubbed `fetch` that answers only Google `generateContent`.

```ts
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleGenerateImageRequest } from "./handler.ts";

type Calls = { inserts: Array<[string, unknown]>; rpcs: Array<[string, unknown]> };
function fakeClient(opts: { admin?: boolean; calls: Calls }) {
  const tableData: Record<string, unknown> = { user_roles: opts.admin ? { role: "admin" } : null };
  const builder = (table: string): any => {
    const result = { data: tableData[table] ?? null, error: null, count: 0 };
    const b: any = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => void) => res(result);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(result);
        if (prop === "insert") return (row: unknown) => { opts.calls.inserts.push([table, row]); return b; };
        return () => b;
      },
    });
    return b;
  };
  return {
    from: builder,
    rpc: (name: string, args: unknown) => { opts.calls.rpcs.push([name, args]); return Promise.resolve({ data: null, error: null }); },
    auth: { getUser: () => Promise.resolve({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } }, error: null }) },
    storage: { from: () => ({ remove: () => Promise.resolve({ error: null }) }) },
  };
}
function run(body: unknown, opts: { admin?: boolean; googleOk?: boolean } = {}) {
  const calls: Calls = { inserts: [], rpcs: [] };
  const client = fakeClient({ admin: opts.admin ?? true, calls });
  Deno.env.set("GOOGLE_AI_STUDIO_KEY", "test-key");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes(":generateContent")) throw new Error(`unexpected fetch ${url}`);
    return opts.googleOk === false
      ? new Response("boom", { status: 500 })
      : Response.json({ candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/png", data: "AAAA" } }, { text: "a cat" }] } }] });
  }) as typeof fetch;
  const req = new Request("http://local/generate-image", {
    method: "POST", headers: { Authorization: "Bearer user-jwt", "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return handleGenerateImageRequest(req, { admin: client, userClient: () => client, serviceRoleCallerUserId: async () => null })
    .then(async (res) => ({ res, json: await res.json(), calls }))
    .finally(() => { globalThis.fetch = realFetch; });
}

Deno.test("sync success: 200 { imageUrl, description } with rate-limit headers, nothing queued", async () => {
  const { res, json, calls } = await run({ prompt: "a cat" });
  assertEquals(res.status, 200);
  assertEquals(json, { imageUrl: "data:image/png;base64,AAAA", description: "a cat" });
  for (const h of ["X-RateLimit-Limit-Hour", "X-RateLimit-Limit-Day", "X-RateLimit-Remaining-Hour", "X-RateLimit-Remaining-Day"]) {
    assert(/^\d+$/.test(res.headers.get(h) ?? ""), `${h} present`);
  }
  assertEquals(calls.rpcs.filter(([n]) => n === "enqueue_ai_image_job").length, 0);
  assertEquals(calls.inserts.filter(([t]) => t === "ai_image_job_payloads").length, 0);
});
Deno.test("sync provider failure: 200 { success:false, error_code, message }", async () => {
  const { res, json } = await run({ prompt: "a cat" }, { googleOk: false });
  assertEquals(res.status, 200);
  assertEquals(json.success, false);
  assertEquals(json.error_code, "ai_not_configured");
  assert(String(json.message).includes("All image providers failed"));
});
Deno.test("no AI access: 403", async () => {
  const { res } = await run({ prompt: "a cat" }, { admin: false });
  assertEquals(res.status, 403);
});
Deno.test("invalid body: 400 before any provider call", async () => {
  const { res } = await run({ prompt: "" });
  assertEquals(res.status, 400);
});
```

- [ ] **Step 3: Run and typecheck.** `deno check` fails only on the two known errors (`handler.ts:268`, `:981`), which Task 3 fixes. Run `/f/Dev/Runtimes/deno-bin/bin/deno.exe test --node-modules-dir=none --allow-env --no-check supabase/functions/generate-image/` and expect PASS. Commit: `git commit -m "test(generate-image): pin the sync contract of the real handler" -- supabase/functions/generate-image/` (stage `handler.ts`, `handler.test.ts` and `index.ts`).

---

### Task 3: Failure mapping, one deadline, outcome classification, runner (B1, B2)

**Files:**
- Create: `generate-image/imageFailure.ts` (+ test), `generate-image/callBudget.ts` (+ test), `generate-image/runImageGeneration.ts` (+ test)
- Modify: `generate-image/handler.ts`, `_shared/higgsfield-mcp.ts`, `_shared/vercelGateway.ts` (+ `vercelGateway.test.ts`)

**Interfaces:**

```ts
// callBudget.ts
export interface CallBudget { deadlineMs: number; now(): number; signal(ms: number): AbortSignal }
export class NotEnoughTimeError extends Error {}
export const UNBOUNDED: (now?: () => number) => CallBudget;          // deadline = +Infinity (sync path)
/** Signal for one network call: min(capMs, time left). Throws NotEnoughTimeError before sending when time left < minMs.
 *  Returns undefined only when the deadline is unbounded AND capMs is undefined (today's no-timeout Google call). */
export function budgetSignal(b: CallBudget, minMs: number, capMs?: number): AbortSignal | undefined;
export function timeLeftMs(b: CallBudget): number;

// runImageGeneration.ts
export const PROVIDER_MIN_MS: Record<string, number> = { higgsfield: 45_000, openai: 45_000, google: 20_000, vercel: 20_000 };
export class ProviderOutcomeUnknownError extends Error {}
export function isDefinitiveHiggsfieldRejection(err: unknown): boolean;
export interface ImageJobInput { userId: string; prompt: string; requestedModel?: string; aspectRatio?: string; quality?: string;
  references: ReferenceInput[]; budget: CallBudget }
export type ImageRunResult =
  | { kind: "succeeded"; imageUrl: string; description: string; usedModel: ResolvedModel; credentialSource: "platform" | "byo"; attemptErrors: string[] }
  | { kind: "refused"; status: 402 | 429; message: string; errorCode: "ai_quota_exhausted" | "ai_rate_limited" }
  | { kind: "outcome_unknown"; message: string; usedModel: ResolvedModel; credentialSource: "platform" | "byo" }
  | { kind: "lease_lost" }
  | { kind: "failed"; message: string; attemptErrors: string[] };
export interface ImageRunDeps {
  onDispatch(): Promise<boolean>;
  resolveChain(requestedModel?: string): Promise<ResolvedModel[]>;
  getApiKey(m: ResolvedModel): Promise<string | null>;
  generateWithModel(m: ResolvedModel, apiKey: string, prompt: string, aspectRatio: string, references: ReferenceInput[], budget: CallBudget): Promise<{ imageUrl: string; description: string }>;
  resolveHiggsfieldCredential(userId: string): Promise<{ source: "platform" | "byo" }>;
  checkByoLimits(userId: string): Promise<{ allowed: boolean; error?: string }>;
  reserveQuota(userId: string): Promise<boolean>;
  releaseQuota(userId: string): Promise<void>;
  /** Throws ProviderOutcomeUnknownError when generate_image was sent and the outcome is not a definitive rejection. */
  generateWithHiggsfield(input: { m: ResolvedModel; cred: unknown; prompt: string; rawPrompt: string; aspectRatio?: string;
    references: ReferenceInput[]; userId: string; budget: CallBudget }): Promise<{ url: string; params: Record<string, unknown> }>;
  recordHiggsfieldSuccess(row: { userId: string; m: ResolvedModel; credentialSource: string; url: string; rawPrompt: string;
    params: Record<string, unknown>; reserved: boolean }): Promise<void>;
}
export function buildImagePrompt(prompt: string, references: ReferenceInput[], aspectRatio?: string, quality?: string): string;
export function defaultImageRunDeps(admin: any, o: Pick<ImageRunDeps, "onDispatch" | "recordHiggsfieldSuccess">): ImageRunDeps;
export async function runImageGeneration(deps: ImageRunDeps, job: ImageJobInput): Promise<ImageRunResult>;
export type { ResolvedModel };

// imageFailure.ts
export function describeImageFailure(errMsg: string): { code: string; message: string };
```

- [ ] **Step 1: `imageFailure.ts` (TDD).** Use the same test and code as the mapping at `handler.ts:1077-1107` (was `index.ts`). Move that block verbatim into `describeImageFailure`, keeping the branch order and copy (the `ai_not_configured` → `ai_gateway_error` → `ai_error` chain). The test covers every branch plus the `ai_error` default. Replace the block in the handler with `const { code: error_code, message } = describeImageFailure(errMsg); return jsonResponse({ success: false, error_code, message }, 200);`.

- [ ] **Step 2: `callBudget.ts` (TDD).**

```ts
// callBudget.test.ts
import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { budgetSignal, NotEnoughTimeError, timeLeftMs, UNBOUNDED, type CallBudget } from "./callBudget.ts";

const fake = (deadlineMs: number, t: { now: number }, seen: number[]): CallBudget =>
  ({ deadlineMs, now: () => t.now, signal: (ms) => { seen.push(ms); return new AbortController().signal; } });

Deno.test("signal is capped at the time left", () => {
  const seen: number[] = []; const t = { now: 0 };
  budgetSignal(fake(30_000, t, seen), 5_000, 50_000);
  assertEquals(seen, [30_000]);
});
Deno.test("signal is capped at capMs when more time is left", () => {
  const seen: number[] = []; const t = { now: 0 };
  budgetSignal(fake(100_000, t, seen), 5_000, 20_000);
  assertEquals(seen, [20_000]);
});
Deno.test("refuses before sending when less than minMs is left", () => {
  const t = { now: 96_000 };
  assertThrows(() => budgetSignal(fake(100_000, t, []), 5_000, 50_000), NotEnoughTimeError);
});
Deno.test("unbounded keeps today's behaviour", () => {
  assertEquals(budgetSignal(UNBOUNDED(), 5_000, undefined), undefined);
  assertEquals(timeLeftMs(UNBOUNDED()), Number.POSITIVE_INFINITY);
});
```

```ts
// callBudget.ts
/** One absolute deadline shared by every network call of one generation (worker: start + 140 s). */
export interface CallBudget { deadlineMs: number; now(): number; signal(ms: number): AbortSignal }
export class NotEnoughTimeError extends Error {}

export const UNBOUNDED = (now: () => number = Date.now): CallBudget =>
  ({ deadlineMs: Number.POSITIVE_INFINITY, now, signal: (ms) => AbortSignal.timeout(ms) });

export function timeLeftMs(b: CallBudget): number {
  return b.deadlineMs - b.now();
}

export function budgetSignal(b: CallBudget, minMs: number, capMs?: number): AbortSignal | undefined {
  const left = timeLeftMs(b);
  if (left < minMs) throw new NotEnoughTimeError(`not enough time left (${Math.max(0, Math.round(left))} ms) to start this call`);
  const ms = Math.min(capMs ?? Number.POSITIVE_INFINITY, left);
  return Number.isFinite(ms) ? b.signal(ms) : undefined;
}
```

- [ ] **Step 3: Shared providers.**
  - **`_shared/vercelGateway.ts:78`:** change the signature to `vercelGenerateImage(apiKey, modelId, prompt, aspectRatio, timeoutMs = 50_000)` and use `abortSignal: AbortSignal.timeout(timeoutMs)`. Extend `vercelGateway.test.ts` with one case: the default stays 50 s, and a passed value is used. Callers that pass nothing are unchanged.
  - **`_shared/higgsfield-mcp.ts`:**
    - `export class McpError extends Error { constructor(message: string, public readonly data?: unknown, public readonly outcome: "rejected" | "unknown" = "unknown") {...} }`.
    - Mark these as `"rejected"`:
      - `rpc` with `!res.ok` and `res.status` in 400-499 except 408;
      - `message.error` (JSON-RPC error);
      - `callToolOnce` `result.isError`;
      - "authorization failed and could not be refreshed";
      - the new pre-send deadline refusal.
    - These stay `"unknown"`: the timeout (`:164`), 408/5xx, and "returned no response".
    - Add `private deadlineMs = Number.POSITIVE_INFINITY;` and `withDeadline(ms: number): this { this.deadlineMs = ms; return this; }`.
    - In `post`, before `fetch`: `const left = this.deadlineMs - Date.now(); if (left < 5_000) throw new McpError("Not enough time left to call Higgsfield", undefined, "rejected");`. Use `signal: AbortSignal.timeout(Math.min(MCP_REQUEST_TIMEOUT_MS, left))`.
    - `generate-video` reads neither field, so its behaviour is unchanged.

- [ ] **Step 4: Write the failing runner test** `runImageGeneration.test.ts`. The B1 and B2 cases are marked.

```ts
// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { McpError } from "../_shared/higgsfield-mcp.ts";
import { HiggsfieldAuthError } from "../_shared/higgsfield-oauth.ts";
import {
  runImageGeneration, isDefinitiveHiggsfieldRejection, ProviderOutcomeUnknownError, PROVIDER_MIN_MS,
  type ImageRunDeps, type ResolvedModel,
} from "./runImageGeneration.ts";
import type { CallBudget } from "./callBudget.ts";

const google = { provider_code: "google", api_type: "google", model_id: "gemini-2.5-flash-image", api_endpoint: "https://g.invalid",
  api_key_env_var: "GOOGLE_AI_STUDIO_KEY", admin_params: {}, source: "primary" } as unknown as ResolvedModel;
const openai = { ...google, provider_code: "openai", api_type: "openai", model_id: "gpt-image-1" } as unknown as ResolvedModel;
const higgs = { ...google, provider_code: "higgsfield", api_type: "higgsfield", model_id: "hf-img" } as unknown as ResolvedModel;
const clock = { now: 0 };
const budget = (deadlineMs: number): CallBudget => ({ deadlineMs, now: () => clock.now, signal: () => new AbortController().signal });

function fakeDeps(over: Partial<ImageRunDeps> = {}) {
  const calls: string[] = [];
  const deps: ImageRunDeps = {
    onDispatch: async () => { calls.push("dispatch"); return true; },
    resolveChain: async () => [google],
    getApiKey: async () => "key",
    generateWithModel: async (m) => { calls.push(`gen:${m.model_id}`); return { imageUrl: "data:image/png;base64,AA", description: "d" }; },
    resolveHiggsfieldCredential: async () => ({ source: "platform" }),
    checkByoLimits: async () => ({ allowed: true }),
    reserveQuota: async () => { calls.push("reserve"); return true; },
    releaseQuota: async () => { calls.push("release"); },
    generateWithHiggsfield: async () => { calls.push("hf"); return { url: "https://hf.invalid/i.png", params: {} }; },
    recordHiggsfieldSuccess: async () => { calls.push("record"); },
    ...over,
  };
  return { deps, calls };
}
const job = (deadlineMs = Number.POSITIVE_INFINITY) => ({ userId: "u", prompt: "p", references: [], budget: budget(deadlineMs) });

Deno.test("first provider succeeds: one dispatch, no quota", async () => {
  clock.now = 0;
  const { deps, calls } = fakeDeps();
  assertEquals((await runImageGeneration(deps, job())).kind, "succeeded");
  assertEquals(calls, ["dispatch", "gen:gemini-2.5-flash-image"]);
});
Deno.test("B1: confirmed Higgsfield refusal refunds once and falls back", async () => {
  const { deps, calls } = fakeDeps({
    resolveChain: async () => [higgs, google],
    generateWithHiggsfield: async () => { calls.push("hf"); throw new McpError("rejected", undefined, "rejected"); },
  });
  assertEquals((await runImageGeneration(deps, job())).kind, "succeeded");
  assertEquals(calls, ["dispatch", "reserve", "hf", "release", "gen:gemini-2.5-flash-image"]);
});
Deno.test("B1: timeout after acceptance: one reserve, zero releases, no second provider", async () => {
  const { deps, calls } = fakeDeps({
    resolveChain: async () => [higgs, google],
    generateWithHiggsfield: async () => { calls.push("hf"); throw new ProviderOutcomeUnknownError("Higgsfield did not respond within 30s"); },
  });
  const r = await runImageGeneration(deps, job());
  assertEquals(r.kind, "outcome_unknown");
  assertEquals(calls, ["dispatch", "reserve", "hf"]);
});
Deno.test("B1: a produced image is returned even if its bookkeeping insert fails", async () => {
  const { deps, calls } = fakeDeps({ resolveChain: async () => [higgs], recordHiggsfieldSuccess: async () => { throw new Error("db"); } });
  assertEquals((await runImageGeneration(deps, job())).kind, "succeeded");
  assert(!calls.includes("release"));
});
Deno.test("B1: classification", () => {
  assert(isDefinitiveHiggsfieldRejection(new McpError("x", undefined, "rejected")));
  assert(isDefinitiveHiggsfieldRejection(new HiggsfieldAuthError("HIGGSFIELD_REAUTH_REQUIRED", "x")));
  assert(!isDefinitiveHiggsfieldRejection(new McpError("Higgsfield did not respond within 30s")));
  assert(!isDefinitiveHiggsfieldRejection(new TypeError("network")));
});
Deno.test("platform quota refused: 402 refusal, no provider call", async () => {
  const { deps, calls } = fakeDeps({ resolveChain: async () => [higgs], reserveQuota: async () => false });
  assertEquals(await runImageGeneration(deps, job()),
    { kind: "refused", status: 402, message: "Daily AI generation limit reached", errorCode: "ai_quota_exhausted" });
  assert(!calls.includes("hf"));
});
Deno.test("BYO limit refused before any dispatch", async () => {
  const { deps, calls } = fakeDeps({ resolveChain: async () => [higgs], resolveHiggsfieldCredential: async () => ({ source: "byo" }),
    checkByoLimits: async () => ({ allowed: false, error: "Too many BYO jobs" }) });
  assertEquals(await runImageGeneration(deps, job()), { kind: "refused", status: 429, message: "Too many BYO jobs", errorCode: "ai_rate_limited" });
  assertEquals(calls, []);
});
Deno.test("lost lease aborts before any billable call", async () => {
  const { deps, calls } = fakeDeps({ onDispatch: async () => false });
  assertEquals((await runImageGeneration(deps, job())).kind, "lease_lost");
  assertEquals(calls, []);
});
Deno.test("B2: a fallback that would start near the end is skipped", async () => {
  clock.now = 0;
  const { deps, calls } = fakeDeps({
    resolveChain: async () => [openai, google],
    generateWithModel: async (m) => { calls.push(`gen:${m.model_id}`); clock.now = 95_000; throw new Error("OpenAI 500"); },
  });
  const r = await runImageGeneration(deps, job(95_000 + PROVIDER_MIN_MS.google - 1));
  assertEquals(r.kind, "failed");
  assertEquals(calls, ["dispatch", "gen:gpt-image-1"]);
});
Deno.test("B2: the first candidate is skipped when its minimum does not fit", async () => {
  clock.now = 0;
  const { deps, calls } = fakeDeps({ resolveChain: async () => [openai, google] });
  await runImageGeneration(deps, job(PROVIDER_MIN_MS.openai - 1));
  assertEquals(calls, ["dispatch", "gen:gemini-2.5-flash-image"]);
});
Deno.test("every candidate failing reports today's message", async () => {
  clock.now = 0;
  const { deps } = fakeDeps({ getApiKey: async () => null });
  const r = await runImageGeneration(deps, job());
  assert(r.kind === "failed" && r.message.startsWith("All image providers failed. Attempts: "));
});
```

Also add `Deno.test("B2: slow references: the Google signal is taken after they are read", ...)`. It calls the exported `generateWithModel` from `runImageGeneration.ts` directly. Set `globalThis.fetch` to a stub that, for the reference URL, sets `clock.now = 30_000` and answers a 1×1 PNG, and for `:generateContent` answers the inline-image JSON from Task 2. Use a `CallBudget` whose `signal(ms)` pushes `ms`, with `deadlineMs = 100_000`. Assert that the pushed values are `[20_000, 70_000]`: the reference cap first, then the time left *after* the reference. Restore `fetch` in `finally`.

- [ ] **Step 5: Create `runImageGeneration.ts` by moving code from `handler.ts`.**

Move these blocks verbatim (the line numbers are the old `index.ts` ones and are unchanged in `handler.ts` after Task 2):
- `ResolvedModel` and `HARDCODED_FALLBACK` (`:50-75`);
- the model lookup and `resolveModelChain` / `getProviderApiKey` (`:76-180`);
- the reference helpers (`:184-380`);
- the providers (`:382-484`).

Edits allowed while moving:
- `readReferenceBytes`: `const bytes = await readBoundedBody(resp); return { mimeType, base64: base64Encode(new Uint8Array(bytes).buffer) };` (type fix).
- `fetchReference(url, budget)` uses `signal: budgetSignal(budget, 2_000, REFERENCE_FETCH_TIMEOUT_MS)` in place of its fixed timeout. `readReferenceBytes`, `stageReferenceUrl` and `importReferences` take and forward `budget`.
- `callOpenAIImages(m, apiKey, prompt, aspectRatio, budget)` uses `signal: budgetSignal(budget, PROVIDER_MIN_MS.openai, 230_000)` in place of its `AbortController` and `setTimeout`.
- `callGoogleGenerateContent(m, apiKey, prompt, aspectRatio, references, budget)` reads the references first (forwarding `budget`), **then** computes `signal: budgetSignal(budget, PROVIDER_MIN_MS.google)`. On the sync path that is `undefined`, the same as today.
- `generateWithModel(m, apiKey, prompt, aspectRatio, references, budget)` passes `budget` on, and calls Vercel with `vercelGenerateImage(apiKey, m.model_id, prompt, aspectRatio, Math.min(50_000, Math.max(0, timeLeftMs(budget))))` after `budgetSignal(budget, PROVIDER_MIN_MS.vercel)` (the pre-send check). Export `generateWithModel` for the slow-reference test.
- `buildImagePrompt` is `handler.ts:849-883`, moved verbatim and returning `fullPrompt`.

`defaultImageRunDeps(admin, o)` wires the real implementations: `reserveQuota` (as `:909-911`), `releaseQuota`, `resolveChain`, `getApiKey`, `checkByoLimits`, `resolveHiggsfieldCredential`, and `generateWithHiggsfield`. The last one is the body of `:915-950`:
- `HiggsfieldMcpClient.fromCredential(cred, admin).withDeadline(budget.deadlineMs)`;
- every step before `callTool('generate_image', ...)` throws through unchanged (not sent, so it is a refusal);
- the `generate_image` call and `findOutputUrl` are wrapped as follows;
- staging cleanup (`:960-967`) runs in `finally`, raced against `Math.max(1_000, Math.min(5_000, timeLeftMs(budget)))` ms. A cleanup that does not finish in time is logged and left to the bucket.

```ts
      let payload: unknown;
      try {
        payload = await mcp.callTool("generate_image", { params: { model: m.model_id, prompt, ...params, ...(medias ? { medias } : {}) } });
      } catch (err) {
        if (isDefinitiveHiggsfieldRejection(err)) throw err;
        throw new ProviderOutcomeUnknownError(`Higgsfield did not confirm the generation: ${err instanceof Error ? err.message : String(err)}`);
      }
      const generatedUrl = findOutputUrl(payload);
      // Accepted but no URL: a job may still be running (and billing) upstream.
      if (!generatedUrl) throw new ProviderOutcomeUnknownError("Higgsfield accepted the request but returned no image URL");
      return { url: generatedUrl, params };
```

```ts
export function isDefinitiveHiggsfieldRejection(err: unknown): boolean {
  return err instanceof HiggsfieldAuthError || (err instanceof McpError && err.outcome === "rejected") || err instanceof NotEnoughTimeError;
}
```

The runner:

```ts
export async function runImageGeneration(deps: ImageRunDeps, job: ImageJobInput): Promise<ImageRunResult> {
  const fullPrompt = buildImagePrompt(job.prompt, job.references, job.aspectRatio, job.quality);
  const chain = await deps.resolveChain(job.requestedModel);
  console.log("[generate-image] resolved model chain:", chain.map((c) => `${c.source}:${c.provider_code}/${c.model_id}`).join(" → "));
  const attemptErrors: string[] = [];
  let dispatched = false;
  const dispatchOnce = async () => (dispatched ||= await deps.onDispatch());
  const record = (m: ResolvedModel, err: unknown) => {
    const msg = `[${m.source}] ${m.provider_code}/${m.model_id}: ${err instanceof Error ? err.message : String(err)}`;
    console.error(msg);
    attemptErrors.push(msg);
  };

  for (const m of chain) {
    const isHiggsfield = m.provider_code === "higgsfield" || m.api_type === "higgsfield";
    const minMs = PROVIDER_MIN_MS[isHiggsfield ? "higgsfield" : m.provider_code] ?? 20_000;
    if (timeLeftMs(job.budget) < minMs) {
      attemptErrors.push(`[deadline] not enough time left for ${m.provider_code}/${m.model_id}`);
      continue;
    }
    if (isHiggsfield) {
      let cred: { source: "platform" | "byo" };
      try {
        cred = await deps.resolveHiggsfieldCredential(job.userId);
      } catch (err) {
        record(m, err);
        continue;
      }
      if (cred.source === "byo") {
        const byo = await deps.checkByoLimits(job.userId);
        if (!byo.allowed) return { kind: "refused", status: 429, message: byo.error ?? "Rate limit exceeded", errorCode: "ai_rate_limited" };
      }
      if (!(await dispatchOnce())) return { kind: "lease_lost" };
      let reserved = false;
      if (cred.source === "platform") {
        if (!(await deps.reserveQuota(job.userId))) {
          return { kind: "refused", status: 402, message: "Daily AI generation limit reached", errorCode: "ai_quota_exhausted" };
        }
        reserved = true;
      }
      let out: { url: string; params: Record<string, unknown> };
      try {
        out = await deps.generateWithHiggsfield({ m, cred, prompt: fullPrompt, rawPrompt: job.prompt, aspectRatio: job.aspectRatio,
          references: job.references, userId: job.userId, budget: job.budget });
      } catch (err) {
        if (err instanceof ProviderOutcomeUnknownError) {
          // Possibly billed upstream: no refund and no fallback (a second image could follow).
          console.error(`[generate-image] ${m.model_id}: outcome unknown, not refunded:`, err.message);
          return { kind: "outcome_unknown", message: err.message, usedModel: m, credentialSource: cred.source };
        }
        if (reserved) await deps.releaseQuota(job.userId);
        record(m, err);
        continue;
      }
      try {
        await deps.recordHiggsfieldSuccess({ userId: job.userId, m, credentialSource: cred.source, url: out.url,
          rawPrompt: job.prompt, params: out.params, reserved });
      } catch (err) {
        console.error("[generate-image] could not record the Higgsfield job row:", err instanceof Error ? err.message : err);
      }
      return { kind: "succeeded", imageUrl: out.url, description: `Generated with Higgsfield ${m.model_id}`, usedModel: m,
        credentialSource: cred.source, attemptErrors };
    }
    const apiKey = await deps.getApiKey(m);
    if (!apiKey) {
      const msg = `[${m.source}] ${m.provider_code}/${m.model_id}: missing ${m.api_key_env_var}`;
      console.warn(msg);
      attemptErrors.push(msg);
      continue;
    }
    if (!(await dispatchOnce())) return { kind: "lease_lost" };
    try {
      console.log(`[generate-image] attempt ${m.source} ${m.provider_code}/${m.model_id}`);
      // Platform-key providers reserve no user quota and a timed-out reply is discarded, so falling
      // back costs only the platform; the user never sees two images.
      const result = await deps.generateWithModel(m, apiKey, fullPrompt, job.aspectRatio ?? "", job.references, job.budget);
      return { kind: "succeeded", imageUrl: result.imageUrl, description: result.description, usedModel: m, credentialSource: "platform", attemptErrors };
    } catch (err) {
      record(m, err);
    }
  }
  return { kind: "failed", message: `All image providers failed. Attempts: ${attemptErrors.join(" | ")}`, attemptErrors };
}
```

`aspectRatio ?? ""` gives the same runtime behaviour for each provider (`OPENAI_SIZE_MAP[""]` uses the default, the Google guard is falsy, the Vercel regex fails) and fixes the `:981` type error.

- [ ] **Step 6: Rewire the sync handler.** Replace `handler.ts:849-997` with the following. The success logging and response at `:999-1038` stay unchanged.

```ts
    const run = await runImageGeneration(
      defaultImageRunDeps(supabaseAdmin, {
        onDispatch: async () => true,
        recordHiggsfieldSuccess: async (row) => {
          const { error: jobError } = await supabaseAdmin.from('ai_generation_jobs').insert({
            user_id: row.userId, provider: 'higgsfield', model_id: row.m.model_id, modality: 'image',
            credential_source: row.credentialSource, status: 'succeeded', result_url: row.url,
            params: { prompt: row.rawPrompt, ...row.params, reservation: row.reserved },
          });
          if (jobError) throw jobError;
        },
      }),
      { userId: user.id, prompt, requestedModel, aspectRatio, quality, references, budget: UNBOUNDED() },
    );
    if (run.kind === 'refused') return errorResponse(run.message, run.status);
    if (run.kind === 'outcome_unknown') {
      return jsonResponse({ success: false, error_code: 'ai_outcome_unknown',
        message: 'The image provider did not confirm the result. Check your Higgsfield history before trying again.' }, 200);
    }
    if (run.kind !== 'succeeded') throw new Error(run.kind === 'failed' ? run.message : 'lease lost');
    const { imageUrl, description, usedModel, attemptErrors } = run;
```

- [ ] **Step 7: Verify.** `cd /f/Dev/Worktrees/Postora_new/background-workers && D=/f/Dev/Runtimes/deno-bin/bin/deno.exe && $D check --node-modules-dir=none supabase/functions/generate-image/index.ts supabase/functions/generate-video/index.ts && $D test --node-modules-dir=none --allow-env supabase/functions/generate-image/ supabase/functions/_shared/vercelGateway.test.ts supabase/functions/n8n-api/serviceProxy.test.ts`. Expect 0 type errors and all green. **`handler.test.ts` from Task 2 passes unchanged.**
- [ ] **Step 8: Commit** `git commit -m "refactor(generate-image): one runner, one deadline, no refund on an unknown outcome" -- supabase/functions/generate-image/ supabase/functions/_shared/higgsfield-mcp.ts supabase/functions/_shared/vercelGateway.ts supabase/functions/_shared/vercelGateway.test.ts` (stage the new files first).

---

### Task 4: The async path in `generate-image` (B4, B8)

**Files:** Create `generate-image/asyncJob.ts` (+ test); modify `generate-image/handler.ts`, `generate-image/handler.test.ts`.

**Interfaces:**

```ts
export function buildEnqueueArgs(userId: string, input: { prompt: string; requestedModel?: string; aspectRatio?: string; quality?: string },
  references: ReferenceInput[]): { p_user_id: string; p_model_id: string | null; p_params: Record<string, unknown>; p_references: ReferenceInput[] };
export async function kickAiImageWorker(fetchFn: typeof fetch, supabaseUrl: string, serviceRoleKey: string): Promise<void>;
export const KICK_TIMEOUT_MS = 10_000;
```

- [ ] **Step 1: Write the failing test.**

```ts
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildEnqueueArgs, kickAiImageWorker } from "./asyncJob.ts";

Deno.test("enqueue args carry scalars and the https reference URLs only (B8)", () => {
  const refs = [{ url: "data:image/png;base64,AAAA", type: "style", priority: 1 }, { url: "https://cdn.example/a.png", type: "content", priority: 2 }];
  assertEquals(buildEnqueueArgs("u1", { prompt: "cat", aspectRatio: "16:9" }, refs), {
    p_user_id: "u1", p_model_id: null,
    p_params: { prompt: "cat", aspectRatio: "16:9", quality: null, requestedModel: null, reference_urls: ["https://cdn.example/a.png"] },
    p_references: refs,
  });
});
Deno.test("kick posts to the worker with the service-role bearer and a timeout", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fake = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response("{}", { status: 202 }); }) as typeof fetch;
  await kickAiImageWorker(fake, "https://api.example.invalid/", "srk");
  assertEquals(seen!.url, "https://api.example.invalid/functions/v1/ai-image-worker");
  assertEquals((seen!.init.headers as Record<string, string>).Authorization, "Bearer srk");
  assertEquals(seen!.init.signal instanceof AbortSignal, true);
});
```

- [ ] **Step 2: Implement.**

```ts
import type { ReferenceInput } from "../_shared/image-references.ts";

export const KICK_TIMEOUT_MS = 10_000;

export function buildEnqueueArgs(
  userId: string,
  input: { prompt: string; requestedModel?: string; aspectRatio?: string; quality?: string },
  references: ReferenceInput[],
) {
  return {
    p_user_id: userId,
    p_model_id: input.requestedModel ?? null,
    p_params: {
      prompt: input.prompt,
      aspectRatio: input.aspectRatio ?? null,
      quality: input.quality ?? null,
      requestedModel: input.requestedModel ?? null,
      // Non-terminal job params are scanned by the media-retention sweep, so a queued
      // job's library references stay protected until the worker has read them.
      reference_urls: references.map((r) => r.url).filter((u) => !u.startsWith("data:")),
    },
    p_references: references,
  };
}

/** The worker answers 202 at once; cron is the safety net if this kick is lost. */
export async function kickAiImageWorker(fetchFn: typeof fetch, supabaseUrl: string, serviceRoleKey: string): Promise<void> {
  const resp = await fetchFn(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/ai-image-worker`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(KICK_TIMEOUT_MS),
  });
  await resp.body?.cancel();
  if (!resp.ok) console.warn(`[generate-image] ai-image-worker kick answered ${resp.status}; cron will pick the job up`);
}
```

- [ ] **Step 3: Wire it into the handler.**
  - Add `async: z.boolean().optional(),` to `GenerateImageSchema` and destructure it as `async: wantsAsync`.
  - After `const references = collectReferences(...)`, insert:

```ts
    if (wantsAsync === true) {
      const { data: jobId, error: queueError } = await supabaseAdmin.rpc('enqueue_ai_image_job',
        buildEnqueueArgs(user.id, { prompt, requestedModel, aspectRatio, quality }, references));
      if (queueError || typeof jobId !== 'string') throw queueError ?? new Error('could not queue the image job');
      await runInBackground('kick ai-image-worker', () =>
        kickAiImageWorker(fetch, Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''));
      return new Response(JSON.stringify({ success: true, jobId, status: 'queued' }), {
        status: 202,
        headers: {
          ...corsHeaders, 'Content-Type': 'application/json',
          'X-RateLimit-Limit-Hour': String(rateLimitResult.limitHour),
          'X-RateLimit-Limit-Day': String(rateLimitResult.limitDay),
          'X-RateLimit-Remaining-Hour': String(Math.max(0, rateLimitResult.remainingHour - 1)),
          'X-RateLimit-Remaining-Day': String(Math.max(0, rateLimitResult.remainingDay - 1)),
        },
      });
    }
```

  - Imports: `buildEnqueueArgs` and `kickAiImageWorker` from `./asyncJob.ts`, and `runInBackground` from `../_shared/background.ts`.
  - Add an async case to `handler.test.ts`. The fake `rpc` answers `enqueue_ai_image_job` with `{ data: "job-1", error: null }`, and `fetch` answers the worker URL with 202. Assert a 202 body `{ success: true, jobId: "job-1", status: "queued" }`, exactly one `enqueue_ai_image_job` RPC, and no `:generateContent` fetch.
- [ ] **Step 4: Verify and commit.** Run the Task 3 Step 7 commands; expect green. `git commit -m "feat(generate-image): async:true queues a background image job" -- supabase/functions/generate-image/`.

---

### Task 5: `ai-image-worker`

**Files:** Create `supabase/functions/ai-image-worker/{worker.ts,worker.test.ts,deps.ts,index.ts}`; modify `supabase/config.toml`.

**Interfaces:**

```ts
export const AI_IMAGE_WORKER_LIMITS = {
  lease: "3 minutes", tickBudgetMs: 50_000, workerLifetimeMs: 150_000, saveReserveMs: 10_000,
  minRemainingToClaimMs: 100_000, maxRunningPerUser: 2,
} as const;  // job deadline = workerStartedAtMs + workerLifetimeMs - saveReserveMs (140 s)
export interface ClaimedImageJob { id: string; user_id: string; claim_token: string; params: Record<string, unknown> }
export interface ImageJobCompletion { jobId: string; claimToken: string; status: "succeeded" | "failed"; resultUrl: string | null;
  resultDataUrl: string | null; error: string | null; provider: string | null; modelId: string | null; credentialSource: string | null;
  params: Record<string, unknown> }
export interface AiImageWorkerPorts {
  now(): number;
  workerStartedAtMs: number;
  claim(limit: number, lease: string, maxPerUser: number): Promise<ClaimedImageJob[]>;
  loadReferences(jobId: string): Promise<ReferenceInput[]>;          // throws if the payload row is missing
  markDispatched(jobId: string, claimToken: string): Promise<boolean>;
  run(job: ImageJobInput, onDispatch: () => Promise<boolean>): Promise<ImageRunResult>;
  complete(c: ImageJobCompletion): Promise<boolean>;
  log(level: "info" | "error", userId: string, message: string, metadata: Record<string, unknown>): Promise<void>;
}
export interface AiImageWorkerSummary { claimed: number; succeeded: number; failed: number; lost: number; stoppedForLifetime: boolean }
export async function runAiImageWorker(ports: AiImageWorkerPorts): Promise<AiImageWorkerSummary>;
export function completionFor(job: ClaimedImageJob, r: ImageRunResult | { kind: "threw"; message: string }): ImageJobCompletion | null;
```

- [ ] **Step 1: Write the failing `worker.test.ts`.**

```ts
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runAiImageWorker, completionFor, AI_IMAGE_WORKER_LIMITS as L, type AiImageWorkerPorts, type ClaimedImageJob } from "./worker.ts";

const job: ClaimedImageJob = { id: "j1", user_id: "u1", claim_token: "t1", params: { worker: true, prompt: "cat", aspectRatio: "1:1" } };
const model = { provider_code: "google", model_id: "gemini-2.5-flash-image", source: "primary" } as never;

function ports(over: Partial<AiImageWorkerPorts> = {}, queue: ClaimedImageJob[] = [job]) {
  const completed: unknown[] = []; const claims: unknown[][] = [];
  const p: AiImageWorkerPorts = {
    now: () => 0, workerStartedAtMs: 0,
    claim: async (...args) => { claims.push(args); const n = queue.shift(); return n ? [n] : []; },
    loadReferences: async () => [],
    markDispatched: async () => true,
    run: async (_j, onDispatch) => { await onDispatch();
      return { kind: "succeeded", imageUrl: "data:image/png;base64,AA", description: "d", usedModel: model, credentialSource: "platform", attemptErrors: [] }; },
    complete: async (c) => { completed.push(c); return true; },
    log: async () => {},
    ...over,
  };
  return { p, completed, claims };
}

Deno.test("data: result goes to result_data_url; placeholders are overwritten", async () => {
  const { p, completed, claims } = ports();
  assertEquals((await runAiImageWorker(p)).succeeded, 1);
  assertEquals(claims[0], [1, L.lease, L.maxRunningPerUser]);
  assertEquals(completed[0], { jobId: "j1", claimToken: "t1", status: "succeeded", resultUrl: null, resultDataUrl: "data:image/png;base64,AA",
    error: null, provider: "google", modelId: "gemini-2.5-flash-image", credentialSource: "platform",
    params: { description: "d", chain_source: "primary", error_code: null } });
});
Deno.test("https result goes to result_url", () => {
  const c = completionFor(job, { kind: "succeeded", imageUrl: "https://hf.invalid/i.png", description: "", usedModel: model, credentialSource: "byo", attemptErrors: [] });
  assertEquals([c!.resultUrl, c!.resultDataUrl, c!.credentialSource], ["https://hf.invalid/i.png", null, "byo"]);
});
Deno.test("refusal and unknown outcome fail with their codes", () => {
  assertEquals(completionFor(job, { kind: "refused", status: 402, message: "Daily AI generation limit reached", errorCode: "ai_quota_exhausted" })!.params.error_code, "ai_quota_exhausted");
  const u = completionFor(job, { kind: "outcome_unknown", message: "x", usedModel: model, credentialSource: "platform" })!;
  assertEquals([u.status, u.params.error_code, u.provider], ["failed", "ai_outcome_unknown", "google"]);
});
Deno.test("a thrown run (including a missing payload) fails through describeImageFailure", async () => {
  const { p, completed } = ports({ loadReferences: async () => { throw new Error("payload missing for j1"); } });
  await runAiImageWorker(p);
  assertEquals((completed[0] as { status: string }).status, "failed");
});
Deno.test("lease lost or a stale token writes nothing", async () => {
  assertEquals((await runAiImageWorker(ports({ run: async () => ({ kind: "lease_lost" }) }).p)).lost, 1);
  assertEquals((await runAiImageWorker(ports({ complete: async () => false }).p)).lost, 1);
});
Deno.test("onDispatch stamps the claimed token", async () => {
  const seen: string[] = [];
  await runAiImageWorker(ports({ markDispatched: async (id, tok) => { seen.push(`${id}:${tok}`); return true; } }).p);
  assertEquals(seen, ["j1:t1"]);
});
Deno.test("a spent worker claims nothing", async () => {
  const { p, claims } = ports({ workerStartedAtMs: -60_000 });
  assertEquals((await runAiImageWorker(p)).stoppedForLifetime, true);
  assertEquals(claims.length, 0);
});
Deno.test("job deadline leaves the save reserve", async () => {
  let deadline = 0;
  await runAiImageWorker(ports({ run: async (j) => { deadline = j.budget.deadlineMs; return { kind: "lease_lost" }; } }).p);
  assertEquals(deadline, L.workerLifetimeMs - L.saveReserveMs);
});
```

- [ ] **Step 2: Implement `worker.ts`.**

```ts
// Background image generation worker. Decisions live here; deps.ts adapts them to Postgres.
import { redactProviderError } from "../_shared/ai-routing-errors.ts";
import { describeImageFailure } from "../generate-image/imageFailure.ts";
import type { CallBudget } from "../generate-image/callBudget.ts";
import type { ImageJobInput, ImageRunResult } from "../generate-image/runImageGeneration.ts";
import type { ReferenceInput } from "../_shared/image-references.ts";

export const AI_IMAGE_WORKER_LIMITS = {
  lease: "3 minutes",            // > workerLifetimeMs: a live worker never loses its lease
  tickBudgetMs: 50_000,
  workerLifetimeMs: 150_000,     // edge runtime workerTimeoutMs
  saveReserveMs: 10_000,         // time kept back to write the result
  minRemainingToClaimMs: 100_000,
  maxRunningPerUser: 2,          // enforced atomically by claim_ai_image_jobs
} as const;

// ...interfaces as in the Interfaces block...

const asText = (v: unknown) => (typeof v === "string" ? v : undefined);

export function completionFor(job: ClaimedImageJob, r: ImageRunResult | { kind: "threw"; message: string }): ImageJobCompletion | null {
  const base = { jobId: job.id, claimToken: job.claim_token, resultUrl: null, resultDataUrl: null, provider: null, modelId: null, credentialSource: null };
  switch (r.kind) {
    case "lease_lost":
      return null;
    case "succeeded": {
      const inline = r.imageUrl.startsWith("data:");
      return { ...base, status: "succeeded", error: null, resultUrl: inline ? null : r.imageUrl, resultDataUrl: inline ? r.imageUrl : null,
        provider: r.usedModel.provider_code, modelId: r.usedModel.model_id, credentialSource: r.credentialSource,
        params: { description: r.description, chain_source: r.usedModel.source, error_code: null } };
    }
    case "refused":
      return { ...base, status: "failed", error: r.message, params: { error_code: r.errorCode } };
    case "outcome_unknown":
      return { ...base, status: "failed", provider: r.usedModel.provider_code, modelId: r.usedModel.model_id, credentialSource: r.credentialSource,
        error: "The image provider did not confirm the result. Check your Higgsfield history before trying again.",
        params: { error_code: "ai_outcome_unknown" } };
    default: {
      const { code, message } = describeImageFailure(r.message);
      return { ...base, status: "failed", error: redactProviderError(message, ""), params: { error_code: code } };
    }
  }
}

export async function runAiImageWorker(ports: AiImageWorkerPorts): Promise<AiImageWorkerSummary> {
  const L = AI_IMAGE_WORKER_LIMITS;
  const tickStartedAt = ports.now();
  const deadlineMs = ports.workerStartedAtMs + L.workerLifetimeMs - L.saveReserveMs;
  const budget: CallBudget = { deadlineMs, now: () => ports.now(), signal: (ms) => AbortSignal.timeout(ms) };
  const summary: AiImageWorkerSummary = { claimed: 0, succeeded: 0, failed: 0, lost: 0, stoppedForLifetime: false };

  while (ports.now() - tickStartedAt < L.tickBudgetMs) {
    if (ports.workerStartedAtMs + L.workerLifetimeMs - ports.now() < L.minRemainingToClaimMs) {
      summary.stoppedForLifetime = true;
      break;
    }
    const [job] = await ports.claim(1, L.lease, L.maxRunningPerUser);
    if (!job) break;
    summary.claimed++;

    let result: ImageRunResult | { kind: "threw"; message: string };
    try {
      const input: ImageJobInput = {
        userId: job.user_id, prompt: asText(job.params.prompt) ?? "", requestedModel: asText(job.params.requestedModel),
        aspectRatio: asText(job.params.aspectRatio), quality: asText(job.params.quality),
        references: await ports.loadReferences(job.id), budget,
      };
      result = await ports.run(input, () => ports.markDispatched(job.id, job.claim_token));
    } catch (error) {
      result = { kind: "threw", message: error instanceof Error ? error.message : String(error) };
    }

    const completion = completionFor(job, result);
    if (!completion || !(await ports.complete(completion))) {
      summary.lost++;
      console.warn(`[ai-image-worker] job ${job.id}: lease lost, result not written`);
      continue;
    }
    if (completion.status === "succeeded") summary.succeeded++; else summary.failed++;
    await ports.log(completion.status === "succeeded" ? "info" : "error", job.user_id,
      completion.status === "succeeded"
        ? `Image generated using ${completion.provider}/${completion.modelId} (background)`
        : `Image generation failed: ${completion.error}`,
      { feature: "image_generation", async: true, job_id: job.id, error_code: completion.params.error_code ?? null,
        success: completion.status === "succeeded" });
  }
  return summary;
}
```

- [ ] **Step 3: `deps.ts`** (the real ports; the SQL proof covers the RPCs).

```ts
import { defaultImageRunDeps, runImageGeneration } from "../generate-image/runImageGeneration.ts";
import type { AiImageWorkerPorts, ClaimedImageJob } from "./worker.ts";

// deno-lint-ignore no-explicit-any
export function createAiImageWorkerPorts(admin: any, workerStartedAtMs: number): AiImageWorkerPorts {
  const nowIso = () => new Date().toISOString();
  return {
    now: () => Date.now(),
    workerStartedAtMs,
    async claim(limit, lease, maxPerUser) {
      const { data, error } = await admin.rpc("claim_ai_image_jobs", { p_limit: limit, p_lease: lease, p_max_per_user: maxPerUser });
      if (error) throw new Error(`claim_ai_image_jobs: ${error.message}`);
      return (data ?? []) as ClaimedImageJob[];
    },
    async loadReferences(jobId) {
      const { data, error } = await admin.from("ai_image_job_payloads").select("reference_images").eq("job_id", jobId).maybeSingle();
      if (error) throw new Error(`load payload: ${error.message}`);
      if (!data) throw new Error(`payload missing for ${jobId}`);
      return data.reference_images ?? [];
    },
    async markDispatched(jobId, claimToken) {
      const { data, error } = await admin.from("ai_generation_jobs")
        .update({ dispatched_at: nowIso(), updated_at: nowIso() })
        .eq("id", jobId).eq("claim_token", claimToken).eq("status", "running").is("dispatched_at", null)
        .select("id");
      return !error && (data?.length ?? 0) === 1;
    },
    run: (job, onDispatch) => runImageGeneration(defaultImageRunDeps(admin, { onDispatch, recordHiggsfieldSuccess: async () => {} }), job),
    async complete(c) {
      const { data, error } = await admin.rpc("complete_ai_image_job", {
        p_job_id: c.jobId, p_claim_token: c.claimToken, p_status: c.status, p_result_url: c.resultUrl,
        p_result_data_url: c.resultDataUrl, p_error: c.error, p_provider: c.provider, p_model_id: c.modelId,
        p_credential_source: c.credentialSource, p_params: c.params,
      });
      if (error) throw new Error(`complete_ai_image_job: ${error.message}`);
      return data === true;
    },
    async log(level, userId, message, metadata) {
      const { error } = await admin.from("system_logs").insert({ level, category: "ai", source: "generate-image", message, user_id: userId, metadata });
      if (error) console.error("[ai-image-worker] system_logs insert failed:", error.message);
    },
  };
}
```

Why `recordHiggsfieldSuccess` is a no-op here: the job row itself is completed with `credential_source`, so a second `succeeded` row would double-count the BYO hourly limit.

What happens when `complete` throws (DB down): the error propagates out of the tick and the lease expires. The job is then failed as `ai_interrupted` and never re-run. The image is lost and quota is not refunded, which is accepted under Risks.

- [ ] **Step 4: Door `index.ts`.**

```ts
// Background image generation worker. Cron (every minute) and generate-image's kick call it.
// The door only authenticates and answers 202; the tick runs in waitUntil so neither pg_net's
// timeout nor the gateway's ~60 s response limit can cut a generation. Decisions live in worker.ts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { runInBackground } from "../_shared/background.ts";
import { createAiImageWorkerPorts } from "./deps.ts";
import { runAiImageWorker } from "./worker.ts";

const WORKER_STARTED_AT_MS = Date.now();
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const cronAuth = verifyCronAuth(req);
  if (!cronAuth.ok) return cronAuth.response;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  await runInBackground("ai-image-worker tick", async () => {
    const summary = await runAiImageWorker(createAiImageWorkerPorts(admin, WORKER_STARTED_AT_MS));
    console.log("[ai-image-worker] tick", JSON.stringify(summary));
  });
  return new Response(JSON.stringify({ success: true, accepted: true }), {
    status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
```

- [ ] **Step 5: `config.toml`.** After `[functions.process-store-events]` (`:56-58`) add:

```toml
# Cron and generate-image's service-role kick call it; verifyCronAuth is the gate.
[functions.ai-image-worker]
verify_jwt = false
```

- [ ] **Step 6: Verify and commit.** `$D check --node-modules-dir=none supabase/functions/ai-image-worker/index.ts && $D test --node-modules-dir=none --allow-env supabase/functions/ai-image-worker/`, then `git commit -m "feat(ai-image-worker): claim, run and fence background image jobs" -- supabase/functions/ai-image-worker supabase/config.toml`.

---

### Task 6: `ai-generation-status` reads and short-circuit (B3)

**Files:** Create `ai-generation-status/workerImageJob.ts` (+ test); modify `ai-generation-status/index.ts`.

**Interfaces:**

```ts
export const WORKER_IMAGE_POLL_SECONDS = 3;
export type OwnedJobRead = { kind: "found"; job: any } | { kind: "missing" } | { kind: "error"; message: string };
export async function loadOwnedJob(db: any, jobId: unknown, userId: string): Promise<OwnedJobRead>;
export function isWorkerImageJob(job: { modality: string; params: unknown }): boolean;
export async function answerWorkerImageJob(db: any, job: any): Promise<{ status: number; body: Record<string, unknown> }>;
export const RETRYABLE_READ_BODY = { success: false, retryable: true, error: "Could not read the generation status. Retrying." };
```

- [ ] **Step 1: Write the failing test.** A fake client returns the configured `{ data, error }` for each table.

```ts
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { answerWorkerImageJob, isWorkerImageJob, loadOwnedJob, RETRYABLE_READ_BODY } from "./workerImageJob.ts";

const db = (tables: Record<string, { data: unknown; error: unknown }>) => ({
  from: (t: string) => {
    const b: any = { select: () => b, eq: () => b, maybeSingle: () => Promise.resolve(tables[t]) };
    return b;
  },
});
const row = (o: Record<string, unknown> = {}) =>
  ({ id: "j1", modality: "image", status: "queued", params: { worker: true }, result_url: null, error: null, ...o });

Deno.test("B3: a failed job read is an error, not a missing job", async () => {
  assertEquals((await loadOwnedJob(db({ ai_generation_jobs: { data: null, error: { message: "timeout" } } }), "j1", "u")).kind, "error");
  assertEquals((await loadOwnedJob(db({ ai_generation_jobs: { data: null, error: null } }), "j1", "u")).kind, "missing");
  assertEquals((await loadOwnedJob(db({ ai_generation_jobs: { data: row(), error: null } }), "j1", "u")).kind, "found");
});
Deno.test("B3: a non-string jobId is missing without a query", async () => {
  assertEquals((await loadOwnedJob(db({}), 42, "u")).kind, "missing");
});
Deno.test("B3: a failed payload read is a retryable 503, never 'expired'", async () => {
  const a = await answerWorkerImageJob(db({ ai_image_job_payloads: { data: null, error: { message: "conn reset" } } }), row({ status: "succeeded" }));
  assertEquals(a, { status: 503, body: RETRYABLE_READ_BODY });
});
Deno.test("succeeded: inline data URL, hosted URL, or a real expiry", async () => {
  const inline = await answerWorkerImageJob(db({ ai_image_job_payloads: { data: { result_data_url: "data:image/png;base64,AA" }, error: null } }), row({ status: "succeeded" }));
  assertEquals(inline.body.imageUrl, "data:image/png;base64,AA");
  const hosted = await answerWorkerImageJob(db({}), row({ status: "succeeded", result_url: "https://h/i.png", params: { worker: true, description: "d" } }));
  assertEquals(hosted, { status: 200, body: { success: true, status: "succeeded", imageUrl: "https://h/i.png", url: "https://h/i.png", description: "d" } });
  const gone = await answerWorkerImageJob(db({ ai_image_job_payloads: { data: { result_data_url: null }, error: null } }), row({ status: "succeeded" }));
  assertEquals(gone.body.errorCode, "ai_result_expired");
});
Deno.test("queued/running poll every 3 s; failed carries errorCode", async () => {
  assertEquals((await answerWorkerImageJob(db({}), row())).body, { success: true, status: "queued", pollAfterSeconds: 3 });
  const f = await answerWorkerImageJob(db({}), row({ status: "failed", error: "x", params: { worker: true, error_code: "ai_outcome_unknown" } }));
  assertEquals(f.body, { success: true, status: "failed", error: "x", errorCode: "ai_outcome_unknown" });
});
Deno.test("only worker image rows match", () => {
  assertEquals(isWorkerImageJob(row()), true);
  assertEquals(isWorkerImageJob(row({ modality: "video" })), false);
  assertEquals(isWorkerImageJob(row({ params: { prompt: "sync" } })), false);
  assertEquals(isWorkerImageJob(row({ params: null })), false);
});
```

- [ ] **Step 2: Implement `workerImageJob.ts`.**

```ts
/**
 * Database reads for ai-generation-status, and the answer for background image jobs. A failed read
 * is a retryable 503: answering "not found" or "expired" on a transient error would end the
 * browser's wait on an image that exists. Worker image jobs must never reach index.ts's provider
 * or 30-minute branches, which would refund a reservation the worker never made.
 */
// deno-lint-ignore-file no-explicit-any
export const WORKER_IMAGE_POLL_SECONDS = 3;
export const RETRYABLE_READ_BODY = { success: false, retryable: true, error: "Could not read the generation status. Retrying." };
export type OwnedJobRead = { kind: "found"; job: any } | { kind: "missing" } | { kind: "error"; message: string };

const paramsOf = (job: { params: unknown }) =>
  job.params && typeof job.params === "object" ? (job.params as Record<string, unknown>) : {};

export async function loadOwnedJob(db: any, jobId: unknown, userId: string): Promise<OwnedJobRead> {
  if (typeof jobId !== "string" || jobId.length === 0) return { kind: "missing" };
  const { data, error } = await db.from("ai_generation_jobs").select("*").eq("id", jobId).eq("user_id", userId).maybeSingle();
  if (error) return { kind: "error", message: String(error.message ?? error) };
  return data ? { kind: "found", job: data } : { kind: "missing" };
}

export function isWorkerImageJob(job: { modality: string; params: unknown }): boolean {
  return job.modality === "image" && paramsOf(job).worker === true;
}

export async function answerWorkerImageJob(db: any, job: any): Promise<{ status: number; body: Record<string, unknown> }> {
  const params = paramsOf(job);
  if (job.status === "succeeded") {
    let imageUrl: string | null = job.result_url ?? null;
    if (!imageUrl) {
      const { data, error } = await db.from("ai_image_job_payloads").select("result_data_url").eq("job_id", job.id).maybeSingle();
      if (error) return { status: 503, body: RETRYABLE_READ_BODY };
      imageUrl = data?.result_data_url ?? null;
    }
    if (!imageUrl) {
      return { status: 200, body: { success: true, status: "failed", error: "This generated image has expired. Please generate it again.", errorCode: "ai_result_expired" } };
    }
    return { status: 200, body: { success: true, status: "succeeded", imageUrl, url: imageUrl, description: params.description ?? null } };
  }
  if (job.status === "failed" || job.status === "timeout") {
    return { status: 200, body: { success: true, status: job.status, error: job.error,
      errorCode: typeof params.error_code === "string" ? params.error_code : "ai_error" } };
  }
  return { status: 200, body: { success: true, status: job.status === "queued" ? "queued" : "running", pollAfterSeconds: WORKER_IMAGE_POLL_SECONDS } };
}
```

- [ ] **Step 3: Wire it into `index.ts`.** Replace lines 27-34 (`const { jobId } = await req.json();` through the 404) with:

```ts
    const { jobId } = await req.json();
    const owned = await loadOwnedJob(supabase, jobId, user.id);
    if (owned.kind === "error") {
      console.error("[ai-generation-status] job read failed:", owned.message);
      return json(RETRYABLE_READ_BODY, 503);
    }
    if (owned.kind === "missing") return json({ error: "Job not found" }, 404);
    const job = owned.job;
    if (isWorkerImageJob(job)) {
      const answer = await answerWorkerImageJob(supabase, job);
      return json(answer.body, answer.status);
    }
```

The video path behaves as today, except that a failed read is now a retryable 503 instead of a terminal 404.

- [ ] **Step 4: Verify and commit.** `$D check --node-modules-dir=none supabase/functions/ai-generation-status/index.ts && $D test --node-modules-dir=none --allow-env supabase/functions/ai-generation-status/`, then `git commit -m "fix(ai-generation-status): DB errors are retryable; answer background image jobs first" -- supabase/functions/ai-generation-status/`.

---

### Task 7: The watcher and `useAiGenerationJob` (B6, B7)

**Files:** Create `src/lib/aiGenerationJobWatcher.ts`, `src/lib/__tests__/aiGenerationJobWatcher.test.ts`, `src/hooks/__tests__/useAiGenerationJob.test.tsx`; modify `src/hooks/useAiGenerationJob.ts`.

**Interfaces:**

```ts
export type AiJobStatus = "idle" | "running" | "succeeded" | "failed" | "timeout";
export interface AiJobSnapshot { status: AiJobStatus; videoUrl: string | null; imageUrl: string | null; error: string | null; errorCode: string | null; elapsedSeconds: number }
export const DEFAULT_POLL_SECONDS = 5; export const MAX_POLL_MS = 10 * 60_000; export const READ_TIMEOUT_MS = 20_000;
export function watchAiGenerationJob(jobId: string, onChange: (s: AiJobSnapshot) => void): () => void;
export function awaitAiGenerationJob(jobId: string): Promise<AiJobSnapshot>;
export async function resolveAiImageResponse(data: unknown): Promise<Record<string, unknown> | null>;
```

`useAiGenerationJob(jobId)` keeps `status, videoUrl, imageUrl, error, isPolling, elapsedSeconds`, adds `errorCode`, and re-exports `AiJobStatus`.

- [ ] **Step 1: Write the failing watcher test.**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ onUpdate: null as null | ((p: unknown) => void), invoke: vi.fn(), removeChannel: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => {
  const channel = { on: (_e: string, _f: unknown, cb: (p: unknown) => void) => { h.onUpdate = cb; return channel; }, subscribe: () => channel };
  return { supabase: { channel: () => channel, removeChannel: h.removeChannel, functions: { invoke: h.invoke } } };
});
import { watchAiGenerationJob, awaitAiGenerationJob, resolveAiImageResponse } from "@/lib/aiGenerationJobWatcher";

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { context: { status } });
const running = { data: { success: true, status: "running", pollAfterSeconds: 3 }, error: null };

describe("aiGenerationJobWatcher", () => {
  beforeEach(() => { vi.useFakeTimers(); h.invoke.mockReset(); h.removeChannel.mockReset(); });
  afterEach(() => vi.useRealTimers());

  it("polls immediately when Realtime reports a terminal status", async () => {
    h.invoke.mockResolvedValue({ data: { success: true, status: "succeeded", imageUrl: "data:image/png;base64,AA" }, error: null });
    const seen: string[] = [];
    watchAiGenerationJob("j1", (s) => seen.push(s.status));
    h.onUpdate!({ new: { status: "succeeded" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe("succeeded");
    expect(h.removeChannel).toHaveBeenCalled();
  });

  it("B6: a Realtime event during a pending read never runs two reads at once", async () => {
    let active = 0; let maxActive = 0; let release!: (v: unknown) => void;
    h.invoke.mockImplementation(() => {
      active++; maxActive = Math.max(maxActive, active);
      const p = h.invoke.mock.calls.length === 1 ? new Promise((r) => { release = r; }) : Promise.resolve(running);
      return p.finally(() => { active--; });
    });
    watchAiGenerationJob("j1", () => {});
    await vi.advanceTimersByTimeAsync(5_000);           // first read starts and hangs
    h.onUpdate!({ new: { status: "succeeded" } });       // event while it is in flight
    release(running);                                    // the stale read says running
    await vi.advanceTimersByTimeAsync(0);                // immediate re-poll (read 2) answers running
    await vi.advanceTimersByTimeAsync(3_000);            // exactly one scheduled read (read 3)
    expect(maxActive).toBe(1);
    expect(h.invoke).toHaveBeenCalledTimes(3);
  });

  it("a failed read is never terminal: it backs off and keeps polling", async () => {
    h.invoke
      .mockResolvedValueOnce({ data: null, error: httpError(500) })
      .mockResolvedValueOnce({ data: null, error: httpError(503) })
      .mockResolvedValueOnce({ data: { success: true, status: "succeeded", imageUrl: "https://h/i.png" }, error: null });
    const done = awaitAiGenerationJob("j1");
    await vi.advanceTimersByTimeAsync(5_000 + 5_000 + 10_000);
    await expect(done).resolves.toMatchObject({ status: "succeeded", imageUrl: "https://h/i.png" });
  });

  it("404 ends the watch as failed", async () => {
    h.invoke.mockResolvedValue({ data: null, error: httpError(404) });
    const done = awaitAiGenerationJob("j1");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(done).resolves.toMatchObject({ status: "failed", errorCode: "job_not_found" });
  });

  it("B7: a read that never settles still ends the wait and removes the channel", async () => {
    h.invoke.mockImplementation(() => new Promise(() => {}));
    const done = awaitAiGenerationJob("j1");
    await vi.advanceTimersByTimeAsync(5_000 + 20_000 + 5_000);
    expect(h.invoke.mock.calls.length).toBeGreaterThan(1);  // the read timed out and was retried
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(done).resolves.toMatchObject({ status: "timeout" });
    expect(h.removeChannel).toHaveBeenCalled();
  });

  it("resolveAiImageResponse passes a sync answer through and maps a failed job", async () => {
    await expect(resolveAiImageResponse({ imageUrl: "data:x" })).resolves.toEqual({ imageUrl: "data:x" });
    h.invoke.mockResolvedValue({ data: { success: true, status: "failed", error: "Daily AI generation limit reached", errorCode: "ai_quota_exhausted" }, error: null });
    const r = resolveAiImageResponse({ success: true, jobId: "j1", status: "queued" });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(r).resolves.toEqual({ success: false, error_code: "ai_quota_exhausted", message: "Daily AI generation limit reached" });
  });
});
```

- [ ] **Step 2: Implement `src/lib/aiGenerationJobWatcher.ts`.**

```ts
/**
 * Follows one ai_generation_jobs row to its end: Realtime for speed, polling ai-generation-status
 * for the result and as the fallback. At most one read is in flight; each read times out; the whole
 * watch has its own deadline. Only 401/403/404 or the deadline end it; any other failed read backs off.
 */
import { supabase } from "@/integrations/supabase/client";

export type AiJobStatus = "idle" | "running" | "succeeded" | "failed" | "timeout";
export interface AiJobSnapshot {
  status: AiJobStatus; videoUrl: string | null; imageUrl: string | null;
  error: string | null; errorCode: string | null; elapsedSeconds: number;
}

export const DEFAULT_POLL_SECONDS = 5;
export const MAX_POLL_MS = 10 * 60_000;
export const READ_TIMEOUT_MS = 20_000;
const BACKOFF_SECONDS = [5, 10, 20, 30];
const TERMINAL = new Set(["succeeded", "failed", "timeout", "canceled"]);
const FATAL_HTTP = new Set([401, 403, 404]);

function httpStatusOf(error: unknown): number | null {
  const status = (error as { context?: { status?: unknown } } | null)?.context?.status;
  return typeof status === "number" ? status : null;
}

export function watchAiGenerationJob(jobId: string, onChange: (s: AiJobSnapshot) => void): () => void {
  const startedAt = Date.now();
  let active = true;
  let inFlight = false;
  let pollAgain = false;
  let failures = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const clearPollTimer = () => { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; };
  const snapshot = (patch: Partial<AiJobSnapshot>): AiJobSnapshot => ({
    status: "running", videoUrl: null, imageUrl: null, error: null, errorCode: null,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), ...patch,
  });

  const channel = supabase.channel(`ai-generation-job-${jobId}`);
  const stop = () => {
    if (!active) return;
    active = false;
    clearPollTimer();
    clearTimeout(deadlineTimer);
    void supabase.removeChannel(channel);
  };
  const finish = (patch: Partial<AiJobSnapshot>) => {
    if (!active) return;
    const last = snapshot(patch);
    stop();
    onChange(last);
  };
  const deadlineTimer = setTimeout(() => finish({ status: "timeout",
    error: "The generation is taking longer than expected. Check back shortly." }), MAX_POLL_MS);

  const schedule = (seconds: number) => {
    if (!active) return;
    clearPollTimer();
    pollTimer = setTimeout(() => void poll(), seconds * 1000);
  };

  const readStatus = () => {
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      readTimer = setTimeout(() => reject(new Error("status read timed out")), READ_TIMEOUT_MS);
    });
    return Promise.race([supabase.functions.invoke("ai-generation-status", { body: { jobId } }), timeout])
      .finally(() => clearTimeout(readTimer));
  };

  const poll = async (): Promise<void> => {
    if (!active || inFlight) return;
    clearPollTimer();
    inFlight = true;
    try {
      const { data, error } = await readStatus();
      if (!active) return;
      if (error) throw error;
      const status = String(data?.status ?? "");
      if (status === "succeeded") {
        finish({ status: "succeeded", videoUrl: data.videoUrl ?? data.imageUrl ?? data.url ?? null,
          imageUrl: data.imageUrl ?? data.videoUrl ?? data.url ?? null });
        return;
      }
      if (TERMINAL.has(status)) {
        finish({ status: status === "failed" ? "failed" : "timeout", error: data.error || "The generation did not complete.",
          errorCode: data.errorCode ?? null });
        return;
      }
      if (!status) throw new Error("Unexpected status response");
      failures = 0;
      onChange(snapshot({ status: "running" }));
      const next = Number(data?.pollAfterSeconds);
      schedule(Number.isFinite(next) && next > 0 ? Math.min(next, 30) : DEFAULT_POLL_SECONDS);
    } catch (err) {
      if (!active) return;
      const http = httpStatusOf(err);
      if (http !== null && FATAL_HTTP.has(http)) {
        finish(http === 404
          ? { status: "failed", error: "This generation could not be found.", errorCode: "job_not_found" }
          : { status: "failed", error: "Your session has expired. Refresh and try again.", errorCode: "unauthorized" });
        return;
      }
      failures += 1;
      schedule(BACKOFF_SECONDS[Math.min(failures - 1, BACKOFF_SECONDS.length - 1)]);
    } finally {
      inFlight = false;
      if (pollAgain && active) {
        pollAgain = false;
        clearPollTimer();
        void poll();
      }
    }
  };

  const pollNow = () => {
    if (!active) return;
    if (inFlight) { pollAgain = true; return; }
    void poll();
  };

  channel
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "ai_generation_jobs", filter: `id=eq.${jobId}` },
      (payload: { new?: { status?: string } }) => { if (TERMINAL.has(String(payload.new?.status))) pollNow(); })
    .subscribe();

  onChange(snapshot({ status: "running" }));
  schedule(DEFAULT_POLL_SECONDS);
  return stop;
}

export function awaitAiGenerationJob(jobId: string): Promise<AiJobSnapshot> {
  return new Promise((resolve) => {
    watchAiGenerationJob(jobId, (s) => { if (s.status !== "running" && s.status !== "idle") resolve(s); });
  });
}

/** Turns generate-image's answer into the synchronous shape every caller handles. A sync answer passes through. */
export async function resolveAiImageResponse(data: unknown): Promise<Record<string, unknown> | null> {
  const body = (data ?? null) as Record<string, unknown> | null;
  if (!body || typeof body.jobId !== "string") return body;
  const end = await awaitAiGenerationJob(body.jobId);
  if (end.status === "succeeded" && end.imageUrl) return { imageUrl: end.imageUrl, description: "" };
  return { success: false, error_code: end.errorCode ?? (end.status === "timeout" ? "ai_timeout" : "ai_error"),
    message: end.error ?? "Image generation failed" };
}
```

`deadlineTimer` is declared after `stop` but assigned before any callback can run, because every path into `stop` is a timer or an async callback. If the linter flags it, move the declaration up as `let deadlineTimer: ReturnType<typeof setTimeout>;` and assign it in place.

- [ ] **Step 3: Rewrite `src/hooks/useAiGenerationJob.ts` over the watcher.** Keep its JSDoc header and update it to "Realtime + polling".

```ts
import { useEffect, useState } from "react";
import { watchAiGenerationJob, type AiJobSnapshot } from "@/lib/aiGenerationJobWatcher";
export type { AiJobStatus } from "@/lib/aiGenerationJobWatcher";

export interface AiGenerationJobState extends AiJobSnapshot { isPolling: boolean }
const INITIAL: AiGenerationJobState = { status: "idle", videoUrl: null, imageUrl: null, error: null, errorCode: null, isPolling: false, elapsedSeconds: 0 };

export function useAiGenerationJob(jobId: string | null): AiGenerationJobState {
  const [state, setState] = useState<AiGenerationJobState>(INITIAL);
  useEffect(() => {
    if (!jobId) { setState(INITIAL); return; }
    return watchAiGenerationJob(jobId, (s) => setState({ ...s, isPolling: s.status === "running" }));
  }, [jobId]);
  return state;
}
```

- [ ] **Step 4: `src/hooks/__tests__/useAiGenerationJob.test.tsx`.**

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const h = vi.hoisted(() => ({ invoke: vi.fn(), removeChannel: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => {
  const channel = { on: () => channel, subscribe: () => channel };
  return { supabase: { channel: () => channel, removeChannel: h.removeChannel, functions: { invoke: h.invoke } } };
});
import { useAiGenerationJob } from "@/hooks/useAiGenerationJob";

describe("useAiGenerationJob", () => {
  beforeEach(() => { vi.useFakeTimers(); h.invoke.mockReset(); h.removeChannel.mockReset(); });
  afterEach(() => vi.useRealTimers());

  it("stays idle without a job id", async () => {
    const { result } = renderHook(() => useAiGenerationJob(null));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.status).toBe("idle");
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it("reports running with isPolling", () => {
    const { result } = renderHook(() => useAiGenerationJob("j1"));
    expect(result.current).toMatchObject({ status: "running", isPolling: true });
  });
  it("ends with the video URL VideoGenerator reads and cleans up on unmount", async () => {
    h.invoke.mockResolvedValue({ data: { success: true, status: "succeeded", videoUrl: "https://v/x.mp4" }, error: null });
    const { result, unmount } = renderHook(() => useAiGenerationJob("j1"));
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(result.current).toMatchObject({ status: "succeeded", isPolling: false, videoUrl: "https://v/x.mp4" });
    unmount();
    expect(h.removeChannel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Verify and commit.** `npx vitest run src/lib/__tests__/aiGenerationJobWatcher.test.ts src/hooks/__tests__/useAiGenerationJob.test.tsx && npx tsc --noEmit -p tsconfig.app.json`, then `git commit -m "feat(ai-jobs): realtime + polling watcher with one read in flight and a hard deadline" -- src/lib/aiGenerationJobWatcher.ts src/lib/__tests__/aiGenerationJobWatcher.test.ts src/hooks/useAiGenerationJob.ts src/hooks/__tests__/useAiGenerationJob.test.tsx`.

---

### Task 8: The four callers send `async: true`

**Files:** `src/components/post/ImageGenerator.tsx` (`:270`), `src/components/canvas/nodes/CaptionNode.tsx` (`:103`), `src/components/canvas/nodes/MediaNode.tsx` (`:141`), `src/hooks/useYouTubeThumbnails.tsx` (`:119`) and `src/hooks/__tests__/useYouTubeThumbnails.test.tsx` (`:82`, `:127`).

- [ ] **Step 1: Update the YouTube test first (it fails).**
  - Add `async: true` to the exact body at `:82` and to the `objectContaining` at `:127`.
  - Extend the client mock with `channel`/`removeChannel`, as in Task 7.
  - Add a job case. `mockInvoke` answers `generate-image` with `{ data: { success: true, jobId: "j1", status: "queued" } }` and `ai-generation-status` with `{ data: { success: true, status: "succeeded", imageUrl: "data:image/png;base64,AA" } }`. Use fake timers and advance 5 s. Assert that the updater given to `mockSetAiGeneratedThumbnails` appends `"data:image/png;base64,AA"`, and that `mockSetGeneratingAiThumbnail(false)` happens after that.
  - Add a failure case: the job ends `failed`. Expect the "Failed to generate" toast and no append.
  - Run `npx vitest run src/hooks/__tests__/useYouTubeThumbnails.test.tsx src/hooks/__tests__/useYouTubeThumbnails.video.test.tsx` and expect FAIL.

- [ ] **Step 2: Change the call sites.** Each one sends `async: true`, resolves the answer, and surfaces a structured failure.
  - `useYouTubeThumbnails.tsx` (`:119-131`):

```ts
      const { data: raw, error } = await supabase.functions.invoke("generate-image", {
        body: { prompt, aspectRatio: "16:9", referenceImage: refImage || undefined, async: true },
      });
      if (error) throw error;
      const data = await resolveAiImageResponse(raw);
      if (data?.success === false) throw new Error(String(data.message ?? "Image generation failed"));
      if (data?.error) throw new Error(String(data.error));
```

    Keep the existing comment block in the body. `isGeneratingAi` stays true until the job ends, because `finally` runs after the `await`.
  - `CaptionNode.tsx` (`:93-110`): add `async: true` to `body`. Then `const { data: raw, error } = ...; if (error) throw error; const data = await resolveAiImageResponse(raw); if (data?.success === false) throw new Error(String(data.message ?? "Image generation failed"));`. The `data?.imageUrl` branch is unchanged.
  - `MediaNode.tsx` (`:141-145`): body `{ prompt: generatePrompt, style: 'realistic', size: '1024x1024', async: true }` plus the same three lines. The Cloudinary re-upload of a `data:` URL (`:147-157`) is unchanged.
  - `ImageGenerator.tsx` (`:270-279`):
    - Add `async: true` and rename the destructured `data` to `raw`, and log `raw` at `:282`.
    - Right after the `if (error) {...}` block (`:286-318`), add `const data = await resolveAiImageResponse(raw);`.
    - In the structured-failure branch (`:321-336`), use `if (code === 'ai_credits_exhausted' || code === 'ai_quota_exhausted') { handleAIError({ status: 402, message }, 'Image generation'); }`. `ai_outcome_unknown` falls into the existing destructive toast with its message.
  - Import `resolveAiImageResponse` from `@/lib/aiGenerationJobWatcher` in all four files.

- [ ] **Step 3: Gates.** `npx vitest run && npx tsc --noEmit -p tsconfig.app.json && npm run check:i18n && npm run lint`, all green.
- [ ] **Step 4: Commit.** `git commit -m "feat(ai-image): callers queue generations and wait on the job" -- src/components/post/ImageGenerator.tsx src/components/canvas/nodes/CaptionNode.tsx src/components/canvas/nodes/MediaNode.tsx src/hooks/useYouTubeThumbnails.tsx src/hooks/__tests__/useYouTubeThumbnails.test.tsx`.

---

### Task 9: Types, CI, gates and guard pass

**Files:** `src/integrations/supabase/types.ts`, `.github/workflows/ci.yml`.

- [ ] **Step 1: Types.** After the production migration (Deployment step 2), regenerate with `supabase_postora_mcp` `generate_typescript_types` and take these blocks: `ai_generation_jobs`, `ai_image_job_payloads`, `enqueue_ai_image_job`, `claim_ai_image_jobs` and `complete_ai_image_job`.

  If regeneration is not reachable before merge, hand-edit:
  - `ai_generation_jobs` (from `:2351`): add `attempts: number`, `claim_token`, `claimed_at` and `dispatched_at` (`string | null`), optional in Insert/Update.
  - A new `ai_image_job_payloads` block: Row `{ created_at: string; job_id: string; reference_images: Json; result_data_url: string | null }`, plus the FK relationship.
  - Next to `release_ai_generation_quota` (`:12348`):
    - `enqueue_ai_image_job: { Args: { p_user_id: string; p_model_id: string; p_params: Json; p_references: Json }; Returns: string }`
    - `claim_ai_image_jobs: { Args: { p_limit?: number; p_lease?: unknown; p_max_per_user?: number }; Returns: Database["public"]["Tables"]["ai_generation_jobs"]["Row"][] }`
    - `complete_ai_image_job: { Args: { p_job_id: string; p_claim_token: string; p_status: string; p_result_url?: string; p_result_data_url?: string; p_error?: string; p_provider?: string; p_model_id?: string; p_credential_source?: string; p_params?: Json }; Returns: boolean }`

  Regenerate after deploy and commit any drift.
- [ ] **Step 2: CI.** After the step "Typecheck and test the AI image jobs and the staging sweep" (`ci.yml:285-291`) add:

```yaml
      # generate-image was never typechecked in CI; the extraction fixed its two latent errors.
      - name: Typecheck and test AI image generation jobs
        run: |
          set -euo pipefail
          fn="supabase/functions"
          deno check --node-modules-dir=none "${fn}/generate-image/index.ts" "${fn}/ai-image-worker/index.ts" "${fn}/ai-generation-status/index.ts" "${fn}/generate-video/index.ts"
          deno test --allow-env --node-modules-dir=none "${fn}/generate-image/" "${fn}/ai-image-worker/" "${fn}/ai-generation-status/" "${fn}/_shared/vercelGateway.test.ts"
```

- [ ] **Step 3: All gates.**

```bash
cd /f/Dev/Worktrees/Postora_new/background-workers && D=/f/Dev/Runtimes/deno-bin/bin/deno.exe && fn=supabase/functions && \
$D check --node-modules-dir=none $fn/generate-image/index.ts $fn/ai-image-worker/index.ts $fn/ai-generation-status/index.ts $fn/generate-video/index.ts && \
$D test --allow-env --node-modules-dir=none $fn/generate-image/ $fn/ai-image-worker/ $fn/ai-generation-status/ $fn/_shared/vercelGateway.test.ts $fn/n8n-api/serviceProxy.test.ts && \
bash scripts/db-harness.sh && npx vitest run && npx tsc --noEmit -p tsconfig.app.json && npm run check:i18n && npm run lint && npm run build
```

- [ ] **Step 4: Guard pass.** Run `clean-code-guard` on the changed production files and `test-guard` on the new or changed tests, and fix the findings inline. Then `git diff --stat main...HEAD -- supabase/functions/process-post` must be empty (§41).
- [ ] **Step 5: Commit** `git commit -m "chore(ai-image): types and CI for background image jobs" -- src/integrations/supabase/types.ts .github/workflows/ci.yml`.

---

## Deployment

Order: the migration first, then the functions, then the frontend. One PR is fine. The migration is applied by hand before merge, and the functions deploy within about 2 minutes of the merge, before the frontend build finishes. During that window the old frontend sends sync requests, which still work.

1. **Harness green on the PR head.** Run `bash scripts/db-harness.sh`; CI runs it too.
2. **Apply the migration on production before merge**, through `ssh-contabo-mcp`: psql into the stack's db container and run `git show origin/feat/background-workers-b:supabase/migrations/20261107120000_ai_image_jobs_worker.sql`. Never use the dirty `/root/postora-runtime` tree. Then verify:
   - `cron.job` has `ai-image-worker` and `purge-ai-image-payloads` once each.
   - `pg_publication_tables` lists `ai_generation_jobs` and not `ai_image_job_payloads`.
   - `has_function_privilege('authenticated','public.enqueue_ai_image_job(uuid, text, jsonb, jsonb)','EXECUTE')` and the claim equivalent are `f`.
   - Until the function is deployed, the worker cron gets a 404 every minute. That is harmless.
3. **Merge to `main`.**
   - The Dokploy "Edge Functions Sync" schedule (every 2 min) deploys the functions; it does not run migrations.
   - Verify SHA256 of `generate-image/{index,handler,runImageGeneration,callBudget,imageFailure,asyncJob}.ts`, `ai-image-worker/{index,worker,deps}.ts`, `ai-generation-status/{index,workerImageJob}.ts`, `_shared/higgsfield-mcp.ts` and `_shared/vercelGateway.ts` in `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/` against `git show origin/main:<path> | sha256sum`.
   - If needed, run `docker compose restart functions` from the stack dir (`docs/runbooks/deploy-edge-function.md`).
   - Never use `npx supabase functions deploy`.
4. **Probes.**
   - `curl -i -X OPTIONS https://api.postora.cloud/functions/v1/ai-image-worker` returns 200.
   - An unauthenticated `POST` returns 401.
   - Within a minute the logs show `[background] waitUntil path active` and `[ai-image-worker] tick {"claimed":0,...}`. If they show `degraded inline`, stop before any user traffic.
5. **The frontend deploys from the same merge** (Dokploy, `postors.cloud`).
6. **Regenerate the types** if they were hand-edited.
7. **mem0** `add_memory` (`user_id="HP"`, `app_id="lolotam-postora"`). Record:
   - the Phase B design;
   - "unknown outcome: never refund, never fall back";
   - "status short-circuit before the timeout branch";
   - "enqueue is one RPC";
   - the deploy order.

Rollback: revert the merge, and the frontend returns to sync calls. If the worker is gone too, settle queued rows by hand: `UPDATE ai_generation_jobs SET status='timeout' WHERE modality='image' AND params->>'worker'='true' AND status IN ('queued','running');`. The migration is additive and can stay.

## Verification (live)

Use the logged-in pilot browser (Playwright MCP). The `postora` MCP key is not the pilot user.

1. **ImageGenerator.** On `/post`, generate an image.
   - `generate-image` answers **202** in under 1 s with `{"success":true,"jobId","status":"queued"}`.
   - In `supabase_postora_mcp`, `SELECT status, attempts, dispatched_at IS NOT NULL, provider, model_id FROM ai_generation_jobs WHERE id='<jobId>'` moves `queued` → `running` → `succeeded`, with the placeholders overwritten.
   - The image renders without a reload.
   - The `ai-generation-status` call that returns `succeeded` fires right after the Realtime UPDATE.
2. **Use Image** adds the image to the post, and Download works.
3. **YouTube thumbnail.** It appends once, and the spinner stays until it does. Schedule the post and confirm `settings.thumbnailUrl` is set.
4. **Canvas.** The CaptionNode and MediaNode generators render the image. MediaNode stores a Cloudinary URL.
5. **Failure.** Use an account at its daily platform quota, or point the image model at a provider with no key. The job ends `failed` with `params.error_code`, the UI shows the existing destructive or 402 toast, and there is no fake success.
6. **Polling fallback.** Block the Realtime websocket and generate again. The result arrives through 3 s polling.
7. **Sync contract (§36).**
   - n8n: `POST /api/v1/ai/image` answers `200 {"success":true,"image_url",…}` for a hosted image or `201 {"success":true,"media_file_id","url",…}` for an inline one.
   - MCP `generate_image` returns the same through n8n.
   - No `ai_generation_jobs` row with `params.worker` is created.
8. **Worker health.**
   - `SELECT count(*) FROM ai_generation_jobs WHERE params->>'worker'='true' AND status IN ('queued','running') AND created_at < now() - interval '5 minutes';` returns 0.
   - `cron.job_run_details` for `ai-image-worker` shows `succeeded`.
9. **Cross-user.** From a second account's console, `supabase.from('ai_generation_jobs').select('*').eq('id','<first user job>')` returns `[]`, and `ai_image_job_payloads` returns a permission error.
10. **Retention.** For a reference picked from the media library: while the job is queued, `params.reference_urls` holds its URL.

## Risks and follow-ups

- **Slow models vs the 140 s deadline.** A candidate whose minimum does not fit is skipped. A job cut at the deadline after dispatch ends `failed`, and its quota is not refunded. Watch `error_code IN ('ai_interrupted','ai_outcome_unknown')` in the first week.
- **An unknown Higgsfield outcome now fails the generation on the sync path too** (B1). The user may find the image in their Higgsfield history. This is deliberate: refunding plus a fallback could charge twice and produce two images.
- **The per-user cap of 2 running jobs also applies to platform users.** A third generation waits in the queue: honest, but slower.
- **Multi-MB data URLs in Postgres** for up to 24 h, purged hourly. If volume grows, move to Openinary. That needs a CORS check for `handleUseImage`'s `fetch` and a durable URL for YouTube `thumbnailUrl`.
- **A kick that lands on a spent worker** waits for the next cron run: 60-150 s.
- **Imperative callers do not cancel.** `awaitAiGenerationJob` keeps watching after unmount, until the job ends or the 10-minute deadline. That is one read every 3 s, and the result is dropped.
- **Follow-ups:** an n8n/MCP `async` opt-in; making `async` the default after one release; a cancel signal for `awaitAiGenerationJob`; an admin view of worker failures; Higgsfield reconciliation through `job_status` for `ai_outcome_unknown` jobs.

## Self-review

- **Spec coverage:**
  - the extraction: Task 3;
  - `async: true` with sync as the default, the row before dispatch, the kick in `runInBackground` and the 202 shape: Task 4;
  - the worker door, the claim RPC, one job per claim within 50 s, and the token fence: Tasks 1 and 5;
  - the status short-circuit with `pollAfterSeconds: 3`: Task 6;
  - the migration (columns, `SECURITY DEFINER` + `search_path` + REVOKE/GRANT, partial index, idempotent publication, guarded cron): Task 1;
  - the hook (Realtime + polling, failed reads not terminal, a `setTimeout` chain): Task 7;
  - the callers: Task 8;
  - tests, harness and CI: every task and Task 9;
  - types: Task 9;
  - deployment and `verify_jwt`: Task 5 and Deployment.
- **Deviations from the spec:**
  - quota is reserved per platform-Higgsfield candidate, not at claim (D12);
  - the private payload table;
  - the worker door answers 202 and runs in `waitUntil` (D8);
  - the watcher ends on 401/403/404, because the server answered definitively, while every other failed read backs off;
  - "one job per tick" is read as one job per claim, with the tick claiming again within its 50 s budget;
  - a per-user cap of 2 running worker jobs (B5).
- **Placeholders:** none. Moves name exact ranges and the only edits allowed while moving.
- **Type consistency:**
  - `CallBudget` comes from `callBudget.ts` and is used by the runner, the providers and the worker.
  - `ImageJobInput.budget` replaces the earlier `deadlineMs` everywhere.
  - `ImageRunResult` gains `outcome_unknown`, which is handled by the sync handler (Task 3 Step 6) and by `completionFor` (Task 5).
  - `claim` takes `(limit, lease, maxPerUser)` in the port, `deps.ts`, the RPC and the SQL proof.
  - The `errorCode` values are produced in Tasks 1, 3, 5, 6 and 7: `ai_quota_exhausted`, `ai_rate_limited`, `ai_outcome_unknown`, `ai_interrupted`, `ai_attempts_exhausted`, `ai_queue_timeout`, `ai_payload_missing`, `ai_result_expired`, `job_not_found` and `unauthorized`. Task 8 maps the quota code.
- **YAGNI:** the worker's requeue port and the `loadReferences → null` branch are removed, because B4's atomic enqueue makes them unnecessary. `buildQueuedImageJob` is replaced by `buildEnqueueArgs`. The generic `MIN_ATTEMPT_MS` is replaced by `PROVIDER_MIN_MS`.
