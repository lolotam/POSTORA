# Background workers Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Delegated implementers (Codex / Grok / OpenCode / Antigravity): read `ARCHITECTURE.md` before touching any file.** Nothing loads it for you. The sections that bind this plan are listed under Global Constraints.

**Goal:** "Generate image" answers in under a second with 202 `queued`. The image arrives later through Realtime, with polling as the fallback. The UI never shows a fake "done". No generation charges quota twice or produces two images. MCP and n8n keep today's synchronous contract.

**Architecture:**
- **Shared chain.** The provider chain moves out of `generate-image/index.ts` into `generate-image/runImageGeneration.ts` as `runImageGeneration(deps, job)`. The sync path and the new worker both call it, so the chain logic has one copy.
- **Enqueue.** On `async: true`, `generate-image` runs every existing gate first: auth, subscription, rate limit and the `api_logs` row. It then inserts the `ai_generation_jobs` row and a private `ai_image_job_payloads` row, kicks `ai-image-worker` inside `runInBackground`, and returns 202 `{ success: true, jobId, status: "queued" }`.
- **Worker.** `ai-image-worker` is a cron-auth door that also answers 202 at once and works inside `runInBackground`.
  - It claims one job at a time through `claim_ai_image_jobs` (`FOR UPDATE SKIP LOCKED`, lease, fresh `claim_token`).
  - It stamps `dispatched_at` before the first billable call.
  - It writes the terminal state through `complete_ai_image_job`, fenced on `claim_token`.
- **Interrupted jobs.** A dispatched job whose worker died is failed, never re-run: its outcome is indeterminate. An undispatched one is re-claimed up to 3 attempts.
- **Status.** `ai-generation-status` short-circuits worker image jobs with `pollAfterSeconds: 3` and returns the image exactly as the sync path does today.
- **Frontend.** `useAiGenerationJob` and the four callers share one watcher, `src/lib/aiGenerationJobWatcher.ts`.
  - It subscribes to `postgres_changes` on the job row and polls as the fallback.
  - A failed read is never terminal, and reads chain with `setTimeout`.

**Tech Stack:** Deno edge functions (self-hosted Supabase edge runtime, `workerTimeoutMs` 150 s), PostgREST RPC, pg_cron + pg_net, Supabase Realtime `postgres_changes`, React 18, Vitest, Deno test, SQL proof suites run by `scripts/db-harness.sh`.

**Spec:** `docs/superpowers/specs/2026-11-06-background-workers-design.md` (section "Phase B").

**Required reading before code:** `ARCHITECTURE.md` §1 (zero dead modules: every new export names its call site), §12 (index.ts is an adapter), §13-§14 (no body `user_id` except after service-role auth), §15 (Zod), §16 (sanitized errors), §17 (no secret logging), §23 (RLS + policies + cross-user denial tests, `SECURITY DEFINER` with `search_path`, regenerate types), §24 (service-role key backend only), §25 (CORS), §26 (timeouts on every network call; never blindly retry a billable side effect), §27 (`waitUntil` only for bounded work, state persisted), §28 (atomic claim, duplicate prevention, attempt state, retryable vs permanent), §35 (no cosmetic refactors), §36 (backward compatibility: n8n/MCP), §38 (quota enforced server-side), §40 (shared-code rules), §41 (`process-post` untouched).

## Global Constraints

- **Sync stays the default for one release.** A body without `async: true` must produce byte-for-byte today's response, `{ imageUrl, description }` or `{ success: false, error_code, message }`, with the same status codes and `X-RateLimit-*` headers. `n8n-api/serviceProxy.ts:375-403` (`handleGenerateImage`) and `mcp/index.ts:603` (`generate_image`, through n8n-api) send no `async`, and they must not change. `supabase/functions/n8n-api/serviceProxy.test.ts` must pass unmodified.
- **The extraction is a move, not a rewrite (§35).** Only three changes are allowed:
  - the dependency-injection seams named in Task 2;
  - the deadline-capped timeouts;
  - the two type errors that `deno check` reports today: `generate-image/index.ts:268` (a `Uint8Array<ArrayBufferLike>` passed to `base64Encode`) and `:981` (`aspectRatio` is `string | undefined`).
- **Never charge quota twice or produce two images.**
  - Quota reserve and release stay per platform-Higgsfield candidate inside the chain, exactly as today (`index.ts:908-913`, `:953`).
  - A job whose `dispatched_at` is set is never claimed again.
  - An indeterminate outcome never releases quota. This matches the existing rule in `ai-generation-status/index.ts:46-50`, which releases only on a definitive end.
- **Heavy bytes stay off the published row.**
  - Reference images and `data:` results live in `ai_image_job_payloads`, which is private and not in the Realtime publication.
  - `ai_generation_jobs.params` carries only small scalars. That keeps Realtime payloads small and keeps `20261001100000_media_retention.sql`'s scan of non-terminal `params` cheap.
- **§40 placement:** the chain is image-generation policy (quota, BYO limits, model chain), so it stays in its feature folder (`generate-image/`), not `_shared/`. `ai-image-worker` is part of the same feature and imports `../generate-image/runImageGeneration.ts` and `../generate-image/imageFailure.ts`. Precedent: `ai-knowledge-excel-worker/index.ts:3-4` imports `../ai-knowledge-ingest/*`.
- **The migration carries no `BEGIN`/`COMMIT`.** The SQL proof re-applies it with `\ir` twice inside one transaction.
- **Copy:** no new `t()` keys. The i18n gate (`npm run check:i18n`) checks keys only, and Phase B reuses the existing `imageGen.*` keys.
- Never commit `graphify-out/`, logs, `.env*` or secrets. Commit with `git commit -- <paths>`.
- Every command runs from the worktree: `cd /f/Dev/Worktrees/Postora_new/background-workers && ...`.
- Deno binary: `/f/Dev/Runtimes/deno-bin/bin/deno.exe` (CI uses `deno`). The generate-image graph typechecks **without** the process-post import map. Today `deno check --node-modules-dir=none supabase/functions/generate-image/index.ts` reports exactly the two errors above, and Task 2 fixes them.

## Decisions with evidence

| # | Decision | Evidence |
|---|---|---|
| D1 | Today the row is written only after a successful Higgsfield call, never before dispatch, and non-Higgsfield providers write no row at all. Phase B writes the row at enqueue. | `generate-image/index.ts:951` inserts `status:'succeeded'` inside the Higgsfield success branch; `:973-990` (OpenAI/Google/Vercel) insert nothing |
| D2 | `ai_generation_jobs` columns `provider`, `model_id` and `credential_source` are NOT NULL, `credential_source` is `CHECK IN ('platform','byo')` and `status` has no CHECK. The enqueue row therefore uses placeholders that the worker overwrites on completion: `provider='postora'`, `model_id = requested ?? 'auto'`, `credential_source='platform'`. | `20260820130000_higgsfield_oauth_and_generation.sql` (table DDL); the status values used in code are `queued/running/archiving/succeeded/failed/timeout` |
| D3 | The table has owner-only SELECT under RLS. The worker writes as service role, and `user_id` comes from the claimed row, never from a body. | policy `ai_generation_jobs_owner_select ... USING (auth.uid() = user_id)` in the same migration; §13/§14 |
| D4 | A worker job is recognised by `modality='image' AND params->>'worker'='true'`, which is set at enqueue and kept on completion. Video rows always carry `provider_job_id`, and sync Higgsfield rows have no `params.worker`. | `generate-video/index.ts:84-89,139+`; `generate-image/index.ts:951` |
| D5 | `ai-generation-status` must short-circuit worker jobs **before** its 30-minute timeout branch. That branch releases quota for any `platform` row, which would refund a reservation the worker never made, because the enqueue placeholder is `platform`. | `ai-generation-status/index.ts:36-51` |
| D6 | The BYO concurrency gate counts `byo` rows in `queued/running`. A queued worker job is a `platform` placeholder, so it is not counted. The chain still calls `checkByoGenerationLimits` before every BYO Higgsfield dispatch, and a BYO success is written back as `credential_source='byo'`, which keeps the hourly count the same as sync. | `_shared/higgsfield-rate-limit.ts`; `generate-image/index.ts:903-906` |
| D7 | Lease is `3 minutes`, longer than the 150 s worker lifetime. A job is claimed only when ≥ 100 s of the worker's lifetime remain, and provider calls are capped at `workerStart + 140 s`. A live worker therefore never loses its lease. | `process-post/deferredPublish.ts:175` (`WORKER_LIFETIME_MS`, `refuseOnSpentWorker`), `process-post/index.ts:175` (module-level `WORKER_STARTED_AT_MS`), `docs/runbooks/deploy-edge-function.md` (`workerTimeoutMs` 150 s) |
| D8 | Both doors (`ai-image-worker`, and the kick from `generate-image`) return before the work ends: the worker answers 202 and runs in `runInBackground`. pg_net's request timeout and the gateway's ~60 s response limit then never cut a generation. | `_shared/aiImageJob.ts:1-3` (~60 s gateway limit), `_shared/background.ts` (`waitUntil` keeps work alive after the Response) |
| D9 | The kick authenticates with the service-role bearer, which `verifyCronAuth` accepts. `config.toml` gets `[functions.ai-image-worker] verify_jwt = false`. config.toml governs only the local CLI, and the self-hosted runtime routes by folder. | `_shared/cron-auth.ts:64`; `supabase/config.toml:56-58` (`process-store-events` precedent) |
| D10 | Callers keep receiving `data:` URLs, as they do today. The YouTube thumbnail is persisted as `settings.thumbnailUrl` and the MediaNode re-uploads `data:` URLs. A signed storage URL would expire before a scheduled post publishes. | `useYouTubeThumbnails.tsx:119-131`, `YouTubeSettings.tsx:787`, `MediaNode.tsx:145-157` |
| D11 | `useAiGenerationJob`'s only consumer today is `VideoGenerator.tsx:65`. Its fields (`status, videoUrl, imageUrl, error, isPolling, elapsedSeconds`) are kept, and `errorCode` is added. | `src/components/post/VideoGenerator.tsx:24,65` |
| D12 | The spec's "reserve quota at claim" is replaced. Quota is metered only for platform Higgsfield candidates (`reserve_ai_generation_quota`), so reserving at claim would charge users whose chain resolves to OpenAI/Gemini. | `generate-image/index.ts:908-913` |

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `supabase/migrations/20261107120000_ai_image_jobs_worker.sql` | Create | Claim columns, partial index, payload table, `claim_ai_image_jobs`, `complete_ai_image_job`, Realtime membership, two crons |
| `supabase/tests/ai_image_jobs_worker.sql` | Create | SQL proof (claims, fences, RLS, grants, publication, cron) |
| `scripts/db-harness.sh` | Modify | Register the suite after `publish_requests.sql` |
| `supabase/functions/generate-image/imageFailure.ts` (+ `.test.ts`) | Create | Pure `describeImageFailure(errMsg)`: today's catch mapping, used by sync and the worker |
| `supabase/functions/generate-image/runImageGeneration.ts` (+ `.test.ts`) | Create | Prompt builder, model chain, provider calls, `runImageGeneration(deps, job)` |
| `supabase/functions/generate-image/asyncJob.ts` (+ `.test.ts`) | Create | Pure enqueue row builders and the worker kick |
| `supabase/functions/generate-image/index.ts` | Modify | Adapter: gates, then the sync path via the runner, or the async enqueue |
| `supabase/functions/ai-image-worker/worker.ts` (+ `.test.ts`) | Create | Ports, limits, `runAiImageWorker(ports)` |
| `supabase/functions/ai-image-worker/deps.ts` | Create | Real ports over the admin client |
| `supabase/functions/ai-image-worker/index.ts` | Create | Cron-auth door, answers 202 and runs the tick in `runInBackground` |
| `supabase/functions/ai-generation-status/workerImageJob.ts` (+ `.test.ts`) | Create | Pure predicate and response shape for worker image jobs |
| `supabase/functions/ai-generation-status/index.ts` | Modify | Short-circuit before the timeout branch |
| `supabase/config.toml` | Modify | `[functions.ai-image-worker] verify_jwt = false` |
| `src/lib/aiGenerationJobWatcher.ts` (+ `src/lib/__tests__/aiGenerationJobWatcher.test.ts`) | Create | Realtime + polling watcher, `awaitAiGenerationJob`, `resolveAiImageResponse` |
| `src/hooks/useAiGenerationJob.ts` (+ `src/hooks/__tests__/useAiGenerationJob.test.tsx`) | Modify / Create | Thin hook over the watcher |
| `src/components/post/ImageGenerator.tsx` | Modify | `async: true`, resolve through the watcher, map the new codes |
| `src/components/canvas/nodes/CaptionNode.tsx` | Modify | `async: true`, resolve, surface failure |
| `src/components/canvas/nodes/MediaNode.tsx` | Modify | `async: true`, resolve, surface failure |
| `src/hooks/useYouTubeThumbnails.tsx` (+ its test) | Modify | `async: true`, resolve, surface failure |
| `src/integrations/supabase/types.ts` | Modify | New columns, payload table, two RPCs |
| `.github/workflows/ci.yml` | Modify | New step "Typecheck and test AI image generation jobs" |

