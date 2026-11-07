-- Background workers Phase C+D: a generic job table driven by one worker, and the first
-- kind, whatsapp_broadcast_chunk.
-- Spec: docs/superpowers/specs/2026-11-06-background-workers-design.md (Phase C+D).
-- Plan: docs/superpowers/plans/2026-11-07-background-workers-phase-cd.md.
--
-- No BEGIN/COMMIT on purpose: supabase/tests/background_jobs.sql applies this file twice
-- inside one transaction, so it has to stay idempotent and must never commit the caller's
-- transaction. Same rule as 20261107120000_ai_image_jobs_worker.sql.

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

CREATE INDEX IF NOT EXISTS background_jobs_due_idx
  ON public.background_jobs (run_after) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS background_jobs_running_idx
  ON public.background_jobs (claimed_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS background_jobs_user_idx
  ON public.background_jobs (user_id, created_at DESC);
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

-- Recipients gain 'sending' (set immediately before the Meta call, so a crash leaves at
-- most one indeterminate row per broadcast) and 'skipped' (the opt-out skip that
-- optOut.ts already writes -- the old check constraint rejected it, so every opted-out
-- recipient failed the whole skip write).
-- Same drop-and-recreate as 20260929100000_optout_exhaustion.sql.
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

-- ---------------------------------------------------------------------------
-- Internal enqueue. No API role may call it: the domain start_* functions call it
-- inside their own transaction, so the broadcast state flip and the job insert
-- commit together.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_background_job(p_user_id uuid, p_kind text, p_payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_id uuid;
BEGIN
  -- The per-user cap is a read-then-write, so two concurrent enqueues for the same
  -- user could both read 24 and both insert. The advisory lock serialises them:
  -- every enqueue for one user takes the same transaction-scoped lock, so the
  -- second one waits and then sees the first one's row. Lock order is always
  -- user-scoped and taken before any other lock, so two users can never wait on
  -- each other.
  PERFORM pg_advisory_xact_lock(hashtextextended('enqueue_background_job:' || p_user_id::text, 0));
  IF (SELECT count(*) FROM public.background_jobs
      WHERE user_id = p_user_id AND status IN ('queued','running')) >= 25 THEN
    RAISE EXCEPTION 'background job limit reached' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.background_jobs (user_id, kind, payload)
  VALUES (p_user_id, p_kind, coalesce(p_payload, '{}'::jsonb)) RETURNING id INTO v_id;
  RETURN v_id;
END $fn$;

-- The broadcast state flip and the job insert are one transaction, so two concurrent
-- clicks start exactly one job: the loser sees status <> 'pending' and gets NULL.
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

-- The conditional update is the whole guard: only the row that moved pending -> sending
-- may be sent, so two workers can never send the same recipient.
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

-- Settles every broadcast whose job has failed but that is still 'sending'.
-- A 'sending' broadcast with no job at all is left alone: it can only be one the
-- pre-job synchronous function is still sending at deploy time.
CREATE OR REPLACE FUNCTION public.sweep_background_jobs()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_failed int; r record;
BEGIN
  WITH exhausted AS (
    UPDATE public.background_jobs AS j
    SET status = 'failed', error = 'attempts_exhausted', claim_token = NULL,
        finished_at = now(), updated_at = now()
    WHERE j.status = 'running' AND j.claimed_at < now() - interval '3 minutes'
      AND j.attempts >= j.max_attempts
    RETURNING j.id
  ), stalled AS (
    -- A worker outage would leave a job queued forever: the exhausted-lease rule above
    -- only sees 'running' jobs. A live job's updated_at moves at every claim and every
    -- continue (at most every 3 minutes), so 15 minutes of silence means it is dead.
    UPDATE public.background_jobs AS j
    SET status = 'failed', error = 'stalled', claim_token = NULL,
        finished_at = now(), updated_at = now()
    WHERE j.status IN ('queued','running') AND j.updated_at < now() - interval '15 minutes'
    RETURNING j.id
  )
  SELECT (SELECT count(*) FROM exhausted) + (SELECT count(*) FROM stalled) INTO v_failed;

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
  RETURN v_failed;
END $fn$;

-- ---------------------------------------------------------------------------
-- Client state guards.
--
-- The owner's UPDATE policy on recipients lets a browser move 'sent' back to 'pending',
-- which would make the next chunk resend it. The broadcast counters and status are the
-- worker's truth; a browser may rename its own pending broadcast and nothing else.
--
-- The check keys on current_user, so the service role and SECURITY DEFINER callers pass
-- straight through. Modelled on whatsapp_scheduled_messages_client_guard
-- (20260930100000_whatsapp_scheduled_sender.sql).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_broadcast_recipients_client_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending'
      OR NEW.sent_at IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.whatsapp_broadcasts AS b
        WHERE b.id = NEW.broadcast_id AND b.status = 'pending'
        -- Hold admission against a concurrent pending -> sending transition until commit.
        FOR SHARE
      ) THEN
      RAISE EXCEPTION 'whatsapp_broadcast_recipients: clients may only insert fresh pending recipients into a pending broadcast'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'whatsapp_broadcast_recipients: clients may not update recipients'
    USING ERRCODE = '42501';
END;
$function$;

CREATE OR REPLACE FUNCTION public.whatsapp_broadcasts_client_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending'
      OR NEW.sent_count IS DISTINCT FROM 0
      OR NEW.failed_count IS DISTINCT FROM 0
      OR NEW.delivered_count IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'whatsapp_broadcasts: clients may only insert fresh pending broadcasts'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IS DISTINCT FROM 'pending'
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.sent_count IS DISTINCT FROM OLD.sent_count
    OR NEW.failed_count IS DISTINCT FROM OLD.failed_count
    OR NEW.delivered_count IS DISTINCT FROM OLD.delivered_count
    OR NEW.template_name IS DISTINCT FROM OLD.template_name
    OR NEW.template_components IS DISTINCT FROM OLD.template_components THEN
    RAISE EXCEPTION 'whatsapp_broadcasts: clients may only rename a pending broadcast'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.whatsapp_broadcast_recipients_client_guard()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_broadcast_recipients_client_guard()
  TO service_role;
REVOKE EXECUTE ON FUNCTION public.whatsapp_broadcasts_client_guard()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_broadcasts_client_guard()
  TO service_role;

DROP TRIGGER IF EXISTS whatsapp_broadcast_recipients_client_guard
  ON public.whatsapp_broadcast_recipients;
CREATE TRIGGER whatsapp_broadcast_recipients_client_guard
  BEFORE INSERT OR UPDATE ON public.whatsapp_broadcast_recipients
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_broadcast_recipients_client_guard();

DROP TRIGGER IF EXISTS whatsapp_broadcasts_client_guard
  ON public.whatsapp_broadcasts;
CREATE TRIGGER whatsapp_broadcasts_client_guard
  BEFORE INSERT OR UPDATE ON public.whatsapp_broadcasts
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_broadcasts_client_guard();

-- ---------------------------------------------------------------------------
-- Grants. Every RPC is service_role only: the browser never reaches the queue.
-- enqueue_background_job gets no grant at all -- it is internal to start_*.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.enqueue_background_job(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
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
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron missing; background-jobs crons not scheduled';
    RETURN;
  END IF;
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
