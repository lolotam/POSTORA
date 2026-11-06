# Background workers Phase C+D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Delegated implementers (Codex / Grok / OpenCode / Antigravity): read `ARCHITECTURE.md` before touching any file.** Nothing loads it for you. The sections that bind this plan are listed under Global Constraints.

**Goal:** Pressing **Send** on a WhatsApp broadcast answers in under a second with 202 `sending`. A background worker then sends the broadcast in time-bounded chunks, and the UI shows the live counts until the broadcast is `completed` or `failed`. No recipient is ever sent the template twice, and a crash never leaves a broadcast stuck in `sending`.

**Architecture:**
- **Generic jobs (D).**
  - One table, `background_jobs`, with a fenced lifecycle: `queued → running → (queued again via continue) → succeeded | failed`.
  - RPCs:
    - `claim_background_job(p_kinds, p_lease)` claims **one** job at a time with `FOR UPDATE SKIP LOCKED`, a fresh `claim_token` and `attempts + 1`.
    - `continue_background_job` and `complete_background_job` are fenced on `(id, claim_token)`.
    - `sweep_background_jobs()` is pure SQL with its own cron. It fails jobs whose expired lease has used up `max_attempts`, settles the domain row of every failed job, and purges terminal rows older than 7 days.
  - The worker is one edge function, `background-jobs-worker`. It has a registry that maps `kind` to a handler, and each handler returns `done | continue | failed`.
- **First kind (C): `whatsapp_broadcast_chunk`.**
  - `whatsapp-broadcast` keeps every validation it does today: auth, ownership, `status = 'pending'`, Cloud API credentials and that pending recipients exist.
  - It then calls one RPC, `start_whatsapp_broadcast`. In one transaction the RPC flips the broadcast `pending → sending` and inserts the job. Two concurrent clicks therefore start exactly one job.
  - The function kicks the worker inside `runInBackground` and returns 202.
  - **Each chunk:**
    1. Fail the indeterminate `sending` recipients that a crashed run left behind.
    2. Read up to 150 `pending` recipients and drop opt-outs.
    3. For each recipient, CAS `pending → sending`, then call Meta, then write `sent` (with a message id) or `failed`.
    4. Stop when the chunk's time budget is spent.
    5. Write the totals to the broadcast row.
    6. `continue` if recipients are still pending, otherwise finish.
- **Frontend.** `useWhatsAppBroadcasts` treats 202 as "submitted". While any broadcast is `sending`, the list follows `whatsapp_broadcasts` changes over Realtime, with bounded polling as the fallback. It toasts the final result when a tracked broadcast reaches `completed` or `failed`.

**Tech Stack:** Deno edge functions (self-hosted Supabase edge runtime, `workerTimeoutMs` 150 s), PostgREST RPC, pg_cron + pg_net, Supabase Realtime `postgres_changes`, React 18 + TanStack Query, Vitest, Deno test, SQL proof suites run by `scripts/db-harness.sh`.

**Spec:** `docs/superpowers/specs/2026-11-06-background-workers-design.md` (section "Phase C+D").

**Required reading before code:** `ARCHITECTURE.md` §1 (zero dead modules), §12 (index.ts is an adapter), §13-§14 (no body `user_id`), §15 (Zod), §16 (sanitized errors), §17 (no secret logging), §23 (RLS + policies + cross-user denial tests, `SECURITY DEFINER` with `search_path`, regenerate types), §24 (service-role key backend only), §25 (CORS), §26 (timeouts; never blindly retry a billable or user-visible side effect), §27 (`waitUntil` only for bounded work, state persisted), §28 (atomic claim, duplicate prevention, attempt state), §35 (no cosmetic refactors).

## Deviations from the spec (decided, with reasons)

| Spec says | This plan does | Why |
|---|---|---|
| `claim_background_jobs(p_kinds, p_limit, p_lease)` | `claim_background_job(p_kinds, p_lease)`, one row | The spec's worker bullet already says "claims one job at a time"; a limit nobody passes is a dead parameter (§1). |
| `enqueue_background_job(...)` callable by service_role | Internal SQL function `enqueue_background_job` that only `start_whatsapp_broadcast` calls; no grant to any API role | The broadcast state flip and the job insert must commit together (§28). A second, separately callable enqueue would have no caller today (§1). C' adds its own domain `start_*` RPCs that call it. |
| `_shared/backgroundJobs.ts: enqueueAndKick` | `_shared/backgroundJobs.ts: kickBackgroundJobsWorker` | Enqueue is the domain RPC (above); the helper only owns the kick, which is what the spec wants centralised. |
| `claim_broadcast_recipients` with `UPDATE … LIMIT … SKIP LOCKED` marking a batch `sending` | Read up to 150 `pending` rows; mark **one** recipient `sending` immediately before its Meta call | Marking a whole batch `sending` up front turns every not-yet-attempted recipient into "outcome unknown" when the worker dies. Per-recipient CAS bounds the indeterminate set to one row and still prevents double sends. |
| `status` includes `cancelled` | `queued, running, succeeded, failed` | No cancel path exists (§1). C' can widen the check when it ships a cancel. |
| Shared client layer `src/features/background-jobs/` (`useBackgroundJob`, `JobStatusBadge`, `submittedToast`) | Deferred to Phase C' | The broadcast UI already reads its own row (counts, status); `useBackgroundJob` and `JobStatusBadge` would have no caller in this PR (§1). C' has six callers and builds them there. |

## Global Constraints

