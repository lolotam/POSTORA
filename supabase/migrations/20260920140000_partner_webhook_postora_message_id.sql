-- Inbound media becomes reachable for partners.
--
-- `message.received` already carries `media_url`, but a partner cannot fetch it:
-- it is a graph.facebook.com lookaside URL that expires quickly and needs a
-- bearer token the partner does not hold. The supported path is now
-- `GET /v1/messages/{id}/media`, which mints a short-lived Postora-origin URL.
--
-- To call it, a partner needs the id of the message. The payload published only
-- the provider's wamid as `id`, so this adds `postora_message_id`, the same
-- `msg_`-prefixed surrogate the /v1 read surface already publishes.
--
-- `id` is deliberately unchanged. It is the wamid, it is documented as such, and
-- repurposing it would be a breaking change to a published field. The new key is
-- additive, which is why no accepted-breaking-change entry accompanies this.
--
-- No signed URL is ever put in this payload: outbox rows are durable and get
-- redelivered, so a URL in one is a capability persisted well past its
-- usefulness and replayed.
--
-- Both functions are re-issued with IDENTICAL signatures. A changed argument
-- list would create a second overload rather than replacing, and the existing
-- REVOKE/GRANT block would not cover it.

CREATE OR REPLACE FUNCTION public.partner_upsert_whatsapp_message(
  p_workspace_id      UUID,
  p_user_id           UUID,
  p_social_account_id UUID,
  p_conversation_id   TEXT,
  p_message_id        TEXT,
  p_from_phone        TEXT,
  p_from_name         TEXT,
  p_to_phone          TEXT,
  p_message_text      TEXT,
  p_message_type      TEXT,
  p_media_url         TEXT,
  p_media_type        TEXT,
  p_media_metadata    JSONB,
  p_direction         TEXT,
  p_status            TEXT,
  p_timestamp         TIMESTAMPTZ
)
RETURNS TABLE (row_id UUID, was_inserted BOOLEAN, events_enqueued INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row_id   UUID;
  v_enqueued INTEGER := 0;
BEGIN
  INSERT INTO public.whatsapp_messages (
    user_id, social_account_id, conversation_id, message_id,
    from_phone, from_name, to_phone, message_text, message_type,
    media_url, media_type, media_metadata, direction, status, "timestamp"
  )
  VALUES (
    p_user_id, p_social_account_id, p_conversation_id, p_message_id,
    p_from_phone, p_from_name, p_to_phone, p_message_text, p_message_type,
    p_media_url, p_media_type, p_media_metadata, p_direction, p_status, p_timestamp
  )
  -- Meta redelivers webhooks; the (user_id, message_id) conflict absorbing
  -- the redelivery is what makes the idempotency claim.
  ON CONFLICT (user_id, message_id) DO NOTHING
  RETURNING whatsapp_messages.id INTO v_row_id;

  -- The :765 trap, stated as code: this function also persists OUTBOUND rows
  -- (history threads and owner-sent echoes). Only a row that was genuinely
  -- INSERTED and is genuinely INBOUND is a message.received transition -- a
  -- hook that fired for "the statement" would report outbound traffic too.
  IF v_row_id IS NOT NULL AND p_direction = 'inbound' THEN
    v_enqueued := public.partner_emit_webhook_event(
      p_workspace_id,
      'message.received',
      'message.received:' || p_message_id,
      jsonb_build_object(
        'account_id', 'acc_' || p_social_account_id::text,
        'platform', 'whatsapp',
        'message', jsonb_build_object(
          'id', p_message_id,
            'postora_message_id', 'msg_' || v_row_id::text,
          'direction', 'inbound',
          'from_phone', p_from_phone,
          'from_name', p_from_name,
          'to_phone', p_to_phone,
          'type', p_message_type,
          'text', p_message_text,
          'media_url', p_media_url,
          'media_type', p_media_type,
          'timestamp', p_timestamp
        )
      ),
      'whatsapp',
      p_social_account_id,
      p_timestamp
    );
  END IF;

  RETURN QUERY SELECT v_row_id, (v_row_id IS NOT NULL), v_enqueued;
END;
$$;

CREATE OR REPLACE FUNCTION public.partner_import_whatsapp_message_batch(
  p_workspace_id UUID,
  p_rows         JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted INTEGER := 0;
  v_enqueued INTEGER := 0;
  v_row RECORD;
BEGIN
  FOR v_row IN
    WITH ins AS (
      INSERT INTO public.whatsapp_messages (
        user_id, social_account_id, conversation_id, message_id,
        from_phone, from_name, to_phone, message_text, message_type,
        media_url, media_type, media_metadata, direction, status, "timestamp"
      )
      SELECT r.user_id, r.social_account_id, r.conversation_id, r.message_id,
             r.from_phone, r.from_name, r.to_phone, r.message_text, r.message_type,
             r.media_url, r.media_type, r.media_metadata, r.direction, r.status,
             r.timestamp
        FROM jsonb_to_recordset(p_rows) AS r(
          user_id uuid, social_account_id uuid, conversation_id text, message_id text,
          from_phone text, from_name text, to_phone text, message_text text,
          message_type text, media_url text, media_type text, media_metadata jsonb,
          direction text, status text, timestamp timestamptz
        )
      ON CONFLICT (user_id, message_id) DO NOTHING
      RETURNING id, message_id, direction, from_phone, from_name, to_phone,
                message_text, message_type, media_url, media_type,
                social_account_id, "timestamp"
    )
    SELECT * FROM ins
  LOOP
    v_inserted := v_inserted + 1;
    IF v_row.direction = 'inbound' THEN
      v_enqueued := v_enqueued + public.partner_emit_webhook_event(
        p_workspace_id,
        'message.received',
        'message.received:' || v_row.message_id,
        jsonb_build_object(
          'account_id', 'acc_' || v_row.social_account_id::text,
          'platform', 'whatsapp',
          'message', jsonb_build_object(
            'id', v_row.message_id,
            'postora_message_id', 'msg_' || v_row.id::text,
            'direction', 'inbound',
            'from_phone', v_row.from_phone,
            'from_name', v_row.from_name,
            'to_phone', v_row.to_phone,
            'type', v_row.message_type,
            'text', v_row.message_text,
            'media_url', v_row.media_url,
            'media_type', v_row.media_type,
            'timestamp', v_row.timestamp
          )
        ),
        'whatsapp',
        v_row.social_account_id,
        v_row.timestamp
      );
    END IF;
  END LOOP;

  RETURN v_inserted;
END;
$$;
