-- Store webhook secret reclaim: the Vault half of Spec B bindings.
--
-- WHY
-- 20260927120000 stores each binding's webhook signing secret as ONE Vault
-- row (following the connector credential pattern of 20260831140000) and
-- keeps only the secret's id on the row (secret_id, plus previous_secret_id
-- across a rotation). supabase_vault has create_secret and update_secret but
-- NO delete_secret, so nothing reclaims a secret on its own. Deleting a
-- binding -- directly, via the connector/account/user cascades, or via the
-- store_events cascade -- would otherwise leave live signing secrets
-- encrypted at rest and never reclaimed, with no row pointing at them.
--
-- The AFTER DELETE trigger below is the only thing that covers the cascade
-- paths: a cascade never calls application code, for the same reason the
-- ai_agent_tools_reclaim_secret trigger exists (20260831140000). Idempotent
-- with any app-path delete: when the secret is already gone, the DELETEs
-- match nothing.
--
-- The body resolves vault.* only at execution (plpgsql, not LANGUAGE sql),
-- so this file still applies on a database without the supabase_vault
-- extension, like 20260927120000 sections F/G.
--
-- Idempotent: the function uses CREATE OR REPLACE; the trigger is dropped
-- IF EXISTS before CREATE, so this file applies twice without error.
-- Does not touch 20260927120000 or 20260927130000 objects.

BEGIN;

-- ---------------------------------------------------------------------------
-- reclaim_store_webhook_secret: delete both vault rows for a deleted binding.
-- Mirrors reclaim_ai_agent_tool_secret (20260831140000): SECURITY DEFINER,
-- controlled search_path, and the DELETE FROM vault.secrets WHERE id = ...
-- of delete_connector_credential_secret. Both legs are null-guarded: a
-- binding that was never rotated has previous_secret_id NULL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reclaim_store_webhook_secret()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF OLD.secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = OLD.secret_id;
  END IF;
  IF OLD.previous_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = OLD.previous_secret_id;
  END IF;
  RETURN OLD;
END;
$function$;

REVOKE ALL ON FUNCTION public.reclaim_store_webhook_secret()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclaim_store_webhook_secret() TO service_role;

DROP TRIGGER IF EXISTS store_webhook_bindings_reclaim_secret
  ON public.store_webhook_bindings;

CREATE TRIGGER store_webhook_bindings_reclaim_secret
  AFTER DELETE ON public.store_webhook_bindings
  FOR EACH ROW
  WHEN (OLD.secret_id IS NOT NULL OR OLD.previous_secret_id IS NOT NULL)
  EXECUTE FUNCTION public.reclaim_store_webhook_secret();

COMMIT;

NOTIFY pgrst, 'reload schema';
