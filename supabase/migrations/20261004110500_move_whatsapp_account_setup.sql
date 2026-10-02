-- WhatsApp account continuity, PR-BC (spec 2026-10-01 §3, §5.1-§5.2, §6).
--
-- move_whatsapp_account_setup moves an owner's WhatsApp *setup* (never history) from one
-- of their WhatsApp rows to another. Two callers:
--   * 'auto'        — activate_evolution_qr_account, when a QR re-pair retires a duplicate.
--   * 'interactive' — the "Bring over my setup" banner, with the owner's choices.
--
-- Group S (agent config, account-scoped connectors and their links, store bindings, and
-- the waitlist when the number is unchanged) moves together or not at all: the store
-- worker needs the connector, the binding and the agent's procedures on one account.
--
-- Lock order, shared with activate_evolution_qr_account: the per-user ':wa-setup'
-- advisory lock first, then both social_accounts rows ordered by id, then store_events.

CREATE TABLE IF NOT EXISTS public.ai_agent_config_archive (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  archived_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  social_account_id uuid,
  -- The whole replaced row as jsonb, so a later column added to ai_agent_configs never
  -- breaks the archive insert.
  config jsonb NOT NULL
);
ALTER TABLE public.ai_agent_config_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_agent_config_archive FROM PUBLIC, anon, authenticated;

-- Digits of the phone number a WhatsApp row sends from. QR rows store it in
-- platform_user_id; Meta rows store a phone_number_id there, so their number comes from
-- account_metadata.display_phone_number; a retired QR row keeps it in retired_number.
CREATE OR REPLACE FUNCTION public.whatsapp_account_number_digits(p_account public.social_accounts)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT regexp_replace(
    CASE
      WHEN p_account.platform_user_id LIKE 'retired\_%' THEN coalesce(p_account.account_metadata->>'retired_number', '')
      WHEN p_account.connection_mode = 'evolution_qr' THEN coalesce(p_account.platform_user_id, '')
      ELSE coalesce(p_account.account_metadata->>'display_phone_number', '')
    END, '\D', '', 'g');
$$;
REVOKE ALL ON FUNCTION public.whatsapp_account_number_digits(public.social_accounts) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_account_number_digits(public.social_accounts) TO service_role;

