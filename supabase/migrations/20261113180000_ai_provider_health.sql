-- Latest provider health per (provider, auth_method), written by the ai-provider-health
-- edge function (spec 2026-11-13-ai-providers-test-and-sync-design.md).
--
-- WHY a table and not a log
-- The admin card shows "last checked" and the status for every provider without running
-- anything, and the daily job must leave a result behind. A log cannot answer "what is the
-- status now" without replaying every entry.
--
-- WHY previous_status
-- The alert fires on a transition: connected -> failed or connected -> needs re-login.
-- Copying the old status into previous_status on every write turns "did it just break?"
-- into a comparison the database can answer under a row lock, so two concurrent runs
-- cannot both fire the same alert.
--
-- WHY claim_token / claimed_at / notified_at
-- The notification is sent in two phases: claim the row, send, then mark it notified. A
-- run that dies between the send and the mark re-claims the row after 10 minutes instead of
-- losing the alert or sending it twice.

CREATE TABLE IF NOT EXISTS public.ai_provider_health (
  provider_code       text NOT NULL REFERENCES public.ai_providers(provider_code) ON DELETE CASCADE,
  auth_method        text NOT NULL DEFAULT 'api_key' CHECK (auth_method IN ('api_key','oauth')),
  status             text NOT NULL CHECK (status IN ('connected','failed','needs_relogin')),
  previous_status    text CHECK (previous_status IN ('connected','failed','needs_relogin')),
  reason             text,
  models_added       integer NOT NULL DEFAULT 0,
  models_updated     integer NOT NULL DEFAULT 0,
  models_deactivated integer NOT NULL DEFAULT 0,
  latency_ms         integer,
  run_id             uuid,
  checked_at         timestamptz NOT NULL DEFAULT now(),
  notified_at        timestamptz,
  claim_token        uuid,
  claimed_at         timestamptz,
  PRIMARY KEY (provider_code, auth_method)
);

CREATE INDEX IF NOT EXISTS ai_provider_health_checked_at_idx
  ON public.ai_provider_health (checked_at DESC);

ALTER TABLE public.ai_provider_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_provider_health FROM PUBLIC, anon;

-- Admin only: a normal authenticated user reads no row and writes none. The
-- grant is explicit so the policy, not a missing privilege, is what hides the
-- rows from a non-admin.
DROP POLICY IF EXISTS ai_provider_health_admin_all ON public.ai_provider_health;
CREATE POLICY ai_provider_health_admin_all ON public.ai_provider_health
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

GRANT SELECT ON TABLE public.ai_provider_health TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_provider_health TO service_role;

-- Models are keyed by credential kind: one provider can serve an API key and a
-- subscription login with the same model_id. The statements are idempotent so this
-- migration is safe next to the concurrent auth-grouping branch.
ALTER TABLE public.ai_models ADD COLUMN IF NOT EXISTS auth_method text NOT NULL DEFAULT 'api_key';
ALTER TABLE public.ai_models DROP CONSTRAINT IF EXISTS ai_models_provider_id_model_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS ai_models_provider_model_auth_method_key
  ON public.ai_models (provider_id, model_id, auth_method);

