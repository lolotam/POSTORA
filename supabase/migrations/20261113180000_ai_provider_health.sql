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
--
-- WHY alert_pending
-- previous_status answers "did it just break?", but it is overwritten by the next write:
-- re-checking a provider that is still broken turns previous_status into 'failed', and the
-- pending alert is lost before anyone was told. alert_pending is a durable flag instead.
-- It is set on the transition into a broken state and stays set until the alert is sent,
-- so a provider that breaks, is re-checked while still broken, and then breaks again
-- after a recovery raises an alert every time it breaks -- and exactly once per break.
--
-- WHY alert_id
-- The alert is sent in two phases and a run can die between them, so the same alert can
-- be claimed again. alert_id is the id of ONE break: it is minted when the provider
-- enters a broken state and stays the same while the provider is still broken. It is
-- sent to the mail provider as the idempotency key, so the second attempt of the same
-- alert is refused instead of mailing the admin twice.
--
-- WHY the counts are nullable
-- A provider that was not synced has NO count. A zero would say "nothing changed",
-- which is a different and wrong claim after a failed sync. The columns are nullable
-- and the RPC stores NULL for a count nobody measured.

CREATE TABLE IF NOT EXISTS public.ai_provider_health (
  provider_code       text NOT NULL REFERENCES public.ai_providers(provider_code) ON DELETE CASCADE,
  auth_method        text NOT NULL DEFAULT 'api_key' CHECK (auth_method IN ('api_key','oauth')),
  status             text NOT NULL CHECK (status IN ('connected','failed','needs_relogin')),
  previous_status    text CHECK (previous_status IN ('connected','failed','needs_relogin')),
  reason             text,
  models_added       integer,
  models_updated     integer,
  models_deactivated integer,
  latency_ms         integer,
  run_id             uuid,
  checked_at         timestamptz NOT NULL DEFAULT now(),
  notified_at        timestamptz,
  claim_token        uuid,
  claimed_at         timestamptz,
  alert_pending      boolean NOT NULL DEFAULT false,
  alert_id           uuid,
  alert_payload      jsonb,
  PRIMARY KEY (provider_code, auth_method)
);

CREATE INDEX IF NOT EXISTS ai_provider_health_checked_at_idx
  ON public.ai_provider_health (checked_at DESC);

ALTER TABLE public.ai_provider_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_provider_health FROM PUBLIC, anon, authenticated;

-- Admin only, and read only: a normal authenticated user reads no row, and an
-- authenticated admin cannot write one either. The health rows are written by the
-- edge function through the service role, never from the browser -- an admin who
-- could UPDATE notified_at could silence an alert by hand, so the privilege is
-- not granted. The grant is explicit so the policy, not a missing privilege, is
-- what hides the rows from a non-admin.
DROP POLICY IF EXISTS ai_provider_health_admin_all ON public.ai_provider_health;
DROP POLICY IF EXISTS ai_provider_health_admin_select ON public.ai_provider_health;
CREATE POLICY ai_provider_health_admin_select ON public.ai_provider_health
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

GRANT SELECT ON TABLE public.ai_provider_health TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_provider_health TO service_role;

-- Models are keyed by credential kind: one provider can serve an API key and a
-- subscription login with the same model_id. The statements are idempotent so this
-- migration is safe next to the concurrent auth-grouping branch.
--
-- WHY THIS MIGRATION IS THE EXPAND HALF
-- The three-column unique index is ADDED here and the old two-column unique
-- CONSTRAINT (ai_models_provider_id_model_id_key) is still in place. The edge
-- function that writes the catalogue upserts on (provider_id, model_id,
-- auth_method); the code that is deployed today upserts on (provider_id, model_id).
-- Dropping the old constraint before the new code is deployed would leave that
-- code with no unique index to upsert on, and Postgres answers 42P10.
--
-- The rollout is therefore:
--   1. apply THIS migration (EXPAND) -- both unique indexes exist
--   2. merge and deploy the edge functions
--   3. apply 20261113180100_ai_model_catalog_drop_legacy_unique.sql (CONTRACT)
--
-- WHAT THE EXPAND WINDOW COSTS
-- Until the CONTRACT migration is applied, the old two-column constraint still
-- forbids a second row for the same (provider_id, model_id). An OAuth catalogue
-- row for a model that already has an API-key row therefore cannot be written
-- yet. The OAuth sync reports that as a sync error rather than pretending the
-- catalogue is in sync.
ALTER TABLE public.ai_models ADD COLUMN IF NOT EXISTS auth_method text NOT NULL DEFAULT 'api_key';
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
  v_old_pending boolean := false;
  v_old_alert_id uuid;
  v_alert_id uuid;
  v_alert_payload jsonb;
  v_pending boolean := false;
  v_changed boolean;