CREATE OR REPLACE FUNCTION public.move_whatsapp_account_setup(
  p_from uuid,
  p_to uuid,
  p_mode text,
  p_choices jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_from social_accounts%ROWTYPE;
  v_to social_accounts%ROWTYPE;
  v_moved jsonb := '{}'::jsonb;
  v_left jsonb := '[]'::jsonb;
  v_conflicts jsonb := '[]'::jsonb;
  v_n integer;
  v_any boolean := false;
  v_same_number boolean;
  v_cfg_choice text := 'destination';
  v_cfg_moves boolean;
  v_partner boolean := true;
  v_src_has_config boolean;
  v_dst_has_config boolean;
  v_src_tools uuid[];
  v_name_clash text[];
  v_skip_names text[] := '{}';
  v_replace_names text[] := '{}';
  v_moving_tools uuid[];
  v_moving_bindings uuid[];
  v_moving_connectors uuid[];
  v_group_exists boolean;
  v_group_ok boolean := true;
  v_defer_reason text;
  v_in_flight boolean;
  v_room integer;
  v_key text;
  v_value jsonb;
  v_n8n_prefix text;
  v_handler text;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('auto', 'interactive') THEN
    RAISE EXCEPTION 'move_whatsapp_account_setup: unknown mode' USING errcode = '22023';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from = p_to THEN
    RAISE EXCEPTION 'move_whatsapp_account_setup: two different accounts are required' USING errcode = '22023';
  END IF;

  SELECT user_id INTO v_user FROM social_accounts WHERE id = p_from;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'move_whatsapp_account_setup: source not found' USING errcode = '22023';
  END IF;

  -- Lock 1 of the shared order; activate_evolution_qr_account takes the same lock first.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text || ':wa-setup', 0));
  -- Lock 2: both rows, in id order.
  PERFORM 1 FROM social_accounts WHERE id IN (p_from, p_to) ORDER BY id FOR UPDATE;

  SELECT * INTO v_from FROM social_accounts WHERE id = p_from;
  SELECT * INTO v_to FROM social_accounts WHERE id = p_to;
  IF v_to.id IS NULL
     OR v_to.user_id IS DISTINCT FROM v_from.user_id
     OR v_from.platform <> 'whatsapp' OR v_to.platform <> 'whatsapp'
     OR v_from.workspace_id IS DISTINCT FROM v_to.workspace_id
     OR v_from.platform_user_id LIKE 'pending\_%' OR v_to.platform_user_id LIKE 'pending\_%'
     OR v_to.platform_user_id LIKE 'retired\_%' OR v_to.is_active IS NOT TRUE THEN
    -- The destination must be a live connection: setup moved onto a retired or
    -- disconnected row would be stranded again.
    RAISE EXCEPTION 'move_whatsapp_account_setup: accounts_not_compatible'
      USING errcode = '22023';
  END IF;

  v_same_number := whatsapp_account_number_digits(v_from) <> ''
               AND whatsapp_account_number_digits(v_from) = whatsapp_account_number_digits(v_to);

  -- Choices (interactive only), validated before anything changes.
  IF p_mode = 'interactive' THEN
    IF p_choices IS NULL OR jsonb_typeof(p_choices) <> 'object' THEN
      RAISE EXCEPTION 'move_whatsapp_account_setup: choices must be an object' USING errcode = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_choices) k WHERE k NOT IN ('agent_config', 'connectors', 'partner')) THEN
      RAISE EXCEPTION 'move_whatsapp_account_setup: unknown choice key' USING errcode = '22023';
    END IF;
    v_cfg_choice := coalesce(p_choices->>'agent_config', 'destination');
    IF v_cfg_choice NOT IN ('source', 'destination') THEN
      RAISE EXCEPTION 'move_whatsapp_account_setup: agent_config must be source or destination' USING errcode = '22023';
    END IF;
    IF p_choices ? 'partner' THEN
      IF jsonb_typeof(p_choices->'partner') <> 'boolean' THEN
        RAISE EXCEPTION 'move_whatsapp_account_setup: partner must be true or false' USING errcode = '22023';
      END IF;
      v_partner := (p_choices->>'partner')::boolean;
    ELSE
      v_partner := false;
    END IF;
    IF p_choices ? 'connectors' THEN
      IF jsonb_typeof(p_choices->'connectors') <> 'object' THEN
        RAISE EXCEPTION 'move_whatsapp_account_setup: connectors must be an object' USING errcode = '22023';
      END IF;
      FOR v_key, v_value IN SELECT * FROM jsonb_each(p_choices->'connectors') LOOP
        IF NOT EXISTS (SELECT 1 FROM ai_agent_tools WHERE social_account_id = p_from AND name = v_key) THEN
          RAISE EXCEPTION 'move_whatsapp_account_setup: % is not a connector of the source account', v_key USING errcode = '22023';
        END IF;
        IF jsonb_typeof(v_value) <> 'string' OR v_value #>> '{}' NOT IN ('replace', 'skip') THEN
          RAISE EXCEPTION 'move_whatsapp_account_setup: connector choice must be replace or skip' USING errcode = '22023';
        END IF;
        IF v_value #>> '{}' = 'skip' THEN v_skip_names := v_skip_names || v_key;
        ELSE v_replace_names := v_replace_names || v_key; END IF;
      END LOOP;
    END IF;
  END IF;

  -- Group S inventory.
  v_src_has_config := EXISTS (SELECT 1 FROM ai_agent_configs WHERE social_account_id = p_from);
  v_dst_has_config := EXISTS (SELECT 1 FROM ai_agent_configs WHERE social_account_id = p_to);
  SELECT coalesce(array_agg(id), '{}') INTO v_src_tools FROM ai_agent_tools WHERE social_account_id = p_from;
  SELECT coalesce(array_agg(s.name), '{}') INTO v_name_clash
    FROM ai_agent_tools s JOIN ai_agent_tools d ON d.name = s.name AND d.user_id = s.user_id
   WHERE s.social_account_id = p_from AND d.social_account_id = p_to;
  v_group_exists := v_src_has_config OR cardinality(v_src_tools) > 0
                 OR EXISTS (SELECT 1 FROM store_webhook_bindings WHERE social_account_id = p_from)
                 OR EXISTS (SELECT 1 FROM ai_agent_tool_accounts WHERE social_account_id = p_from);

  -- Lock 3: events that could still be sent for the source's bindings.
  PERFORM 1 FROM store_events
   WHERE binding_id IN (SELECT id FROM store_webhook_bindings WHERE social_account_id = p_from)
     AND status IN ('pending', 'claimed', 'sending')
   ORDER BY id
   FOR UPDATE;
  v_in_flight := EXISTS (
    SELECT 1 FROM store_events
     WHERE binding_id IN (SELECT id FROM store_webhook_bindings WHERE social_account_id = p_from)
       AND status IN ('claimed', 'sending'));

  IF p_mode = 'auto' THEN
    IF v_group_exists AND v_src_has_config AND v_dst_has_config THEN
      v_group_ok := false; v_defer_reason := 'agent_config_conflict';
      v_conflicts := v_conflicts || jsonb_build_object('item', 'agent_config');
    END IF;
    IF v_group_exists AND cardinality(v_name_clash) > 0 THEN
      v_group_ok := false; v_defer_reason := coalesce(v_defer_reason, 'connector_name_conflict');
      v_conflicts := v_conflicts || (SELECT jsonb_agg(jsonb_build_object('item', 'connector', 'name', n)) FROM unnest(v_name_clash) n);
    END IF;
    IF v_group_exists AND v_in_flight THEN
      v_group_ok := false; v_defer_reason := coalesce(v_defer_reason, 'store_event_in_flight');
    END IF;
  ELSE
    IF v_group_exists AND v_in_flight THEN
      RAISE EXCEPTION 'move_whatsapp_account_setup: a store order message is being sent' USING errcode = '55006';
    END IF;
    -- Every name clash needs an explicit choice.
    IF EXISTS (SELECT 1 FROM unnest(v_name_clash) n WHERE n <> ALL (v_skip_names) AND n <> ALL (v_replace_names)) THEN
      RAISE EXCEPTION 'move_whatsapp_account_setup: connector_name_clash' USING errcode = '22023';
    END IF;
    -- Moving the agent config away while a store-bound connector stays behind would leave
    -- that store webhook with no procedures on its account: the original incident.
    IF v_src_has_config AND (NOT v_dst_has_config OR v_cfg_choice = 'source') AND EXISTS (
      SELECT 1 FROM ai_agent_tools t JOIN store_webhook_bindings b ON b.connector_id = t.id
       WHERE t.social_account_id = p_from AND t.name = ANY (v_skip_names)) THEN
      RAISE EXCEPTION 'move_whatsapp_account_setup: store_connector_left_behind' USING errcode = '22023';
    END IF;
    -- A replaced destination connector must not own a store webhook (deleting it would drop the binding).
    IF EXISTS (
      SELECT 1 FROM ai_agent_tools d JOIN store_webhook_bindings b ON b.connector_id = d.id
       WHERE d.social_account_id = p_to AND d.name = ANY (v_replace_names)) THEN
      RAISE EXCEPTION 'move_whatsapp_account_setup: replaced_connector_has_store_webhook' USING errcode = '22023';
    END IF;
  END IF;

  -- ---------------------------------------------------------------- group S
  IF v_group_exists AND v_group_ok THEN
    -- Agent config.
    v_cfg_moves := v_src_has_config AND (NOT v_dst_has_config OR v_cfg_choice = 'source');
    IF v_cfg_moves THEN
      IF v_dst_has_config THEN
        INSERT INTO ai_agent_config_archive (user_id, social_account_id, config)
        SELECT c.user_id, c.social_account_id, to_jsonb(c) FROM ai_agent_configs c WHERE c.social_account_id = p_to;
        DELETE FROM ai_agent_configs WHERE social_account_id = p_to;
      END IF;
      UPDATE ai_agent_configs SET social_account_id = p_to WHERE social_account_id = p_from;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_moved := v_moved || jsonb_build_object('agent_config', v_n); v_any := v_any OR v_n > 0;
    ELSIF v_src_has_config THEN
      v_left := v_left || jsonb_build_object('item', 'agent_config', 'reason', 'kept_destination');
    END IF;

    -- Connectors.
    IF cardinality(v_replace_names) > 0 THEN
      DELETE FROM ai_agent_tools WHERE social_account_id = p_to AND name = ANY (v_replace_names);
    END IF;
    SELECT coalesce(array_agg(id), '{}') INTO v_moving_tools
      FROM ai_agent_tools WHERE social_account_id = p_from AND name <> ALL (v_skip_names);
    UPDATE ai_agent_tools SET social_account_id = p_to WHERE id = ANY (v_moving_tools);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_moved := v_moved || jsonb_build_object('connectors', v_n); v_any := v_any OR v_n > 0;
    IF cardinality(v_skip_names) > 0 THEN
      v_left := v_left || (SELECT jsonb_agg(jsonb_build_object('item', 'connector', 'name', n, 'reason', 'skipped')) FROM unnest(v_skip_names) n);
    END IF;

    -- Store bindings move with the setup unless their connector is a source-scoped one
    -- that stays behind (skipped): a shared, linked or all-accounts connector is visible
    -- from the destination once the links below move, so its binding must move too.
    SELECT coalesce(array_agg(b.id), '{}'), coalesce(array_agg(b.connector_id), '{}')
      INTO v_moving_bindings, v_moving_connectors
      FROM store_webhook_bindings b JOIN ai_agent_tools t ON t.id = b.connector_id
     WHERE b.social_account_id = p_from
       AND NOT (t.social_account_id IS NOT DISTINCT FROM p_from AND t.id <> ALL (v_moving_tools));

    -- Connector sharing links.
    INSERT INTO ai_agent_tool_accounts (tool_id, social_account_id, user_id, created_at)
    SELECT tool_id, p_to, user_id, created_at FROM ai_agent_tool_accounts WHERE social_account_id = p_from
    ON CONFLICT DO NOTHING;
    DELETE FROM ai_agent_tool_accounts WHERE social_account_id = p_from;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_moved := v_moved || jsonb_build_object('connector_links', v_n); v_any := v_any OR v_n > 0;

    UPDATE store_webhook_bindings SET social_account_id = p_to WHERE id = ANY (v_moving_bindings);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_moved := v_moved || jsonb_build_object('store_bindings', v_n); v_any := v_any OR v_n > 0;

    -- Orders not yet started now go out from the destination; everything else is history.
    UPDATE store_events SET social_account_id = p_to
     WHERE binding_id = ANY (v_moving_bindings) AND status = 'pending';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_moved := v_moved || jsonb_build_object('pending_store_events', v_n);

    -- Waitlist consent was given for messages from this number.
    IF v_same_number THEN
      DELETE FROM stock_waitlist s
       WHERE s.social_account_id = p_from AND s.connector_id = ANY (v_moving_connectors)
         AND EXISTS (SELECT 1 FROM stock_waitlist d
                      WHERE d.social_account_id = p_to AND d.connector_id = s.connector_id
                        AND d.phone = s.phone AND d.product_id = s.product_id);
      UPDATE stock_waitlist SET social_account_id = p_to
       WHERE social_account_id = p_from AND connector_id = ANY (v_moving_connectors);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_moved := v_moved || jsonb_build_object('waitlist', v_n); v_any := v_any OR v_n > 0;
    ELSE
      SELECT count(*) INTO v_n FROM stock_waitlist WHERE social_account_id = p_from;
      IF v_n > 0 THEN
        v_left := v_left || jsonb_build_object('item', 'waitlist', 'count', v_n, 'reason', 'number_changed');
      END IF;
    END IF;
  ELSIF v_group_exists THEN
    v_left := v_left || jsonb_build_object('item', 'agent_setup', 'reason', v_defer_reason);
  END IF;

  -- ---------------------------------------------------------------- independent items
  INSERT INTO ai_knowledge_source_accounts (source_id, social_account_id, user_id, created_at)
  SELECT source_id, p_to, user_id, created_at FROM ai_knowledge_source_accounts WHERE social_account_id = p_from
  ON CONFLICT DO NOTHING;
  DELETE FROM ai_knowledge_source_accounts WHERE social_account_id = p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_moved := v_moved || jsonb_build_object('knowledge_sources', v_n); v_any := v_any OR v_n > 0;

  SELECT 100 - count(*) INTO v_room FROM ai_agent_test_cases WHERE social_account_id = p_to;
  UPDATE ai_agent_test_cases SET social_account_id = p_to
   WHERE id IN (SELECT id FROM ai_agent_test_cases WHERE social_account_id = p_from
                 ORDER BY position, created_at LIMIT greatest(v_room, 0));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_moved := v_moved || jsonb_build_object('test_cases', v_n); v_any := v_any OR v_n > 0;
  SELECT count(*) INTO v_n FROM ai_agent_test_cases WHERE social_account_id = p_from;
  IF v_n > 0 THEN
    v_left := v_left || jsonb_build_object('item', 'test_cases', 'count', v_n, 'reason', 'test_case_cap');
  END IF;

  IF coalesce(v_from.account_metadata->>'waba_id', '') <> ''
     AND v_from.account_metadata->>'waba_id' = v_to.account_metadata->>'waba_id' THEN
    UPDATE whatsapp_message_templates SET social_account_id = p_to WHERE social_account_id = p_from;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_moved := v_moved || jsonb_build_object('templates', v_n); v_any := v_any OR v_n > 0;
  ELSE
    SELECT count(*) INTO v_n FROM whatsapp_message_templates WHERE social_account_id = p_from;
    IF v_n > 0 THEN
      v_left := v_left || jsonb_build_object('item', 'templates', 'count', v_n, 'reason', 'waba_mismatch');
    END IF;
  END IF;

  IF v_partner THEN
    UPDATE partner_api_keys SET social_account_id = p_to WHERE social_account_id = p_from;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_moved := v_moved || jsonb_build_object('partner_keys_primary', v_n); v_any := v_any OR v_n > 0;
    INSERT INTO partner_api_key_accounts (key_id, social_account_id, workspace_id, created_at)
    SELECT key_id, p_to, workspace_id, created_at FROM partner_api_key_accounts WHERE social_account_id = p_from
    ON CONFLICT DO NOTHING;
    DELETE FROM partner_api_key_accounts WHERE social_account_id = p_from;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_moved := v_moved || jsonb_build_object('partner_key_links', v_n); v_any := v_any OR v_n > 0;
    UPDATE partner_webhooks SET social_account_id = p_to WHERE social_account_id = p_from;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_moved := v_moved || jsonb_build_object('partner_webhooks', v_n); v_any := v_any OR v_n > 0;
  ELSIF EXISTS (SELECT 1 FROM partner_api_keys WHERE social_account_id = p_from)
     OR EXISTS (SELECT 1 FROM partner_api_key_accounts WHERE social_account_id = p_from)
     OR EXISTS (SELECT 1 FROM partner_webhooks WHERE social_account_id = p_from) THEN
    v_left := v_left || jsonb_build_object('item', 'partner', 'reason', 'not_chosen');
  END IF;

  -- n8n trigger subscriptions: literal key prefix ('_' is a LIKE wildcard).
  v_n8n_prefix := 'n8n_webhook_' || v_user::text || '_';
  UPDATE app_settings
     SET value = jsonb_set(value, '{social_account_id}', to_jsonb(p_to::text))
   WHERE left(key, length(v_n8n_prefix)) = v_n8n_prefix
     AND value->>'social_account_id' = p_from::text;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_moved := v_moved || jsonb_build_object('n8n_subscriptions', v_n); v_any := v_any OR v_n > 0;

  UPDATE whatsapp_scheduled_messages SET social_account_id = p_to
   WHERE social_account_id = p_from AND status = 'pending';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_moved := v_moved || jsonb_build_object('scheduled_messages', v_n); v_any := v_any OR v_n > 0;

  -- Automation handlers: copied only where the destination has not set its own.
  FOREACH v_handler IN ARRAY ARRAY['automation_handler', 'comment_automation_handler', 'media_understanding'] LOOP
    IF coalesce(v_from.account_metadata, '{}'::jsonb) ? v_handler
       AND NOT (coalesce(v_to.account_metadata, '{}'::jsonb) ? v_handler) THEN
      v_to.account_metadata := coalesce(v_to.account_metadata, '{}'::jsonb)
                               || jsonb_build_object(v_handler, v_from.account_metadata->v_handler);
      v_moved := v_moved || jsonb_build_object(v_handler, 1); v_any := true;
    END IF;
  END LOOP;

  -- Bookkeeping on the destination's metadata (one write).
  IF v_group_exists AND NOT v_group_ok THEN
    v_to.account_metadata := coalesce(v_to.account_metadata, '{}'::jsonb) || jsonb_build_object(
      'setup_move_pending', jsonb_build_object('from', p_from::text, 'at', clock_timestamp()::text, 'reason', v_defer_reason));
  ELSIF v_group_exists THEN
    v_to.account_metadata := coalesce(v_to.account_metadata, '{}'::jsonb)
                             - 'setup_move_pending' - 'undelivered_store_events'
                             - 'undelivered_alert_email_at' - 'undelivered_alert_claimed_at';
    UPDATE social_accounts
       SET account_metadata = coalesce(account_metadata, '{}'::jsonb)
                              - 'undelivered_store_events' - 'undelivered_alert_email_at' - 'undelivered_alert_claimed_at'
     WHERE id = p_from;
  END IF;
  UPDATE social_accounts SET account_metadata = v_to.account_metadata
   WHERE id = p_to AND account_metadata IS DISTINCT FROM v_to.account_metadata;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_group_exists AND NOT v_group_ok THEN 'deferred'
                   WHEN v_any THEN 'moved'
                   ELSE 'noop' END,
    'moved', v_moved,
    'left', v_left,
    'conflicts', v_conflicts);
