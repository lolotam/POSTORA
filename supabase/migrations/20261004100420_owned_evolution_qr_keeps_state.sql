-- WhatsApp account continuity, PR-A follow-up: the bridge poll's "refresh QR" write was the
-- last service-role instance write scoped only by account id. save_owned_evolution_qr now
-- treats a NULL p_state as "keep the stored state", so that write can use the owner-scoped
-- function too. Same signature as 20261004100400: replaced in place, no overload.
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
         last_connection_state = coalesce(p_state, i.last_connection_state)
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
