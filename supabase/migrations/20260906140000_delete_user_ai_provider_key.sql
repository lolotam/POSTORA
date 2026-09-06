-- delete_user_ai_provider_key: locked Vault-safe delete for BYOK keys.
--
-- WHY THIS EXISTS: 20260906130000_save_user_ai_provider_key.sql serialises
-- saves for one (user, provider) with
-- pg_advisory_xact_lock(hashtext(p_user_id::text || ':' || p_provider_code)),
-- but a delete of the same row from the Edge Function takes no lock at all.
-- A delete overlapping a save can interleave between the save's Vault write
-- and its row upsert (or between its row read and its row write) and leave an
-- active row pointing at a reclaimed Vault secret. This function closes that
-- hole: it takes the SAME lock and deletes the row in the same transaction,
-- so a delete and a save for the same (user, provider) can never overlap.
-- The existing AFTER DELETE trigger user_ai_provider_keys_reclaim_secret
-- (20260906120000 §B) reclaims the Vault secret inside the same transaction;
-- this function does NOT touch vault.* directly.
--
-- LOCK KEY, READ THIS BEFORE EDITING: the lock expression below is
-- byte-identical to the one in save_user_ai_provider_key -- both hash the
-- string (p_user_id::text || ':' || p_provider_code) with hashtext and lock
-- the result with pg_advisory_xact_lock. Advisory locks only exclude each
-- other when the hashed key is the same 32-bit value, so even a cosmetic
-- drift (a different separator, a cast in another position, text vs varchar)
-- would hash to a different key and silently stop the save and the delete
-- from serialising each other. The byok_provider_keys suite asserts the
-- shared substring in both bodies for exactly this reason.
--
-- APPLY AS supabase_admin. It owns the function below; postgres is not a
-- superuser on this stack, and a REVOKE by a non-owner is a WARNING that
-- changes nothing (same reason as in 20260906120000).
--
-- Wrapped in one transaction like the sibling migrations. Idempotent
-- (OR REPLACE) so the file replays cleanly on the PG17 harness.
--
-- plpgsql, not sql: the boolean result needs GET DIAGNOSTICS on the DELETE
-- row count, which LANGUAGE sql cannot express. The body references no
-- vault.* object, so creation never depends on the supabase_vault extension
-- being installed -- only execution of the trigger's reclaim path does, and
-- that trigger already exists from 20260906120000 §B.
--
-- One function, one signature. Never add an overload: a second signature
-- would double as a second delete path with its own (default-open)
-- privileges.

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_user_ai_provider_key(
  p_user_id uuid,
  p_provider_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_count integer;
BEGIN
  -- Same lock as save_user_ai_provider_key: serialises a delete against an
  -- overlapping save for the same (user, provider) for the rest of this
  -- transaction. Transaction-scoped (xact), so no cleanup path can leak it.
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text || ':' || p_provider_code));

  DELETE FROM public.user_ai_provider_keys AS k
   WHERE k.user_id = p_user_id
     AND k.provider_code = p_provider_code;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- The AFTER DELETE trigger user_ai_provider_keys_reclaim_secret
  -- (20260906120000 §B) reclaims the Vault secret inside this same
  -- transaction when a row was deleted; there is deliberately no vault.*
  -- call here.
  RETURN v_count > 0;
END;
$function$;

-- Named explicitly (not left to PUBLIC): this stack grants EXECUTE on new
-- functions to anon and authenticated by default privilege, and a bare
-- "REVOKE ... FROM PUBLIC" would leave them holding it (see 20260831150000).
REVOKE EXECUTE ON FUNCTION public.delete_user_ai_provider_key(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_user_ai_provider_key(uuid, text) TO service_role;

COMMIT;