---

### Task 1: Migration and SQL proof

**Files:**
- Create: `supabase/migrations/20261107120000_ai_image_jobs_worker.sql`
- Create: `supabase/tests/ai_image_jobs_worker.sql`
- Modify: `scripts/db-harness.sh` (SUITES array, after `publish_requests.sql` at line 141)

**Interfaces:**
- Produces (consumed by Tasks 4-5):
  - `claim_ai_image_jobs(p_limit integer, p_lease interval) RETURNS SETOF ai_generation_jobs`.
  - `complete_ai_image_job(p_job_id uuid, p_claim_token uuid, p_status text, p_result_url text, p_result_data_url text, p_error text, p_provider text, p_model_id text, p_credential_source text, p_params jsonb) RETURNS boolean`.
  - Columns `claim_token uuid`, `claimed_at timestamptz`, `dispatched_at timestamptz`, `attempts integer NOT NULL DEFAULT 0`.
  - Table `ai_image_job_payloads(job_id, reference_images, result_data_url, created_at)`.

- [ ] **Step 1: Write the failing SQL proof** `supabase/tests/ai_image_jobs_worker.sql`:

```sql
-- ============================================================================
-- supabase/tests/ai_image_jobs_worker.sql
-- Phase B (migration 20261107120000_ai_image_jobs_worker.sql).
-- One transaction, labelled ASSERTs, ROLLBACK, sentinel last.
--   W1  the migration applies twice (idempotent) and the crons exist once each
--   W2  two claims never return the same job (SKIP LOCKED + status flip)
--   W3  a claim sets running, a fresh token, claimed_at and attempts+1
--   W4  an expired, undispatched lease is re-claimed with a NEW token
--   W5  an expired, dispatched lease is failed (ai_interrupted), never re-claimed
--   W6  an expired lease with attempts >= 3 is failed (ai_attempts_exhausted)
--   W7  a job queued for over 15 minutes is timed out (ai_queue_timeout)
--   W8  complete with a stale token writes nothing and returns false
--   W9  complete with the live token writes job + payload, clears references
--   W10 a video row and a sync image row are never claimed
--   W11 owner sees own job, not another user's; authenticated cannot read
--       payloads or execute the two RPCs
--   W12 ai_generation_jobs is in supabase_realtime, payloads are not
--   W13 cron commands resolve the secret at run time, no literal credential
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
  j1 uuid; j2 uuid; j3 uuid; j_video uuid; j_sync uuid;
  r1 public.ai_generation_jobs; r2 public.ai_generation_jobs;
  tok uuid; n int; ok boolean;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'ai-image-worker-a@example.invalid'),
    (u_b, 'ai-image-worker-b@example.invalid');

  INSERT INTO public.ai_generation_jobs (user_id, provider, model_id, modality, credential_source, status, params, created_at)
  VALUES (u_a, 'postora', 'auto', 'image', 'platform', 'queued', '{"worker":true,"prompt":"a"}', now() - interval '2 minutes')
  RETURNING id INTO j1;
  INSERT INTO public.ai_generation_jobs (user_id, provider, model_id, modality, credential_source, status, params, created_at)
  VALUES (u_a, 'postora', 'auto', 'image', 'platform', 'queued', '{"worker":true,"prompt":"b"}', now() - interval '1 minute')
  RETURNING id INTO j2;
  INSERT INTO public.ai_image_job_payloads (job_id, reference_images) VALUES
    (j1, '[{"url":"data:image/png;base64,AAAA","type":"style","priority":1}]'), (j2, '[]');
  INSERT INTO public.ai_generation_jobs (user_id, provider, model_id, modality, credential_source, status, provider_job_id, params)
  VALUES (u_a, 'higgsfield', 'v', 'video', 'platform', 'queued', 'pj-1', '{}') RETURNING id INTO j_video;
  INSERT INTO public.ai_generation_jobs (user_id, provider, model_id, modality, credential_source, status, result_url, params)
  VALUES (u_a, 'higgsfield', 'i', 'image', 'platform', 'succeeded', 'https://x.invalid/i.png', '{"prompt":"s"}') RETURNING id INTO j_sync;

  -- W2/W3
  SELECT * INTO r1 FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  SELECT * INTO r2 FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  ASSERT r1.id = j1, 'W2: oldest queued job is claimed first';
  ASSERT r2.id = j2, 'W2: second claim returns the other job';
  ASSERT r1.status = 'running' AND r1.claim_token IS NOT NULL AND r1.claimed_at IS NOT NULL AND r1.attempts = 1,
    'W3: claim sets running, token, claimed_at, attempts+1';
  SELECT count(*) INTO n FROM public.claim_ai_image_jobs(5, interval '3 minutes');
  ASSERT n = 0, 'W10: video and sync rows are never claimed; nothing else is due';

  -- W4: expire j1's lease without dispatch -> re-claimed with a new token
  tok := r1.claim_token;
  UPDATE public.ai_generation_jobs SET claimed_at = now() - interval '4 minutes' WHERE id = j1;
  SELECT * INTO r1 FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  ASSERT r1.id = j1 AND r1.claim_token <> tok AND r1.attempts = 2, 'W4: undispatched expired lease is re-claimed';

  -- W8: the old token is fenced out
  SELECT public.complete_ai_image_job(j1, tok, 'succeeded', 'https://x.invalid/stale.png', NULL, NULL, 'google', 'm', 'platform', '{}') INTO ok;
  ASSERT ok IS FALSE, 'W8: stale token returns false';
  ASSERT (SELECT status FROM public.ai_generation_jobs WHERE id = j1) = 'running', 'W8: stale token writes nothing';

  -- W9
  SELECT public.complete_ai_image_job(j1, r1.claim_token, 'succeeded', NULL, 'data:image/png;base64,BBBB', NULL,
    'google', 'gemini-2.5-flash-image', 'platform', '{"description":"ok"}') INTO ok;
  ASSERT ok, 'W9: live token completes';
  ASSERT (SELECT status = 'succeeded' AND provider = 'google' AND claim_token IS NULL AND params->>'worker' = 'true'
            AND params->>'description' = 'ok' FROM public.ai_generation_jobs WHERE id = j1), 'W9: job row written, marker kept';
  ASSERT (SELECT reference_images = '[]'::jsonb AND result_data_url = 'data:image/png;base64,BBBB'
            FROM public.ai_image_job_payloads WHERE job_id = j1), 'W9: payload result stored, references cleared';
  SELECT public.complete_ai_image_job(j1, r1.claim_token, 'failed', NULL, NULL, 'x', NULL, NULL, NULL, '{}') INTO ok;
  ASSERT ok IS FALSE, 'W9: a terminal job cannot be completed twice';

  -- W5: dispatched + expired -> failed, never re-claimed
  UPDATE public.ai_generation_jobs SET dispatched_at = now() - interval '4 minutes', claimed_at = now() - interval '4 minutes' WHERE id = j2;
  SELECT count(*) INTO n FROM public.claim_ai_image_jobs(5, interval '3 minutes');
  ASSERT n = 0, 'W5: dispatched job is not re-claimed';
  ASSERT (SELECT status = 'failed' AND params->>'error_code' = 'ai_interrupted' AND claim_token IS NULL
            FROM public.ai_generation_jobs WHERE id = j2), 'W5: dispatched expired job failed as interrupted';

  -- W6
  INSERT INTO public.ai_generation_jobs (user_id, provider, model_id, modality, credential_source, status, params, claimed_at, attempts, claim_token)
  VALUES (u_a, 'postora', 'auto', 'image', 'platform', 'running', '{"worker":true}', now() - interval '4 minutes', 3, gen_random_uuid())
  RETURNING id INTO j3;
  PERFORM public.claim_ai_image_jobs(5, interval '3 minutes');
  ASSERT (SELECT status = 'failed' AND params->>'error_code' = 'ai_attempts_exhausted' FROM public.ai_generation_jobs WHERE id = j3),
    'W6: exhausted attempts fail';

  -- W7
  INSERT INTO public.ai_generation_jobs (user_id, provider, model_id, modality, credential_source, status, params, created_at)
  VALUES (u_a, 'postora', 'auto', 'image', 'platform', 'queued', '{"worker":true}', now() - interval '16 minutes')
  RETURNING id INTO j3;
  PERFORM public.claim_ai_image_jobs(1, interval '3 minutes');
  ASSERT (SELECT status = 'timeout' AND params->>'error_code' = 'ai_queue_timeout' FROM public.ai_generation_jobs WHERE id = j3),
    'W7: stale queued job timed out';

  -- W12
  ASSERT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'ai_generation_jobs'),
    'W12: jobs are published';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'ai_image_job_payloads'),
    'W12: payloads are not published';

  -- W11: grants (checked as metadata, role switch below proves RLS)
  ASSERT NOT has_function_privilege('authenticated', 'public.claim_ai_image_jobs(integer, interval)', 'EXECUTE'), 'W11: authenticated cannot claim';
  ASSERT NOT has_function_privilege('anon', 'public.claim_ai_image_jobs(integer, interval)', 'EXECUTE'), 'W11: anon cannot claim';
  ASSERT NOT has_function_privilege('authenticated',
    'public.complete_ai_image_job(uuid, uuid, text, text, text, text, text, text, text, jsonb)', 'EXECUTE'), 'W11: authenticated cannot complete';
  ASSERT has_function_privilege('service_role', 'public.claim_ai_image_jobs(integer, interval)', 'EXECUTE'), 'W11: service_role can claim';
  ASSERT NOT has_table_privilege('authenticated', 'public.ai_image_job_payloads', 'SELECT'), 'W11: authenticated cannot read payloads';

  -- W13
  ASSERT (SELECT count(*) FROM cron.job WHERE jobname = 'ai-image-worker') = 1, 'W1/W13: one worker cron';
  ASSERT (SELECT count(*) FROM cron.job WHERE jobname = 'purge-ai-image-payloads') = 1, 'W1/W13: one purge cron';
  ASSERT (SELECT schedule FROM cron.job WHERE jobname = 'ai-image-worker') = '* * * * *', 'W13: worker every minute';
  ASSERT (SELECT position('get_cron_secret()' in command) > 0 AND position('Bearer ' in command) > 0
            AND command !~ '''[A-Za-z0-9_-]{24,}''' AND command !~ '[A-Za-z0-9_-]{40,}'
            AND position('/functions/v1/ai-image-worker' in command) > 0
          FROM cron.job WHERE jobname = 'ai-image-worker'), 'W13: no literal secret, correct URL';
  ASSERT NOT EXISTS (
    SELECT jobname, schedule, command FROM _cron_before
    EXCEPT SELECT jobname, schedule, command FROM cron.job
  ), 'W13: other cron jobs unchanged';
END
$t$;

-- W11: RLS as an authenticated owner and as a stranger
SELECT set_config('request.jwt.claims', '{"sub":"b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2', true);
SET LOCAL ROLE authenticated;
DO $rls$
BEGIN
  ASSERT (SELECT count(*) FROM public.ai_generation_jobs) = 0, 'W11: stranger sees no jobs of user A';
END
$rls$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"b1b1b1b1-1111-4111-8111-b1b1b1b1b1b1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', 'b1b1b1b1-1111-4111-8111-b1b1b1b1b1b1', true);
SET LOCAL ROLE authenticated;
DO $rls$
BEGIN
  ASSERT (SELECT count(*) FROM public.ai_generation_jobs) >= 2, 'W11: owner sees own jobs';
END
$rls$;
RESET ROLE;

ROLLBACK;
\echo '=== ai_image_jobs_worker: ALL CHECKS PASSED ==='
```

- [ ] **Step 2: Register the suite.** In `scripts/db-harness.sh`, add `  ai_image_jobs_worker.sql` on the line after `  publish_requests.sql` (line 141).

- [ ] **Step 3: Run it and watch it fail.** The migration file is missing, so `\ir` aborts.

Run: `cd /f/Dev/Worktrees/Postora_new/background-workers && bash scripts/db-harness.sh`
Expected: FAIL on `ai_image_jobs_worker.sql` (`No such file`).

- [ ] **Step 4: Write the migration** `supabase/migrations/20261107120000_ai_image_jobs_worker.sql`:

