-- Connector credential secret reclaim: the Vault half of PR-4.
--
-- WHY
-- PR-4's messaging-api writes each connector's credential fields into ONE
-- Vault secret (spec §4.3) and stores only the secret's id on the row.
-- supabase_vault 0.3.1 has create_secret and update_secret but NO
-- delete_secret, so nothing reclaims a secret on its own. Two of the three
-- leaks §4.3 names are covered here:
--
--   1. Connector delete -- the application path. ai_delete_tool calls
--      delete_connector_credential_secret (below) BEFORE the row is gone,
--      because once the row is deleted the secret id is unrecoverable and
--      the secret is orphaned forever.
--   2. Cascade delete -- social_accounts ... ON DELETE CASCADE and the
--      user-delete cascade both remove ai_agent_tools rows WITHOUT going
--      through ai_delete_tool, and a cascade never calls application code.
--      The AFTER DELETE trigger below is the only thing that covers this
--      path. Without it, disconnecting an account leaves that store's live
--      credentials encrypted at rest and never reclaimed, with no row
--      pointing at them.
--
--   (3. Restore-from-backup remains an operational fact, not a schema one: a
--   public-schema-only dump does not carry the vault schema. The runbook
--   must state that vault is backed up with public or not at all. The
--   upsert wrapper below self-heals a dangling id by creating a fresh
--   secret on the next save, so the connector is repairable from the UI.)
--
-- HOW THE EDGE FUNCTION REACHES VAULT AT ALL
-- PostgREST on this stack exposes only public,storage,graphql_public
-- (verified on the server: PGRST_DB_SCHEMES), so supabase-js can neither
-- rpc vault.create_secret nor select vault.secrets. The two thin wrappers
-- below are the bridge: public, SECURITY DEFINER, service_role ONLY --
-- messaging-api authenticates the bearer itself and then runs under the
-- service role, the same trust model as set_ai_agent_tool_accounts
-- (20260831130000). The p_secret_id is always taken from a row the caller
-- was just verified to own, in the same request; the wrapper does not need
-- to re-derive ownership.
--
-- THE MERGE LIVES HERE, ON PURPOSE
-- vault.update_secret replaces the WHOLE secret. A form that submits only
-- consumer_secret must decrypt, merge, and re-encrypt -- never write the
-- single submitted field, which would silently drop consumer_key and leave
-- a connector that authenticates with half its credentials. Doing the merge
-- inside this function keeps decrypted credential material inside the
-- database process: it never enters the Edge Function, a log line, or a
-- response body. The returned configured_fields is derived from the merged
-- blob's keys ON EVERY WRITE, so the row's configured_secret_fields cache
-- can never drift from the blob it describes.
--
-- ORDERING TRAP -- APPLY THIS BEFORE messaging-api IS REDEPLOYED
-- The new code calls both wrappers on every save that carries a secret
-- field, so deploying it before this migration is live turns every
-- credential save into a 500 (function not found). Worse, the moment the
-- new code writes its FIRST Vault secret, the trigger must already exist:
-- from that instant, disconnecting an account without this trigger leaks
-- encrypted credentials that nothing will ever reclaim, with no row
-- pointing at them. Migration first, deploy second. The same rule, one
-- migration.
--
-- WHY NO UPDATE TRIGGER
-- The only write path that changes credentials_secret_id is the dangling-id
-- self-heal above, whose old target does not exist in vault by definition,
-- so an UPDATE trigger could only ever delete a nonexistent secret. If a
-- future path re-points a live id, add the UPDATE variant then; saying so
-- here so the omission is a decision, not an oversight.
--
-- APPLIED BY HAND BY THE OWNER. Rehearse statement by statement with
-- ROLLBACK against production, not a scratch database: Postora migrations
-- self-commit, so an outer BEGIN does not protect anything. A useful
-- rehearsal for the merge semantics:
--   SELECT * FROM public.upsert_connector_credential_secret(NULL,
--     '{"consumer_key":"ck_a","consumer_secret":"cs_a"}'::jsonb);
--   -- note the returned secret_id, then:
--   SELECT * FROM public.upsert_connector_credential_secret('<that id>',
--     '{"consumer_secret":"cs_b"}'::jsonb);
--   -- configured_fields must come back as BOTH keys; then
--   DELETE FROM public.ai_agent_tools WHERE id = '<a seeded row using it>';
--   -- vault.secrets must no longer contain the id.

