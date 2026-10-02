-- WhatsApp account continuity, PR-A follow-up (Codex review round 5 on PR #262).
--
-- Closes the class "a service-role write scoped only by account id" for the reconnect /
-- mismatch code paths:
--   * flag_whatsapp_number_mismatch now also marks the Evolution instance
--     last_connection_state = 'number_mismatch', in the same function, and only when the
--     tenant-scoped account update matched — so the edge handler writes nothing itself.
--   * save_owned_evolution_state: the bridge poll's observed-state write, joined on the
--     caller's user_id like save_owned_evolution_qr.

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
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  -- Reached only after the scoped statement above proved the tenant.
  UPDATE whatsapp_evolution_instances
     SET last_connection_state = 'number_mismatch'
   WHERE social_account_id = p_account_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.flag_whatsapp_number_mismatch(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flag_whatsapp_number_mismatch(uuid, uuid, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.save_owned_evolution_state(p_account_id uuid, p_user_id uuid, p_state text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE whatsapp_evolution_instances i
     SET last_connection_state = p_state
    FROM social_accounts a
   WHERE a.id = i.social_account_id
     AND i.social_account_id = p_account_id
     AND a.user_id = p_user_id
     AND a.platform = 'whatsapp';
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.save_owned_evolution_state(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_owned_evolution_state(uuid, uuid, text) TO service_role;