- **Never send twice.** A recipient moves `pending → sending` by a conditional update (`WHERE status = 'pending'`) and only the row that won the update is sent. `sent` is written only with a Meta message id. A `sending` row found at the start of a chunk is failed with `error_message = 'outcome_unknown'` and is never resent.
- **Never stuck.** Every path out of a broadcast job leaves the broadcast `completed` or `failed`: the handler's `done`, a non-retryable `failed`, and the sweep's attempt exhaustion.
- **Lease longer than the worker.** The lease is `3 minutes`, which is longer than the 150 s worker lifetime. A live worker therefore never loses its lease, and a reclaimed job always belongs to a dead worker.
- **Kick is best effort.** The cron (`* * * * *`) is the safety net. A lost kick costs at most about 60 s.
- **No secrets or phone numbers in logs.** Logs carry ids and counts only.
- **Response contract.** `whatsapp-broadcast` returns `202 { accepted: true, jobId, broadcast_id, status: "sending" }`. Its error bodies and status codes stay as they are today: 400 for a non-pending broadcast, 400 `BROADCAST_REQUIRES_CLOUD_API` / `NO_WHATSAPP_ACCOUNT`, 400 "No pending recipients", 401 and 404. The only caller is `src/hooks/useWhatsAppBroadcasts.ts`; partner-api, n8n and MCP do not call this function (grep verified 2026-11-07).
- **Prod data.** On 2026-11-07, prod has 0 broadcasts and 0 recipients, so the constraint change rewrites no rows.
- **Commits:** `git commit -- <paths>` only. Never commit `graphify-out/`, logs or `.env*`. End every message with `Co-Authored-By: <model> <noreply@…>`.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20261108120000_background_jobs.sql` (create) | The table, RLS, the recipient `sending` status, the RPCs, realtime membership and the crons. |
| `supabase/tests/background_jobs.sql` (create) + `scripts/db-harness.sh` (register in `SUITES`) | SQL proof suite. |
| `supabase/functions/_shared/backgroundJobs.ts` (create) | `kickBackgroundJobsWorker`, the only place the kick lives. |
| `supabase/functions/background-jobs-worker/index.ts` (create) | Cron-auth door: answers 202 and runs the tick in `runInBackground`. |
| `supabase/functions/background-jobs-worker/worker.ts` (create) | Claim → handler → apply outcome loop. Pure; ports are injected. |
| `supabase/functions/background-jobs-worker/deps.ts` (create) | Postgres/PostgREST adapters for the worker ports. |
| `supabase/functions/background-jobs-worker/handlers/index.ts` (create) | Registry `kind → handler`. |
| `supabase/functions/whatsapp-broadcast/chunk.ts` (create) | `runBroadcastChunk(deps, input)`: the send loop that moves out of `handler.ts`. |
| `supabase/functions/whatsapp-broadcast/chunkDeps.ts` (create) | Postgres + Meta adapters for the chunk (moved out of `index.ts`). |
| `supabase/functions/whatsapp-broadcast/handler.ts` (modify) | Validation, then `start_whatsapp_broadcast`, then the kick, then 202. |
| `supabase/functions/whatsapp-broadcast/index.ts` (modify) | Builds the trimmed `BroadcastDeps`. |
| `src/hooks/useWhatsAppBroadcasts.ts` (modify) | Handles 202, follows `sending` broadcasts live, and toasts the final result. |
| `src/integrations/supabase/types.ts` (modify) | Regenerated types. |
| `.github/workflows/ci.yml` (modify) | Typecheck and test the worker and `whatsapp-broadcast`. |

---

### Task 1: Migration + SQL proof

**Files:**
- Create: `supabase/migrations/20261108120000_background_jobs.sql`
- Create: `supabase/tests/background_jobs.sql`
- Modify: `scripts/db-harness.sh` (add `background_jobs.sql` to `SUITES`, after `ai_image_jobs_worker.sql`)

**Interfaces — Produces:**
- `public.background_jobs` table:
  - Columns: `id uuid pk`, `user_id uuid not null → auth.users on delete cascade`, `kind text not null`, `payload jsonb not null default '{}'`, `status text not null default 'queued' check in ('queued','running','succeeded','failed')`, `attempts int not null default 0`, `max_attempts int not null default 3`, `run_after timestamptz not null default now()`, `claimed_at timestamptz`, `claim_token uuid`, `progress jsonb`, `result jsonb`, `error text`, `created_at`, `updated_at timestamptz not null default now()`, `finished_at timestamptz`.
- `public.claim_background_job(p_kinds text[], p_lease interval) RETURNS TABLE(id uuid, user_id uuid, kind text, payload jsonb, attempts int, claim_token uuid)`. Zero or one row.
- `public.continue_background_job(p_id uuid, p_token uuid, p_payload jsonb, p_progress jsonb, p_run_after timestamptz) RETURNS boolean`.
- `public.complete_background_job(p_id uuid, p_token uuid, p_status text, p_result jsonb, p_error text) RETURNS boolean`.
- `public.start_whatsapp_broadcast(p_user_id uuid, p_broadcast_id uuid) RETURNS uuid`. Returns the job id, or NULL when the broadcast is not the user's or not `pending`.
- `public.begin_broadcast_recipient_send(p_recipient_id uuid) RETURNS boolean`. CAS `pending → sending`.
- `public.fail_stale_broadcast_sends(p_broadcast_id uuid) RETURNS int`. Fails the leftover `sending` rows with `'outcome_unknown'`.
- `public.refresh_whatsapp_broadcast_totals(p_broadcast_id uuid, p_finish boolean) RETURNS TABLE(sent int, failed int, skipped int, pending int, final_status text)`.
- `public.sweep_background_jobs() RETURNS int`.

Every function is `SECURITY DEFINER SET search_path = public, pg_temp`. EXECUTE is revoked from `PUBLIC, anon, authenticated` and granted to `service_role` only. The exception is `enqueue_background_job`, which gets no grant to any API role.

- [ ] **Step 1: Write the SQL proof `supabase/tests/background_jobs.sql`** (it fails because the objects don't exist). Model it on `supabase/tests/ai_image_jobs_worker.sql`: a `BEGIN … ROLLBACK` block, `DO $$ … ASSERT … $$` checks, two users seeded through the harness helpers that file uses. Proofs (each is one `ASSERT` with a message naming it):
  - **BJ1:** `start_whatsapp_broadcast(owner, pending broadcast)` returns a job id. The broadcast becomes `sending`. One job exists with `kind = 'whatsapp_broadcast_chunk'` and `payload->>'broadcast_id'` = the broadcast id.
  - **BJ2:** A second `start_whatsapp_broadcast` on the same broadcast returns NULL, and the job count stays 1.
  - **BJ3:** `start_whatsapp_broadcast(other_user, broadcast)` returns NULL and changes nothing.
  - **BJ4:** `claim_background_job(ARRAY['whatsapp_broadcast_chunk'], '3 minutes')` returns the job with `attempts = 1` and a non-null token. Its status is `running`. A second claim returns 0 rows.
  - **BJ5:** `continue_background_job` with a wrong token returns false and changes nothing. With the right token it returns true, and the job becomes `queued` with `attempts = 0`, `claim_token IS NULL` and the new payload/progress.
  - **BJ6:** A job with `run_after > now()` is not claimed.
  - **BJ7:** A running job with `claimed_at = now() - '4 minutes'` and `attempts < max_attempts` is reclaimed with a new token and `attempts + 1`. The old token's `complete_background_job` now returns false.
  - **BJ8:** `complete_background_job(..., 'succeeded', ...)` sets `finished_at`, clears `claim_token` and returns true. A status outside `succeeded|failed` raises SQLSTATE `22023`.
  - **BJ9:** `begin_broadcast_recipient_send` returns true once and false on the second call. A recipient already `sent` returns false.
  - **BJ10:** `fail_stale_broadcast_sends` turns `sending` rows into `failed` with `error_message = 'outcome_unknown'`, leaves `pending` and `sent` alone, and returns the count.
  - **BJ11:** `refresh_whatsapp_broadcast_totals(b, false)` writes `sent_count`/`failed_count` from recipient rows and leaves the status alone. With `true` and 0 pending, it sets `completed` when `sent > 0` or nothing failed, and `failed` when `sent = 0 AND failed > 0`.
  - **BJ12:** `sweep_background_jobs()` on a running job with an expired lease and `attempts >= max_attempts`:
    - The job becomes `failed` with `error = 'attempts_exhausted'`.
    - Its broadcast becomes terminal: `sending` and `pending` recipients become `failed` with `error_message` `'outcome_unknown'` and `'broadcast_stopped'` respectively, the totals are refreshed and the status is set.
    - A `sending` broadcast that has no job at all is left unchanged.
  - **BJ13:** The sweep deletes `succeeded`/`failed` jobs whose `finished_at < now() - '7 days'` and keeps younger ones.
  - **BJ14:** Grants. `has_function_privilege('authenticated', 'public.claim_background_job(text[],interval)', 'EXECUTE')` is false, and likewise for every RPC listed above. `enqueue_background_job` is not executable by `service_role`, `authenticated` or `anon`.
  - **BJ15:** RLS. As `authenticated` user B, `SELECT count(*) FROM background_jobs` sees 0 of user A's jobs. As user A, the count is 1. Inserting as `authenticated` is denied.
  - **BJ16:** `background_jobs` and `whatsapp_broadcasts` are in `pg_publication_tables` for `supabase_realtime`.
  - **BJ17:** The cron job `sweep-background-jobs` exists. The migration's `DO` block runs twice without error (idempotent).

- [ ] **Step 2: Run the harness to see the suite fail.** Run `bash scripts/db-harness.sh`. Expected: FAIL in `background_jobs.sql` (`relation "public.background_jobs" does not exist`).

- [ ] **Step 3: Write the migration.**

```sql
-- Background workers Phase C+D: a generic job table driven by one worker, and the first
-- kind, whatsapp_broadcast_chunk. Spec: docs/superpowers/specs/2026-11-06-background-workers-design.md.
BEGIN;