```sql
-- Phase B: AI image generation as a background job.
-- Applied by hand on production BEFORE the functions merge (deploy runbook);
-- re-applied twice inside one transaction by supabase/tests/ai_image_jobs_worker.sql,
-- so this file must stay idempotent and carry no BEGIN/COMMIT.

ALTER TABLE public.ai_generation_jobs
  ADD COLUMN IF NOT EXISTS claim_token   uuid,
  ADD COLUMN IF NOT EXISTS claimed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts      integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.ai_generation_jobs.dispatched_at IS
  'Set by ai-image-worker just before the first billable call. A job with this set is never re-run: its outcome is indeterminate.';

-- Only worker image jobs are ever queued/running with modality = image
-- (sync Higgsfield rows are inserted already succeeded).
CREATE INDEX IF NOT EXISTS ai_generation_jobs_image_worker_queue_idx
  ON public.ai_generation_jobs (created_at)
  WHERE modality = 'image' AND status IN ('queued', 'running');

-- Heavy bytes off the published row: up to five reference data URLs and the
-- data: URL result of OpenAI/Gemini/Vercel. Service role only; no policies.
CREATE TABLE IF NOT EXISTS public.ai_image_job_payloads (
  job_id           uuid PRIMARY KEY REFERENCES public.ai_generation_jobs(id) ON DELETE CASCADE,
  reference_images jsonb NOT NULL DEFAULT '[]'::jsonb,
  result_data_url  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_image_job_payloads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_image_job_payloads FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_image_job_payloads TO service_role;

CREATE OR REPLACE FUNCTION public.claim_ai_image_jobs(
  p_limit integer DEFAULT 1,
  p_lease interval DEFAULT interval '3 minutes'
) RETURNS SETOF public.ai_generation_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- (a) Dispatched, lease expired: the provider may have produced (and billed)
  -- an image we never saw. Indeterminate: fail it, never re-run, never release.
  WITH done AS (
    UPDATE public.ai_generation_jobs
       SET status = 'failed',
           error = 'The generation was interrupted before it finished. Please try again.',
           params = params || jsonb_build_object('error_code', 'ai_interrupted'),
           claim_token = NULL, updated_at = now()
     WHERE modality = 'image' AND params->>'worker' = 'true'
       AND status = 'running' AND dispatched_at IS NOT NULL AND claimed_at < now() - p_lease
    RETURNING id)
  UPDATE public.ai_image_job_payloads SET reference_images = '[]'::jsonb WHERE job_id IN (SELECT id FROM done);

  -- (b) Never dispatched but out of attempts.
  WITH done AS (
    UPDATE public.ai_generation_jobs
       SET status = 'failed',
           error = 'Image generation could not be started. Please try again.',
           params = params || jsonb_build_object('error_code', 'ai_attempts_exhausted'),
           claim_token = NULL, updated_at = now()
     WHERE modality = 'image' AND params->>'worker' = 'true'
       AND status = 'running' AND dispatched_at IS NULL AND claimed_at < now() - p_lease AND attempts >= 3
    RETURNING id)
  UPDATE public.ai_image_job_payloads SET reference_images = '[]'::jsonb WHERE job_id IN (SELECT id FROM done);

  -- (c) Queued too long (the worker has been down): nothing was reserved.
  WITH done AS (
    UPDATE public.ai_generation_jobs
       SET status = 'timeout',
           error = 'Image generation did not start in time. Please try again.',
           params = params || jsonb_build_object('error_code', 'ai_queue_timeout'),
           updated_at = now()
     WHERE modality = 'image' AND params->>'worker' = 'true'
       AND status = 'queued' AND created_at < now() - interval '15 minutes'
    RETURNING id)
  UPDATE public.ai_image_job_payloads SET reference_images = '[]'::jsonb WHERE job_id IN (SELECT id FROM done);

  -- (d) Claim: queued, or an expired lease that never dispatched.
  RETURN QUERY
  WITH due AS (
    SELECT id FROM public.ai_generation_jobs
     WHERE modality = 'image' AND params->>'worker' = 'true'
       AND (status = 'queued'
            OR (status = 'running' AND dispatched_at IS NULL AND claimed_at < now() - p_lease AND attempts < 3))
     ORDER BY created_at
     LIMIT GREATEST(p_limit, 0)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.ai_generation_jobs j
     SET status = 'running', claim_token = gen_random_uuid(), claimed_at = now(),
         attempts = j.attempts + 1, updated_at = now()
    FROM due
   WHERE j.id = due.id
  RETURNING j.*;
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
     SET status = p_status,
         result_url = p_result_url,
         error = p_error,
         provider = COALESCE(p_provider, provider),
         model_id = COALESCE(p_model_id, model_id),
         credential_source = COALESCE(p_credential_source, credential_source),
         params = params || COALESCE(p_params, '{}'::jsonb),
         claim_token = NULL,
         updated_at = now()
   WHERE id = p_job_id AND claim_token = p_claim_token AND status = 'running'
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN false;  -- stale token: another worker owns (or finished) this job
  END IF;

  UPDATE public.ai_image_job_payloads
     SET reference_images = '[]'::jsonb, result_data_url = p_result_data_url
   WHERE job_id = p_job_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ai_image_jobs(integer, interval) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_ai_image_job(uuid, uuid, text, text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_image_jobs(integer, interval) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_ai_image_job(uuid, uuid, text, text, text, text, text, text, text, jsonb) TO service_role;

-- Realtime: the owner's browser listens for its job row (RLS owner policy applies).
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

  -- Results are collected within seconds; a day is generous.
  PERFORM cron.schedule('purge-ai-image-payloads', '17 * * * *', $cron$
    DELETE FROM public.ai_image_job_payloads WHERE created_at < now() - interval '24 hours';
  $cron$);
END
$do_cron_ai_image$;
```

- [ ] **Step 5: Run the harness. It must pass.**

Run: `cd /f/Dev/Worktrees/Postora_new/background-workers && bash scripts/db-harness.sh`
Expected: `=== ai_image_jobs_worker: ALL CHECKS PASSED ===` and every other suite still passes.

- [ ] **Step 6: Commit.**

```bash
cd /f/Dev/Worktrees/Postora_new/background-workers && git add supabase/migrations/20261107120000_ai_image_jobs_worker.sql supabase/tests/ai_image_jobs_worker.sql && git commit -m "feat(ai-image): claim, fence and realtime for background image jobs" -- supabase/migrations/20261107120000_ai_image_jobs_worker.sql supabase/tests/ai_image_jobs_worker.sql scripts/db-harness.sh
```

---

### Task 2: Pure failure mapping and the runner extraction

**Files:**
- Create: `supabase/functions/generate-image/imageFailure.ts`, `imageFailure.test.ts`
- Create: `supabase/functions/generate-image/runImageGeneration.ts`, `runImageGeneration.test.ts`
- Modify: `supabase/functions/generate-image/index.ts`

**Interfaces:**
- Produces `describeImageFailure(errMsg: string): { code: string; message: string }`. It is consumed by the sync catch in `index.ts` and by `ai-image-worker/worker.ts`.
- Produces from `runImageGeneration.ts`, consumed by `generate-image/index.ts` (sync) and `ai-image-worker/deps.ts`:

```ts
export interface ImageJobInput {
  userId: string;
  prompt: string;
  requestedModel?: string;
  aspectRatio?: string;
  quality?: string;
  references: ReferenceInput[];
  /** Epoch ms after which no new candidate starts; Number.POSITIVE_INFINITY on the sync path. */
  deadlineMs: number;
}
export type ImageRunResult =
  | { kind: "succeeded"; imageUrl: string; description: string; usedModel: ResolvedModel;
      credentialSource: "platform" | "byo"; attemptErrors: string[] }
  | { kind: "refused"; status: 402 | 429; message: string; errorCode: "ai_quota_exhausted" | "ai_rate_limited" }
  | { kind: "lease_lost" }
  | { kind: "failed"; message: string; attemptErrors: string[] };
export interface ImageRunDeps {
  now(): number;
  /** Called once, right before the first billable step. false = lease lost, abort. */
  onDispatch(): Promise<boolean>;
  resolveChain(requestedModel?: string): Promise<ResolvedModel[]>;
  getApiKey(m: ResolvedModel): Promise<string | null>;
  generateWithModel(m: ResolvedModel, apiKey: string, prompt: string, aspectRatio: string,
    references: ReferenceInput[], timeoutMs?: number): Promise<{ imageUrl: string; description: string }>;
  resolveHiggsfieldCredential(userId: string): Promise<{ source: "platform" | "byo" }>;
  checkByoLimits(userId: string): Promise<{ allowed: boolean; error?: string }>;
  reserveQuota(userId: string): Promise<boolean>;
  releaseQuota(userId: string): Promise<void>;
  generateWithHiggsfield(input: { m: ResolvedModel; cred: unknown; prompt: string; rawPrompt: string;
    aspectRatio?: string; references: ReferenceInput[]; userId: string }): Promise<{ url: string; params: Record<string, unknown> }>;
  /** Sync path inserts today's succeeded row (index.ts:951); the worker passes a no-op. */
  recordHiggsfieldSuccess(row: { userId: string; m: ResolvedModel; credentialSource: string; url: string;
    rawPrompt: string; params: Record<string, unknown>; reserved: boolean }): Promise<void>;
}
export function buildImagePrompt(prompt: string, references: ReferenceInput[], aspectRatio?: string, quality?: string): string;
export function defaultImageRunDeps(admin: any, overrides: Pick<ImageRunDeps, "onDispatch" | "recordHiggsfieldSuccess">): ImageRunDeps;
export async function runImageGeneration(deps: ImageRunDeps, job: ImageJobInput): Promise<ImageRunResult>;
export const MIN_ATTEMPT_MS = 20_000;
export type { ResolvedModel };
```

- [ ] **Step 1: Write the failing `imageFailure.test.ts`.**

```ts
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { describeImageFailure } from "./imageFailure.ts";

Deno.test("all providers failed maps to ai_not_configured with the detail kept", () => {
  const r = describeImageFailure("All image providers failed. Attempts: [x] google/m: missing KEY");
  assertEquals(r.code, "ai_not_configured");
  assertStringIncludes(r.message, "missing KEY");
});
Deno.test("each known phrase maps to its code", () => {
  assertEquals(describeImageFailure("Unsupported provider foo").code, "ai_provider_unsupported");
  assertEquals(describeImageFailure("no credits left").code, "ai_credits_exhausted");
  assertEquals(describeImageFailure("Rate limit hit").code, "ai_rate_limited");
  assertEquals(describeImageFailure("Google returned no image: {}").code, "ai_no_image");
  assertEquals(describeImageFailure("empty response").code, "ai_gateway_empty");
  assertEquals(describeImageFailure("Google API 500").code, "ai_gateway_error");
});
Deno.test("unknown errors keep the raw text under ai_error", () => {
  assertEquals(describeImageFailure("boom"), { code: "ai_error", message: "Image generation failed: boom" });
});
```

- [ ] **Step 2: Run it and watch it fail** (module missing).

Run: `cd /f/Dev/Worktrees/Postora_new/background-workers && /f/Dev/Runtimes/deno-bin/bin/deno.exe test --node-modules-dir=none --allow-env supabase/functions/generate-image/imageFailure.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Create `imageFailure.ts`.** Move the mapping block from `index.ts:1077-1107` verbatim into this function. Do not change the order of the branches or their copy:

```ts
/**
 * Caller-facing code and message for a failed image generation. One mapping for the
 * synchronous response (generate-image) and the background job row (ai-image-worker).
 */
export function describeImageFailure(errMsg: string): { code: string; message: string } {
  const lower = errMsg.toLowerCase();
  if (lower.includes("all image providers failed") || lower.includes("missing ")) {
    return {
      code: "ai_not_configured",
      message: `Image generation is not configured. Set the provider API key (e.g. OPENAI_API_KEY or GOOGLE_AI_STUDIO_KEY) for the model selected in admin settings. ${errMsg}`,
    };
  }
  if (lower.includes("unsupported provider")) {
    return { code: "ai_provider_unsupported", message: `The configured image provider is not supported by this function. ${errMsg}` };
  }
  if (lower.includes("credits")) return { code: "ai_credits_exhausted", message: "AI credits exhausted. Please add credits to continue." };
  if (lower.includes("rate limit")) return { code: "ai_rate_limited", message: "Too many requests. Please wait a moment and try again." };
  if (lower.includes("did not return an image") || lower.includes("no image")) {
    return { code: "ai_no_image", message: `The model could not generate an image. ${errMsg}` };
  }
  if (lower.includes("empty response")) return { code: "ai_gateway_empty", message: `The AI gateway returned an empty response. ${errMsg}` };
  if (lower.includes("gateway") || lower.includes("google api")) return { code: "ai_gateway_error", message: `AI provider error: ${errMsg}` };
  return { code: "ai_error", message: `Image generation failed: ${errMsg}` };
}
```

In `index.ts`, replace lines 1077-1107 with:

```ts
    const { code: error_code, message } = describeImageFailure(errMsg);
    return jsonResponse({ success: false, error_code, message }, 200);
```

Add `import { describeImageFailure } from "./imageFailure.ts";`. Run the test: PASS.

- [ ] **Step 4: Write the failing `runImageGeneration.test.ts`.** The fake `deps` record each call, and every test is offline.

```ts
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runImageGeneration, type ImageRunDeps, type ResolvedModel, MIN_ATTEMPT_MS } from "./runImageGeneration.ts";

const google: ResolvedModel = { provider_code: "google", api_type: "google", model_id: "gemini-2.5-flash-image",
  api_endpoint: "https://g.invalid", api_key_env_var: "GOOGLE_AI_STUDIO_KEY", admin_params: {}, source: "primary" } as ResolvedModel;
const higgs: ResolvedModel = { ...google, provider_code: "higgsfield", api_type: "higgsfield", model_id: "hf-img", source: "primary" } as ResolvedModel;

