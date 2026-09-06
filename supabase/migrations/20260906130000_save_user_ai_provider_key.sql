-- save_user_ai_provider_key: transactional Vault+row save for BYOK keys.
--
-- WHY THIS EXISTS: 20260906120000 created public.user_ai_provider_keys and the
-- Vault read path, but left the WRITE split across two Edge Function steps --
-- a Vault write (public.upsert_connector_credential_secret) and then a
-- separate row upsert, with compensation on failure. Two overlapping
-- replacement saves for the same (user, provider) can interleave between
-- those steps and leave Vault and the row pointing at different secrets.
-- This function folds both writes into ONE transaction: it takes an advisory
-- transaction lock for the (user, provider) pair, writes Vault, and upserts
-- the row. Because everything runs in one transaction, a failure anywhere
-- rolls back the Vault write too -- that is the whole point.
--
-- APPLY AS supabase_admin. It touches vault.* and owns the function below;
-- postgres is not a superuser on this stack, and a REVOKE by a non-owner is
-- a WARNING that changes nothing (same reason as in 20260906120000).
--
-- Wrapped in one transaction like the sibling migrations. Idempotent
-- (OR REPLACE) so the file replays cleanly on the PG17 harness.
--
-- plpgsql, not sql, and the reason is the harness rather than taste. A
-- LANGUAGE sql body is parsed and validated when the function is CREATED, so
-- it fails with "relation vault.secrets does not exist" on a database
-- without the supabase_vault extension -- which the harness baseline is. A
-- plpgsql body is not resolved until it runs. (Same comment as
-- 20260906120000 §C; same constraint.)
--
-- One function, one signature. Never add an overload: a second signature
-- would double as a second write path with its own (default-open)
-- privileges.

BEGIN;

CREATE OR REPLACE FUNCTION public.save_user_ai_provider_key(
  p_user_id uuid,
  p_provider_code text,
  p_api_key text,
  p_key_hint text,
  p_verified_at timestamptz
)
RETURNS TABLE(id uuid, provider_code text, key_hint text, status text, last_verified_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_existing uuid;
  v_id uuid;
BEGIN
  IF p_api_key IS NULL OR btrim(p_api_key) = '' THEN
    RAISE EXCEPTION 'api key must not be empty';
  END IF;
  IF p_provider_code NOT IN ('openai', 'claude', 'gemini', 'openrouter') THEN
    RAISE EXCEPTION 'unknown provider: %', p_provider_code;
  END IF;

  -- Serialises overlapping saves for the same key for the rest of this
  -- transaction. Transaction-scoped (xact), so no cleanup path can leak it.
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text || ':' || p_provider_code));

  SELECT k.credentials_secret_id INTO v_existing
    FROM public.user_ai_provider_keys AS k
   WHERE k.user_id = p_user_id
     AND k.provider_code = p_provider_code;

  IF v_existing IS NOT NULL
     AND EXISTS (SELECT 1 FROM vault.secrets WHERE vault.secrets.id = v_existing) THEN
    PERFORM vault.update_secret(
      v_existing,
      jsonb_build_object('api_key', p_api_key)::text
    );
    v_id := v_existing;
  ELSE
    -- Dangling id (a public-only restore leaves every id dangling) is
    -- repaired the same way 20260831140000 does it: a fresh secret is
    -- created and the row write below re-points the link in the same
    -- transaction. The name is for humans sweeping vault; it is never used
    -- for lookup. gen_random_uuid keeps it unique under vault.secrets'
    -- partial unique index on name.
    v_id := vault.create_secret(
      jsonb_build_object('api_key', p_api_key)::text,
      'user_ai_provider_key:credentials:' || gen_random_uuid()::text,
      'Per-user AI provider API key for public.user_ai_provider_keys'
    );
  END IF;

  INSERT INTO public.user_ai_provider_keys
    (user_id, provider_code, credentials_secret_id, key_hint, status,
     last_verified_at, last_error_code)
  VALUES (p_user_id, p_provider_code, v_id, p_key_hint, 'active',
          p_verified_at, NULL)
  -- ON CONSTRAINT, not ON CONFLICT (user_id, provider_code): the RETURNS
  -- TABLE out params (notably provider_code) are plpgsql variables, so a
  -- bare column name in the inference list is an "ambiguous column
  -- reference" error at execution. The constraint name is fixed by
  -- 20260906120000 §A.
  ON CONFLICT ON CONSTRAINT user_ai_provider_keys_user_provider_key DO UPDATE SET
    credentials_secret_id = EXCLUDED.credentials_secret_id,
    key_hint = EXCLUDED.key_hint,
    status = 'active',
    last_verified_at = EXCLUDED.last_verified_at,
    last_error_code = NULL;

  RETURN QUERY
  SELECT k.id, k.provider_code, k.key_hint, k.status,
         k.last_verified_at, k.updated_at
    FROM public.user_ai_provider_keys AS k
   WHERE k.user_id = p_user_id
     AND k.provider_code = p_provider_code;
END;
$function$;

-- Named explicitly (not left to PUBLIC): this stack grants EXECUTE on new
-- functions to anon and authenticated by default privilege, and a bare
-- "REVOKE ... FROM PUBLIC" would leave them holding it (see 20260831150000).
REVOKE EXECUTE ON FUNCTION public.save_user_ai_provider_key(uuid, text, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_user_ai_provider_key(uuid, text, text, text, timestamptz) TO service_role;

COMMIT;
