-- WhatsApp account continuity, PR-A follow-up (Codex review on PR #262).
--
-- The number_mismatch flag was written by reading account_metadata, editing it in the edge
-- function and writing the whole object back. A concurrent note_undelivered_store_event
-- between that read and write was silently overwritten (the "orders on hold" alert lost).
-- Both directions now change only their own key, atomically, in one statement, and each
-- call is scoped to the tenant the caller can prove: the browser bridge passes the owner's
-- user_id, the partner API passes its workspace_id.

CREATE OR REPLACE FUNCTION public.flag_whatsapp_number_mismatch(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Caller identity: the bridge and pairing paths resolved this account owner- or
  -- workspace-scoped before syncing; the webhook resolved it from the instance's own
  -- jwt_key, the only identity a provider callback carries.
  UPDATE social_accounts
     SET is_active = false,
         account_metadata = coalesce(account_metadata, '{}'::jsonb) || '{"number_mismatch": true}'::jsonb
   WHERE id = p_account_id AND platform = 'whatsapp';
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.flag_whatsapp_number_mismatch(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flag_whatsapp_number_mismatch(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.clear_whatsapp_number_mismatch(
  p_account_id uuid,
  p_user_id uuid DEFAULT NULL,
  p_workspace_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL AND p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'clear_whatsapp_number_mismatch: a user or workspace scope is required' USING errcode = '22023';
  END IF;
  UPDATE social_accounts
     SET account_metadata = account_metadata - 'number_mismatch'
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND (p_user_id IS NULL OR user_id = p_user_id)
     AND (p_workspace_id IS NULL OR workspace_id = p_workspace_id)
     AND account_metadata ? 'number_mismatch';
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.clear_whatsapp_number_mismatch(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_whatsapp_number_mismatch(uuid, uuid, uuid) TO service_role;
