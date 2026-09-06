-- BYOK provider keys and routing (Slice 1 of the AI provider account/auth/routing plan).
--
-- Design contract: docs/superpowers/specs/2026-09-05-ai-provider-account-auth-routing-design.md §5.
-- Plan: docs/superpowers/plans/2026-09-05-ai-provider-account-auth-routing.md (Slice 1).
--
-- APPLY AS supabase_admin. It owns the vault-touching functions below; postgres is
-- not a superuser on this stack, and a REVOKE by a non-owner is a WARNING that
-- changes nothing (same reason as in 20260831150000).
--
-- Wrapped in one transaction like the two 20260831 migrations. Everything is
-- idempotent (IF NOT EXISTS / OR REPLACE / DROP-then-CREATE / ON CONFLICT) so
-- the file replays cleanly on the PG17 harness.
--
-- SAVE SERIALISATION (spec §7.5): there is deliberately NO advisory-lock wrapper
-- function here. The Edge Function handles the rare concurrent-first-save race
-- by re-reading the row after its write and deleting the newly created Vault
-- secret when the row now points at a different id (the losing race). A new
-- parameter list on the existing upsert_connector_credential_secret would add an
-- overload, which the design forbids, so no wrapper is added.
--
-- ACTIVATION WARNING (spec §5.5): this migration RENAMES but does NOT activate
-- the openai/claude providers. DefaultModelSelector exposes active providers
-- immediately and the deployed getAiEndpoint still routes them to Google, so
-- activation happens only after the edge functions are deployed and verified.

BEGIN;

-- ============================================================================
-- A. user_ai_provider_keys: one Vault-backed API key per (user, provider)
-- ============================================================================
-- Protection is copied from higgsfield_connections (20260820130000): the table
-- is revoked from anon/authenticated outright, authenticated gets a
-- column-level SELECT on the non-secret columns only, and the browser reads
-- through the security_invoker status view below. All writes go through the
-- user-ai-providers Edge Function under the service role, which is why
-- service_role keeps ALL (it bypasses RLS but still needs table privileges).
CREATE TABLE IF NOT EXISTS public.user_ai_provider_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider_code text NOT NULL REFERENCES public.ai_providers(provider_code)
    CHECK (provider_code IN ('openai', 'claude', 'gemini', 'openrouter')),
  credentials_secret_id uuid,
  key_hint text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'invalid')),
  last_verified_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_ai_provider_keys_user_provider_key UNIQUE (user_id, provider_code)
);

ALTER TABLE public.user_ai_provider_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_ai_provider_keys_owner_select ON public.user_ai_provider_keys;
CREATE POLICY user_ai_provider_keys_owner_select
  ON public.user_ai_provider_keys FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- The base table must never be client-readable beyond the safe columns: revoke
-- outright, then grant only the non-secret projection. credentials_secret_id
-- and last_error_code stay service-role-only (readable via
-- get_user_ai_provider_key, never directly).
REVOKE ALL ON public.user_ai_provider_keys FROM anon, authenticated;
GRANT SELECT (id, user_id, provider_code, key_hint, status, last_verified_at, updated_at)
  ON public.user_ai_provider_keys TO authenticated;
GRANT ALL ON public.user_ai_provider_keys TO service_role;

-- Status-only projection for the browser. Both conditions from the higgsfield
-- pattern are required: the WHERE clause scopes rows to the caller, and
-- security_invoker makes the base table's RLS apply to the view as well.
-- Without security_invoker the view would run as its DEFINER (this migration
-- role) and expose every user's key hints to every authenticated caller.
CREATE OR REPLACE VIEW public.user_ai_provider_key_status AS
  SELECT id, user_id, provider_code, key_hint, status, last_verified_at, updated_at
  FROM public.user_ai_provider_keys
  WHERE user_id = auth.uid();
ALTER VIEW public.user_ai_provider_key_status SET (security_invoker = on);
GRANT SELECT ON public.user_ai_provider_key_status TO authenticated;

DROP TRIGGER IF EXISTS user_ai_provider_keys_updated_at ON public.user_ai_provider_keys;
CREATE TRIGGER user_ai_provider_keys_updated_at
  BEFORE UPDATE ON public.user_ai_provider_keys
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================================
-- B. Cascade-path secret reclaim, cloned from reclaim_ai_agent_tool_secret()
--    (20260831140000). Application code cannot cover the cascades (user delete
--    removes key rows without going through the Edge Function), so this AFTER
--    DELETE trigger is the only thing that reclaims the Vault row on that
--    path. Idempotent with the app path: when the Edge Function already
--    removed the secret, this DELETE matches nothing.
--    No UPDATE trigger: no write path re-points a live secret id; the Edge
--    Function upserts the secret in place under the same id.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reclaim_user_ai_provider_key_secret()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  DELETE FROM vault.secrets WHERE id = OLD.credentials_secret_id;
  RETURN OLD;
