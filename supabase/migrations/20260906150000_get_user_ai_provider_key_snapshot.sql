-- get_user_ai_provider_key_snapshot: single-statement key + row-version read for BYOK keys.
--
-- WHY THIS EXISTS: public.get_user_ai_provider_key(uuid,text,boolean)
-- (20260906120000 §C) returns only the decrypted key. Callers that need to
-- make a later write conditional on the key's version currently read
-- user_ai_provider_keys.updated_at in one statement and call that function
-- in another; a replacement committing between the two makes the version
-- and the key disagree. This function returns the key AND its row version
-- from the same statement (one snapshot), so version and key cannot skew.
--
-- READ THIS BEFORE EDITING: PostgREST serialises a RETURNS TABLE function
-- as an ARRAY even for one row. The Edge Function reader must take element
-- [0] (exactly one row) or handle the empty array (zero rows) -- it must
-- not expect a single object.
--
-- APPLY AS supabase_admin. It owns the function below; postgres is not a
-- superuser on this stack, and a REVOKE by a non-owner is a WARNING that
-- changes nothing (same reason as in 20260906120000).
--
-- Wrapped in one transaction like the sibling migrations. Idempotent
-- (OR REPLACE) so the file replays cleanly on the PG17 harness.
--
-- plpgsql, not sql, and the reason is the harness rather than taste. A
-- LANGUAGE sql body is parsed and validated when the function is CREATED, so
-- it fails with "relation vault.decrypted_secrets does not exist" on a
-- database without the supabase_vault extension -- which the harness baseline
-- is. A plpgsql body is not resolved until it runs. (Same comment as
-- 20260906120000 §C; same constraint.)
--
-- One function, one signature. Never add an overload: a second signature
-- would double as a second read path with its own (default-open)
-- privileges. Leave get_user_ai_provider_key untouched.
--
-- AMBIGUOUS-COLUMN WARNING: RETURNS TABLE declares out-params named
-- status/updated_at, so every column reference in the body MUST be qualified
-- (k.status, k.updated_at) or the body fails with "ambiguous column
-- reference" at execution.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_user_ai_provider_key_snapshot(
  p_user_id uuid,
  p_provider_code text,
  p_include_invalid boolean DEFAULT false
)
RETURNS TABLE(api_key text, status text, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  -- Qualified k.status / k.updated_at: the OUT params share those names,
  -- and an unqualified reference fails with "ambiguous column reference".
  RETURN QUERY
  SELECT (decrypted.decrypted_secret::jsonb ->> 'api_key'),
         k.status,
         k.updated_at
    FROM public.user_ai_provider_keys AS k
    JOIN vault.decrypted_secrets AS decrypted
      ON decrypted.id = k.credentials_secret_id
   WHERE k.user_id = p_user_id
     AND k.provider_code = p_provider_code
     AND (p_include_invalid OR k.status = 'active');
END;
$function$;

-- Named explicitly (not left to PUBLIC): this stack grants EXECUTE on new
-- functions to anon and authenticated by default privilege, and a bare
-- "REVOKE ... FROM PUBLIC" would leave them holding it (see 20260831150000).
REVOKE EXECUTE ON FUNCTION public.get_user_ai_provider_key_snapshot(uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_ai_provider_key_snapshot(uuid, text, boolean) TO service_role;

COMMIT;