BEGIN
  IF coalesce(p_provider_code, '') = '' OR coalesce(p_auth_method, '') = '' THEN
    RAISE EXCEPTION 'record_ai_provider_health: provider_code and auth_method are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('connected','failed','needs_relogin') THEN
    RAISE EXCEPTION 'record_ai_provider_health: unknown status %', p_status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT status, alert_pending, alert_id, alert_payload INTO v_old, v_old_pending, v_old_alert_id, v_alert_payload
    FROM public.ai_provider_health
    WHERE provider_code = p_provider_code AND auth_method = p_auth_method
    FOR UPDATE;

  -- A status change is a new state, so the notification state of the old one is
  -- dropped and the row becomes claimable again. An unchanged status keeps it:
  -- a provider that is still broken raises no second alert, and an alert that was
  -- never sent survives a re-check.
  v_changed := (v_old IS DISTINCT FROM p_status);
  IF v_changed THEN
    IF p_status IN ('failed','needs_relogin')
       AND (v_old = 'connected'
            OR (v_old IN ('failed','needs_relogin') AND coalesce(v_old_pending, false))) THEN
      -- It just broke, or it is still broken with an alert nobody sent yet.
      v_pending := true;
      IF v_old = 'connected' THEN
        -- It just broke: this is a new break, so it gets a new id. The id is the
        -- mail provider's idempotency key, so it has to name ONE break.
        v_alert_id := gen_random_uuid();
        v_alert_payload := jsonb_build_object('status', p_status, 'reason', left(p_reason, 500));
      ELSE
        -- It is still the same break: the id stays, so a re-claimed alert is the
        -- same alert and cannot be mailed twice.
        v_alert_id := v_old_alert_id;
      END IF;
    ELSE
      -- It recovered, or it was never connected: there is nothing to alert about.
      v_pending := false;
      v_alert_id := NULL;
      v_alert_payload := NULL;
    END IF;
  ELSE
    v_pending := coalesce(v_old_pending, false);
    v_alert_id := v_old_alert_id;
  END IF;

  INSERT INTO public.ai_provider_health AS h (
    provider_code, auth_method, status, previous_status, reason,
    models_added, models_updated, models_deactivated, latency_ms, run_id, checked_at,
    alert_pending, alert_id, alert_payload
  )
  VALUES (
    p_provider_code, p_auth_method, p_status, v_old,
    left(coalesce(p_reason, ''), 500),
    p_models_added, p_models_updated, p_models_deactivated,
    p_latency_ms, p_run_id, now(),
    v_pending, v_alert_id, v_alert_payload
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
    checked_at = EXCLUDED.checked_at,
    alert_pending = EXCLUDED.alert_pending,
    alert_id = EXCLUDED.alert_id,
    alert_payload = EXCLUDED.alert_payload,
    notified_at = CASE WHEN v_changed THEN NULL ELSE h.notified_at END,
    claim_token = CASE WHEN v_changed THEN NULL ELSE h.claim_token END,
    claimed_at = CASE WHEN v_changed THEN NULL ELSE h.claimed_at END;
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_provider_health(text, text, text, text, int, int, int, int, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_provider_health(text, text, text, text, int, int, int, int, uuid) TO service_role;

-- claim_ai_provider_health_notifications returns the rows whose alert is still
-- pending and claims them. The pending flag, not previous_status, decides: a
-- provider that is re-checked while still broken keeps its pending alert.
-- A claim older than 10 minutes with no notified_at is re-claimable, so a run that died
-- mid-notification does not lose the alert.
--
-- The function is dropped first because its result gained a column: Postgres cannot
-- change the result of an existing function with CREATE OR REPLACE.
DROP FUNCTION IF EXISTS public.claim_ai_provider_health_notifications(uuid);
CREATE OR REPLACE FUNCTION public.claim_ai_provider_health_notifications(p_claim_token uuid)
RETURNS TABLE (
  provider_code text, auth_method text, status text, reason text, previous_status text,
  alert_id uuid
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
   WHERE h.alert_pending
     AND h.status IN ('failed','needs_relogin')
     AND h.notified_at IS NULL
     AND (h.claim_token IS NULL OR h.claimed_at IS NULL OR h.claimed_at < now() - interval '10 minutes')
  -- Retrying an idempotency key requires the same payload. A later health check
  -- may change the live reason or failed status without creating a new break.
  RETURNING h.provider_code, h.auth_method,
    coalesce(h.alert_payload->>'status', h.status),
    CASE WHEN h.alert_payload IS NOT NULL THEN h.alert_payload->>'reason' ELSE h.reason END,
    h.previous_status, h.alert_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ai_provider_health_notifications(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_provider_health_notifications(uuid) TO service_role;

-- One row per call: the alert is sent provider by provider, and a send that
-- failed for one of them must not close the alert of the others. The single
-- argument form closed the whole claim and is gone.
DROP FUNCTION IF EXISTS public.mark_ai_provider_health_notified(uuid);

CREATE OR REPLACE FUNCTION public.mark_ai_provider_health_notified(
  p_claim_token uuid,
  p_provider_code text,
  p_auth_method text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_claim_token IS NULL OR coalesce(p_provider_code, '') = '' OR coalesce(p_auth_method, '') = '' THEN
    RAISE EXCEPTION 'mark_ai_provider_health_notified: claim token, provider_code and auth_method are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.ai_provider_health
     SET notified_at = now(), claim_token = NULL, claimed_at = NULL, alert_pending = false
   WHERE claim_token = p_claim_token
     AND provider_code = p_provider_code
     AND auth_method = p_auth_method;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_ai_provider_health_notified(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_ai_provider_health_notified(uuid, text, text) TO service_role;

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
