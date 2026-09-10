-- Apply before deploying the partner agent routes. Auth identities are minted
-- through the Auth admin API; only the two public rows belong in this transaction.
CREATE OR REPLACE FUNCTION public.provision_partner_agent(
  p_workspace_id UUID,
  p_user_id UUID,
  p_display_name TEXT,
  p_max_conversations INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent public.whatsapp_agents;
BEGIN
  IF p_display_name IS NULL OR length(btrim(p_display_name)) NOT BETWEEN 1 AND 200
     OR p_max_conversations IS NULL OR p_max_conversations < 1 THEN
    RAISE EXCEPTION 'Invalid agent fields' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (p_workspace_id, p_user_id, 'agent');

  INSERT INTO public.whatsapp_agents (workspace_id, user_id, display_name, max_conversations)
  VALUES (p_workspace_id, p_user_id, btrim(p_display_name), p_max_conversations)
  RETURNING * INTO v_agent;

  RETURN to_jsonb(v_agent);
END;
$$;

-- PUBLIC alone does not remove this database's direct default role grants.
REVOKE ALL ON FUNCTION public.provision_partner_agent(UUID, UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_partner_agent(UUID, UUID, TEXT, INTEGER) TO service_role;