function fakeDeps(over: Partial<ImageRunDeps> = {}) {
  const calls: string[] = [];
  const deps: ImageRunDeps = {
    now: () => 1_000,
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
const job = { userId: "u", prompt: "p", references: [], deadlineMs: Number.POSITIVE_INFINITY };

Deno.test("first provider succeeds: one dispatch, no quota", async () => {
  const { deps, calls } = fakeDeps();
  const r = await runImageGeneration(deps, job);
  assertEquals(r.kind, "succeeded");
  assertEquals(calls, ["dispatch", "gen:gemini-2.5-flash-image"]);
});
Deno.test("platform Higgsfield failure releases once and falls through", async () => {
  const { deps, calls } = fakeDeps({
    resolveChain: async () => [higgs, google],
    generateWithHiggsfield: async () => { calls.push("hf"); throw new Error("hf down"); },
  });
  const r = await runImageGeneration(deps, job);
  assertEquals(r.kind, "succeeded");
  assertEquals(calls, ["dispatch", "reserve", "hf", "release", "gen:gemini-2.5-flash-image"]);
});
Deno.test("platform quota refused is a 402 refusal, no provider call", async () => {
  const { deps, calls } = fakeDeps({ resolveChain: async () => [higgs], reserveQuota: async () => false });
  const r = await runImageGeneration(deps, job);
  assertEquals(r, { kind: "refused", status: 402, message: "Daily AI generation limit reached", errorCode: "ai_quota_exhausted" });
  assert(!calls.includes("hf"));
});
Deno.test("BYO limit refused is a 429 refusal before any dispatch", async () => {
  const { deps, calls } = fakeDeps({
    resolveChain: async () => [higgs],
    resolveHiggsfieldCredential: async () => ({ source: "byo" }),
    checkByoLimits: async () => ({ allowed: false, error: "Too many BYO jobs" }),
  });
  const r = await runImageGeneration(deps, job);
  assertEquals(r, { kind: "refused", status: 429, message: "Too many BYO jobs", errorCode: "ai_rate_limited" });
  assertEquals(calls, []);
});
Deno.test("lost lease aborts before any billable call", async () => {
  const { deps, calls } = fakeDeps({ onDispatch: async () => false });
  assertEquals((await runImageGeneration(deps, job)).kind, "lease_lost");
  assertEquals(calls, []);
});
Deno.test("no time left: no candidate starts", async () => {
  const { deps, calls } = fakeDeps({ now: () => 10_000 });
  const r = await runImageGeneration(deps, { ...job, deadlineMs: 10_000 + MIN_ATTEMPT_MS - 1 });
  assertEquals(r.kind, "failed");
  assertEquals(calls, []);
});
Deno.test("finite deadline caps the provider timeout", async () => {
  let seen: number | undefined;
  const { deps } = fakeDeps({
    now: () => 0,
    generateWithModel: async (_m, _k, _p, _a, _r, t) => { seen = t; return { imageUrl: "data:x", description: "" }; },
  });
  await runImageGeneration(deps, { ...job, deadlineMs: 90_000 });
  assertEquals(seen, 90_000);
});
Deno.test("dispatch is reported once across several candidates", async () => {
  const { deps, calls } = fakeDeps({
    resolveChain: async () => [google, { ...google, model_id: "second" } as ResolvedModel],
    generateWithModel: async (m) => { calls.push(`gen:${m.model_id}`); if (m.model_id !== "second") throw new Error("x"); return { imageUrl: "data:y", description: "" }; },
  });
  await runImageGeneration(deps, job);
  assertEquals(calls.filter((c) => c === "dispatch").length, 1);
});
Deno.test("every candidate failing reports today's message", async () => {
  const { deps } = fakeDeps({ getApiKey: async () => null });
  const r = await runImageGeneration(deps, job);
  assert(r.kind === "failed" && r.message.startsWith("All image providers failed. Attempts: "));
});
```

- [ ] **Step 5: Run it and watch it fail** (module missing).

Run: `cd /f/Dev/Worktrees/Postora_new/background-workers && /f/Dev/Runtimes/deno-bin/bin/deno.exe test --node-modules-dir=none --allow-env supabase/functions/generate-image/runImageGeneration.test.ts`

- [ ] **Step 6: Create `runImageGeneration.ts` by moving code out of `index.ts`.**

Move these blocks verbatim:
- the `ResolvedModel` interface and `HARDCODED_FALLBACK` (`:50-75`);
- `lookupModelByProviderAndId`, `getSystemSettingModel`, `resolveModelChain` and `getProviderApiKey` (`:76-180`);
- the reference constants and `fetchReference`, `readBoundedBody`, `readReferenceBytes`, `publicSupabaseOrigin`, `stageReferenceUrl` and `importReferences` (`:184-380`);
- `OPENAI_SIZE_MAP`, `callOpenAIImages`, `callGoogleGenerateContent` and `generateWithModel` (`:382-484`).

Move with them the imports they use: `base64Encode`, `resolveHiggsfieldCredential`, `HiggsfieldMcpClient`/`findOutputUrl`, `checkByoGenerationLimits`, the model-spec helpers, `image-references`, `vercelGenerateImage` and `pickRequestedModelRow`.

Make only these edits while moving:
- `readReferenceBytes` (was `:268`): `const bytes = await readBoundedBody(resp); return { mimeType, base64: base64Encode(new Uint8Array(bytes).buffer) };`.
- `callOpenAIImages(m, apiKey, prompt, aspectRatio, timeoutMs = 230_000)`: use `setTimeout(() => controller.abort(), timeoutMs)`.
- `callGoogleGenerateContent(..., references, timeoutMs?: number)`: pass `signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined` to its `fetch`.
- `generateWithModel(m, apiKey, prompt, aspectRatio, references, timeoutMs?: number)`: forward `timeoutMs` to the two calls above. Vercel keeps its own 50 s cap (`vercelGateway.ts:83`).

Then add `buildImagePrompt`. Its body is `index.ts:849-883` (the `referenceContext` and `fullPrompt` template) moved verbatim and returning `fullPrompt`.

Add `defaultImageRunDeps`, which wires the real implementations:
- `reserveQuota` runs `rpc('reserve_ai_generation_quota', { p_user_id })` and reads `allowed` as `index.ts:909-911` does.
- `releaseQuota` is `rpc('release_ai_generation_quota', ...)`.
- `generateWithHiggsfield` is the body of `index.ts:915-950`: catalog, spec, params, missing check, MCP client, `importReferences`, `callTool`, `findOutputUrl`, and the staged-path `finally` removal from `:960-967`. It returns `{ url, params }`.

Finally, add the runner:

```ts
export const MIN_ATTEMPT_MS = 20_000;

export async function runImageGeneration(deps: ImageRunDeps, job: ImageJobInput): Promise<ImageRunResult> {
  const fullPrompt = buildImagePrompt(job.prompt, job.references, job.aspectRatio, job.quality);
  const chain = await deps.resolveChain(job.requestedModel);
  console.log("[generate-image] resolved model chain:", chain.map((c) => `${c.source}:${c.provider_code}/${c.model_id}`).join(" → "));
  const attemptErrors: string[] = [];
  let dispatched = false;
  const dispatchOnce = async () => {
    if (dispatched) return true;
    dispatched = await deps.onDispatch();
    return dispatched;
  };
  const remainingMs = () => job.deadlineMs - deps.now();
  const timeoutFor = () => (Number.isFinite(job.deadlineMs) ? Math.max(remainingMs(), 1_000) : undefined);
  const record = (m: ResolvedModel, err: unknown) => {
    const msg = `[${m.source}] ${m.provider_code}/${m.model_id}: ${err instanceof Error ? err.message : String(err)}`;
    console.error(msg);
    attemptErrors.push(msg);
  };

  for (const m of chain) {
    if (remainingMs() < MIN_ATTEMPT_MS) {
      attemptErrors.push(`[deadline] no time left for ${m.provider_code}/${m.model_id}`);
      break;
    }
    if (m.provider_code === "higgsfield" || m.api_type === "higgsfield") {
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
      try {
        const out = await deps.generateWithHiggsfield({ m, cred, prompt: fullPrompt, rawPrompt: job.prompt,
          aspectRatio: job.aspectRatio, references: job.references, userId: job.userId });
        await deps.recordHiggsfieldSuccess({ userId: job.userId, m, credentialSource: cred.source, url: out.url,
          rawPrompt: job.prompt, params: out.params, reserved });
        return { kind: "succeeded", imageUrl: out.url, description: `Generated with Higgsfield ${m.model_id}`,
          usedModel: m, credentialSource: cred.source, attemptErrors };
      } catch (err) {
        if (reserved) await deps.releaseQuota(job.userId);
        record(m, err);
        continue;
      }
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
      const result = await deps.generateWithModel(m, apiKey, fullPrompt, job.aspectRatio ?? "", job.references, timeoutFor());
      return { kind: "succeeded", imageUrl: result.imageUrl, description: result.description, usedModel: m,
        credentialSource: "platform", attemptErrors };
    } catch (err) {
      record(m, err);
    }
  }
  return { kind: "failed", message: `All image providers failed. Attempts: ${attemptErrors.join(" | ")}`, attemptErrors };
}
```

`aspectRatio ?? ""` keeps today's runtime behaviour. Each provider treats `""` exactly as it treats `undefined`: `OPENAI_SIZE_MAP[""]` falls back to the default, the Google guard `aspectRatio &&` is falsy, and Vercel's regex fails. It also fixes the `:981` type error.

- [ ] **Step 7: Rewire the sync handler in `index.ts`.** Replace `:849-997` (prompt build, chain loop and `!usedModel` throw) with:

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
      { userId: user.id, prompt, requestedModel, aspectRatio, quality, references, deadlineMs: Number.POSITIVE_INFINITY },
    );
    if (run.kind === 'refused') return errorResponse(run.message, run.status);
    if (run.kind !== 'succeeded') throw new Error(run.kind === 'failed' ? run.message : 'lease lost');
    const { imageUrl, description, usedModel, attemptErrors } = run;
```

Keep `:999-1038` (success `system_logs` row and the response) unchanged. The names `imageUrl`, `description`, `usedModel` and `attemptErrors` are the same as before.

If `recordHiggsfieldSuccess` throws, the runner releases the quota and moves on. The old code did the same, because the insert sat inside the same `try` (`:951-953`). Behaviour is identical.

- [ ] **Step 8: Run the tests and the typecheck.**

Run: `cd /f/Dev/Worktrees/Postora_new/background-workers && /f/Dev/Runtimes/deno-bin/bin/deno.exe check --node-modules-dir=none supabase/functions/generate-image/index.ts && /f/Dev/Runtimes/deno-bin/bin/deno.exe test --node-modules-dir=none --allow-env supabase/functions/generate-image/ supabase/functions/n8n-api/serviceProxy.test.ts`
Expected: `Check` with 0 errors (both pre-existing errors gone); all tests PASS; `serviceProxy.test.ts` unmodified and green.

- [ ] **Step 9: Commit.**

```bash
cd /f/Dev/Worktrees/Postora_new/background-workers && git add supabase/functions/generate-image/imageFailure.ts supabase/functions/generate-image/imageFailure.test.ts supabase/functions/generate-image/runImageGeneration.ts supabase/functions/generate-image/runImageGeneration.test.ts && git commit -m "refactor(generate-image): extract the provider chain into runImageGeneration" -- supabase/functions/generate-image/
```

---

### Task 3: The async path in `generate-image`

**Files:**
- Create: `supabase/functions/generate-image/asyncJob.ts`, `asyncJob.test.ts`
- Modify: `supabase/functions/generate-image/index.ts` (schema plus a branch after validation)

**Interfaces:**
- Produces:

```ts
export function buildQueuedImageJob(userId: string, input: { prompt: string; requestedModel?: string; aspectRatio?: string; quality?: string }): {
  user_id: string; provider: "postora"; model_id: string; modality: "image"; credential_source: "platform";
  status: "queued"; params: Record<string, unknown>;
};
export async function kickAiImageWorker(fetchFn: typeof fetch, supabaseUrl: string, serviceRoleKey: string): Promise<void>;
export const KICK_TIMEOUT_MS = 10_000;
```

- [ ] **Step 1: Write the failing test.**

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildQueuedImageJob, kickAiImageWorker } from "./asyncJob.ts";

Deno.test("queued row satisfies the NOT NULL / CHECK columns and carries the worker marker", () => {
  const row = buildQueuedImageJob("u1", { prompt: "cat", aspectRatio: "16:9" });
  assertEquals(row, { user_id: "u1", provider: "postora", model_id: "auto", modality: "image", credential_source: "platform",
    status: "queued", params: { worker: true, prompt: "cat", aspectRatio: "16:9", quality: null, requestedModel: null } });
});
Deno.test("requested model is the placeholder model_id", () => {
  assertEquals(buildQueuedImageJob("u1", { prompt: "p", requestedModel: "gpt-image-1" }).model_id, "gpt-image-1");
});
Deno.test("kick posts to the worker with the service-role bearer and a timeout", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fake = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response("{}", { status: 202 }); }) as typeof fetch;
  await kickAiImageWorker(fake, "https://api.example.invalid", "srk");
  assertEquals(seen!.url, "https://api.example.invalid/functions/v1/ai-image-worker");
  assertEquals((seen!.init.headers as Record<string, string>).Authorization, "Bearer srk");
  assertEquals(seen!.init.method, "POST");
  assertEquals(seen!.init.signal instanceof AbortSignal, true);
});
```

- [ ] **Step 2: Run it (FAIL), then implement `asyncJob.ts`.**

```ts
/** Enqueue-side helpers for background image generation; the worker is ai-image-worker. */
export const KICK_TIMEOUT_MS = 10_000;

