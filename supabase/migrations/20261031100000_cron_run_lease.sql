-- One process-scheduled-posts run at a time, enforced in SQL.
--
-- WHY
-- process-scheduled-posts runs every minute and publishes its due posts one at
-- a time, so a run with several posts outlives the next tick. On 2026-10-31 two
-- runs overlapped and both published the same two posts. #318 closed the
-- publish race (a scheduler claim now requires a claimable status), but the
-- overlap itself still happens: the second run refreshes the same accounts'
-- tokens concurrently with the first (rotating refresh tokens can be spent
-- twice) and calls process-post for posts the first run already holds.
--
-- WHAT
-- A lease row per cron job. acquire_cron_run_lease takes the lease when nobody
-- holds it or the holder's lease expired, and extends it when the caller already
-- holds it; it answers false while another holder's lease is live. The
-- ON CONFLICT ... DO UPDATE ... WHERE runs under the row lock, so two concurrent
-- callers can never both get true. release_cron_run_lease drops the lease only
-- for its own holder. The TTL bounds how long a run that died without releasing
-- (worker killed, crash) blocks the next one.
--
-- Additive and safe to apply before the Edge Function deploys: nothing calls
-- these functions until then. No BEGIN/COMMIT of its own.

CREATE TABLE IF NOT EXISTS public.cron_run_leases (
  job text PRIMARY KEY,
  holder uuid NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- Service-only state: RLS on with no policies, and no browser grants.
ALTER TABLE public.cron_run_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cron_run_leases FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.acquire_cron_run_lease(
  p_job text,
  p_holder uuid,
  p_ttl interval
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_holder uuid;
BEGIN
  IF coalesce(p_job, '') = '' OR p_holder IS NULL THEN
    RAISE EXCEPTION 'acquire_cron_run_lease: job and holder are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_ttl IS NULL OR p_ttl <= interval '0' OR p_ttl > interval '1 hour' THEN
    RAISE EXCEPTION 'acquire_cron_run_lease: ttl must be positive and at most one hour'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.cron_run_leases AS l (job, holder, acquired_at, expires_at)
  VALUES (p_job, p_holder, now(), now() + p_ttl)
  ON CONFLICT (job) DO UPDATE
    SET holder = EXCLUDED.holder,
        acquired_at = CASE WHEN l.holder = EXCLUDED.holder THEN l.acquired_at ELSE EXCLUDED.acquired_at END,
        expires_at = EXCLUDED.expires_at
    WHERE l.holder = EXCLUDED.holder OR l.expires_at <= now()
  RETURNING l.holder INTO v_holder;

  RETURN v_holder IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_cron_run_lease(
  p_job text,
  p_holder uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.cron_run_leases WHERE job = p_job AND holder = p_holder;
  RETURN FOUND;
END;
$$;

-- Same grant convention as the other cron and publish-path functions: service role only.
REVOKE ALL ON FUNCTION public.acquire_cron_run_lease(text, uuid, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_cron_run_lease(text, uuid, interval) TO service_role;
REVOKE ALL ON FUNCTION public.release_cron_run_lease(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_cron_run_lease(text, uuid) TO service_role;
