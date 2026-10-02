-- WhatsApp account continuity, PR-A follow-up (Codex review round 4 on PR #262).
--
-- The reconnect path read the Evolution instance (name + webhook jwt_key) and saved the new
-- QR with service-role statements filtered only by social_account_id; ownership was proven
-- by an earlier, separate lookup. Both now prove ownership inside the statement by joining
-- the owning social_accounts row on the caller's user_id.
--
-- jsonb, not RETURNS TABLE: a composite RETURNS TABLE crashed this PG17 build before.

CREATE OR REPLACE FUNCTION public.get_owned_evolution_instance(p_account_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object('instance_name', i.instance_name, 'jwt_key', i.jwt_key)
    FROM whatsapp_evolution_instances i
    JOIN social_accounts a ON a.id = i.social_account_id
   WHERE i.social_account_id = p_account_id
     AND a.user_id = p_user_id
     AND a.platform = 'whatsapp';
$$;
REVOKE ALL ON FUNCTION public.get_owned_evolution_instance(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_owned_evolution_instance(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.save_owned_evolution_qr(
  p_account_id uuid,
  p_user_id uuid,
  p_qr text,
  p_state text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE whatsapp_evolution_instances i
     SET last_qr = p_qr,
         last_connection_state = p_state
    FROM social_accounts a
   WHERE a.id = i.social_account_id
     AND i.social_account_id = p_account_id
     AND a.user_id = p_user_id
     AND a.platform = 'whatsapp';
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.save_owned_evolution_qr(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_owned_evolution_qr(uuid, uuid, text, text) TO service_role;
