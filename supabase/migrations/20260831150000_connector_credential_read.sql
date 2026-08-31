-- Connector credential read: the read half of design §4.3.
--
-- This wrapper exists in public because this self-hosted PostgREST exposes only
-- public, storage, and graphql_public; Edge Functions cannot address
-- vault.decrypted_secrets directly. It returns only the decrypted credential
-- blob, and only when the named tool belongs to p_user_id. ai-agent-adapters
-- authenticates the bearer before passing that id, then calls under service_role.
--
-- APPLIED BY HAND BY THE OWNER. Do not execute from an automated deploy.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_connector_credential(
  p_user_id uuid,
  p_tool_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
-- plpgsql, not sql, and the reason is the CI harness rather than taste. A
-- LANGUAGE sql body is parsed and validated when the function is CREATED, so it
-- fails with "relation vault.decrypted_secrets does not exist" on a database
-- without the supabase_vault extension -- which the integration harness's
-- baseline is. A plpgsql body is not resolved until it runs. That is exactly why
-- the sibling wrappers in 20260831140000 are plpgsql and apply cleanly there.
DECLARE
  v_secret jsonb;
BEGIN
  SELECT decrypted.decrypted_secret::jsonb
    INTO v_secret
  FROM public.ai_agent_tools AS t
  JOIN vault.decrypted_secrets AS decrypted
    ON decrypted.id = t.credentials_secret_id
  WHERE t.id = p_tool_id
    AND t.user_id = p_user_id;

  RETURN v_secret;
END;
$function$;

-- anon and authenticated are named EXPLICITLY. This stack carries
-- ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon, authenticated,
-- so both receive EXECUTE at CREATE time and "REVOKE ... FROM PUBLIC" -- which
-- touches only the PUBLIC pseudo-role -- leaves them holding it. Omitting them
-- here left this function, which returns a decrypted credential blob for any
-- (user_id, tool_id) passed as parameters, callable with nothing but the anon
-- key. Verified against production: HTTP 200 before the revoke, 401 after.
--
-- Apply as supabase_admin: it owns these functions, postgres is not a superuser
-- on this stack, and a REVOKE by a non-owner is a WARNING that changes nothing.
REVOKE EXECUTE ON FUNCTION public.get_connector_credential(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_connector_credential(uuid, uuid) TO service_role;

COMMIT;

