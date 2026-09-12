-- Partner service-role sibling: merge inside the UPDATE row lock so unrelated
-- account_metadata keys written concurrently survive the partial patch.
CREATE OR REPLACE FUNCTION public.patch_account_metadata_in_workspace(
  p_account_id uuid,
  p_workspace_id uuid,
  p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_metadata jsonb;
BEGIN
  -- jsonb || NULL is NULL, so a null patch would erase every key rather than change none.
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'p_patch must be a jsonb object';
  END IF;

  UPDATE public.social_accounts
  SET account_metadata = COALESCE(account_metadata, '{}'::jsonb) || p_patch
  WHERE id = p_account_id AND workspace_id = p_workspace_id
  RETURNING account_metadata INTO v_metadata;

  IF v_metadata IS NULL THEN
    RAISE EXCEPTION 'Account not found or access denied';
  END IF;

  RETURN v_metadata;
END
$function$;

-- This stack's default privileges grant directly to both API roles; revoking
-- PUBLIC alone leaves those grants intact.
REVOKE ALL ON FUNCTION public.patch_account_metadata_in_workspace(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.patch_account_metadata_in_workspace(uuid, uuid, jsonb) TO service_role;