END;
$$;
REVOKE ALL ON FUNCTION public.move_whatsapp_account_setup(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_whatsapp_account_setup(uuid, uuid, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.dismiss_whatsapp_setup_move(p_to uuid, p_from uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM social_accounts t JOIN social_accounts f ON f.user_id = t.user_id
     WHERE t.id = p_to AND f.id = p_from AND t.platform = 'whatsapp' AND f.platform = 'whatsapp'
  ) THEN
    RAISE EXCEPTION 'dismiss_whatsapp_setup_move: accounts not found for one owner' USING errcode = '22023';
  END IF;
  UPDATE social_accounts
     SET account_metadata = jsonb_set(
           coalesce(account_metadata, '{}'::jsonb), '{setup_move_dismissed}',
           CASE WHEN coalesce(account_metadata->'setup_move_dismissed', '[]'::jsonb) ? p_from::text
                THEN coalesce(account_metadata->'setup_move_dismissed', '[]'::jsonb)
                ELSE coalesce(account_metadata->'setup_move_dismissed', '[]'::jsonb) || to_jsonb(p_from::text) END)
         - CASE WHEN account_metadata->'setup_move_pending'->>'from' = p_from::text THEN 'setup_move_pending' ELSE '' END
   WHERE id = p_to;
END;
$$;
REVOKE ALL ON FUNCTION public.dismiss_whatsapp_setup_move(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dismiss_whatsapp_setup_move(uuid, uuid) TO service_role;
