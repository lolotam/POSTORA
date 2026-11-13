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
-- losing the alert; transport idempotency deduplicates retries within 24 hours.
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

-- Standalone service keys predate provider rows. Seed their FK identities so
-- durable health/completion/alert writes work; never overwrite explicit disablement.
INSERT INTO public.ai_providers(provider_code, name, api_endpoint, api_key_env_var, api_type, supports_streaming)
VALUES ('firecrawl', 'Firecrawl', 'https://api.firecrawl.dev', 'FIRECRAWL_API_KEY', 'rest', false),
       ('apify', 'Apify', 'https://api.apify.com', 'APIFY_API_KEY', 'rest', false)
ON CONFLICT (provider_code) DO NOTHING;

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

-- Immutable degradation events survive recovery and multiple breaks before delivery.
CREATE TABLE IF NOT EXISTS public.ai_provider_health_alerts (
  alert_id uuid PRIMARY KEY,
  provider_code text NOT NULL REFERENCES public.ai_providers(provider_code) ON DELETE CASCADE,
  auth_method text NOT NULL CHECK (auth_method IN ('api_key','oauth')),
  status text NOT NULL CHECK (status IN ('failed','needs_relogin')),
  previous_status text NOT NULL DEFAULT 'connected' CHECK (previous_status = 'connected'),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  claimed_at timestamptz,
  notified_at timestamptz
);
CREATE INDEX IF NOT EXISTS ai_provider_health_alerts_pending_idx
  ON public.ai_provider_health_alerts(created_at) WHERE notified_at IS NULL;
ALTER TABLE public.ai_provider_health_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_provider_health_alerts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_provider_health_alerts TO service_role;

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
-- Repair a column introduced by a concurrent branch before enforcing its contract.
UPDATE public.ai_models SET auth_method = 'api_key'
 WHERE auth_method IS NULL OR auth_method NOT IN ('api_key', 'oauth');
ALTER TABLE public.ai_models ALTER COLUMN auth_method SET DEFAULT 'api_key';
ALTER TABLE public.ai_models ALTER COLUMN auth_method SET NOT NULL;
DO $auth_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ai_models'::regclass
    AND conname = 'ai_models_auth_method_check') THEN
    ALTER TABLE public.ai_models ADD CONSTRAINT ai_models_auth_method_check
      CHECK (auth_method IN ('api_key', 'oauth'));
  END IF;
END $auth_check$;

CREATE TABLE IF NOT EXISTS public.ai_provider_health_completions (
  run_id uuid NOT NULL,
  provider_code text NOT NULL REFERENCES public.ai_providers(provider_code) ON DELETE CASCADE,
  auth_method text NOT NULL CHECK (auth_method IN ('api_key','oauth')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, provider_code, auth_method)
);
CREATE TABLE IF NOT EXISTS public.ai_provider_health_runs (
  run_id uuid PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('daily','manual')),
  admin_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes')
);
CREATE INDEX IF NOT EXISTS ai_provider_health_runs_admin_idx
 ON public.ai_provider_health_runs(admin_id, completed_at DESC);
ALTER TABLE public.ai_provider_health_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_provider_health_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_provider_health_completions, public.ai_provider_health_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_provider_health_completions, public.ai_provider_health_runs TO service_role;

