-- WhatsApp account continuity, PR-BC (spec 2026-10-01 §5.5). Browser-side reads for the
-- "Bring over my setup" banner, so it can offer real per-item choices and needs one call
-- instead of one summary RPC per old connection.
--
-- list_whatsapp_setup_move_candidates(p_to): the owner's inactive or retired WhatsApp rows
--   in the same workspace that still carry setup and either share p_to's number, are the
--   most recently deactivated row while the owner has exactly one live connection, or are
--   p_to's pending deferral (setup_move_pending.from, always offered). Dismissed sources are
--   skipped. At most 5, newest first.
-- get_whatsapp_setup_move_preview(p_from, p_to): what an interactive move would touch —
--   each source connector with its store binding and name clash, which side has an agent,
--   partner items, and what stays behind (waitlist on a number change, templates on a WABA
--   change).
-- Both are SECURITY DEFINER, owner-only via auth.uid(), granted to authenticated only.

CREATE OR REPLACE FUNCTION public.list_whatsapp_setup_move_candidates(p_to uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_to social_accounts%ROWTYPE;
  v_dismissed jsonb;
  v_pending_from text;
  v_live_count integer;
  v_last_deactivated uuid;
  v_result jsonb;
BEGIN
  SELECT * INTO v_to FROM social_accounts WHERE id = p_to AND platform = 'whatsapp';
  IF v_to.id IS NULL OR v_to.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'list_whatsapp_setup_move_candidates: not found' USING errcode = '42501';
  END IF;
  v_dismissed := coalesce(v_to.account_metadata->'setup_move_dismissed', '[]'::jsonb);
  v_pending_from := v_to.account_metadata->'setup_move_pending'->>'from';

  SELECT count(*) INTO v_live_count
    FROM social_accounts
   WHERE user_id = v_to.user_id AND platform = 'whatsapp' AND is_active
     AND workspace_id IS NOT DISTINCT FROM v_to.workspace_id
     AND platform_user_id NOT LIKE 'retired\_%' AND platform_user_id NOT LIKE 'pending\_%';

  SELECT id INTO v_last_deactivated
    FROM social_accounts
   WHERE user_id = v_to.user_id AND platform = 'whatsapp' AND id <> p_to
     AND workspace_id IS NOT DISTINCT FROM v_to.workspace_id
     AND platform_user_id NOT LIKE 'pending\_%'
     AND (is_active IS NOT TRUE OR platform_user_id LIKE 'retired\_%')
   ORDER BY updated_at DESC
   LIMIT 1;

  WITH candidates AS (
    SELECT a.*,
           CASE
             WHEN a.id::text = v_pending_from THEN 'pending'
             WHEN whatsapp_account_number_digits(a) <> ''
                  AND whatsapp_account_number_digits(a) = whatsapp_account_number_digits(v_to) THEN 'same_number'
             WHEN v_live_count = 1 AND a.id = v_last_deactivated THEN 'last_deactivated'
           END AS reason
      FROM social_accounts a
     WHERE a.user_id = v_to.user_id AND a.platform = 'whatsapp' AND a.id <> p_to
       AND a.workspace_id IS NOT DISTINCT FROM v_to.workspace_id
       AND a.platform_user_id NOT LIKE 'pending\_%'
       AND (a.is_active IS NOT TRUE OR a.platform_user_id LIKE 'retired\_%')
  ), offered AS (
    SELECT c.*,
           get_whatsapp_account_setup_summary(c.id) AS summary
      FROM candidates c
     WHERE c.reason IS NOT NULL
       AND (c.reason = 'pending' OR NOT (v_dismissed ? c.id::text))
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id,
           'platform_username', o.platform_username,
           'reason', o.reason,
           'summary', o.summary) ORDER BY (o.reason = 'pending') DESC, o.updated_at DESC), '[]'::jsonb)
    INTO v_result
    FROM (
      SELECT * FROM offered o
       WHERE o.reason = 'pending'
          OR (SELECT bool_or(value::text <> '0' AND value::text <> '[]')
                FROM jsonb_each(o.summary)
               WHERE key NOT IN ('scheduled_messages'))
       ORDER BY (o.reason = 'pending') DESC, o.updated_at DESC
       LIMIT 5
    ) o;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.list_whatsapp_setup_move_candidates(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_whatsapp_setup_move_candidates(uuid) TO authenticated;

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