-- record_ai_provider_health reads the old status under a row lock so two
-- concurrent runs cannot both see 'connected'.
CREATE OR REPLACE FUNCTION public.record_ai_provider_health(
  p_provider_code text,
  p_auth_method text,
  p_status text,
  p_reason text,
  p_models_added int,
  p_models_updated int,
  p_models_deactivated int,
  p_latency_ms int,
  p_run_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old text;
BEGIN
  IF coalesce(p_provider_code, '') = '' OR coalesce(p_auth_method, '') = '' THEN
    RAISE EXCEPTION 'record_ai_provider_health: provider_code and auth_method are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('connected','failed','needs_relogin') THEN
    RAISE EXCEPTION 'record_ai_provider_health: unknown status %', p_status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT status INTO v_old FROM public.ai_provider_health
    WHERE provider_code = p_provider_code AND auth_method = p_auth_method
    FOR UPDATE;

  INSERT INTO public.ai_provider_health AS h (
    provider_code, auth_method, status, previous_status, reason,
    models_added, models_updated, models_deactivated, latency_ms, run_id, checked_at
  )
  VALUES (
    p_provider_code, p_auth_method, p_status, v_old,
    left(coalesce(p_reason, ''), 500),
    coalesce(p_models_added, 0), coalesce(p_models_updated, 0), coalesce(p_models_deactivated, 0),
    p_latency_ms, p_run_id, now()
  )
  ON CONFLICT (provider_code, auth_method) DO UPDATE SET
    status = EXCLUDED.status,
    previous_status = EXCLUDED.previous_status,
    reason = EXCLUDED.reason,
    models_added = EXCLUDED.models_added,
    models_updated = EXCLUDED.models_updated,
    models_deactivated = EXCLUDED.models_deactivated,
    latency_ms = EXCLUDED.latency_ms,
    run_id = EXCLUDED.run_id,
    checked_at = EXCLUDED.checked_at;
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_provider_health(text, text, text, text, int, int, int, int, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_provider_health(text, text, text, text, int, int, int, int, uuid) TO service_role;

-- claim_ai_provider_health_notifications returns the newly-degraded rows and claims them.
-- A claim older than 10 minutes with no notified_at is re-claimable, so a run that died
-- mid-notification does not lose the alert.
CREATE OR REPLACE FUNCTION public.claim_ai_provider_health_notifications(p_claim_token uuid)
RETURNS TABLE (
  provider_code text, auth_method text, status text, reason text, previous_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_claim_token IS NULL THEN
    RAISE EXCEPTION 'claim_ai_provider_health_notifications: claim token is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  UPDATE public.ai_provider_health h
     SET claim_token = p_claim_token, claimed_at = now()
   WHERE h.previous_status = 'connected'
     AND h.status IN ('failed','needs_relogin')
     AND h.notified_at IS NULL
     AND (h.claim_token IS NULL OR h.claimed_at IS NULL OR h.claimed_at < now() - interval '10 minutes')
  RETURNING h.provider_code, h.auth_method, h.status, h.reason, h.previous_status;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ai_provider_health_notifications(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_provider_health_notifications(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_ai_provider_health_notified(p_claim_token uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.ai_provider_health
     SET notified_at = now(), claim_token = NULL, claimed_at = NULL
   WHERE claim_token = p_claim_token;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_ai_provider_health_notified(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_ai_provider_health_notified(uuid) TO service_role;

-- Once a day: test every configured AI provider and sync the catalogue of the ones that
-- pass. The run is split over four entries seven minutes apart because a single edge
-- invocation has a hard 50 second budget and pg_cron cannot wait for a follow-up call.
-- The body carries the chunk number; chunk 1..4 cover today's maximum of sixteen targets.
--
-- The four bodies are written out one by one on purpose: cron.schedule runs the third
-- argument as a single SQL statement, and a literal body is provably one statement.
DO $do_ai_provider_health_cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR to_regprocedure('public.get_cron_secret()') IS NULL THEN
    RAISE NOTICE 'ai-provider-health cron not scheduled: pg_cron or get_cron_secret() is missing';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai-provider-health-1') THEN
    PERFORM cron.schedule(
      'ai-provider-health-1',
      '5 3 * * *',
      $$
      SELECT net.http_post(url := 'https://api.postora.cloud/functions/v1/ai-provider-health', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{"action":"run","scope":"daily","chunk":1}'::jsonb);
      $$
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai-provider-health-2') THEN
    PERFORM cron.schedule(
      'ai-provider-health-2',
      '12 3 * * *',
      $$
      SELECT net.http_post(url := 'https://api.postora.cloud/functions/v1/ai-provider-health', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{"action":"run","scope":"daily","chunk":2}'::jsonb);
      $$
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai-provider-health-3') THEN
    PERFORM cron.schedule(
      'ai-provider-health-3',
      '19 3 * * *',
      $$
      SELECT net.http_post(url := 'https://api.postora.cloud/functions/v1/ai-provider-health', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{"action":"run","scope":"daily","chunk":3}'::jsonb);
      $$
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai-provider-health-4') THEN
    PERFORM cron.schedule(
      'ai-provider-health-4',
      '26 3 * * *',
      $$
      SELECT net.http_post(url := 'https://api.postora.cloud/functions/v1/ai-provider-health', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{"action":"run","scope":"daily","chunk":4}'::jsonb);
      $$
    );
  END IF;
END $do_ai_provider_health_cron$;
