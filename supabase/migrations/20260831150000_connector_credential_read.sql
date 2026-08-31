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
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT decrypted.decrypted_secret::jsonb
  FROM public.ai_agent_tools AS t
  JOIN vault.decrypted_secrets AS decrypted
    ON decrypted.id = t.credentials_secret_id
  WHERE t.id = p_tool_id
    AND t.user_id = p_user_id;
$function$;

REVOKE ALL ON FUNCTION public.get_connector_credential(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_connector_credential(uuid, uuid) TO service_role;

COMMIT;