export function buildQueuedImageJob(userId: string, input: { prompt: string; requestedModel?: string; aspectRatio?: string; quality?: string }) {
  return {
    user_id: userId,
    // Placeholders for NOT NULL / CHECK columns; complete_ai_image_job overwrites
    // them with the provider, model and credential that actually ran.
    provider: "postora" as const,
    model_id: input.requestedModel ?? "auto",
    modality: "image" as const,
    credential_source: "platform" as const,
    status: "queued" as const,
    params: {
      worker: true,
      prompt: input.prompt,
      aspectRatio: input.aspectRatio ?? null,
      quality: input.quality ?? null,
      requestedModel: input.requestedModel ?? null,
    },
  };
}

/** The worker answers 202 at once and works in waitUntil, so a short timeout is enough. Cron is the safety net. */
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

- [ ] **Step 3: Wire it into `index.ts`.**
  - Add `async: z.boolean().optional(),` to `GenerateImageSchema` (`:32-39`).
  - Destructure it: `const { prompt, model: requestedModel, aspectRatio, quality, referenceImage, referenceImages, async: wantsAsync } = validation.data;`.
  - Right after `const references = collectReferences(referenceImage, referenceImages);` insert:

```ts
    if (wantsAsync === true) {
      const { data: queued, error: queueError } = await supabaseAdmin
        .from('ai_generation_jobs')
        .insert(buildQueuedImageJob(user.id, { prompt, requestedModel, aspectRatio, quality }))
        .select('id')
        .single();
      if (queueError || !queued) throw queueError ?? new Error('could not queue the image job');
      const { error: payloadError } = await supabaseAdmin
        .from('ai_image_job_payloads')
        .insert({ job_id: queued.id, reference_images: references });
      if (payloadError) {
        await supabaseAdmin.from('ai_generation_jobs').delete().eq('id', queued.id);
        throw payloadError;
      }
      await runInBackground('kick ai-image-worker', () =>
        kickAiImageWorker(fetch, Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''));
      return new Response(JSON.stringify({ success: true, jobId: queued.id, status: 'queued' }), {
        status: 202,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'X-RateLimit-Limit-Hour': String(rateLimitResult.limitHour),
          'X-RateLimit-Limit-Day': String(rateLimitResult.limitDay),
          'X-RateLimit-Remaining-Hour': String(Math.max(0, rateLimitResult.remainingHour - 1)),
          'X-RateLimit-Remaining-Day': String(Math.max(0, rateLimitResult.remainingDay - 1)),
        },
      });
    }
```

  - Imports: `import { buildQueuedImageJob, kickAiImageWorker } from "./asyncJob.ts";` and `import { runInBackground } from "../_shared/background.ts";`.

The payload row is inserted before the kick, and the claim needs `params.worker` (set in the first insert). A worker that claims between the two inserts would find no references. Mitigation: `loadReferences` in Task 4 treats a missing payload row as **not yet ready** and releases the job back to `queued`. Do not reorder the inserts.

- [ ] **Step 4: Run, typecheck and commit.**

Run: `cd /f/Dev/Worktrees/Postora_new/background-workers && /f/Dev/Runtimes/deno-bin/bin/deno.exe check --node-modules-dir=none supabase/functions/generate-image/index.ts && /f/Dev/Runtimes/deno-bin/bin/deno.exe test --node-modules-dir=none --allow-env supabase/functions/generate-image/ supabase/functions/n8n-api/serviceProxy.test.ts`
Expected: PASS.

```bash
cd /f/Dev/Worktrees/Postora_new/background-workers && git add supabase/functions/generate-image/asyncJob.ts supabase/functions/generate-image/asyncJob.test.ts && git commit -m "feat(generate-image): async:true queues a background image job" -- supabase/functions/generate-image/
```

---

### Task 4: `ai-image-worker`

**Files:**
- Create: `supabase/functions/ai-image-worker/worker.ts`, `worker.test.ts`, `deps.ts`, `index.ts`
- Modify: `supabase/config.toml`

**Interfaces:**
- Consumes `claim_ai_image_jobs` and `complete_ai_image_job` (Task 1), `runImageGeneration` and `defaultImageRunDeps` (Task 2), and `describeImageFailure` (Task 2).
- Produces:

```ts
export const AI_IMAGE_WORKER_LIMITS = {
  lease: "3 minutes",
  tickBudgetMs: 50_000,
  workerLifetimeMs: 150_000,
  minRemainingToClaimMs: 100_000,
  jobDeadlineFromStartMs: 140_000,
} as const;
export interface ClaimedImageJob { id: string; user_id: string; claim_token: string; params: Record<string, unknown> }
export interface ImageJobCompletion {
  jobId: string; claimToken: string; status: "succeeded" | "failed";
  resultUrl: string | null; resultDataUrl: string | null; error: string | null;
  provider: string | null; modelId: string | null; credentialSource: string | null; params: Record<string, unknown>;
}
export interface AiImageWorkerPorts {
  now(): number;
  workerStartedAtMs: number;
  claim(limit: number, lease: string): Promise<ClaimedImageJob[]>;
  /** null = payload row not written yet. */
  loadReferences(jobId: string): Promise<ReferenceInput[] | null>;
  requeue(jobId: string, claimToken: string): Promise<void>;
  markDispatched(jobId: string, claimToken: string): Promise<boolean>;
  run(job: ImageJobInput, onDispatch: () => Promise<boolean>): Promise<ImageRunResult>;
  complete(c: ImageJobCompletion): Promise<boolean>;
  log(level: "info" | "error", userId: string, message: string, metadata: Record<string, unknown>): Promise<void>;
}
export interface AiImageWorkerSummary { claimed: number; succeeded: number; failed: number; lost: number; requeued: number; stoppedForLifetime: boolean }
export async function runAiImageWorker(ports: AiImageWorkerPorts): Promise<AiImageWorkerSummary>;
export function completionFor(job: ClaimedImageJob, result: ImageRunResult | { kind: "threw"; message: string }): ImageJobCompletion | null;
```

- [ ] **Step 1: Write the failing `worker.test.ts`.**

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runAiImageWorker, completionFor, AI_IMAGE_WORKER_LIMITS, type AiImageWorkerPorts, type ClaimedImageJob } from "./worker.ts";

const job: ClaimedImageJob = { id: "j1", user_id: "u1", claim_token: "t1", params: { worker: true, prompt: "cat", aspectRatio: "1:1" } };
const model = { provider_code: "google", model_id: "gemini-2.5-flash-image", source: "primary" } as never;

function ports(over: Partial<AiImageWorkerPorts> = {}, queue: ClaimedImageJob[] = [job]) {
  const completed: unknown[] = [];
  let t = 0;
  const p: AiImageWorkerPorts = {
    now: () => t,
    workerStartedAtMs: 0,
    claim: async () => { const next = queue.shift(); return next ? [next] : []; },
    loadReferences: async () => [],
    requeue: async () => {},
    markDispatched: async () => true,
    run: async (_j, onDispatch) => { await onDispatch(); t += 1_000;
      return { kind: "succeeded", imageUrl: "data:image/png;base64,AA", description: "d", usedModel: model, credentialSource: "platform", attemptErrors: [] }; },
    complete: async (c) => { completed.push(c); return true; },
    log: async () => {},
    ...over,
  };
  return { p, completed, advance: (ms: number) => { t += ms; } };
}

Deno.test("data: result goes to result_data_url, model fields overwrite placeholders", async () => {
  const { p, completed } = ports();
  const s = await runAiImageWorker(p);
  assertEquals(s.claimed, 1);
  assertEquals(s.succeeded, 1);
  assertEquals(completed[0], { jobId: "j1", claimToken: "t1", status: "succeeded", resultUrl: null, resultDataUrl: "data:image/png;base64,AA",
    error: null, provider: "google", modelId: "gemini-2.5-flash-image", credentialSource: "platform",
    params: { description: "d", chain_source: "primary", error_code: null } });
});
Deno.test("https result goes to result_url", () => {
  const c = completionFor(job, { kind: "succeeded", imageUrl: "https://hf.invalid/i.png", description: "", usedModel: model, credentialSource: "byo", attemptErrors: [] });
  assertEquals([c!.resultUrl, c!.resultDataUrl, c!.credentialSource], ["https://hf.invalid/i.png", null, "byo"]);
});
Deno.test("refusal fails the job with its code", () => {
  const c = completionFor(job, { kind: "refused", status: 402, message: "Daily AI generation limit reached", errorCode: "ai_quota_exhausted" });
  assertEquals([c!.status, c!.error, c!.params.error_code], ["failed", "Daily AI generation limit reached", "ai_quota_exhausted"]);
});
Deno.test("a thrown run is failed through describeImageFailure", () => {
  const c = completionFor(job, { kind: "threw", message: "Rate limit hit" });
  assertEquals([c!.status, c!.params.error_code], ["failed", "ai_rate_limited"]);
});
Deno.test("lease lost writes nothing", async () => {
  const { p, completed } = ports({ run: async () => ({ kind: "lease_lost" }) });
  const s = await runAiImageWorker(p);
  assertEquals([s.lost, completed.length], [1, 0]);
});
Deno.test("stale token on complete counts as lost", async () => {
  const { p } = ports({ complete: async () => false });
  assertEquals((await runAiImageWorker(p)).lost, 1);
});
Deno.test("onDispatch stamps the claimed token", async () => {
  const seen: string[] = [];
  const { p } = ports({ markDispatched: async (id, tok) => { seen.push(`${id}:${tok}`); return true; } });
  await runAiImageWorker(p);
  assertEquals(seen, ["j1:t1"]);
});
Deno.test("a spent worker claims nothing", async () => {
  let claims = 0;
  const { p } = ports({ workerStartedAtMs: -60_000, claim: async () => { claims++; return []; } });
  const s = await runAiImageWorker(p);
  assertEquals([claims, s.stoppedForLifetime], [0, true]);
});
Deno.test("missing payload row requeues instead of running", async () => {
  const requeued: string[] = [];
  let ran = false;
  const { p } = ports({ loadReferences: async () => null, requeue: async (id) => { requeued.push(id); }, run: async () => { ran = true; return { kind: "lease_lost" }; } });
  const s = await runAiImageWorker(p);
  assertEquals([requeued, ran, s.requeued], [["j1"], false, 1]);
});
Deno.test("job deadline is worker start + 140 s", async () => {
  let deadline = 0;
  const { p } = ports({ run: async (j) => { deadline = j.deadlineMs; return { kind: "lease_lost" }; } });
  await runAiImageWorker(p);
  assertEquals(deadline, AI_IMAGE_WORKER_LIMITS.jobDeadlineFromStartMs);
});
```

- [ ] **Step 2: Run it (FAIL), then implement `worker.ts`.**

```ts
// Background image generation worker. Decisions live here; deps.ts adapts them to Postgres.
import type { ReferenceInput } from "../_shared/image-references.ts";
import { redactProviderError } from "../_shared/ai-routing-errors.ts";
import { describeImageFailure } from "../generate-image/imageFailure.ts";
import type { ImageJobInput, ImageRunResult } from "../generate-image/runImageGeneration.ts";

export const AI_IMAGE_WORKER_LIMITS = {
  lease: "3 minutes",            // > workerLifetimeMs: a live worker never loses its lease
  tickBudgetMs: 50_000,
  workerLifetimeMs: 150_000,     // edge runtime workerTimeoutMs
  minRemainingToClaimMs: 100_000,
  jobDeadlineFromStartMs: 140_000,
} as const;

// ...interfaces exactly as in the Interfaces block above...

const asText = (v: unknown) => (typeof v === "string" ? v : undefined);

export function completionFor(job: ClaimedImageJob, result: ImageRunResult | { kind: "threw"; message: string }): ImageJobCompletion | null {
  const base = { jobId: job.id, claimToken: job.claim_token, resultUrl: null, resultDataUrl: null, provider: null, modelId: null, credentialSource: null };
  switch (result.kind) {
    case "lease_lost":
      return null;
    case "succeeded": {
      const inline = result.imageUrl.startsWith("data:");
      return { ...base, status: "succeeded", error: null,
        resultUrl: inline ? null : result.imageUrl, resultDataUrl: inline ? result.imageUrl : null,
        provider: result.usedModel.provider_code, modelId: result.usedModel.model_id, credentialSource: result.credentialSource,
        params: { description: result.description, chain_source: result.usedModel.source, error_code: null } };
    }
    case "refused":
      return { ...base, status: "failed", error: result.message, params: { error_code: result.errorCode } };
    default: {
      const { code, message } = describeImageFailure(result.message);
      // The owner can read this row and it is published to Realtime.
      return { ...base, status: "failed", error: redactProviderError(message, ""), params: { error_code: code } };
    }
  }
}

