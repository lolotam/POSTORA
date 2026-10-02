-- WhatsApp account continuity, PR-A follow-up (Codex review round 3 on PR #262).
--
-- flag_whatsapp_number_mismatch (20261004100200, applied) took only the account id. Every
-- caller now proves a tenant scope inside the statement itself:
--   * the browser bridge: the owner's user_id;
--   * the partner API: its workspace_id;
--   * the provider webhook: the Evolution instance_name the callback was authenticated
--     for (its jwt_key), joined structurally to the account it belongs to.
-- The one-argument version is dropped so no unscoped overload remains.

DROP FUNCTION IF EXISTS public.flag_whatsapp_number_mismatch(uuid);

CREATE OR REPLACE FUNCTION public.flag_whatsapp_number_mismatch(
  p_account_id uuid,
  p_user_id uuid DEFAULT NULL,
  p_workspace_id uuid DEFAULT NULL,
  p_instance_name text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL AND p_workspace_id IS NULL AND p_instance_name IS NULL THEN
    RAISE EXCEPTION 'flag_whatsapp_number_mismatch: a user, workspace or instance scope is required' USING errcode = '22023';
  END IF;
  UPDATE social_accounts a
     SET is_active = false,
         account_metadata = coalesce(a.account_metadata, '{}'::jsonb) || '{"number_mismatch": true}'::jsonb
   WHERE a.id = p_account_id
     AND a.platform = 'whatsapp'
     AND (p_user_id IS NULL OR a.user_id = p_user_id)
     AND (p_workspace_id IS NULL OR a.workspace_id = p_workspace_id)
     AND (p_instance_name IS NULL OR EXISTS (
           SELECT 1 FROM whatsapp_evolution_instances i
            WHERE i.social_account_id = a.id AND i.instance_name = p_instance_name));
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.flag_whatsapp_number_mismatch(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flag_whatsapp_number_mismatch(uuid, uuid, uuid, text) TO service_role;