END;
$function$;

-- Named explicitly (not left to PUBLIC): this stack grants EXECUTE on new
-- functions to anon and authenticated by default privilege, and a bare
-- "REVOKE ... FROM PUBLIC" would leave them holding it (see 20260831150000).
REVOKE EXECUTE ON FUNCTION public.reclaim_user_ai_provider_key_secret()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclaim_user_ai_provider_key_secret() TO service_role;

DROP TRIGGER IF EXISTS user_ai_provider_keys_reclaim_secret ON public.user_ai_provider_keys;
CREATE TRIGGER user_ai_provider_keys_reclaim_secret
  AFTER DELETE ON public.user_ai_provider_keys
  FOR EACH ROW
  WHEN (OLD.credentials_secret_id IS NOT NULL)
  EXECUTE FUNCTION public.reclaim_user_ai_provider_key_secret();

-- ============================================================================
-- C. get_user_ai_provider_key: the only read path for key material
-- ============================================================================
-- plpgsql, not sql, and the reason is the harness rather than taste. A
-- LANGUAGE sql body is parsed and validated when the function is CREATED, so
-- it fails with "relation vault.decrypted_secrets does not exist" on a
-- database without the supabase_vault extension -- which the harness baseline
-- is. A plpgsql body is not resolved until it runs. (Same comment as
-- 20260831150000; same constraint.)
--
-- One function, one signature. Never add an overload: the Vault name label
-- accepted as-is in upsert_connector_credential_secret exists for exactly
-- this reason.
CREATE OR REPLACE FUNCTION public.get_user_ai_provider_key(
  p_user_id uuid,
  p_provider_code text,
  p_include_invalid boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_key text;
BEGIN
  SELECT (decrypted.decrypted_secret::jsonb ->> 'api_key')
    INTO v_key
  FROM public.user_ai_provider_keys AS k
  JOIN vault.decrypted_secrets AS decrypted
    ON decrypted.id = k.credentials_secret_id
  WHERE k.user_id = p_user_id
    AND k.provider_code = p_provider_code
    AND (p_include_invalid OR k.status = 'active');

  RETURN v_key;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_user_ai_provider_key(uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_ai_provider_key(uuid, text, boolean) TO service_role;

-- ============================================================================
-- D. user_ai_routing_preferences: per-capability routing mode (spec §5.3)
-- ============================================================================
-- preferred_provider_code is deliberately NOT a foreign key to the keys table:
-- the resolver treats a missing or invalid key as "no user candidate".
-- Both CHECKs are explicitly named so they can be addressed (dropped,
-- inspected) individually; the harness mutation test drops the mode/consent
-- one by name.
CREATE TABLE IF NOT EXISTS public.user_ai_routing_preferences (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  capability text NOT NULL CHECK (capability IN ('*', 'chat', 'agent')),
  mode text NOT NULL CHECK (mode IN ('postora_only', 'user_first', 'user_only')),
  preferred_provider_code text
    CHECK (preferred_provider_code IN ('openai', 'claude', 'gemini', 'openrouter')),
  preferred_model_id text,
  allow_platform_fallback boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, capability),
  CONSTRAINT user_ai_routing_preferences_mode_consent_check CHECK (
    (mode = 'user_first'   AND allow_platform_fallback = true) OR
    (mode <> 'user_first'  AND allow_platform_fallback = false)
  ),
  CONSTRAINT user_ai_routing_preferences_provider_model_check CHECK (
    mode = 'postora_only' OR
    (preferred_provider_code IS NOT NULL AND preferred_model_id IS NOT NULL)
  )
);

ALTER TABLE public.user_ai_routing_preferences ENABLE ROW LEVEL SECURITY;

-- The browser writes this table directly, so it needs all four owner
-- policies; each one is scoped to the caller on both read and write sides.
DROP POLICY IF EXISTS user_ai_routing_preferences_owner_select ON public.user_ai_routing_preferences;
CREATE POLICY user_ai_routing_preferences_owner_select
  ON public.user_ai_routing_preferences FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
DROP POLICY IF EXISTS user_ai_routing_preferences_owner_insert ON public.user_ai_routing_preferences;
CREATE POLICY user_ai_routing_preferences_owner_insert
  ON public.user_ai_routing_preferences FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS user_ai_routing_preferences_owner_update ON public.user_ai_routing_preferences;
CREATE POLICY user_ai_routing_preferences_owner_update
  ON public.user_ai_routing_preferences FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS user_ai_routing_preferences_owner_delete ON public.user_ai_routing_preferences;
CREATE POLICY user_ai_routing_preferences_owner_delete
  ON public.user_ai_routing_preferences FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.user_ai_routing_preferences FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_ai_routing_preferences TO authenticated;
GRANT ALL ON public.user_ai_routing_preferences TO service_role;

DROP TRIGGER IF EXISTS user_ai_routing_preferences_updated_at ON public.user_ai_routing_preferences;
CREATE TRIGGER user_ai_routing_preferences_updated_at
  BEFORE UPDATE ON public.user_ai_routing_preferences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================================
-- E. ai_provider_waitlist: Codex demand signal (spec §5.4)
-- ============================================================================
-- Owner SELECT and INSERT only. Admin reads use the service role, which
-- bypasses RLS. PRIMARY KEY (user_id, provider_code) is the one-row-per-user-
-- per-provider rule: the second join attempt fails closed with a
-- unique_violation, which the Edge Function maps to idempotent success.
CREATE TABLE IF NOT EXISTS public.ai_provider_waitlist (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider_code text NOT NULL CHECK (provider_code IN ('codex')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider_code)
);

ALTER TABLE public.ai_provider_waitlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_provider_waitlist_owner_select ON public.ai_provider_waitlist;
CREATE POLICY ai_provider_waitlist_owner_select
  ON public.ai_provider_waitlist FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
DROP POLICY IF EXISTS ai_provider_waitlist_owner_insert ON public.ai_provider_waitlist;
CREATE POLICY ai_provider_waitlist_owner_insert
  ON public.ai_provider_waitlist FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON public.ai_provider_waitlist FROM anon, authenticated;
GRANT SELECT, INSERT ON public.ai_provider_waitlist TO authenticated;
GRANT ALL ON public.ai_provider_waitlist TO service_role;

-- ============================================================================
-- F. Catalog: rename only, seed current Anthropic models, retire old ones
-- ============================================================================
-- RENAME ONLY -- is_active is untouched here. Activating openai/claude before
-- the adapters are deployed would let an admin select a chain entry that the
-- deployed getAiEndpoint still routes to Google (spec §5.5).
UPDATE public.ai_providers SET name = 'OpenAI API' WHERE provider_code = 'openai';
UPDATE public.ai_providers SET name = 'Anthropic API' WHERE provider_code = 'claude';

-- Current catalog (ids and prices confirmed 2026-09-06 from
-- platform.claude.com/docs/en/models/overview). Idempotent on
-- (provider_id, model_id): re-running refreshes the row instead of failing.
INSERT INTO public.ai_models
  (provider_id, model_id, name, description, capabilities, context_limit,
   cost_per_1m_input_tokens, cost_per_1m_output_tokens, is_active)
SELECT p.id, v.model_id, v.name, v.description, v.capabilities, v.context_limit,
       v.cost_in, v.cost_out, true
FROM public.ai_providers AS p CROSS JOIN (VALUES
  ('claude-sonnet-5', 'Claude Sonnet 5', 'Best balance of speed and intelligence',
   ARRAY['chat','agent'], 1000000, 2.0, 10.0),
  ('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'Fastest, near-frontier',
   ARRAY['chat','agent'], 200000, 1.0, 5.0),
  ('claude-opus-5', 'Claude Opus 5', 'Most capable for complex agentic work',
   ARRAY['chat','agent'], 1000000, 5.0, 25.0)
) AS v(model_id, name, description, capabilities, context_limit, cost_in, cost_out)
WHERE p.provider_code = 'claude'
ON CONFLICT (provider_id, model_id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  capabilities = EXCLUDED.capabilities,
  context_limit = EXCLUDED.context_limit,
  cost_per_1m_input_tokens = EXCLUDED.cost_per_1m_input_tokens,
  cost_per_1m_output_tokens = EXCLUDED.cost_per_1m_output_tokens,
  is_active = true;

-- Retire the superseded Claude ids. Model rows may stay active in general
-- (the selector only shows models of active providers), but these ids are
-- retired upstream, so they go dark now rather than lingering as selectable.
UPDATE public.ai_models AS m
SET is_active = false
FROM public.ai_providers AS p
WHERE m.provider_id = p.id
  AND p.provider_code = 'claude'
  AND m.model_id IN ('claude-3-5-sonnet-20241022',
                     'claude-3-5-haiku-20241022',
                     'claude-3-opus-20240229',
                     'claude-sonnet-4-20250514');

-- ============================================================================
-- G. Feature flag (spec §5.5). No policy change: the "Authenticated can read
--    public settings" policy (20260709090000) admits every feature\_% key.
-- ============================================================================
INSERT INTO public.app_settings (key, value, description)
VALUES ('feature_byok_providers', 'false'::jsonb,
        'Enable user-owned AI provider keys and routing')
ON CONFLICT (key) DO NOTHING;

COMMIT;
