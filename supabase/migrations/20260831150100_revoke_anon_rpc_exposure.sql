-- Close an unauthenticated credential-disclosure hole, and stop it recurring.
--
-- WHAT WAS WRONG
-- Every "service_role only" helper written since 20260828180000 ends with
--
--     REVOKE ALL ON FUNCTION ... FROM PUBLIC;
--     GRANT EXECUTE ON FUNCTION ... TO service_role;
--
-- and every one of them was executable by `anon` and `authenticated` anyway.
-- This stack carries
--
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS
--       TO anon, authenticated
--
-- (visible in pg_default_acl for both the postgres and supabase_admin grantors),
-- so EXECUTE is granted to those two roles explicitly at CREATE time. REVOKE
-- ... FROM PUBLIC only touches the PUBLIC pseudo-role and leaves those grants
-- untouched. The functions looked locked down in review and in a ROLLBACK
-- rehearsal -- which tests behaviour, not grants -- and shipped open.
--
-- Confirmed against production before this migration was written: an anon-key
-- POST to /rest/v1/rpc/get_connector_credential returned HTTP 200. That function
-- takes (p_user_id, p_tool_id) as PARAMETERS and returns a decrypted vendor
-- credential blob, so an unauthenticated caller could read any tenant's
-- WooCommerce or Supabase credentials by naming the ids. The same exposure
-- applied to the sharing and secret-write helpers.
--
-- The grants were revoked by hand at the time of discovery. This migration
-- makes that repair reproducible, so a database built from these files is not
-- born vulnerable.
--
-- WHY IT MUST RUN AS THE FUNCTION OWNER
-- These functions are owned by supabase_admin, and `postgres` is not a
-- superuser on this stack. Running the REVOKEs as postgres emits
-- "WARNING: no privileges could be revoked" and changes nothing -- a warning,
-- not an error, so a migration runner would report success. That is exactly the
-- silent failure this file exists to close, so the verification block below
-- RAISES if any grant survived. Apply as supabase_admin.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.get_connector_credential(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_connector_credential_secret(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_connector_credential_secret(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_ai_agent_tool_accounts(uuid, uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_ai_knowledge_source_visibility(uuid, uuid, text, uuid[])
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_connector_credential(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_connector_credential_secret(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_connector_credential_secret(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_ai_agent_tool_accounts(uuid, uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_ai_knowledge_source_visibility(uuid, uuid, text, uuid[]) TO service_role;

-- Loud, not silent. A REVOKE issued by a non-owner is a WARNING, so without
-- this the migration would "succeed" having done nothing -- which is how the
-- original hole survived review.
DO $verify$
DECLARE
  v_leaked text;
BEGIN
  SELECT string_agg(routine_name || ' -> ' || grantee, ', ' ORDER BY routine_name)
    INTO v_leaked
  FROM information_schema.role_routine_grants
  WHERE privilege_type = 'EXECUTE'
    AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    AND routine_name IN (
      'get_connector_credential',
      'upsert_connector_credential_secret',
      'delete_connector_credential_secret',
      'set_ai_agent_tool_accounts',
      'set_ai_knowledge_source_visibility'
    );

  IF v_leaked IS NOT NULL THEN
    RAISE EXCEPTION
      'Grants survived the REVOKE (%). Re-run this migration as the function owner (supabase_admin); postgres is not a superuser here and its REVOKE is a no-op warning.',
      v_leaked;
  END IF;
END
$verify$;

COMMIT;