BEGIN;

-- ============================================================================
-- A. upsert_connector_credential_secret: create-or-merge one credential blob
-- ============================================================================
CREATE OR REPLACE FUNCTION public.upsert_connector_credential_secret(
  p_secret_id uuid,
  p_secret jsonb
)
RETURNS TABLE(secret_id uuid, configured_fields text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_existing text;
  v_merged jsonb;
  v_id uuid;
BEGIN
  IF p_secret IS NULL OR p_secret = '{}'::jsonb THEN
    RAISE EXCEPTION 'credential payload must contain at least one field';
  END IF;

  v_merged := p_secret;
  v_id := p_secret_id;

  IF v_id IS NOT NULL THEN
    SELECT decrypted_secret INTO v_existing
    FROM vault.decrypted_secrets
    WHERE id = v_id;
    IF v_existing IS NOT NULL THEN
      -- The merge §4.3 requires: jsonb || keeps every unsubmitted key.
      v_merged := v_existing::jsonb || p_secret;
    ELSE
      -- Dangling id (a public-only restore leaves every id dangling). A
      -- fresh secret is created and returned so the caller's row write
      -- repairs the link in the same request.
      v_id := NULL;
    END IF;
  END IF;

  IF v_id IS NOT NULL THEN
    PERFORM vault.update_secret(v_id, v_merged::text);
  ELSE
    -- The name is for humans sweeping vault; it is never used for lookup.
    -- gen_random_uuid keeps it unique under vault.secrets' partial unique
    -- index on name.
    v_id := vault.create_secret(
      v_merged::text,
      'ai_agent_tool:credentials:' || gen_random_uuid()::text,
      'Per-connector credential blob for public.ai_agent_tools (PR-4)'
    );
  END IF;

  RETURN QUERY
  SELECT v_id, coalesce(array_agg(key ORDER BY key), '{}'::text[])
  FROM jsonb_object_keys(v_merged) AS key;
END;
$function$;

REVOKE ALL ON FUNCTION public.upsert_connector_credential_secret(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_connector_credential_secret(uuid, jsonb) TO service_role;

-- ============================================================================
-- B. delete_connector_credential_secret: the app-path reclaim
-- ============================================================================
-- ai_delete_tool calls this BEFORE deleting the row. Vault has no
-- delete_secret; this is the DELETE FROM vault.secrets WHERE id = ... of
-- spec §4.3, translated through the only schema PostgREST exposes.
CREATE OR REPLACE FUNCTION public.delete_connector_credential_secret(
  p_secret_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  DELETE FROM vault.secrets WHERE id = p_secret_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_connector_credential_secret(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_connector_credential_secret(uuid) TO service_role;

-- ============================================================================
-- C. The cascade-path reclaim: AFTER DELETE trigger on ai_agent_tools
-- ============================================================================
-- Application code cannot cover the cascades (social account disconnect,
-- user delete) because they never call it. A trigger, not application code,
-- for the same reason set_ai_agent_tool_accounts keeps its checks in SQL.
-- Idempotent with the app path: when ai_delete_tool already removed the
-- secret, this DELETE matches nothing.
CREATE OR REPLACE FUNCTION public.reclaim_ai_agent_tool_secret()
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

CREATE TRIGGER ai_agent_tools_reclaim_secret
  AFTER DELETE ON public.ai_agent_tools
  FOR EACH ROW
  WHEN (OLD.credentials_secret_id IS NOT NULL)
  EXECUTE FUNCTION public.reclaim_ai_agent_tool_secret();

COMMIT;
