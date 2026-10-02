-- WhatsApp account continuity, PR-BC follow-up (Codex review on PR #263).
--
-- 1. The mover proved only that p_from and p_to share an owner, not that the owner is the
--    user the bridge authenticated. Any service-role caller that skipped its own lookup could
--    move another tenant's setup by naming two of that tenant's accounts. The browser path
--    now goes through owner-bound wrappers that lock both rows under the caller's user_id
--    before the mover runs, and service_role loses EXECUTE on the unbound functions. The
--    only remaining caller of those is activate_evolution_qr_account, a definer function
--    that resolves the owner from the instance being activated.
-- 2. Keeping the destination's agent while the source's store connectors move hands the
--    moved store orders to that agent's procedures. If the destination has a flow switched
--    off, the worker skips those orders as flow_disabled. The preview now reports which
--    store flows each side has on, so the banner can warn before the move.

CREATE OR REPLACE FUNCTION public.move_owned_whatsapp_account_setup(
  p_user_id uuid,
  p_from uuid,
  p_to uuid,
  p_choices jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owned integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'move_owned_whatsapp_account_setup: a user scope is required' USING errcode = '22023';
  END IF;
  -- The mover's own lock order: the per-owner advisory lock, then both rows in id order.
  -- Both locks are re-entrant, so the mover takes them again without waiting.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':wa-setup', 0));
  SELECT count(*) INTO v_owned FROM (
    SELECT 1 FROM social_accounts
     WHERE id IN (p_from, p_to) AND user_id = p_user_id AND platform = 'whatsapp'
     ORDER BY id FOR UPDATE
  ) owned;
  IF p_from IS NULL OR p_to IS NULL OR p_from = p_to OR v_owned <> 2 THEN
    RAISE EXCEPTION 'move_owned_whatsapp_account_setup: accounts_not_compatible' USING errcode = '22023';
  END IF;
  RETURN public.move_whatsapp_account_setup(p_from, p_to, 'interactive', p_choices);
END;
$$;
REVOKE ALL ON FUNCTION public.move_owned_whatsapp_account_setup(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_owned_whatsapp_account_setup(uuid, uuid, uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.dismiss_owned_whatsapp_setup_move(p_user_id uuid, p_to uuid, p_from uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'dismiss_owned_whatsapp_setup_move: a user scope is required' USING errcode = '22023';
  END IF;
  IF (SELECT count(*) FROM social_accounts
       WHERE id IN (p_from, p_to) AND user_id = p_user_id AND platform = 'whatsapp') <> 2 THEN
    RETURN false;
  END IF;
  PERFORM public.dismiss_whatsapp_setup_move(p_to, p_from);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.dismiss_owned_whatsapp_setup_move(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dismiss_owned_whatsapp_setup_move(uuid, uuid, uuid) TO service_role;

-- The unbound functions stay callable by their owner (activate_evolution_qr_account and the
-- wrappers above run as that owner) and by nobody else.
REVOKE ALL ON FUNCTION public.move_whatsapp_account_setup(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.dismiss_whatsapp_setup_move(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Store flows a config has switched on, in the shape process-store-events reads them
-- (agent_behavior.procedures.<flow>.enabled = true).
CREATE OR REPLACE FUNCTION public.whatsapp_store_flows_enabled(p_account_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(f.flow ORDER BY f.flow), '[]'::jsonb)
    FROM unnest(ARRAY['back_in_stock', 'cod_confirm', 'review_request']) AS f(flow)
   WHERE EXISTS (
     SELECT 1 FROM ai_agent_configs c
      WHERE c.social_account_id = p_account_id
        AND c.agent_behavior #>> ARRAY['procedures', f.flow, 'enabled'] = 'true'
   );
$$;
REVOKE ALL ON FUNCTION public.whatsapp_store_flows_enabled(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_whatsapp_setup_move_preview(p_from uuid, p_to uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from social_accounts%ROWTYPE;
  v_to social_accounts%ROWTYPE;
  v_same_number boolean;
  v_same_waba boolean;
BEGIN
  SELECT * INTO v_from FROM social_accounts WHERE id = p_from AND platform = 'whatsapp';
  SELECT * INTO v_to FROM social_accounts WHERE id = p_to AND platform = 'whatsapp';
  IF v_from.id IS NULL OR v_to.id IS NULL
     OR v_from.user_id IS DISTINCT FROM auth.uid() OR v_to.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'get_whatsapp_setup_move_preview: not found' USING errcode = '42501';
  END IF;
  v_same_number := whatsapp_account_number_digits(v_from) <> ''
               AND whatsapp_account_number_digits(v_from) = whatsapp_account_number_digits(v_to);
  v_same_waba := coalesce(v_from.account_metadata->>'waba_id', '') <> ''
             AND v_from.account_metadata->>'waba_id' = v_to.account_metadata->>'waba_id';
  RETURN jsonb_build_object(
    'same_workspace', v_from.workspace_id IS NOT DISTINCT FROM v_to.workspace_id,
    'source_has_agent', EXISTS (SELECT 1 FROM ai_agent_configs WHERE social_account_id = p_from),
    'destination_has_agent', EXISTS (SELECT 1 FROM ai_agent_configs WHERE social_account_id = p_to),
    'destination_agent_enabled', EXISTS (SELECT 1 FROM ai_agent_configs WHERE social_account_id = p_to AND is_enabled),
    'source_store_flows', whatsapp_store_flows_enabled(p_from),
    'destination_store_flows', whatsapp_store_flows_enabled(p_to),
    'connectors', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'name', t.name,
               'connector_type', t.connector_type,
               'has_store_webhook', EXISTS (SELECT 1 FROM store_webhook_bindings b WHERE b.connector_id = t.id),
               'name_clash', EXISTS (SELECT 1 FROM ai_agent_tools d WHERE d.social_account_id = p_to AND d.name = t.name),
               'destination_has_store_webhook', EXISTS (
                 SELECT 1 FROM ai_agent_tools d JOIN store_webhook_bindings b ON b.connector_id = d.id
                  WHERE d.social_account_id = p_to AND d.name = t.name)
             ) ORDER BY t.name)
        FROM ai_agent_tools t WHERE t.social_account_id = p_from), '[]'::jsonb),
    'partner_items',
      (SELECT count(*) FROM partner_api_keys WHERE social_account_id = p_from AND revoked_at IS NULL)
      + (SELECT count(*) FROM partner_api_key_accounts WHERE social_account_id = p_from)
      + (SELECT count(*) FROM partner_webhooks WHERE social_account_id = p_from AND is_active),
    'waitlist_count', (SELECT count(*) FROM stock_waitlist WHERE social_account_id = p_from),
    'waitlist_moves', v_same_number,
    'template_count', (SELECT count(*) FROM whatsapp_message_templates WHERE social_account_id = p_from),
    'templates_move', v_same_waba
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_whatsapp_setup_move_preview(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_whatsapp_setup_move_preview(uuid, uuid) TO authenticated;