export async function runAiImageWorker(ports: AiImageWorkerPorts): Promise<AiImageWorkerSummary> {
  const L = AI_IMAGE_WORKER_LIMITS;
  const tickStartedAt = ports.now();
  const summary: AiImageWorkerSummary = { claimed: 0, succeeded: 0, failed: 0, lost: 0, requeued: 0, stoppedForLifetime: false };
  while (ports.now() - tickStartedAt < L.tickBudgetMs) {
    if (ports.workerStartedAtMs + L.workerLifetimeMs - ports.now() < L.minRemainingToClaimMs) {
      summary.stoppedForLifetime = true;  // cron or the next kick lands on a fresh worker
      break;
    }
    const [job] = await ports.claim(1, L.lease);
    if (!job) break;
    summary.claimed++;

    const references = await ports.loadReferences(job.id);
    if (references === null) {
      await ports.requeue(job.id, job.claim_token);
      summary.requeued++;
      break;  // the enqueue is mid-flight; do not spin on it this tick
    }

    const input: ImageJobInput = {
      userId: job.user_id,
      prompt: asText(job.params.prompt) ?? "",
      requestedModel: asText(job.params.requestedModel),
      aspectRatio: asText(job.params.aspectRatio),
      quality: asText(job.params.quality),
      references,
      deadlineMs: ports.workerStartedAtMs + L.jobDeadlineFromStartMs,
    };
    let result: ImageRunResult | { kind: "threw"; message: string };
    try {
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
    if (completion.status === "succeeded") summary.succeeded++;
    else summary.failed++;
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

- [ ] **Step 3: Implement `deps.ts`.** These are the real ports. They are not unit-tested; the SQL proof covers the RPCs.

```ts
import { defaultImageRunDeps, runImageGeneration } from "../generate-image/runImageGeneration.ts";
import type { AiImageWorkerPorts, ClaimedImageJob } from "./worker.ts";

// deno-lint-ignore no-explicit-any
export function createAiImageWorkerPorts(admin: any, workerStartedAtMs: number): AiImageWorkerPorts {
  return {
    now: () => Date.now(),
    workerStartedAtMs,
    async claim(limit, lease) {
      const { data, error } = await admin.rpc("claim_ai_image_jobs", { p_limit: limit, p_lease: lease });
      if (error) throw new Error(`claim_ai_image_jobs: ${error.message}`);
      return (data ?? []) as ClaimedImageJob[];
    },
    async loadReferences(jobId) {
      const { data, error } = await admin.from("ai_image_job_payloads").select("reference_images").eq("job_id", jobId).maybeSingle();
      if (error) throw new Error(`load payload: ${error.message}`);
      return data ? (data.reference_images ?? []) : null;
    },
    async requeue(jobId, claimToken) {
      await admin.from("ai_generation_jobs")
        .update({ status: "queued", claim_token: null, claimed_at: null, updated_at: new Date().toISOString() })
        .eq("id", jobId).eq("claim_token", claimToken).eq("status", "running").is("dispatched_at", null);
    },
    async markDispatched(jobId, claimToken) {
      const { data, error } = await admin.from("ai_generation_jobs")
        .update({ dispatched_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", jobId).eq("claim_token", claimToken).eq("status", "running").is("dispatched_at", null)
        .select("id");
      return !error && (data?.length ?? 0) === 1;
    },
    run: (job, onDispatch) =>
      runImageGeneration(defaultImageRunDeps(admin, { onDispatch, recordHiggsfieldSuccess: async () => {} }), job),
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

`recordHiggsfieldSuccess` is a no-op here. The job row itself is completed with `provider`/`credential_source`, so writing a second `succeeded` row (as the sync path does) would double-count the BYO hourly limit.

Requeueing does not reset `attempts`, so an enqueue that keeps failing still ends at W6.

A `complete` that throws (DB down) propagates out of the tick. The lease then expires. Because `dispatched_at` is set, the job is failed as `ai_interrupted` and never re-run: indeterminate, so no second charge. The image is lost; this is accepted, see Risks.

- [ ] **Step 4: Implement the door `index.ts`.**

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
    status: 202,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
```

- [ ] **Step 5: Update `config.toml`.** After the `[functions.process-store-events]` block (`supabase/config.toml:56-58`) add:

```toml
# Cron and generate-image's service-role kick call it; verifyCronAuth is the gate.
[functions.ai-image-worker]
verify_jwt = false
```

- [ ] **Step 6: Run, typecheck and commit.**

Run: `cd /f/Dev/Worktrees/Postora_new/background-workers && /f/Dev/Runtimes/deno-bin/bin/deno.exe check --node-modules-dir=none supabase/functions/ai-image-worker/index.ts && /f/Dev/Runtimes/deno-bin/bin/deno.exe test --node-modules-dir=none --allow-env supabase/functions/ai-image-worker/`
Expected: PASS.

```bash
cd /f/Dev/Worktrees/Postora_new/background-workers && git add supabase/functions/ai-image-worker && git commit -m "feat(ai-image-worker): claim, run and fence background image jobs" -- supabase/functions/ai-image-worker supabase/config.toml
```

---

### Task 5: `ai-generation-status` short-circuit

**Files:**
- Create: `supabase/functions/ai-generation-status/workerImageJob.ts`, `workerImageJob.test.ts`
- Modify: `supabase/functions/ai-generation-status/index.ts`

**Interfaces:**
- Produces `isWorkerImageJob(job: { modality: string; params: unknown }): boolean`, `workerImageJobResponse(job, inlineResult: string | null): Record<string, unknown>`, and `WORKER_IMAGE_POLL_SECONDS = 3`.

- [ ] **Step 1: Write the failing test.**

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { isWorkerImageJob, workerImageJobResponse } from "./workerImageJob.ts";

const row = (o: Record<string, unknown>) => ({ modality: "image", status: "queued", params: { worker: true }, result_url: null, error: null, ...o });

Deno.test("only worker image rows match", () => {
  assertEquals(isWorkerImageJob(row({})), true);
  assertEquals(isWorkerImageJob(row({ modality: "video" })), false);
  assertEquals(isWorkerImageJob(row({ params: { prompt: "sync higgsfield row" } })), false);
  assertEquals(isWorkerImageJob(row({ params: null })), false);
});
Deno.test("queued and running poll every 3 s", () => {
  assertEquals(workerImageJobResponse(row({}), null), { success: true, status: "queued", pollAfterSeconds: 3 });
  assertEquals(workerImageJobResponse(row({ status: "running" }), null), { success: true, status: "running", pollAfterSeconds: 3 });
});
Deno.test("succeeded returns the hosted URL or the inline data URL", () => {
  assertEquals(workerImageJobResponse(row({ status: "succeeded", result_url: "https://h/i.png", params: { worker: true, description: "d" } }), null),
    { success: true, status: "succeeded", imageUrl: "https://h/i.png", url: "https://h/i.png", description: "d" });
  assertEquals(workerImageJobResponse(row({ status: "succeeded" }), "data:image/png;base64,AA").imageUrl, "data:image/png;base64,AA");
});
Deno.test("succeeded with no stored image reports expiry as a failure", () => {
  assertEquals(workerImageJobResponse(row({ status: "succeeded" }), null),
    { success: true, status: "failed", error: "This generated image has expired. Please generate it again.", errorCode: "ai_result_expired" });
});
Deno.test("failed and timeout carry error and errorCode", () => {
  assertEquals(workerImageJobResponse(row({ status: "failed", error: "x", params: { worker: true, error_code: "ai_quota_exhausted" } }), null),
    { success: true, status: "failed", error: "x", errorCode: "ai_quota_exhausted" });
  assertEquals(workerImageJobResponse(row({ status: "timeout", error: null }), null).errorCode, "ai_error");
});
```

- [ ] **Step 2: Run it (FAIL), then implement `workerImageJob.ts`.**

```ts
/**
 * Status answers for background image jobs (ai-image-worker). These rows have no provider job
 * to ask about and no reservation of their own, so they must never reach the provider-polling
 * or 30-minute timeout branches of index.ts: the timeout branch would refund a reservation the
 * worker never made.
 */
export const WORKER_IMAGE_POLL_SECONDS = 3;

interface WorkerJobRow { modality: string; status: string; params: unknown; result_url: string | null; error: string | null }

const paramsOf = (job: { params: unknown }) =>
  job.params && typeof job.params === "object" ? (job.params as Record<string, unknown>) : {};

export function isWorkerImageJob(job: { modality: string; params: unknown }): boolean {
  return job.modality === "image" && paramsOf(job).worker === true;
}

export function workerImageJobResponse(job: WorkerJobRow, inlineResult: string | null): Record<string, unknown> {
  const params = paramsOf(job);
  if (job.status === "succeeded") {
    const imageUrl = job.result_url ?? inlineResult;
    if (!imageUrl) {
      return { success: true, status: "failed", error: "This generated image has expired. Please generate it again.", errorCode: "ai_result_expired" };
    }
    return { success: true, status: "succeeded", imageUrl, url: imageUrl, description: params.description ?? null };
  }
  if (job.status === "failed" || job.status === "timeout") {
    return { success: true, status: job.status, error: job.error, errorCode: typeof params.error_code === "string" ? params.error_code : "ai_error" };
  }
  return { success: true, status: job.status === "queued" ? "queued" : "running", pollAfterSeconds: WORKER_IMAGE_POLL_SECONDS };
}
```

- [ ] **Step 3: Wire it into `index.ts`.** Insert right after `if (!job) return json({ error: "Job not found" }, 404);` (line 34), **before** the terminal check and the 30-minute branch:

```ts
    if (isWorkerImageJob(job)) {
      let inline: string | null = null;
      if (job.status === "succeeded" && !job.result_url) {
        const { data: payload } = await supabase
          .from("ai_image_job_payloads")
          .select("result_data_url")
          .eq("job_id", job.id)
          .maybeSingle();
        inline = payload?.result_data_url ?? null;
      }
      return json(workerImageJobResponse(job, inline));
    }
```

Add `import { isWorkerImageJob, workerImageJobResponse } from "./workerImageJob.ts";`.

- [ ] **Step 4: Run, typecheck and commit.**

Run: `cd /f/Dev/Worktrees/Postora_new/background-workers && /f/Dev/Runtimes/deno-bin/bin/deno.exe check --node-modules-dir=none supabase/functions/ai-generation-status/index.ts && /f/Dev/Runtimes/deno-bin/bin/deno.exe test --node-modules-dir=none --allow-env supabase/functions/ai-generation-status/`
Expected: PASS (including the existing `archiveBody.test.ts`).

```bash
cd /f/Dev/Worktrees/Postora_new/background-workers && git add supabase/functions/ai-generation-status/workerImageJob.ts supabase/functions/ai-generation-status/workerImageJob.test.ts && git commit -m "feat(ai-generation-status): answer background image jobs before the provider branches" -- supabase/functions/ai-generation-status/
```

---

### Task 6: The watcher and `useAiGenerationJob`

**Files:**
- Create: `src/lib/aiGenerationJobWatcher.ts`, `src/lib/__tests__/aiGenerationJobWatcher.test.ts`
- Modify: `src/hooks/useAiGenerationJob.ts`
- Create: `src/hooks/__tests__/useAiGenerationJob.test.tsx`

**Interfaces:**
- Produces:

```ts
export type AiJobStatus = "idle" | "running" | "succeeded" | "failed" | "timeout";
export interface AiJobSnapshot { status: AiJobStatus; videoUrl: string | null; imageUrl: string | null;
  error: string | null; errorCode: string | null; elapsedSeconds: number }
export function watchAiGenerationJob(jobId: string, onChange: (s: AiJobSnapshot) => void): () => void;
export function awaitAiGenerationJob(jobId: string): Promise<AiJobSnapshot>;          // resolves on a terminal snapshot
export async function resolveAiImageResponse(data: unknown): Promise<Record<string, unknown> | null>; // sync-shaped
export const DEFAULT_POLL_SECONDS = 5; export const MAX_POLL_MS = 10 * 60_000;
```

- `useAiGenerationJob(jobId)` keeps its existing return fields and adds `errorCode: string | null`. `AiJobStatus` is re-exported from the hook, so `VideoGenerator` imports keep working.

- [ ] **Step 1: Write the failing watcher test.** It follows the mock pattern in `src/hooks/__tests__/useRealtimePostUpdates.test.tsx`: a `vi.hoisted` callbacks map, a chainable channel, `removeChannel` and fake timers.

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ onUpdate: null as null | ((p: unknown) => void), invoke: vi.fn(), removeChannel: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => {
  const channel = {
    on: (_e: string, _f: unknown, cb: (p: unknown) => void) => { h.onUpdate = cb; return channel; },
    subscribe: () => channel,
  };
  return { supabase: { channel: () => channel, removeChannel: h.removeChannel, functions: { invoke: h.invoke } } };
});
import { watchAiGenerationJob, awaitAiGenerationJob, resolveAiImageResponse } from "@/lib/aiGenerationJobWatcher";

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { context: { status } });

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

  it("a failed read is never terminal: it backs off and keeps polling", async () => {
    h.invoke
      .mockResolvedValueOnce({ data: null, error: httpError(500) })
      .mockResolvedValueOnce({ data: null, error: httpError(503) })
      .mockResolvedValueOnce({ data: null, error: httpError(500) })
      .mockResolvedValueOnce({ data: { success: true, status: "succeeded", imageUrl: "https://h/i.png" }, error: null });
    const done = awaitAiGenerationJob("j1");
    await vi.advanceTimersByTimeAsync(5_000 + 5_000 + 10_000 + 20_000);
    await expect(done).resolves.toMatchObject({ status: "succeeded", imageUrl: "https://h/i.png" });
  });

  it("404 ends the watch as failed", async () => {
    h.invoke.mockResolvedValue({ data: null, error: httpError(404) });
    const done = awaitAiGenerationJob("j1");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(done).resolves.toMatchObject({ status: "failed", errorCode: "job_not_found" });
  });

  it("honours pollAfterSeconds and times out after 10 minutes", async () => {
    h.invoke.mockResolvedValue({ data: { success: true, status: "running", pollAfterSeconds: 3 }, error: null });
    const done = awaitAiGenerationJob("j1");
    await vi.advanceTimersByTimeAsync(5_000 + 3_000);
    expect(h.invoke).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(done).resolves.toMatchObject({ status: "timeout" });
  });

  it("resolveAiImageResponse passes a sync response through and maps a failed job", async () => {
    await expect(resolveAiImageResponse({ imageUrl: "data:x" })).resolves.toEqual({ imageUrl: "data:x" });
    h.invoke.mockResolvedValue({ data: { success: true, status: "failed", error: "Daily AI generation limit reached", errorCode: "ai_quota_exhausted" }, error: null });
    const r = resolveAiImageResponse({ success: true, jobId: "j1", status: "queued" });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(r).resolves.toEqual({ success: false, error_code: "ai_quota_exhausted", message: "Daily AI generation limit reached" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd /f/Dev/Worktrees/Postora_new/background-workers && npx vitest run src/lib/__tests__/aiGenerationJobWatcher.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/aiGenerationJobWatcher.ts`.**

```ts
/**
 * Follows one ai_generation_jobs row to its end: Realtime for speed, polling
 * ai-generation-status for the result and as the fallback when Realtime is missed.
 * A failed read is never terminal; only 401/403/404 or the 10-minute cap end the watch.
 */
import { supabase } from "@/integrations/supabase/client";

export type AiJobStatus = "idle" | "running" | "succeeded" | "failed" | "timeout";
export interface AiJobSnapshot {
  status: AiJobStatus; videoUrl: string | null; imageUrl: string | null;
  error: string | null; errorCode: string | null; elapsedSeconds: number;
}

export const DEFAULT_POLL_SECONDS = 5;
export const MAX_POLL_MS = 10 * 60_000;
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
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let pollAgain = false;
  let failures = 0;

  const snapshot = (patch: Partial<AiJobSnapshot>): AiJobSnapshot => ({
    status: "running", videoUrl: null, imageUrl: null, error: null, errorCode: null,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), ...patch,
  });
  const stop = () => {
    active = false;
    if (timer) clearTimeout(timer);
    timer = null;
    void supabase.removeChannel(channel);
  };
  const finish = (patch: Partial<AiJobSnapshot>) => {
    if (!active) return;
    const last = snapshot(patch);
    stop();
    onChange(last);
  };
  const schedule = (seconds: number) => {
    if (!active) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void poll(), seconds * 1000);
  };

  const poll = async (): Promise<void> => {
    if (!active) return;
    timer = null;
    if (Date.now() - startedAt > MAX_POLL_MS) {
      finish({ status: "timeout", error: "The generation is taking longer than expected. Check back shortly." });
      return;
    }
    inFlight = true;
    try {
      const { data, error } = await supabase.functions.invoke("ai-generation-status", { body: { jobId } });
      if (!active) return;
      if (error) throw error;
      const status = String(data?.status ?? "");
      if (status === "succeeded") {
        finish({ status: "succeeded",
          videoUrl: data.videoUrl ?? data.imageUrl ?? data.url ?? null,
          imageUrl: data.imageUrl ?? data.videoUrl ?? data.url ?? null });
        return;
      }
      if (TERMINAL.has(status)) {
        finish({ status: status === "failed" ? "failed" : "timeout",
          error: data.error || "The generation did not complete.", errorCode: data.errorCode ?? null });
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
        void poll();
      }
    }
  };

  const pollNow = () => {
    if (!active) return;
    if (inFlight) { pollAgain = true; return; }
    if (timer) clearTimeout(timer);
    void poll();
  };

  const channel = supabase
    .channel(`ai-generation-job-${jobId}`)
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "ai_generation_jobs", filter: `id=eq.${jobId}` },
      (payload: { new?: { status?: string } }) => {
        if (TERMINAL.has(String(payload.new?.status))) pollNow();
      })
    .subscribe();

  onChange(snapshot({ status: "running" }));
  schedule(DEFAULT_POLL_SECONDS);
  return stop;
}

export function awaitAiGenerationJob(jobId: string): Promise<AiJobSnapshot> {
  return new Promise((resolve) => {
    watchAiGenerationJob(jobId, (s) => {
      if (s.status !== "running" && s.status !== "idle") resolve(s);
    });
  });
}

/**
 * Turns generate-image's answer into the synchronous shape every caller already handles:
 * `{ imageUrl, description }` or `{ success: false, error_code, message }`. A sync answer
 * (n8n-style, or a backend not yet deployed) passes through untouched.
 */
export async function resolveAiImageResponse(data: unknown): Promise<Record<string, unknown> | null> {
  const body = (data ?? null) as Record<string, unknown> | null;
  if (!body || typeof body.jobId !== "string") return body;
  const end = await awaitAiGenerationJob(body.jobId);
  if (end.status === "succeeded" && end.imageUrl) return { imageUrl: end.imageUrl, description: "" };
  return { success: false, error_code: end.errorCode ?? (end.status === "timeout" ? "ai_timeout" : "ai_error"),
    message: end.error ?? "Image generation failed" };
}
```

Two notes on this code:
- `channel` is used inside `stop` before its `const` line. That is safe because `stop` only runs after `subscribe()` has returned, from a timer or an async callback.
- If the implementer's linter flags `no-use-before-define`, move the channel creation above `stop` and keep the order of the side effects.

- [ ] **Step 4: Rewrite `src/hooks/useAiGenerationJob.ts` as a thin wrapper.** Keep its JSDoc header and update the description to "Realtime + polling".

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

- [ ] **Step 5: Write `src/hooks/__tests__/useAiGenerationJob.test.tsx`.**

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

  it("stays idle without a job id and never calls the status function", async () => {
    const { result } = renderHook(() => useAiGenerationJob(null));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.status).toBe("idle");
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("reports running with isPolling while the job is in progress", () => {
    const { result } = renderHook(() => useAiGenerationJob("j1"));
    expect(result.current).toMatchObject({ status: "running", isPolling: true });
  });

  it("ends with the video URL VideoGenerator reads and stops polling", async () => {
    h.invoke.mockResolvedValue({ data: { success: true, status: "succeeded", videoUrl: "https://v/x.mp4" }, error: null });
    const { result, unmount } = renderHook(() => useAiGenerationJob("j1"));
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(result.current).toMatchObject({ status: "succeeded", isPolling: false, videoUrl: "https://v/x.mp4" });
    unmount();
    expect(h.removeChannel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run and commit.**

Run: `cd /f/Dev/Worktrees/Postora_new/background-workers && npx vitest run src/lib/__tests__/aiGenerationJobWatcher.test.ts src/hooks/__tests__/useAiGenerationJob.test.tsx && npx tsc --noEmit -p tsconfig.app.json`
Expected: PASS, no type errors.

```bash
cd /f/Dev/Worktrees/Postora_new/background-workers && git add src/lib/aiGenerationJobWatcher.ts src/lib/__tests__/aiGenerationJobWatcher.test.ts src/hooks/__tests__/useAiGenerationJob.test.tsx && git commit -m "feat(ai-jobs): realtime + polling watcher; failed reads are never terminal" -- src/lib/aiGenerationJobWatcher.ts src/lib/__tests__/aiGenerationJobWatcher.test.ts src/hooks/useAiGenerationJob.ts src/hooks/__tests__/useAiGenerationJob.test.tsx
```

---

### Task 7: The four callers send `async: true`

**Files:**
- Modify: `src/components/post/ImageGenerator.tsx` (invoke at `:270`)
- Modify: `src/components/canvas/nodes/CaptionNode.tsx` (`:103`)
- Modify: `src/components/canvas/nodes/MediaNode.tsx` (`:141`)
- Modify: `src/hooks/useYouTubeThumbnails.tsx` (`:119`) and `src/hooks/__tests__/useYouTubeThumbnails.test.tsx` (`:82`, `:127`)

**Interfaces:**
- Consumes `resolveAiImageResponse` (Task 6). Every caller keeps its existing success and failure handling, because the resolved value has the sync shape.

- [ ] **Step 1: Update the YouTube test first (it must fail).**
  - Change the exact-body assertion at `:82` to include `async: true`.
  - Add `async: true` to the `objectContaining` at `:127`.
  - Add a case where `mockInvoke` first answers `{ data: { success: true, jobId: "j1", status: "queued" } }`, then `ai-generation-status` answers `{ data: { success: true, status: "succeeded", imageUrl: "data:image/png;base64,AA" } }`. Mock `channel`/`removeChannel` on the client the same way as in Task 6, and use fake timers. Assert that `mockSetAiGeneratedThumbnails` received an updater that appends `"data:image/png;base64,AA"`, and that `mockSetGeneratingAiThumbnail` was set back to `false` only after that.
  - Add a failure case: the job ends `failed`. Assert the "Failed to generate" toast and that nothing is appended.

Run: `cd /f/Dev/Worktrees/Postora_new/background-workers && npx vitest run src/hooks/__tests__/useYouTubeThumbnails.test.tsx src/hooks/__tests__/useYouTubeThumbnails.video.test.tsx`
Expected: FAIL (no `async`, no job resolution).

- [ ] **Step 2: Apply the same three-line change at each call site.** The pattern is to send `async: true`, resolve the answer, and throw on a structured failure where the caller had no `success === false` handling:

`useYouTubeThumbnails.tsx` (`:119-131`):

```ts
      const { data: raw, error } = await supabase.functions.invoke("generate-image", {
        body: { prompt, aspectRatio: "16:9", referenceImage: refImage || undefined, async: true },
      });
      if (error) throw error;
      const data = await resolveAiImageResponse(raw);
      if (data?.success === false) throw new Error(String(data.message ?? "Image generation failed"));
      if (data?.error) throw new Error(String(data.error));
```

The rest is unchanged. `isGeneratingAi` stays `true` until the job ends, because `finally` runs after the `await`. Keep the existing comment block in the body.

`CaptionNode.tsx` (`:93-110`): add `async: true` to `body`. Then use `const { data: raw, error } = ...; if (error) throw error; const data = await resolveAiImageResponse(raw); if (data?.success === false) throw new Error(String(data.message ?? "Image generation failed"));`. The `data?.imageUrl` branch is unchanged. (Today a structured failure here is silent.)

`MediaNode.tsx` (`:141-145`): body `{ prompt: generatePrompt, style: 'realistic', size: '1024x1024', async: true }`, then the same three lines. The Cloudinary re-upload of a `data:` URL (`:147-157`) is unchanged.

`ImageGenerator.tsx` (`:270-279`): add `async: true` to `body` and rename the destructured `data` to `raw`. Right after the `if (error) { ... }` block (`:286-318`), insert `const data = await resolveAiImageResponse(raw);`, then change the debug log at `:282` to log `raw`. In the structured-failure branch (`:321-336`), widen the 402 mapping so the worker's quota refusal reaches the same handler as today's sync 402:

```ts
        if (code === 'ai_credits_exhausted' || code === 'ai_quota_exhausted') {
          handleAIError({ status: 402, message }, 'Image generation');
```

`refreshLimits()` still runs after success.

Import `import { resolveAiImageResponse } from "@/lib/aiGenerationJobWatcher";` in all four files.

- [ ] **Step 3: Run the whole frontend suite, typecheck and the i18n gate.**

Run: `cd /f/Dev/Worktrees/Postora_new/background-workers && npx vitest run && npx tsc --noEmit -p tsconfig.app.json && npm run check:i18n && npm run lint`
Expected: all green; no new `t()` keys, so `check:i18n` is unchanged.

- [ ] **Step 4: Commit.**

```bash
cd /f/Dev/Worktrees/Postora_new/background-workers && git commit -m "feat(ai-image): callers queue generations and wait on the job" -- src/components/post/ImageGenerator.tsx src/components/canvas/nodes/CaptionNode.tsx src/components/canvas/nodes/MediaNode.tsx src/hooks/useYouTubeThumbnails.tsx src/hooks/__tests__/useYouTubeThumbnails.test.tsx
```

---

### Task 8: Types, CI, gates and guard pass

**Files:**
- Modify: `src/integrations/supabase/types.ts`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Regenerate the types.** Do this after the migration is applied on production (Deployment step 2). Use `supabase_postora_mcp` `generate_typescript_types` and take the `ai_generation_jobs`, `ai_image_job_payloads`, `claim_ai_image_jobs` and `complete_ai_image_job` blocks from its output.

If regeneration is not reachable before merge, hand-edit `types.ts`:
- `ai_generation_jobs` Row/Insert/Update (from `:2351`): `attempts: number` (Insert/Update `attempts?: number`), `claim_token: string | null`, `claimed_at: string | null`, `dispatched_at: string | null` (all optional in Insert/Update).
- A new `ai_image_job_payloads` table block: Row `{ created_at: string; job_id: string; reference_images: Json; result_data_url: string | null }`, Insert with `job_id` required, plus a `Relationships` FK to `ai_generation_jobs`.
- In `Functions`, alphabetically next to `release_ai_generation_quota` (`:12348`):
  - `claim_ai_image_jobs: { Args: { p_limit?: number; p_lease?: unknown }; Returns: Database["public"]["Tables"]["ai_generation_jobs"]["Row"][] }`
  - `complete_ai_image_job: { Args: { p_job_id: string; p_claim_token: string; p_status: string; p_result_url?: string; p_result_data_url?: string; p_error?: string; p_provider?: string; p_model_id?: string; p_credential_source?: string; p_params?: Json }; Returns: boolean }`

Either way, regenerate again after deploy and commit any drift.

- [ ] **Step 2: Add the CI step.** In `.github/workflows/ci.yml`, after "Typecheck and test the AI image jobs and the staging sweep" (`:285-291`), add:

```yaml
      # generate-image was never typechecked in CI; the extraction fixed its two latent errors.
      - name: Typecheck and test AI image generation jobs
        run: |
          set -euo pipefail
          fn="supabase/functions"
          deno check --node-modules-dir=none "${fn}/generate-image/index.ts" "${fn}/ai-image-worker/index.ts" "${fn}/ai-generation-status/index.ts"
          deno test --allow-env --node-modules-dir=none "${fn}/generate-image/" "${fn}/ai-image-worker/" "${fn}/ai-generation-status/"
```

- [ ] **Step 3: Run every gate locally.**

Run:
```bash
cd /f/Dev/Worktrees/Postora_new/background-workers && D=/f/Dev/Runtimes/deno-bin/bin/deno.exe && fn=supabase/functions && \
$D check --node-modules-dir=none $fn/generate-image/index.ts $fn/ai-image-worker/index.ts $fn/ai-generation-status/index.ts && \
$D test --allow-env --node-modules-dir=none $fn/generate-image/ $fn/ai-image-worker/ $fn/ai-generation-status/ $fn/n8n-api/serviceProxy.test.ts && \
bash scripts/db-harness.sh && npx vitest run && npx tsc --noEmit -p tsconfig.app.json && npm run check:i18n && npm run lint && npm run build
```
Expected: all green.

- [ ] **Step 4: Guard pass (CLAUDE.md step 5).** Run `clean-code-guard` on every changed production file and `test-guard` on every new or changed test, then fix the findings inline. Confirm with `git diff --stat main...HEAD -- supabase/functions/process-post` (empty) that §41 holds.

- [ ] **Step 5: Commit.**

```bash
cd /f/Dev/Worktrees/Postora_new/background-workers && git commit -m "chore(ai-image): types and CI for background image jobs" -- src/integrations/supabase/types.ts .github/workflows/ci.yml
```

---

## Deployment

Order matters: the migration lands first, then the functions, and the frontend follows them. The same PR is fine. The migration is applied by hand before merge, and the functions deploy within about 2 minutes of the merge, before the frontend build finishes. During that window the old frontend still sends sync requests, which keep working.

1. **Harness green on the PR head.** Run `bash scripts/db-harness.sh`; CI runs it too.
2. **Apply the migration on production before merging**, through `ssh-contabo-mcp`: psql into the stack's db container and run the file read from the fetched PR ref, `git show origin/feat/background-workers-b:supabase/migrations/20261107120000_ai_image_jobs_worker.sql`, never the dirty `/root/postora-runtime` tree. Then verify:
   - `SELECT jobname, schedule FROM cron.job WHERE jobname IN ('ai-image-worker','purge-ai-image-payloads');` returns 2 rows.
   - `SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename IN ('ai_generation_jobs','ai_image_job_payloads');` returns only `ai_generation_jobs`.
   - `\df+ claim_ai_image_jobs` shows `SECURITY DEFINER`, and `has_function_privilege('authenticated','public.claim_ai_image_jobs(integer, interval)','EXECUTE')` is `f`.
   - Until the function is deployed, the worker cron answers 404 every minute. That is harmless, and no job is queued yet because no caller sends `async` before the frontend deploys.
3. **Merge to `main`.**
   - The Dokploy "Edge Functions Sync" schedule (every 2 min) deploys `origin/main` functions. It does not run migrations, which is why step 2 comes first.
   - Verify SHA256 of `generate-image/{index,runImageGeneration,imageFailure,asyncJob}.ts`, `ai-image-worker/{index,worker,deps}.ts` and `ai-generation-status/{index,workerImageJob}.ts` in `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/` against `git show origin/main:<path> | sha256sum`.
   - If the sync has not restarted the runtime, run `docker compose restart functions` from the stack dir (runbook `docs/runbooks/deploy-edge-function.md`).
   - Do **not** use `npx supabase functions deploy`.
4. **Probes:**
   - `curl -i -X OPTIONS https://api.postora.cloud/functions/v1/ai-image-worker` returns 200 with CORS headers.
   - `curl -i -X POST https://api.postora.cloud/functions/v1/ai-image-worker` without auth returns 401.
   - The `functions` logs show `[background] waitUntil path active` and `[ai-image-worker] tick {"claimed":0,...}` within 1 minute. `degraded inline` means `waitUntil` is missing: stop and investigate before any user traffic, because a tick would then be cut at 2 s per request.
5. **The frontend deploys from the same merge** (Dokploy, `postors.cloud`).
6. **Regenerate types** (Task 8 Step 1) if they were hand-edited, and commit any drift.
7. **mem0** `add_memory` (`user_id="HP"`, `app_id="lolotam-postora"`): the Phase B design, the D5 short-circuit-before-timeout gotcha, the dispatched-is-never-re-run rule, and the deploy order.

Rollback: revert the merge, and the frontend returns to sync calls. Jobs still queued are timed out by the claim RPC's queue-timeout branch only while the worker runs. If the worker is also gone, mark them by hand: `UPDATE ai_generation_jobs SET status='timeout' WHERE modality='image' AND params->>'worker'='true' AND status IN ('queued','running');`. The migration can stay; it is additive.

## Verification (live)

Use the logged-in pilot browser (Playwright MCP). The `postora` MCP key is not the pilot user (memory "Postora MCP user mismatch").

1. **ImageGenerator happy path.** Open `/post` and the AI image dialog, enter a prompt and press Generate. In the network panel, `generate-image` answers **202** in under 1 s with `{"success":true,"jobId":"<uuid>","status":"queued"}`. Through `supabase_postora_mcp` (`SELECT status, attempts, dispatched_at IS NOT NULL AS dispatched, provider, model_id FROM ai_generation_jobs WHERE id='<uuid>'`), the row moves `queued` → `running` (dispatched) → `succeeded`, with `provider`/`model_id` overwritten from `postora`/`auto`. The image renders in the dialog **without a reload**. In the network panel, the `ai-generation-status` call that returns `succeeded` fires right after the Realtime UPDATE, not on the 3 s cadence.
2. **Use Image** adds the image to the post (`fetch(dataURL)` → blob still works). Download works.
3. **YouTube thumbnail.** Generate an AI thumbnail. It appends once, and the spinner stays until it does. Schedule the post and confirm `settings.thumbnailUrl` is set.
4. **Canvas.** The CaptionNode and MediaNode generators render the image. MediaNode stores a Cloudinary URL.
5. **Failure path.** As an admin, temporarily point the image model to a provider with no key, or use a test account at its daily platform quota. The job ends `failed` with `params.error_code`, the dialog shows today's destructive toast (402 handler for quota) and no fake success. Restore the setting.
6. **Polling fallback.** Block the Realtime websocket in DevTools and generate again. The result still arrives through 3 s polling.
7. **Sync contract (§36).** Call MCP `generate_image` (or n8n `POST /api/v1/ai/generate-image`). It returns `{ imageUrl, description }` as before, and no `ai_generation_jobs` row with `params.worker` is created.
8. **Worker health.** `SELECT count(*) FROM ai_generation_jobs WHERE params->>'worker'='true' AND status IN ('queued','running') AND created_at < now() - interval '5 minutes';` returns 0. `cron.job_run_details` for `ai-image-worker` shows `succeeded` runs.
9. **Cross-user.** As a second account, call `supabase.from('ai_generation_jobs').select('*').eq('id','<first user job>')` from the console. It returns an empty array, and `ai_image_job_payloads` returns a permission error.

## Risks and follow-ups

- **Slow models vs worker lifetime.** A job gets about 100-140 s. A chain whose first candidate is gpt-image at `quality: 'low'` normally fits. A slow provider that is cut at the deadline ends the job `failed`, because `dispatched_at` is set, and its quota is not refunded (indeterminate). Watch `error_code='ai_interrupted'` in the first week.
- **Interrupted dispatched jobs consume platform quota.** This is accepted and the same rule as today: an indeterminate outcome never releases.
- **Multi-MB data URLs in Postgres.** `ai_image_job_payloads` holds them for up to 24 h, purged hourly. If volume grows, move results to Openinary and return a hosted URL. That needs a CORS check for `ImageGenerator.handleUseImage`'s `fetch`, and a durable (non-expiring) URL for YouTube `thumbnailUrl`.
- **A kick that lands on a spent worker** leaves the job for cron: worst-case start delay is about 60-150 s. The UI keeps showing "generating", which is honest.
- **The enqueue row and the payload row are two inserts.** A crash between them leaves a job with no payload. The worker puts it back to `queued` on every claim; claim branch (b) only fires on `running`, so attempts never end it. Only the 15-minute queue timeout (c) does, as `ai_queue_timeout`. Folding both inserts into one `enqueue_ai_image_job` RPC would remove this window; it is a follow-up.
- **Imperative callers do not cancel.** `awaitAiGenerationJob` keeps watching for up to 10 minutes after the component that started it unmounts. That costs one status read every 3 s, and the result is dropped. A cancel signal is a follow-up.
- **Follow-ups (not in this PR):** an n8n/MCP `async` opt-in; making `async` the default and removing the sync browser path after one release; putting the enqueue into one RPC; an admin view of worker failures.

## Self-review

- **Spec coverage:**
  - `runImageGeneration(deps, job)` extraction: Task 2.
  - `async: true` with sync as the default: Task 3.
  - Row inserted before dispatch: Task 3.
  - Kick in `runInBackground`: Task 3.
  - 202 `{success, jobId, status:'queued'}`: Task 3.
  - `ai-image-worker` cron door plus worker.ts: Task 4.
  - `claim_ai_image_jobs(p_limit, p_lease)`: Task 1.
  - One job per claim within a 50 s budget: Task 4.
  - Terminal writes fenced on `claim_token`: Tasks 1 and 4.
  - Status short-circuit with `pollAfterSeconds: 3`: Task 5.
  - Migration: columns, RPC security, partial index, idempotent publication and guarded cron: Task 1.
  - Hook: Realtime plus polling, failed reads not terminal, `setTimeout` chain: Task 6.
  - Callers send `async: true`: Task 7.
  - Deno, SQL proof plus SUITES, Vitest and CI: Tasks 1-8.
  - types.ts: Task 8.
  - Deployment order and `verify_jwt`: Task 4 Step 5 and Deployment.
  - **Deviations from the spec:**
    - Quota is reserved per platform-Higgsfield candidate, not at claim (D12).
    - Heavy data goes to a side table the spec does not mention (Global Constraints).
    - The worker door answers 202 and works in `waitUntil` (D8).
    - "A failed read is never terminal" has one exception. The watcher ends on 401/403/404, because there the server has answered definitively: the job is gone or the session is. Every 5xx, network error or malformed body backs off (5→10→20→30 s) and keeps reading.
    - "One job per tick" is read as one job per claim. A tick claims again while its 50 s budget and the worker's lifetime gate allow, so cron ticks drain a backlog.
- **Placeholders:** none. Every step has code or an exact move range plus the exact edits allowed while moving.
- **Type consistency:**
  - `ImageJobInput`, `ImageRunResult` and `ImageRunDeps` are defined once (Task 2). `worker.ts`, `deps.ts` and `index.ts` use the same names.
  - `ClaimedImageJob` matches the `RETURNS SETOF ai_generation_jobs` columns it reads (`id`, `user_id`, `claim_token`, `params`).
  - `ImageJobCompletion` maps one-to-one onto the `complete_ai_image_job` arguments.
  - The `errorCode` values (`ai_quota_exhausted`, `ai_rate_limited`, `ai_interrupted`, `ai_attempts_exhausted`, `ai_queue_timeout`, `ai_result_expired`, `job_not_found`, `unauthorized`) are produced in Tasks 1, 2, 4, 5 and 6, and `ImageGenerator` maps the quota one (Task 7).
  - `AiJobStatus` is exported from the watcher and re-exported by the hook.
