-- WhatsApp account continuity, PR-D (spec docs/superpowers/specs/2026-10-01-whatsapp-account-continuity-design.md §7).
--
-- get_whatsapp_account_setup_summary: what is attached to one WhatsApp account, for the
-- disconnect dialogs and the "bring over my setup" banner. Owner-only, browser-callable.
--
-- note_/clear_undelivered_store_events: the flag behind the disconnected-account alert.
-- It carries no count: the store receiver and every 15-minute worker retry raise it, so a
-- counter would count retries, not orders.
--
-- mark_undelivered_alert_emailed: the alert email's "sent for this incident" mark, written
-- in SQL so it cannot overwrite a concurrent flag update with a stale metadata object.

CREATE OR REPLACE FUNCTION public.get_whatsapp_account_setup_summary(p_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_metadata jsonb;
  v_n8n_prefix text;
BEGIN
  SELECT user_id, coalesce(account_metadata, '{}'::jsonb)
    INTO v_user, v_metadata
    FROM social_accounts
   WHERE id = p_account_id AND platform = 'whatsapp';
  IF v_user IS NULL OR v_user IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'get_whatsapp_account_setup_summary: not found' USING errcode = '42501';
  END IF;
  -- Literal prefix, not LIKE ('_' is a LIKE wildcard). Keys are n8n_webhook_<userId>_<webhookId>.
  v_n8n_prefix := 'n8n_webhook_' || v_user::text || '_';
  RETURN jsonb_build_object(
    'agent_config',         (SELECT count(*) FROM ai_agent_configs WHERE social_account_id = p_account_id),
    'connectors',           (SELECT count(*) FROM ai_agent_tools WHERE social_account_id = p_account_id),
    'connector_links',      (SELECT count(*) FROM ai_agent_tool_accounts WHERE social_account_id = p_account_id),
    'store_bindings',       (SELECT count(*) FROM store_webhook_bindings WHERE social_account_id = p_account_id),
    'knowledge_sources',    (SELECT count(*) FROM ai_knowledge_source_accounts WHERE social_account_id = p_account_id),
    'test_cases',           (SELECT count(*) FROM ai_agent_test_cases WHERE social_account_id = p_account_id),
    'waitlist',             (SELECT count(*) FROM stock_waitlist WHERE social_account_id = p_account_id),
    'templates',            (SELECT count(*) FROM whatsapp_message_templates WHERE social_account_id = p_account_id),
    'partner_keys_primary', (SELECT count(*) FROM partner_api_keys WHERE social_account_id = p_account_id AND revoked_at IS NULL),
    'partner_key_links',    (SELECT count(*) FROM partner_api_key_accounts WHERE social_account_id = p_account_id),
    'partner_webhooks',     (SELECT count(*) FROM partner_webhooks WHERE social_account_id = p_account_id AND is_active),
    'n8n_subscriptions',    (SELECT count(*) FROM app_settings
                              WHERE left(key, length(v_n8n_prefix)) = v_n8n_prefix
                                AND value->>'social_account_id' = p_account_id::text),
    'scheduled_messages',   (SELECT count(*) FROM whatsapp_scheduled_messages WHERE social_account_id = p_account_id),
    'automation_handlers',  to_jsonb(ARRAY(
                              SELECT k FROM unnest(ARRAY['automation_handler', 'comment_automation_handler', 'media_understanding']) AS k
                               WHERE v_metadata ? k))
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_whatsapp_account_setup_summary(uuid) FROM PUBLIC, anon, authenticated, service_role;
-- Browser-only: auth.uid() is null under the service role, so it is not granted there.
GRANT EXECUTE ON FUNCTION public.get_whatsapp_account_setup_summary(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.note_undelivered_store_event(p_account_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE social_accounts
     SET account_metadata = coalesce(account_metadata, '{}'::jsonb) || jsonb_build_object(
           'undelivered_store_events', jsonb_build_object(
             'since', coalesce(account_metadata->'undelivered_store_events'->>'since', clock_timestamp()::text),
             'last_at', clock_timestamp()::text))
   WHERE id = p_account_id;
$$;
REVOKE ALL ON FUNCTION public.note_undelivered_store_event(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_undelivered_store_event(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.clear_undelivered_store_events(p_account_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE social_accounts
     SET account_metadata = account_metadata - 'undelivered_store_events' - 'undelivered_alert_email_at' - 'undelivered_alert_claimed_at'
   WHERE id = p_account_id
     AND (account_metadata ? 'undelivered_store_events' OR account_metadata ? 'undelivered_alert_email_at');
$$;
REVOKE ALL ON FUNCTION public.clear_undelivered_store_events(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_undelivered_store_events(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_undelivered_alert_emailed(p_account_id uuid, p_since text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE social_accounts
     SET account_metadata = jsonb_set(account_metadata, '{undelivered_alert_email_at}', to_jsonb(clock_timestamp()::text))
   WHERE id = p_account_id
     AND account_metadata->'undelivered_store_events'->>'since' = p_since;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_undelivered_alert_emailed(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_undelivered_alert_emailed(uuid, text) TO service_role;

-- An expired hold (the worker skips it after 24h) must not leave a permanent incident:
-- clear it once nothing for the account is still waiting, so the next order starts a new
-- incident with its own 'since' and its own email.
CREATE OR REPLACE FUNCTION public.clear_undelivered_if_none_held(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM store_events
     WHERE social_account_id = p_account_id
       AND status IN ('pending', 'claimed', 'sending')
  ) THEN
    RETURN false;
  END IF;
  UPDATE social_accounts
     SET account_metadata = account_metadata - 'undelivered_store_events'
                                             - 'undelivered_alert_email_at'
                                             - 'undelivered_alert_claimed_at'
   WHERE id = p_account_id
     AND account_metadata ? 'undelivered_store_events';
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.clear_undelivered_if_none_held(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_undelivered_if_none_held(uuid) TO service_role;

-- Reserve the alert email for one incident before sending, so two overlapping runs cannot
-- both send. A claim older than 30 minutes is treated as a failed send and may be retaken.
CREATE OR REPLACE FUNCTION public.claim_undelivered_alert_email(p_account_id uuid, p_since text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE social_accounts
     SET account_metadata = jsonb_set(account_metadata, '{undelivered_alert_claimed_at}', to_jsonb(clock_timestamp()::text))
   WHERE id = p_account_id
     AND account_metadata->'undelivered_store_events'->>'since' = p_since
     AND NOT (account_metadata ? 'undelivered_alert_email_at')
     AND (NOT (account_metadata ? 'undelivered_alert_claimed_at')
          OR (account_metadata->>'undelivered_alert_claimed_at')::timestamptz < clock_timestamp() - interval '30 minutes');
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_undelivered_alert_email(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_undelivered_alert_email(uuid, text) TO service_role;
