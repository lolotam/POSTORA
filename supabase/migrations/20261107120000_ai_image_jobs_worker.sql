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

-- Pure SQL: pg_cron must be able to settle jobs even when the edge worker is down.
-- The 3-minute lease mirrors AI_IMAGE_WORKER_LIMITS.lease in ai-image-worker/worker.ts.
CREATE OR REPLACE FUNCTION public.sweep_ai_image_jobs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- (e) Orphans: a queued or running worker row with no payload can never run. enqueue_ai_image_job
  -- makes this impossible; this keeps a hand-written or legacy row from lingering.
  UPDATE public.ai_generation_jobs j
     SET status = 'failed', error = 'Image generation could not be started. Please try again.',
         params = j.params || jsonb_build_object('error_code', 'ai_payload_missing'), claim_token = NULL, updated_at = now()
   WHERE j.modality = 'image' AND j.params->>'worker' = 'true' AND j.status IN ('queued', 'running')
     AND NOT EXISTS (SELECT 1 FROM public.ai_image_job_payloads p WHERE p.job_id = j.id);

  -- (a) Dispatched, lease expired: indeterminate. Fail, never re-run, never release.
  WITH done AS (
    UPDATE public.ai_generation_jobs
       SET status = 'failed', error = 'The generation was interrupted before it finished. Please try again.',
           params = params || jsonb_build_object('error_code', 'ai_interrupted'), claim_token = NULL, updated_at = now()
     WHERE modality = 'image' AND params->>'worker' = 'true'
       AND status = 'running' AND dispatched_at IS NOT NULL AND claimed_at < now() - interval '3 minutes'
    RETURNING id)
  UPDATE public.ai_image_job_payloads SET reference_images = '[]'::jsonb WHERE job_id IN (SELECT id FROM done);

  -- (b) Never dispatched, out of attempts or total lifetime spent. The absolute
  -- bound also covers delayed reclaims and a worker that never comes back.
  -- Queue 5 min + 3 attempts * 3 min lease = 14 min; the watcher allows 16 min.
  -- Keep src/lib/aiGenerationJobWatcher.ts in sync with this policy.
  WITH done AS (
    UPDATE public.ai_generation_jobs
       SET status = 'failed', error = 'Image generation could not be started. Please try again.',
           params = params || jsonb_build_object('error_code', 'ai_attempts_exhausted'), claim_token = NULL, updated_at = now()
     WHERE modality = 'image' AND params->>'worker' = 'true'
       AND status = 'running' AND dispatched_at IS NULL
       AND ((claimed_at < now() - interval '3 minutes' AND attempts >= 3)
            OR created_at < now() - interval '14 minutes')
    RETURNING id)
  UPDATE public.ai_image_job_payloads SET reference_images = '[]'::jsonb WHERE job_id IN (SELECT id FROM done);

  -- (c) Queued too long (worker down). Nothing was reserved.
  WITH done AS (
    UPDATE public.ai_generation_jobs
       SET status = 'timeout', error = 'Image generation did not start in time. Please try again.',
           params = params || jsonb_build_object('error_code', 'ai_queue_timeout'), updated_at = now()
     WHERE modality = 'image' AND params->>'worker' = 'true'
       AND status = 'queued' AND created_at < now() - interval '5 minutes'
    RETURNING id)
  UPDATE public.ai_image_job_payloads SET reference_images = '[]'::jsonb WHERE job_id IN (SELECT id FROM done);

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
  PERFORM public.sweep_ai_image_jobs();

  -- (d) Claim, oldest first, at most p_max_per_user running jobs per user. The per-user
  -- advisory lock serialises concurrent claimers for one user, so the cap count is never
  -- read by two claimers at once. It is a try-lock: a claimer holding one user's lock never
  -- waits on another's, which would deadlock two claimers; a busy user is simply skipped.
  IF p_limit IS NULL OR p_limit <= 0 THEN
    RETURN;
  END IF;
  FOR v_cand IN
    SELECT j.id, j.user_id
      FROM public.ai_generation_jobs j
     WHERE j.modality = 'image' AND j.params->>'worker' = 'true'
       AND EXISTS (SELECT 1 FROM public.ai_image_job_payloads p WHERE p.job_id = j.id)
       AND (j.status = 'queued'
            OR (j.status = 'running' AND j.dispatched_at IS NULL AND j.claimed_at < now() - p_lease AND j.attempts < 3
                -- Leave a full lease before the sweep's 14-minute total-age bound.
                AND j.created_at >= now() - interval '11 minutes'))
     ORDER BY j.created_at
     FOR UPDATE OF j SKIP LOCKED
  LOOP
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(hashtextextended('claim_ai_image_jobs:' || v_cand.user_id::text, 0));
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

REVOKE ALL ON FUNCTION public.sweep_ai_image_jobs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_ai_image_jobs() TO service_role;

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
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron missing; ai-image-worker crons not scheduled';
    RETURN;
  END IF;
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('sweep-ai-image-jobs', 'purge-ai-image-payloads');
  PERFORM cron.schedule('sweep-ai-image-jobs', '* * * * *', 'SELECT public.sweep_ai_image_jobs();');
  PERFORM cron.schedule('purge-ai-image-payloads', '17 * * * *', $cron$
    DELETE FROM public.ai_image_job_payloads WHERE created_at < now() - interval '24 hours';
  $cron$);
  IF to_regprocedure('public.get_cron_secret()') IS NULL THEN
    RAISE NOTICE 'get_cron_secret() missing; ai-image-worker HTTP cron not scheduled';
    RETURN;
  END IF;
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'ai-image-worker';
  PERFORM cron.schedule('ai-image-worker', '* * * * *', $cron$
    SELECT net.http_post(
      url := 'https://api.postora.cloud/functions/v1/ai-image-worker',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || get_cron_secret()),
      body := '{}'::jsonb
    );
  $cron$);
END
$do_cron_ai_image$;