-- Admission spans HTTP chunks; the generic request lease still excludes overlap.
CREATE OR REPLACE FUNCTION public.admit_ai_provider_health_run(p_scope text, p_run_id uuid, p_admin_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run public.ai_provider_health_runs; v_cooldown int := 60; v_value jsonb;
BEGIN
  IF p_scope IS NULL OR p_scope NOT IN ('daily','manual') OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'Invalid health run';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ai_models'::regclass
    AND conname = 'ai_models_provider_id_model_id_key') THEN
    RAISE LOG 'ai_provider_health_rollout_pending: CONTRACT migration required';
    RETURN 'busy';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai-provider-health-admission', 0));
  -- Retain a week of immutable completion markers, independent of latest status.
  DELETE FROM public.ai_provider_health_completions WHERE recorded_at < now() - interval '7 days';
  DELETE FROM public.ai_provider_health_runs WHERE expires_at < now() - interval '7 days';
  -- Admission covers a logical run across chunks, in either direction. Expired
  -- runs cannot resume over a newer active run merely because their id exists.
  IF EXISTS (SELECT 1 FROM public.ai_provider_health_runs
    WHERE run_id <> p_run_id AND completed_at IS NULL AND expires_at > clock_timestamp()) THEN RETURN 'busy'; END IF;
  SELECT * INTO v_run FROM public.ai_provider_health_runs WHERE run_id = p_run_id;
  IF FOUND THEN
    IF v_run.scope <> p_scope OR v_run.admin_id IS DISTINCT FROM p_admin_id THEN RETURN 'busy'; END IF;
    IF v_run.completed_at IS NOT NULL THEN RETURN 'complete'; END IF;
    UPDATE public.ai_provider_health_runs SET expires_at = now() + interval '30 minutes' WHERE run_id = p_run_id;
    RETURN 'ready';
  END IF;
  IF p_scope = 'manual' THEN
    SELECT value INTO v_value FROM public.app_settings WHERE key = 'admin_ai_provider_health_cooldown_seconds';
    IF (v_value #>> '{}') ~ '^[0-9]{1,5}$' THEN v_cooldown := least(86400, (v_value #>> '{}')::int); END IF;
    IF EXISTS (SELECT 1 FROM public.ai_provider_health_runs WHERE admin_id IS NOT DISTINCT FROM p_admin_id
      AND scope = 'manual' AND completed_at > clock_timestamp() - make_interval(secs => v_cooldown)) THEN RETURN 'cooldown'; END IF;
  END IF;
  INSERT INTO public.ai_provider_health_runs(run_id, scope, admin_id) VALUES (p_run_id, p_scope, p_admin_id);
  RETURN 'ready';
END $$;
CREATE OR REPLACE FUNCTION public.complete_ai_provider_health_run(p_run_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.ai_provider_health_runs SET completed_at = now() WHERE run_id = p_run_id;
$$;
REVOKE ALL ON FUNCTION public.admit_ai_provider_health_run(text, uuid, uuid), public.complete_ai_provider_health_run(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_ai_provider_health_run(text, uuid, uuid), public.complete_ai_provider_health_run(uuid) TO service_role;

-- Fencing is transactional: lease takeover/release waits for this row lock.
-- Even a server statement left running after an HTTP abort cannot overlap the
-- next holder's catalogue writes. The deadline is checked again after writes.
CREATE OR REPLACE FUNCTION public.write_ai_health_catalog(p_holder uuid, p_rows jsonb, p_stamp_key text, p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_expires timestamptz;
BEGIN
  SELECT expires_at INTO v_expires FROM public.cron_run_leases
    WHERE job = 'ai-provider-health' AND holder = p_holder FOR UPDATE;
  IF v_expires IS NULL OR v_expires <= clock_timestamp() OR p_at < clock_timestamp() - interval '15 seconds' THEN
    RAISE EXCEPTION 'Health catalogue lease expired';
  END IF;
  INSERT INTO public.ai_models(provider_id, model_id, name, description, capabilities, context_limit,
    cost_per_1m_input_tokens, cost_per_1m_output_tokens, metadata, is_active, updated_at, auth_method)
  SELECT provider_id, model_id, name, description, capabilities, context_limit,
    cost_per_1m_input_tokens, cost_per_1m_output_tokens, metadata, is_active, updated_at, auth_method
  FROM jsonb_populate_recordset(NULL::public.ai_models, p_rows)
  ON CONFLICT (provider_id, model_id, auth_method) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description, capabilities = EXCLUDED.capabilities,
    context_limit = EXCLUDED.context_limit, cost_per_1m_input_tokens = EXCLUDED.cost_per_1m_input_tokens,
    cost_per_1m_output_tokens = EXCLUDED.cost_per_1m_output_tokens, metadata = EXCLUDED.metadata,
    is_active = EXCLUDED.is_active, updated_at = EXCLUDED.updated_at;
  INSERT INTO public.system_settings(key, value) VALUES (p_stamp_key, jsonb_build_object('at', p_at))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  IF v_expires <= clock_timestamp() OR p_at < clock_timestamp() - interval '15 seconds' THEN
    RAISE EXCEPTION 'Health catalogue lease expired';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.write_ai_health_catalog(uuid, jsonb, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_ai_health_catalog(uuid, jsonb, text, timestamptz) TO service_role;

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

  -- Each break has its own durable event. Latest status may recover while an
  -- older event is pending; recovery never deletes or replaces that event.
  v_changed := (v_old IS DISTINCT FROM p_status);
  IF v_old = 'connected' AND p_status IN ('failed','needs_relogin') THEN
    v_alert_id := gen_random_uuid();
    INSERT INTO public.ai_provider_health_alerts(alert_id, provider_code, auth_method, status, reason, previous_status)
      VALUES(v_alert_id, p_provider_code, p_auth_method, p_status, left(p_reason, 500), v_old);
  END IF;
  IF coalesce(v_old_pending, false) THEN
    v_pending := true;
    v_alert_id := v_old_alert_id;
  ELSIF v_old = 'connected' AND p_status IN ('failed','needs_relogin') THEN
    v_pending := true;
    v_alert_payload := jsonb_build_object('status', p_status, 'reason', left(p_reason, 500));
  ELSIF v_changed THEN
    -- A recovery after successful notification clears the latest-row mirror.
    v_pending := false;
    v_alert_id := NULL;
    v_alert_payload := NULL;
  ELSE
    v_pending := false;
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
    notified_at = CASE WHEN v_changed AND NOT coalesce(v_old_pending, false) THEN NULL ELSE h.notified_at END,
    claim_token = CASE WHEN v_changed AND NOT coalesce(v_old_pending, false) THEN NULL ELSE h.claim_token END,
    claimed_at = CASE WHEN v_changed AND NOT coalesce(v_old_pending, false) THEN NULL ELSE h.claimed_at END;
  IF p_run_id IS NOT NULL THEN
    INSERT INTO public.ai_provider_health_completions(run_id, provider_code, auth_method)
      VALUES (p_run_id, p_provider_code, p_auth_method) ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_provider_health(text, text, text, text, int, int, int, int, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_provider_health(text, text, text, text, int, int, int, int, uuid) TO service_role;

-- claim_ai_provider_health_notifications claims immutable unsent outbox events.
-- Latest status and previous_status cannot erase a pending event: a re-check,
-- recovery or later break preserves each independent notification.
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
  WITH claimed AS (
    UPDATE public.ai_provider_health_alerts a
       SET claim_token = p_claim_token, claimed_at = now()
     WHERE a.notified_at IS NULL
       AND (a.claim_token IS NULL OR a.claimed_at < now() - interval '10 minutes')
    RETURNING a.*
  ), mirrored AS (
    UPDATE public.ai_provider_health h SET claim_token = p_claim_token, claimed_at = now()
      FROM claimed a WHERE h.alert_id = a.alert_id RETURNING h.provider_code
  )
  SELECT a.provider_code, a.auth_method, a.status, a.reason, a.previous_status, a.alert_id
    FROM claimed a;

END;
$$;

REVOKE ALL ON FUNCTION public.claim_ai_provider_health_notifications(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_provider_health_notifications(uuid) TO service_role;

-- One row per call: the alert is sent provider by provider, and a send that
-- failed for one of them must not close the alert of the others. The single
-- argument form closed the whole claim and is gone.
DROP FUNCTION IF EXISTS public.mark_ai_provider_health_notified(uuid);

DROP FUNCTION IF EXISTS public.mark_ai_provider_health_notified(uuid, text, text);
CREATE OR REPLACE FUNCTION public.mark_ai_provider_health_notified(
  p_claim_token uuid,
  p_provider_code text,
  p_auth_method text,
  p_alert_id uuid DEFAULT NULL
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

  UPDATE public.ai_provider_health_alerts
     SET notified_at = now(), claim_token = NULL, claimed_at = NULL
   WHERE claim_token = p_claim_token AND provider_code = p_provider_code
     AND auth_method = p_auth_method AND (p_alert_id IS NULL OR alert_id = p_alert_id);
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.ai_provider_health h
     SET notified_at = CASE WHEN EXISTS (SELECT 1 FROM public.ai_provider_health_alerts a
           WHERE a.provider_code = p_provider_code AND a.auth_method = p_auth_method AND a.notified_at IS NULL)
         THEN NULL ELSE now() END,
         claim_token = NULL, claimed_at = NULL,
         alert_pending = EXISTS (SELECT 1 FROM public.ai_provider_health_alerts a
           WHERE a.provider_code = p_provider_code AND a.auth_method = p_auth_method AND a.notified_at IS NULL)
   WHERE h.provider_code = p_provider_code AND h.auth_method = p_auth_method;

END;
$$;

REVOKE ALL ON FUNCTION public.mark_ai_provider_health_notified(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_ai_provider_health_notified(uuid, text, text, uuid) TO service_role;

-- Bootstrap the environment URL resolver before these jobs and CONTRACT use it.
-- The later WhatsApp migration repeats this idempotent definition; fresh replay
-- must not depend on that later timestamp.
CREATE OR REPLACE FUNCTION public.get_cron_functions_base_url()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_base text;
BEGIN
  v_base := nullif(btrim(coalesce(current_setting('app.settings.supabase_url', true), '')), '');
  IF v_base IS NOT NULL THEN
    RETURN v_base;
  END IF;

  -- The vault is optional: a database without it still resolves the setting above.
  BEGIN
    SELECT nullif(btrim(coalesce(decrypted_secret, '')), '') INTO v_base
      FROM vault.decrypted_secrets
     WHERE name = 'functions_base_url'
     LIMIT 1;
  EXCEPTION WHEN others THEN
    v_base := NULL;
  END;

  RETURN nullif(v_base, '');
END;
$fn$;
REVOKE ALL ON FUNCTION public.get_cron_functions_base_url() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_cron_functions_base_url() TO service_role;

-- Once a day: test every configured AI provider and sync the catalogue of the ones that
-- pass. The run is split over four entries seven minutes apart because a single edge
-- invocation has a hard 50 second budget and pg_cron cannot wait for a follow-up call.
-- The body carries the chunk number; chunk 1..4 cover today's maximum of sixteen targets.
--
-- The four bodies are written out one by one on purpose: cron.schedule runs the third
-- argument as one statement. Each DO block resolves the environment URL at runtime
-- and skips with a NOTICE until the operator has configured it.
DO $do_ai_provider_health_cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')
     OR to_regprocedure('public.get_cron_functions_base_url()') IS NULL
     OR to_regprocedure('public.get_cron_secret()') IS NULL THEN
    RAISE NOTICE 'ai-provider-health cron not scheduled: pg_cron, pg_net or cron configuration helpers are missing; install prerequisites and reapply EXPAND before CONTRACT';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai-provider-health-1') THEN
    PERFORM cron.schedule(
      'ai-provider-health-1',
      '5 3 * * *',
      $$
      DO $do_call$
      DECLARE v_url text;
      BEGIN
        SELECT rtrim(public.get_cron_functions_base_url(), '/') || '/functions/v1/ai-provider-health' INTO v_url;
        IF v_url IS NULL THEN
          RAISE NOTICE 'ai-provider-health: no functions base URL configured, skipping this run';
          RETURN;
        END IF;
        PERFORM net.http_post(url := v_url, headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{"action":"run","scope":"daily","chunk":1}'::jsonb, timeout_milliseconds := 50000);
      END $do_call$;
      $$
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai-provider-health-2') THEN
    PERFORM cron.schedule(
      'ai-provider-health-2',
      '12 3 * * *',
      $$
      DO $do_call$
      DECLARE v_url text;
      BEGIN
        SELECT rtrim(public.get_cron_functions_base_url(), '/') || '/functions/v1/ai-provider-health' INTO v_url;
        IF v_url IS NULL THEN
          RAISE NOTICE 'ai-provider-health: no functions base URL configured, skipping this run';
          RETURN;
        END IF;
        PERFORM net.http_post(url := v_url, headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{"action":"run","scope":"daily","chunk":2}'::jsonb, timeout_milliseconds := 50000);
      END $do_call$;
      $$
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai-provider-health-3') THEN
    PERFORM cron.schedule(
      'ai-provider-health-3',
      '19 3 * * *',
      $$
      DO $do_call$
      DECLARE v_url text;
      BEGIN
        SELECT rtrim(public.get_cron_functions_base_url(), '/') || '/functions/v1/ai-provider-health' INTO v_url;
        IF v_url IS NULL THEN
          RAISE NOTICE 'ai-provider-health: no functions base URL configured, skipping this run';
          RETURN;
        END IF;
        PERFORM net.http_post(url := v_url, headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{"action":"run","scope":"daily","chunk":3}'::jsonb, timeout_milliseconds := 50000);
      END $do_call$;
      $$
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai-provider-health-4') THEN
    PERFORM cron.schedule(
      'ai-provider-health-4',
      '26 3 * * *',
      $$
      DO $do_call$
      DECLARE v_url text;
      BEGIN
        SELECT rtrim(public.get_cron_functions_base_url(), '/') || '/functions/v1/ai-provider-health' INTO v_url;
        IF v_url IS NULL THEN
          RAISE NOTICE 'ai-provider-health: no functions base URL configured, skipping this run';
          RETURN;
        END IF;
        PERFORM net.http_post(url := v_url, headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{"action":"run","scope":"daily","chunk":4}'::jsonb, timeout_milliseconds := 50000);
      END $do_call$;
      $$
    );
  END IF;
  -- EXPAND may precede deployment by days. CONTRACT activates these jobs only
  -- after the owner attests that every old writer has drained.
  UPDATE cron.job SET active = false WHERE jobname IN
    ('ai-provider-health-1','ai-provider-health-2','ai-provider-health-3','ai-provider-health-4');
END $do_ai_provider_health_cron$;
