-- Admin subscription OAuth credentials for AI providers
-- (spec docs/superpowers/specs/2026-11-12-ai-provider-auth-methods-design.md §5).
-- Tokens live only in Vault; the browser never reads this table.
--
-- One row per pi-ai OAuth provider ('anthropic', 'openai-codex'). The RPCs are
-- SECURITY DEFINER and granted to service_role only: the edge function is the
-- sole reader/writer. get_ai_oauth_credentials is plpgsql, not sql, for the
-- same reason as get_user_ai_provider_key (20260906120000): a LANGUAGE sql
-- body is validated at CREATE time and would fail on a database without the
-- supabase_vault extension.
CREATE TABLE IF NOT EXISTS public.ai_provider_oauth_connections (
  oauth_provider text PRIMARY KEY CHECK (oauth_provider IN ('anthropic','openai-codex')),
  provider_code text NOT NULL REFERENCES public.ai_providers(provider_code),
  credentials_secret_id uuid,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','reauth_required')),
  account_label text,
  expires_at timestamptz,
  refresh_lock_until timestamptz,
  last_refresh_error text,
  connected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_provider_oauth_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_provider_oauth_connections_deny ON public.ai_provider_oauth_connections;
CREATE POLICY ai_provider_oauth_connections_deny ON public.ai_provider_oauth_connections
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON public.ai_provider_oauth_connections FROM anon, authenticated;

-- The save path is also the refresh "complete" step: it clears the lease and
-- the error columns, and heals a reauth_required row back to connected.
CREATE OR REPLACE FUNCTION public.save_ai_oauth_credentials(
  p_oauth_provider text, p_provider_code text, p_credentials jsonb,
  p_account_label text, p_expires_at timestamptz, p_user uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_secret uuid;
BEGIN
  SELECT credentials_secret_id INTO v_secret FROM public.ai_provider_oauth_connections
    WHERE oauth_provider = p_oauth_provider FOR UPDATE;
  IF v_secret IS NULL THEN
    v_secret := vault.create_secret(p_credentials::text, 'ai_oauth_' || p_oauth_provider);
  ELSE
    PERFORM vault.update_secret(v_secret, p_credentials::text);
  END IF;
  INSERT INTO public.ai_provider_oauth_connections AS c
    (oauth_provider, provider_code, credentials_secret_id, status, account_label, expires_at,
     refresh_lock_until, last_refresh_error, connected_by, updated_at)
  VALUES (p_oauth_provider, p_provider_code, v_secret, 'connected', p_account_label, p_expires_at,
     NULL, NULL, p_user, now())
  ON CONFLICT (oauth_provider) DO UPDATE SET
    provider_code = EXCLUDED.provider_code, credentials_secret_id = EXCLUDED.credentials_secret_id,
    status = 'connected', account_label = COALESCE(EXCLUDED.account_label, c.account_label),
    expires_at = EXCLUDED.expires_at, refresh_lock_until = NULL, last_refresh_error = NULL,
    connected_by = COALESCE(EXCLUDED.connected_by, c.connected_by), updated_at = now();
END $fn$;

CREATE OR REPLACE FUNCTION public.get_ai_oauth_credentials(p_oauth_provider text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_credentials jsonb;
BEGIN
  SELECT ds.decrypted_secret::jsonb || jsonb_build_object('status', c.status)
    INTO v_credentials
  FROM public.ai_provider_oauth_connections c
  JOIN vault.decrypted_secrets ds ON ds.id = c.credentials_secret_id
  WHERE c.oauth_provider = p_oauth_provider;
  RETURN v_credentials;
END $fn$;

CREATE OR REPLACE FUNCTION public.begin_ai_oauth_refresh(p_oauth_provider text, p_lease_seconds int)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  WITH won AS (
    UPDATE public.ai_provider_oauth_connections
       SET refresh_lock_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
     WHERE oauth_provider = p_oauth_provider
       AND (refresh_lock_until IS NULL OR refresh_lock_until < now())
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM won)
$fn$;

CREATE OR REPLACE FUNCTION public.fail_ai_oauth_refresh(p_oauth_provider text, p_error text, p_reauth boolean)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  UPDATE public.ai_provider_oauth_connections
     SET refresh_lock_until = NULL, last_refresh_error = left(p_error, 500),
         status = CASE WHEN p_reauth THEN 'reauth_required' ELSE status END, updated_at = now()
   WHERE oauth_provider = p_oauth_provider
$fn$;

CREATE OR REPLACE FUNCTION public.delete_ai_oauth_connection(p_oauth_provider text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_secret uuid;
BEGIN
  DELETE FROM public.ai_provider_oauth_connections WHERE oauth_provider = p_oauth_provider
    RETURNING credentials_secret_id INTO v_secret;
  IF v_secret IS NOT NULL THEN DELETE FROM vault.secrets WHERE id = v_secret; END IF;
END $fn$;

CREATE OR REPLACE FUNCTION public.get_ai_oauth_statuses()
RETURNS TABLE(oauth_provider text, provider_code text, status text, account_label text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT oauth_provider, provider_code, status, account_label, expires_at FROM public.ai_provider_oauth_connections
$fn$;

DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'save_ai_oauth_credentials(text,text,jsonb,text,timestamptz,uuid)',
    'get_ai_oauth_credentials(text)', 'begin_ai_oauth_refresh(text,int)',
    'fail_ai_oauth_refresh(text,text,boolean)', 'delete_ai_oauth_connection(text)',
    'get_ai_oauth_statuses()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $grants$;

-- Kimi (Moonshot): OpenAI-compatible, API key only (pi-ai 0.73.1 has no Moonshot OAuth).
INSERT INTO public.ai_providers (provider_code, name, api_endpoint, api_key_env_var, api_type, supports_streaming, is_active, auth_type)
VALUES ('moonshot', 'Kimi (Moonshot)', 'https://api.moonshot.ai/v1', 'MOONSHOT_API_KEY', 'openai', true, false, 'api_key')
ON CONFLICT DO NOTHING;

INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, context_limit, is_active)
SELECT p.id, m.model_id, m.name, m.description, ARRAY['chat'], 256000, true
FROM public.ai_providers p
CROSS JOIN (VALUES
  ('kimi-k2.6', 'Kimi K2.6', 'Moonshot flagship model'),
  ('kimi-k2.5', 'Kimi K2.5', 'Moonshot general model'),
  ('kimi-k2-turbo-preview', 'Kimi K2 Turbo', 'Fast Kimi K2'),
  ('kimi-k2-thinking', 'Kimi K2 Thinking', 'Kimi K2 with extended reasoning')
) AS m(model_id, name, description)
WHERE p.provider_code = 'moonshot'
ON CONFLICT DO NOTHING;

INSERT INTO public.system_settings (key, value) VALUES ('feature_ai_provider_oauth', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