CREATE TABLE IF NOT EXISTS public.background_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  run_after timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claim_token uuid,
  progress jsonb,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS background_jobs_due_idx ON public.background_jobs (run_after) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS background_jobs_running_idx ON public.background_jobs (claimed_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS background_jobs_user_idx ON public.background_jobs (user_id, created_at DESC);
-- One live job per broadcast: the CAS in start_whatsapp_broadcast already guarantees it,
-- the index makes a second insert impossible even if a future caller forgets the CAS.
CREATE UNIQUE INDEX IF NOT EXISTS background_jobs_one_live_broadcast
  ON public.background_jobs ((payload->>'broadcast_id'))
  WHERE kind = 'whatsapp_broadcast_chunk' AND status IN ('queued','running');

ALTER TABLE public.background_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Owners read their background jobs" ON public.background_jobs;
CREATE POLICY "Owners read their background jobs" ON public.background_jobs
  FOR SELECT TO authenticated USING (user_id = auth.uid());
REVOKE ALL ON public.background_jobs FROM anon, authenticated;
GRANT SELECT ON public.background_jobs TO authenticated;
GRANT ALL ON public.background_jobs TO service_role;

-- Recipients gain 'sending': set immediately before the Meta call, so a crash leaves at most
-- one indeterminate row per broadcast. Same drop-and-recreate as 20260929100000_optout_exhaustion.sql.
DO $do_recipient_sending$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.conname FROM pg_constraint c
           WHERE c.conrelid = 'public.whatsapp_broadcast_recipients'::regclass AND c.contype = 'c'
             AND pg_get_constraintdef(c.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.whatsapp_broadcast_recipients DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
  ALTER TABLE public.whatsapp_broadcast_recipients
    ADD CONSTRAINT whatsapp_broadcast_recipients_status_check
    CHECK (status IN ('pending','sending','sent','delivered','failed','skipped'));
END $do_recipient_sending$;
CREATE INDEX IF NOT EXISTS whatsapp_broadcast_recipients_open_idx
  ON public.whatsapp_broadcast_recipients (broadcast_id, created_at) WHERE status IN ('pending','sending');

-- Internal: no API role may call it; domain start_* functions call it inside their transaction.
CREATE OR REPLACE FUNCTION public.enqueue_background_job(p_user_id uuid, p_kind text, p_payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_id uuid;
BEGIN
  IF (SELECT count(*) FROM public.background_jobs
      WHERE user_id = p_user_id AND status IN ('queued','running')) >= 25 THEN
    RAISE EXCEPTION 'background job limit reached' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.background_jobs (user_id, kind, payload)
  VALUES (p_user_id, p_kind, coalesce(p_payload, '{}'::jsonb)) RETURNING id INTO v_id;
  RETURN v_id;
END $fn$;

CREATE OR REPLACE FUNCTION public.start_whatsapp_broadcast(p_user_id uuid, p_broadcast_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  UPDATE public.whatsapp_broadcasts SET status = 'sending', updated_at = now()
  WHERE id = p_broadcast_id AND user_id = p_user_id AND status = 'pending';
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN public.enqueue_background_job(p_user_id, 'whatsapp_broadcast_chunk',
    jsonb_build_object('broadcast_id', p_broadcast_id));
END $fn$;

CREATE OR REPLACE FUNCTION public.claim_background_job(p_kinds text[], p_lease interval)
RETURNS TABLE(id uuid, user_id uuid, kind text, payload jsonb, attempts int, claim_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF p_lease IS NULL OR p_lease <= interval '0' THEN
    RAISE EXCEPTION 'claim_background_job: p_lease must be positive' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH cand AS (
    SELECT j.id FROM public.background_jobs AS j
    WHERE j.kind = ANY (p_kinds)
      AND ((j.status = 'queued' AND j.run_after <= now())
        OR (j.status = 'running' AND j.claimed_at < now() - p_lease AND j.attempts < j.max_attempts))
    ORDER BY j.run_after
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.background_jobs AS j
  SET status = 'running', claimed_at = now(), claim_token = gen_random_uuid(),
      attempts = j.attempts + 1, updated_at = now()
  FROM cand WHERE j.id = cand.id
  RETURNING j.id, j.user_id, j.kind, j.payload, j.attempts, j.claim_token;
END $fn$;

-- A continue is a clean hand-off, not a crash: attempts restart so a long broadcast is not
-- exhausted by its own chunks.
CREATE OR REPLACE FUNCTION public.continue_background_job(
  p_id uuid, p_token uuid, p_payload jsonb, p_progress jsonb, p_run_after timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  UPDATE public.background_jobs
  SET status = 'queued', claim_token = NULL, claimed_at = NULL, attempts = 0,
      payload = coalesce(p_payload, payload), progress = p_progress,
      run_after = coalesce(p_run_after, now()), updated_at = now()
  WHERE id = p_id AND claim_token = p_token AND status = 'running';
  RETURN FOUND;
END $fn$;

CREATE OR REPLACE FUNCTION public.complete_background_job(
  p_id uuid, p_token uuid, p_status text, p_result jsonb, p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF p_status NOT IN ('succeeded','failed') THEN
    RAISE EXCEPTION 'complete_background_job: bad status %', p_status USING ERRCODE = '22023';
  END IF;
  UPDATE public.background_jobs
  SET status = p_status, result = p_result, error = left(p_error, 500), claim_token = NULL,
      finished_at = now(), updated_at = now()
  WHERE id = p_id AND claim_token = p_token AND status = 'running';
  RETURN FOUND;
END $fn$;

CREATE OR REPLACE FUNCTION public.begin_broadcast_recipient_send(p_recipient_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  UPDATE public.whatsapp_broadcast_recipients SET status = 'sending'
  WHERE id = p_recipient_id AND status = 'pending';
  RETURN FOUND;
END $fn$;

-- Only the lease holder calls this, at the start of a chunk; with a lease longer than the worker
-- lifetime, a 'sending' row then always belongs to a dead worker. Meta may have accepted it: never resend.
CREATE OR REPLACE FUNCTION public.fail_stale_broadcast_sends(p_broadcast_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_count int;
BEGIN
  UPDATE public.whatsapp_broadcast_recipients SET status = 'failed', error_message = 'outcome_unknown'
  WHERE broadcast_id = p_broadcast_id AND status = 'sending';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $fn$;

CREATE OR REPLACE FUNCTION public.refresh_whatsapp_broadcast_totals(p_broadcast_id uuid, p_finish boolean)
RETURNS TABLE(sent int, failed int, skipped int, pending int, final_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_sent int; v_failed int; v_skipped int; v_pending int; v_status text;
BEGIN
  SELECT count(*) FILTER (WHERE r.status IN ('sent','delivered')),
         count(*) FILTER (WHERE r.status = 'failed'),
         count(*) FILTER (WHERE r.status = 'skipped'),
         count(*) FILTER (WHERE r.status IN ('pending','sending'))
    INTO v_sent, v_failed, v_skipped, v_pending
  FROM public.whatsapp_broadcast_recipients AS r WHERE r.broadcast_id = p_broadcast_id;
  v_status := CASE WHEN p_finish THEN
                CASE WHEN v_sent = 0 AND v_failed > 0 THEN 'failed' ELSE 'completed' END
              END;
  UPDATE public.whatsapp_broadcasts AS b
  SET sent_count = v_sent, failed_count = v_failed,
      status = coalesce(v_status, b.status), updated_at = now()
  WHERE b.id = p_broadcast_id;
  RETURN QUERY SELECT v_sent, v_failed, v_skipped, v_pending, coalesce(v_status, 'sending');
END $fn$;

CREATE OR REPLACE FUNCTION public.sweep_background_jobs()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_exhausted int; r record;
BEGIN
  WITH exhausted AS (
    UPDATE public.background_jobs AS j
    SET status = 'failed', error = 'attempts_exhausted', claim_token = NULL,
        finished_at = now(), updated_at = now()
    WHERE j.status = 'running' AND j.claimed_at < now() - interval '3 minutes'
      AND j.attempts >= j.max_attempts
    RETURNING j.id
  ) SELECT count(*) INTO v_exhausted FROM exhausted;

  -- Settle every broadcast whose job has failed (exhausted here, or failed by the handler)
  -- but that is still 'sending'. A 'sending' broadcast with no job at all is left alone: it
  -- can only be one the pre-job synchronous function is still sending at deploy time.
  FOR r IN SELECT b.id FROM public.whatsapp_broadcasts AS b
           WHERE b.status = 'sending'
             AND EXISTS (SELECT 1 FROM public.background_jobs AS j
                         WHERE j.kind = 'whatsapp_broadcast_chunk'
                           AND j.payload->>'broadcast_id' = b.id::text AND j.status = 'failed')
             AND NOT EXISTS (SELECT 1 FROM public.background_jobs AS j
                             WHERE j.kind = 'whatsapp_broadcast_chunk'
                               AND j.payload->>'broadcast_id' = b.id::text
                               AND j.status IN ('queued','running','succeeded'))
  LOOP
    UPDATE public.whatsapp_broadcast_recipients
    SET status = 'failed',
        error_message = CASE status WHEN 'sending' THEN 'outcome_unknown' ELSE 'broadcast_stopped' END
    WHERE broadcast_id = r.id AND status IN ('pending','sending');
    PERFORM public.refresh_whatsapp_broadcast_totals(r.id, true);
  END LOOP;

  DELETE FROM public.background_jobs
  WHERE status IN ('succeeded','failed') AND finished_at < now() - interval '7 days';
  RETURN v_exhausted;
END $fn$;

REVOKE ALL ON FUNCTION public.enqueue_background_job(uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
DO $do_grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.start_whatsapp_broadcast(uuid,uuid)',
    'public.claim_background_job(text[],interval)',
    'public.continue_background_job(uuid,uuid,jsonb,jsonb,timestamptz)',
    'public.complete_background_job(uuid,uuid,text,jsonb,text)',
    'public.begin_broadcast_recipient_send(uuid)',
    'public.fail_stale_broadcast_sends(uuid)',
    'public.refresh_whatsapp_broadcast_totals(uuid,boolean)',
    'public.sweep_background_jobs()']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $do_grants$;

DO $do_realtime$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'background_jobs') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.background_jobs;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'whatsapp_broadcasts') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_broadcasts;
  END IF;
END $do_realtime$;

DO $do_cron_background_jobs$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('sweep-background-jobs', 'background-jobs-worker');
  PERFORM cron.schedule('sweep-background-jobs', '* * * * *', 'SELECT public.sweep_background_jobs();');
  IF to_regprocedure('public.get_cron_secret()') IS NULL THEN
    RAISE NOTICE 'get_cron_secret() missing; background-jobs-worker HTTP cron not scheduled';
    RETURN;
  END IF;
  PERFORM cron.schedule('background-jobs-worker', '* * * * *', $cron$
    SELECT net.http_post(
      url := 'https://api.postora.cloud/functions/v1/background-jobs-worker',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || get_cron_secret()),
      body := '{}'::jsonb
    );
  $cron$);
END
$do_cron_background_jobs$;

NOTIFY pgrst, 'reload schema';
COMMIT;
```

- [ ] **Step 4: Run the harness.** Run `bash scripts/db-harness.sh`. Expected: `db-harness: OK`, with `background_jobs.sql` passing every proof from BJ1 to BJ17.
- [ ] **Step 5: Commit.** `git commit -m "feat(background-jobs): generic job table and the broadcast start, claim and sweep" -- supabase/migrations/20261108120000_background_jobs.sql supabase/tests/background_jobs.sql scripts/db-harness.sh`

---

### Task 2: Broadcast chunk runner (`runBroadcastChunk`)

**Files:**
- Create: `supabase/functions/whatsapp-broadcast/chunk.ts`
- Create: `supabase/functions/whatsapp-broadcast/chunk.test.ts`

**Interfaces:**
- Consumes (Task 1 RPCs, through ports): `fail_stale_broadcast_sends`, `begin_broadcast_recipient_send`, `refresh_whatsapp_broadcast_totals`.
- Produces:

```ts
export const BROADCAST_CHUNK_LIMIT = 150;
export interface BroadcastChunkPorts {
  now(): number;
  loadBroadcast(broadcastId: string): Promise<BroadcastRecord & { user_id: string } | null>;
  loadWhatsAppAccounts(userId: string): Promise<WhatsAppAccountRow[]>;
  failStaleSends(broadcastId: string): Promise<number>;
  loadPendingRecipients(broadcastId: string, limit: number): Promise<BroadcastRecipient[]>; // throws on DB error
  optedOutPhones(userId: string, phones: string[]): Promise<Set<string>>;                // throws on lookup failure
  skipRecipients(broadcastId: string, ids: string[]): Promise<void>;
  logSendRefused(input: SendRefusedInput): Promise<void>;
  beginSend(recipientId: string): Promise<boolean>;
  markRecipientSent(id: string, sentAt: string): Promise<void>;
  markRecipientFailed(id: string, errorMessage: string): Promise<void>;
  insertOutbound(row: Record<string, unknown>): Promise<void>;
  postTemplate(phoneNumberId: string, accessToken: string, body: Record<string, unknown>): Promise<{ ok: boolean; data: { messages?: Array<{ id?: string }>; error?: { message?: string } } }>;
  refreshTotals(broadcastId: string, finish: boolean): Promise<{ sent: number; failed: number; skipped: number; pending: number; final_status: string }>;
  sleep(ms: number): Promise<void>;
}
export type ChunkOutcome =
  | { kind: "done"; result: { sent: number; failed: number; skipped: number; status: string } }
  | { kind: "continue"; progress: { sent: number; failed: number; skipped: number; pending: number } }
  | { kind: "failed"; error: string; retryable: boolean };
export async function runBroadcastChunk(ports: BroadcastChunkPorts, input: { broadcastId: string; deadlineMs: number }): Promise<ChunkOutcome>;
```

`BroadcastRecord`, `BroadcastRecipient` and `SendRefusedInput` keep their current definitions. The first two stay exported from `handler.ts`; `SendRefusedInput` comes from `../_shared/optOutLookup.ts`.

Behaviour, in order:
1. Load the broadcast. If it is missing or `status !== 'sending'`, return `{ kind: "done", result }` with zero counts and `status: broadcast?.status ?? "missing"`. The broadcast was deleted or is already terminal, and there is nothing to send.
2. Resolve credentials with `resolveWhatsAppCloudCredentials`. If it is not `ok`, return `{ kind: "failed", error: "credentials_unavailable", retryable: false }`. The sweep then settles the broadcast.
3. `failStaleSends(broadcastId)`.
4. `loadPendingRecipients(broadcastId, BROADCAST_CHUNK_LIMIT)`. If the list is empty, call `refreshTotals(id, true)` and return `done` with its counts and `final_status`.
5. Opt-out: the same partition and logging as today's handler (`partitionOptedOut`, `opted_out` / `opt_out_skip_failed` / `opt_out_lookup_failed` with `source: "whatsapp-broadcast"`). A lookup failure or skip failure returns `{ kind: "failed", error: "opt_out_lookup_failed" | "opt_out_skip_failed", retryable: true }`. Nothing has been sent yet, so a retry is safe.
6. For each recipient to send:
   - Stop when `now() >= deadlineMs`.
   - If `beginSend(id)` is false, skip the recipient: another worker owns it.
   - Build the body exactly as today's handler does: template name, language default `en_US`, optional body parameters.
   - Call `postTemplate`.
     - If the response is `ok` and has a message id: `markRecipientSent`, then `insertOutbound` with the same row shape as today, including the `[Broadcast: name]` content.
     - Otherwise: `markRecipientFailed(data.error?.message || "Send failed")`.
     - If `postTemplate` throws: `markRecipientFailed(error.message)`.
     - A throw from `markRecipientSent` or `insertOutbound` after a message id **must not** turn into `failed`. Catch it, `console.error` the recipient id only, and continue. The row stays `sending` and the next chunk fails it as `outcome_unknown` instead of resending.
   - `sleep(100)` between sends.
7. After the loop, call `refreshTotals(id, false)`. If `pending === 0`, call `refreshTotals(id, true)` and return `done`. Otherwise return `continue` with the progress.

- [ ] **Step 1: Write `chunk.test.ts`** with an in-memory fake ports object: an array of recipients plus recorded calls. It follows the style of `supabase/functions/whatsapp-broadcast/handler.test.ts`. Cases (`Deno.test` names are the scenarios):
  - `sends every pending recipient once and finishes completed`: 3 pending, Meta ok. Each is posted once, and the outcome is `done` with `status: "completed"` and `sent: 3`.
  - `a recipient another worker began is not posted`: `beginSend` returns false for one. `postTemplate` is called twice.
  - `stops at the deadline and continues`: `now()` passes `deadlineMs` after the first send. One post, and the outcome is `continue` with `pending: 2`.
  - `a stale sending row is failed before any send`: `failStaleSends` is called before the first `postTemplate`.
  - `a Meta error marks the recipient failed with Meta's message`.
  - `a write error after Meta accepted never marks the recipient failed`: `markRecipientSent` throws, `markRecipientFailed` is not called for that id, and the loop continues.
  - `all sends failing finishes failed`: the fake `refreshTotals(finish=true)` applies the SQL rule (`sent = 0 AND failed > 0 → failed`).
  - `missing credentials fail the job without retry`.
  - `opt-out lookup failure fails retryably before any send`.
  - `opted-out recipients are skipped and logged, others sent`.
  - `a broadcast no longer sending is done without sending`.
- [ ] **Step 2: Run** `deno test --allow-env --node-modules-dir=none supabase/functions/whatsapp-broadcast/chunk.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `chunk.ts`** per the behaviour above. Move the message-body builder out of `handler.ts` into a `templateMessageBody(broadcast, phone)` function in `chunk.ts`; the handler no longer builds messages.
- [ ] **Step 4: Run the test again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(whatsapp-broadcast): send a broadcast in time-bounded chunks that never resend" -- supabase/functions/whatsapp-broadcast/chunk.ts supabase/functions/whatsapp-broadcast/chunk.test.ts`

---

### Task 3: Worker (`background-jobs-worker`) + kick helper

**Files:**
- Create: `supabase/functions/_shared/backgroundJobs.ts`
- Create: `supabase/functions/background-jobs-worker/{index.ts,worker.ts,deps.ts,worker.test.ts}`
- Create: `supabase/functions/background-jobs-worker/handlers/index.ts`
- Create: `supabase/functions/whatsapp-broadcast/chunkDeps.ts`

**Interfaces:**
- Consumes: `runBroadcastChunk`, `BroadcastChunkPorts` and `ChunkOutcome` (Task 2), and the Task 1 RPCs.
- Produces:

```ts
// _shared/backgroundJobs.ts
export async function kickBackgroundJobsWorker(fetchFn: typeof fetch, supabaseUrl: string, serviceRoleKey: string): Promise<void>;
// background-jobs-worker/worker.ts
export const BACKGROUND_JOBS_LIMITS = { lease: "3 minutes", tickBudgetMs: 50_000, workerLifetimeMs: 150_000,
  minRemainingToClaimMs: 60_000, chunkBudgetMs: 40_000, writeReserveMs: 5_000 } as const;
export interface ClaimedJob { id: string; user_id: string; kind: string; payload: Record<string, unknown>; attempts: number; claim_token: string }
export type JobOutcome =
  | { kind: "done"; result: Record<string, unknown> }
  | { kind: "continue"; payload?: Record<string, unknown>; progress: Record<string, unknown>; runAfterMs?: number }
  | { kind: "failed"; error: string; retryable: boolean };
export type JobHandler = (job: ClaimedJob, deadlineMs: number) => Promise<JobOutcome>;
export interface BackgroundJobsWorkerPorts {
  now(): number;
  workerStartedAtMs: number;
  handlers: Record<string, JobHandler>;
  claim(kinds: string[], lease: string): Promise<ClaimedJob | null>;
  continueJob(job: ClaimedJob, o: Extract<JobOutcome, { kind: "continue" }>): Promise<boolean>;
  complete(job: ClaimedJob, status: "succeeded" | "failed", result: Record<string, unknown> | null, error: string | null): Promise<boolean>;
  log(level: "info" | "error", userId: string, message: string, metadata: Record<string, unknown>): Promise<void>;
}
export async function runBackgroundJobsWorker(ports: BackgroundJobsWorkerPorts): Promise<{ claimed: number; done: number; continued: number; failed: number; lost: number }>;
// handlers/index.ts
export function backgroundJobHandlers(admin: SupabaseClient): Record<string, JobHandler>; // { whatsapp_broadcast_chunk }
```

Worker loop:
1. Repeat until `now() - tickStart >= tickBudgetMs`, or `workerStartedAtMs + workerLifetimeMs - now() < minRemainingToClaimMs`. Never lease a job the worker cannot start.
2. `claim(Object.keys(handlers), lease)`. If it returns null, stop.
3. Call the handler with `deadlineMs = min(now() + chunkBudgetMs, workerStartedAtMs + workerLifetimeMs - writeReserveMs)`. A throw becomes `failed` with `retryable: true`.
4. Apply the outcome:
   - `done` → `complete("succeeded", result)`.
   - `continue` → `continueJob`.
   - `failed` with `retryable` and `attempts < 3` → leave the job `running`. Its lease expires and the job is reclaimed (`attempts + 1`), and after 3 attempts the sweep exhausts it. Log the retry. This reuses the existing fence; no new RPC.
   - `failed` that is not retryable (or exhausted) → `complete("failed", null, error)`. The sweep settles the broadcast within a minute.
   - A fenced write that returns false counts as `lost` and is logged; the loop continues.
5. Logs carry `job_id`, `kind`, the outcome kind and counts. They never carry phones or payload text.

`index.ts` mirrors `ai-image-worker/index.ts`: OPTIONS, then `verifyCronAuth`, then `runInBackground("background-jobs-worker tick", …)`, then 202.

`kickBackgroundJobsWorker` is a copy of `kickAiImageWorker`'s shape (POST `{}` with a service-role bearer, `AbortSignal.timeout(5_000)`, body cancelled, a warning on non-2xx) but targets `/functions/v1/background-jobs-worker`.

`chunkDeps.ts` builds `BroadcastChunkPorts` from an admin client. Its Meta and PostgREST calls move here from today's `whatsapp-broadcast/index.ts`: `postTemplate`, `markRecipientSent/Failed`, `insertOutbound`, `optedOutPhones`, `logSendRefused`, `skipRecipients`. RPC calls throw on `error`.

- [ ] **Step 1: Write `worker.test.ts`.** Fake ports with a scripted queue of claims. Cases:
  - `done completes the job succeeded`.
  - `continue hands the job back and the same tick claims the next`.
  - `a retryable failure leaves the job running for the lease to expire`: neither `complete` nor `continueJob` is called.
  - `a non-retryable failure completes the job failed`.
  - `a handler throw is a retryable failure`.
  - `a lost fence counts lost and the tick continues`.
  - `no claim when the worker lifetime cannot fit a chunk`.
  - `the handler deadline never passes the worker lifetime minus the write reserve`.
- [ ] **Step 2: Run** `deno test --allow-env --node-modules-dir=none supabase/functions/background-jobs-worker/`. Expected: FAIL.
- [ ] **Step 3: Implement** `worker.ts`, `deps.ts`, `handlers/index.ts`, `index.ts`, `_shared/backgroundJobs.ts` and `chunkDeps.ts`. The broadcast handler is:
  ```ts
  whatsapp_broadcast_chunk: (job, deadlineMs) =>
    runBroadcastChunk(createBroadcastChunkPorts(admin), { broadcastId: String(job.payload.broadcast_id), deadlineMs })
      .then((o) => o.kind === "continue" ? { kind: "continue", progress: o.progress } : o)
  ```
- [ ] **Step 4: Run the tests, plus** `deno check --node-modules-dir=none supabase/functions/background-jobs-worker/index.ts`. Expected: PASS, with no type errors.
- [ ] **Step 5: Commit.** `git commit -m "feat(background-jobs-worker): claim, run and fence generic background jobs" -- supabase/functions/_shared/backgroundJobs.ts supabase/functions/background-jobs-worker supabase/functions/whatsapp-broadcast/chunkDeps.ts`

---

### Task 4: `whatsapp-broadcast` answers 202 and starts the job

**Files:**
- Modify: `supabase/functions/whatsapp-broadcast/handler.ts`
- Modify: `supabase/functions/whatsapp-broadcast/index.ts`
- Modify: `supabase/functions/whatsapp-broadcast/handler.test.ts`

**Interfaces — Consumes:** `start_whatsapp_broadcast` (Task 1) and `kickBackgroundJobsWorker` (Task 3).

New `BroadcastDeps`:

```ts
export interface BroadcastDeps {
  authenticate(req: Request): Promise<{ userId: string } | { response: Response }>;
  loadBroadcast(userId: string, broadcastId: string): Promise<BroadcastRecord | null>;
  loadWhatsAppAccounts(userId: string): Promise<WhatsAppAccountRow[]>;
  hasPendingRecipients(broadcastId: string): Promise<boolean | null>; // null = DB error
  startBroadcast(userId: string, broadcastId: string): Promise<string | null>; // job id; throws on DB error
  kickWorker(): Promise<void>;
}
```

The handler keeps today's order and error bodies up to and including the credentials check. Opt-out moves to the chunk (Task 2): it now applies to every recipient, not only the first 1000. The handler then:
- `hasPendingRecipients`: `null` → 500 `{ error: "Could not read recipients" }`; `false` → 400 `{ error: "No pending recipients" }`.
- `jobId = startBroadcast(...)`. If it is `null`, return 409 `{ error: "Broadcast already started" }`. This is the race loser: the loser of a double click, or a second tab.
- `await runInBackground("kick background-jobs-worker", () => deps.kickWorker())`. The kick cannot fail the request; its errors are caught inside `runInBackground`.
- Return `202 { accepted: true, jobId, broadcast_id, status: "sending" }`.
- Add a Zod body schema: `z.object({ broadcast_id: z.string().uuid() })`. A bad body returns 400 `{ error: "broadcast_id required" }`, the same text as today.

- [ ] **Step 1: Rewrite `handler.test.ts`** for the new contract. Keep its existing fake-deps style. Cases:
  - `a valid send answers 202 with the job id and kicks the worker`.
  - `a broadcast that is not pending answers 400 as before`.
  - `the loser of two starts answers 409 and never kicks`.
  - `QR-only and missing credentials keep their 400 codes`.
  - `no pending recipients answers 400`.
  - `a recipient read error answers 500`.
  - `a non-uuid broadcast_id answers 400`.
  - `a kick that throws still answers 202`.
- [ ] **Step 2: Run** `deno test --allow-env --node-modules-dir=none supabase/functions/whatsapp-broadcast/`. Expected: FAIL.
- [ ] **Step 3: Implement** the handler and `index.ts` deps. Remove the send-loop deps from `index.ts`: they live in `chunkDeps.ts` now, so nothing stays dead. `optOut.ts` stays, because the chunk uses it.
- [ ] **Step 4: Run the tests, plus** `deno check --node-modules-dir=none supabase/functions/whatsapp-broadcast/index.ts`. Expected: PASS.
- [ ] **Step 5: Add CI.** In `.github/workflows/ci.yml`, add a step after "Typecheck and test AI image generation jobs":
  ```yaml
      - name: Typecheck and test background jobs and WhatsApp broadcasts
        run: |
          set -euo pipefail
          fn="supabase/functions"
          deno check --node-modules-dir=none "${fn}/background-jobs-worker/index.ts" "${fn}/whatsapp-broadcast/index.ts"
          deno test --allow-env --node-modules-dir=none "${fn}/background-jobs-worker/" "${fn}/whatsapp-broadcast/"
  ```
- [ ] **Step 6: Commit.** `git commit -m "feat(whatsapp-broadcast): Send answers 202 and a background job sends the broadcast" -- supabase/functions/whatsapp-broadcast/handler.ts supabase/functions/whatsapp-broadcast/index.ts supabase/functions/whatsapp-broadcast/handler.test.ts .github/workflows/ci.yml`

---

### Task 5: Frontend — submitted, live counts, final toast

**Files:**
- Modify: `src/hooks/useWhatsAppBroadcasts.ts`
- Create: `src/hooks/useWhatsAppBroadcasts.test.tsx`
- Modify: `src/integrations/supabase/types.ts` (regenerate; it adds `background_jobs` and the new RPCs)

**Behaviour:**
- **`sendBroadcast`:**
  - It accepts 202 as success. A non-2xx response throws `data.error`, unchanged.
  - `onSuccess`: `toast.success("Broadcast submitted — sending in the background")`, then invalidate the list.
  - A 409 surfaces as `toast.error("Broadcast failed: Broadcast already started")` (today's `onError` text pattern). This is acceptable copy.
- **Broadcast list query (`useQuery` in the same hook):**
  - Add `refetchInterval: (query) => (query.state.data ?? []).some((b) => b.status === "sending") ? 4_000 : false`. It is bounded by data: polling stops when nothing is sending.
  - Add one Realtime subscription in a `useEffect` keyed on `user?.id`: `supabase.channel(\`whatsapp-broadcasts-${user.id}-${crypto.randomUUID()}\`)`, listening to `postgres_changes` `{ event: "UPDATE", schema: "public", table: "whatsapp_broadcasts", filter: \`user_id=eq.${user.id}\` }`. It invalidates `queryKey`. Clean up with `supabase.removeChannel`. The unique topic follows the Phase B lesson: a shared topic throws on the second `.on()`.
  - Read the user the way this hook's create mutation does (check the top of the file; use `useAuth` if it already uses it).
- **Final toast:**
  - Keep a `useRef<Set<string>>` of broadcast ids this tab saw as `sending`.
  - When fresh data shows such an id as `completed`, toast `Broadcast complete: ${sent_count} sent, ${failed_count} failed`. When it shows `failed`, toast an error. Then drop the id. That is today's success copy, now shown when the broadcast actually finishes.
  - This lives in a `useEffect` on `broadcasts`.
- `BroadcastManager.tsx` needs no change: it already badges `sending` and hides **Send** when the status is not `pending`.

- [ ] **Step 1: Write `useWhatsAppBroadcasts.test.tsx`** (Vitest + Testing Library). Mock `@/integrations/supabase/client` and `sonner` the same way existing hook tests in `src/hooks/*.test.tsx` do; reuse one of them as the template. Cases:
  - `a 202 send toasts submitted, not complete`.
  - `a 409 send toasts the server error`.
  - `polls while a broadcast is sending and stops when none is`: use fake timers and assert the query function call count.
  - `a tracked broadcast that turns completed toasts its counts once`.
  - `a realtime update on the user's broadcasts refetches the list`.
  - `two hook instances subscribe on distinct topics`.
- [ ] **Step 2: Run** `npx vitest run src/hooks/useWhatsAppBroadcasts.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the hook changes.
- [ ] **Step 4: Regenerate types.** Apply the migration to the local harness DB, then run the project's type generation the way Phase B did (see `git log -p --follow src/integrations/supabase/types.ts | head` for the command used in `743df8e8`). Hand-editing types is not allowed (§23).
- [ ] **Step 5: Run** `npx vitest run src/hooks/useWhatsAppBroadcasts.test.tsx`, `npx tsc --noEmit -p tsconfig.app.json` and `npm run lint`. Expected: PASS, and no new lint diagnostics. The Lint/i18n gate counts a pre-existing `any` on an edited line as new, so type those lines.
- [ ] **Step 6: Commit.** `git commit -m "feat(broadcasts): Send shows submitted and follows the broadcast live to its result" -- src/hooks/useWhatsAppBroadcasts.ts src/hooks/useWhatsAppBroadcasts.test.tsx src/integrations/supabase/types.ts`

---

### Task 6: Gates, review, PR, deploy (orchestrator)

- [ ] Run the guard skills on the diff: `clean-code-guard` on production code, `test-guard` on tests.
- [ ] Run the gates:
  - `bash scripts/db-harness.sh`
  - `deno test` on `background-jobs-worker/` and `whatsapp-broadcast/`
  - `npx tsc --noEmit`
  - `npx vitest run`
  - `npm run lint`
- [ ] Open the PR `feat(background-jobs): generic background jobs; WhatsApp broadcasts send in the background (background workers phase C+D)` against `main`. The body states the deviations table and the deploy order.
- [ ] Deploy order:
  1. Apply the migration on prod over `ssh-contabo-mcp` (base64 chunks, then the SHA check, then `psql -1 -v ON_ERROR_STOP=1`).
  2. Verify:
     - `cron.job` has `sweep-background-jobs` and `background-jobs-worker` active.
     - `pg_publication_tables` has both tables.
     - `authenticated` has no EXECUTE on the RPCs.
  3. Merge (squash, `--match-head-commit` with the full SHA, keep the branch).
  4. Verify the edge sync SHA256 on the functions volume for `background-jobs-worker/*`, `whatsapp-broadcast/*` and `_shared/backgroundJobs.ts`.
  5. Probe OPTIONS on `background-jobs-worker` and `whatsapp-broadcast`.
  6. Check the Dokploy frontend deploy is `done`.
  7. Check `cron.job_run_details` for `succeeded`.
- [ ] Live verification by Waleed: create a broadcast to a few test contacts and press **Send**.
  - **Expect:** "submitted" at once, the badge on `sending`, the counts rising without a reload, then `completed` and the final toast. Each contact gets exactly one template. In the DB: one `background_jobs` row ends `succeeded`, and no recipient is left `pending` or `sending`.

## Self-review

- **Spec coverage:** the migration (Task 1), the worker and registry (Task 3), the kick helper (Task 3), `runBroadcastChunk` with a 150 limit and a time budget (Task 2), the HTTP 202 (Task 4), `sending` per recipient and `outcome_unknown` (Tasks 1–2), totals-based `finalStatus` (Task 1 `refresh_whatsapp_broadcast_totals`), the hook with 202, toast and bounded `refetchInterval` (Task 5), and the Realtime publication (Task 1). The SQL proof, the worker test, `handler.test.ts` and the hook test cover the spec's test list. The shared client layer is deferred, with the reason in the deviations table.
- **Placeholders:** none.
- **Type consistency:**
  - `ChunkOutcome` (Task 2) maps onto `JobOutcome` (Task 3) in the registry line.
  - `claim_background_job` returns the `ClaimedJob` fields.
  - `startBroadcast` returns `string | null`, and so does `start_whatsapp_broadcast`.
