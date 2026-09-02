-- Partner API v1, Phase 6: messaging and account events (deliverables 6.1,
-- 6.2, 6.3, 6.4).
--
-- Design record: docs/decisions/2026-09-02-phase6-messaging-account-events.md.
-- Ledger: docs/decisions/2026-09-02-webhook-producer-ledger.md.
--
-- THE CENTRAL RULE (D5 R1): every producer enqueues IN THE SAME TRANSACTION as
-- the state change it reports. supabase-js cannot express that as two client
-- calls -- the crash gap between them is exactly the gap the outbox exists to
-- close -- so each certified transition gets a SECURITY DEFINER function that
-- performs the state change AND the fan-out in ONE statement. A Postgres
-- function call is atomic: it commits or rolls back as a whole, which is what
-- makes "a process died between the write and the enqueue" unrepresentable
-- rather than merely unlikely.
--
-- The fan-out logic is written ONCE (partner_emit_webhook_event) and mirrors
-- the matching rules of the TypeScript fan-out shipped in Phase 5
-- (_shared/partnerWebhookEvents.ts): same workspace, is_active, events array
-- contains the type, NULL platform/account filter matches everything, one row
-- per matching subscription with ON CONFLICT DO NOTHING, secret_version
-- captured at enqueue.
--
-- Additive only. No existing column is dropped or repurposed.

-- ---------------------------------------------------------------------------
-- 1. Widen the closed allowlist (the gate on advertising an event)
-- ---------------------------------------------------------------------------
--
-- An event joins this list ONLY when its ledger row is complete AND a crash
-- test between its state change and its enqueue still delivers it. Phase 6
-- certifies:
--
--   message.received                -- inbound whatsapp_messages insert
--   message.accepted                -- the D13 dispatch settle (partner sends)
--   message.delivered/.read/.failed -- WhatsApp Cloud status callbacks
--   account.reauthorization_required-- refresh-tokens' needs_reauth escalation
--
-- account.connected / account.disconnected are deliberately STILL NOT on this
-- list: the activation transition has 24 genuine commit points across 15
-- files including a SQL RPC (see the ledger's resolved inventory), and the
-- right mechanism is a database trigger, not 24 hand-wired enqueues. Certifying them
-- without that would advertise an event most paths never fire.
DO $widen$
DECLARE
  v_constraint RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partner_webhooks_events_certified'
  ) THEN
    RETURN;
  END IF;

  -- Drop whatever CHECK guards the events column -- Phase 5's inline check
  -- carries the auto-generated name, and guessing it would silently leave it
  -- in place beside the new one. The events CHECK is single-column; the
  -- previous-secret completeness check spans three OTHER columns and does
  -- not match the filter.
  FOR v_constraint IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
     WHERE t.relname = 'partner_webhooks'
       AND c.contype = 'c'
       AND a.attname = 'events'
  LOOP
    EXECUTE format('ALTER TABLE public.partner_webhooks DROP CONSTRAINT %I', v_constraint.conname);
  END LOOP;

  ALTER TABLE public.partner_webhooks
    ADD CONSTRAINT partner_webhooks_events_certified
    CHECK (
      cardinality(events) > 0
      AND events <@ ARRAY[
        'webhook.test',
        'message.received',
        'message.accepted',
        'message.delivered',
        'message.read',
        'message.failed',
        'account.reauthorization_required'
      ]
    );
END
$widen$;

-- ---------------------------------------------------------------------------
-- 2. The SQL fan-out helper
-- ---------------------------------------------------------------------------
-- Written once, called by every per-transition function below. Mirrors
-- enqueuePartnerWebhookEvent exactly; the two must not drift.
CREATE OR REPLACE FUNCTION public.partner_emit_webhook_event(
  p_workspace_id      UUID,
  p_event_type        TEXT,
  p_occurrence_id     TEXT,
  p_payload           JSONB,
  p_platform          TEXT,
  p_social_account_id UUID,
  p_occurred_at       TIMESTAMPTZ DEFAULT now()
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enqueued INTEGER := 0;
BEGIN
  INSERT INTO public.partner_webhook_deliveries (
    webhook_id, workspace_id, event_type, event_occurrence_id,
    payload, occurred_at, secret_version
  )
  SELECT w.id,
         w.workspace_id,
         p_event_type,
         p_occurrence_id,
         p_payload,
         p_occurred_at,
         -- Captured at ENQUEUE, never read at send time -- re-signing a
         -- mid-ladder retry under a rotated secret would change the signature
         -- of an event whose id is immutable.
         w.secret_version
    FROM public.partner_webhooks w
   WHERE w.workspace_id = p_workspace_id
     AND w.is_active
     AND p_event_type = ANY (w.events)
     -- A filter may only ever REMOVE a subscription from a match, never add
     -- one: an unset filter means "no narrowing", a set one must agree.
     AND (w.platform IS NULL OR w.platform = p_platform)
     AND (w.social_account_id IS NULL OR w.social_account_id = p_social_account_id)
  -- Dedup is per subscription: a producer retry re-enqueuing the same
  -- occurrence is the NORMAL case, and absorbing it is what the outbox is
  -- for. The events CHECK constraint means no subscription can exist for an
  -- uncertified type, so this helper cannot enqueue one by mistake.
  ON CONFLICT (webhook_id, event_occurrence_id) DO NOTHING;

  GET DIAGNOSTICS v_enqueued = ROW_COUNT;
  RETURN v_enqueued;
END;
$$;

-- Internal helper: revoke the default PUBLIC execute grant. No service_role
-- grant on purpose -- only the SECURITY DEFINER functions below call it.
REVOKE ALL ON FUNCTION public.partner_emit_webhook_event(
  UUID, TEXT, TEXT, JSONB, TEXT, UUID, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;

-- Resolve the workspace an account's events belong in. Most accounts carry
-- workspace_id; legacy rows may not, and every TS path falls back to the
-- owner's personal workspace for those, so the SQL must too or a legacy
-- account's events would silently reach zero subscriptions.
CREATE OR REPLACE FUNCTION public.partner_workspace_of_account(
  p_account_id UUID
)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    sa.workspace_id,
    (SELECT w.id FROM public.workspaces w
      WHERE w.owner_id = sa.user_id AND w.is_personal LIMIT 1)
  )
  FROM public.social_accounts sa
  WHERE sa.id = p_account_id;
$$;

REVOKE ALL ON FUNCTION public.partner_workspace_of_account(UUID) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. message.received -- the inbound whatsapp_messages insert (6.1)
-- ---------------------------------------------------------------------------
-- Producers (per the ledger):
--   whatsapp-webhook/index.ts        live inbound upsert (was :451)
--   whatsapp-webhook/index.ts        history bulk upsert, inbound rows only
--                                    (was :765 -- one statement whose rows
--                                    commit EITHER direction per row)
--   whatsapp-evolution-webhook       QR-mode persist (was :123; owner-sent
--                                    echoes go through the same statement as
--                                    direction='outbound')
--
-- Occurrence id: message.received:<provider message id>. One insert, one
-- occurrence; a duplicate message id inserts nothing and emits nothing.
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

-- The bulk form, for the coexistence history push. Same conflict rule as
-- import_whatsapp_messages (which stays untouched for the sync engine); this
-- variant exists because history rows arrive as ONE statement whose rows
-- commit either direction, and message.received belongs to the inbound rows
-- of it only.
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
      RETURNING message_id, direction, from_phone, from_name, to_phone,
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

-- ---------------------------------------------------------------------------
-- 4. message.delivered / .read / .failed -- the status callback (6.3)
-- ---------------------------------------------------------------------------
-- Producer: the WhatsApp Cloud status handler in whatsapp-webhook (the
-- UPDATE that was :665). WhatsApp Cloud ONLY: Evolution QR mode does not
-- route provider status through this handler, so these three events are
-- documented as unavailable there.
--
-- Occurrence id: message.<status>:<wamid> -- the event type is part of the
-- key because delivered/read/failed for ONE message share one wamid; keyed
-- on the resource alone they collide and the outbox silently drops the
-- second and third transitions.
CREATE OR REPLACE FUNCTION public.partner_apply_whatsapp_message_status(
  p_message_id    TEXT,
  p_status        TEXT,
  p_error_code    TEXT DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL
)
RETURNS TABLE (
  conversation_id TEXT,
  user_id         UUID,
  social_account_id UUID,
  message_text    TEXT,
  events_enqueued INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row      RECORD;
  v_ws       UUID;
  v_enqueued INTEGER;
BEGIN
  FOR v_row IN
    -- The alias is not cosmetic: the RETURNS TABLE columns below become OUT
    -- parameters, and plpgsql would substitute them for these unqualified
    -- RETURNING names and fail on ambiguity. Qualified references (in the
    -- WHERE, the expressions and the RETURNING list) are exempt -- but the
    -- SET column NAMES themselves must stay unqualified, which is a Postgres
    -- syntax rule, not a preference.
    UPDATE public.whatsapp_messages m
       SET status        = p_status,
           error_code    = coalesce(p_error_code, m.error_code),
           error_message = coalesce(p_error_message, m.error_message)
     WHERE m.message_id = p_message_id
    RETURNING m.conversation_id, m.user_id, m.social_account_id, m.message_text
  LOOP
    v_enqueued := 0;
    -- 'sent' is deliberately NOT an event: D6 renamed message.sent to
    -- message.accepted precisely because "sent" overstates what the code
    -- knows, and the certified message.accepted producer is the D13 dispatch
    -- settle, not a status echo.
    IF p_status IN ('delivered', 'read', 'failed') THEN
      v_ws := public.partner_workspace_of_account(v_row.social_account_id);
      IF v_ws IS NOT NULL THEN
        v_enqueued := public.partner_emit_webhook_event(
          v_ws,
          'message.' || p_status,
          'message.' || p_status || ':' || p_message_id,
          jsonb_build_object(
            'account_id', 'acc_' || v_row.social_account_id::text,
            'platform', 'whatsapp',
            'message_id', p_message_id,
            'status', p_status,
            'timestamp', now(),
            'error', CASE WHEN p_status = 'failed'
                          THEN jsonb_build_object(
                                 'code', p_error_code,
                                 'message', p_error_message
                               )
                     END
          ),
          'whatsapp',
          v_row.social_account_id,
          now()
        );
      END IF;
    END IF;

    RETURN QUERY SELECT v_row.conversation_id, v_row.user_id,
                        v_row.social_account_id, v_row.message_text, v_enqueued;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. message.accepted -- the D13 dispatch settle (6.2)
-- ---------------------------------------------------------------------------
-- The single correct seam for PARTNER-originated sends is the dispatch
-- intent's own state machine: `intended -> sent` (the handler settle) and
-- the echo reconciliation (`-> reconciled_sent`) are the only two writes
-- that PROVE the provider accepted. Both emit the same occurrence id, so a
-- send that settled and was later echo-reconciled emits once -- and a send
-- whose attempt crashed after the provider call gets its message.accepted
-- from the reconciliation instead, which is the D13 escalation path
-- resolving itself.
--
-- The other outbound whatsapp_messages writers (the UI send path, broadcasts,
-- scheduled sends, the AI agent) are NOT producers of this event: D6 scopes
-- message.accepted to the partner send path, and those writers cannot be
-- made transactional without the same trigger discussion as the activation
-- transition. See the ledger.
CREATE OR REPLACE FUNCTION public.partner_settle_dispatch_intent_sent(
  p_intent_id     UUID,
  p_wamid         TEXT,
  p_http_status   INTEGER,
  p_response_body JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state    TEXT;
  v_ws       UUID;
  v_account  UUID;
  v_settled  BOOLEAN := FALSE;
  v_enqueued INTEGER := 0;
BEGIN
  SELECT state, workspace_id, social_account_id
    INTO v_state, v_ws, v_account
    FROM public.partner_dispatch_intents
   WHERE id = p_intent_id
   FOR UPDATE;

  IF v_state = 'intended' THEN
    UPDATE public.partner_dispatch_intents
       SET state         = 'sent',
           wamid         = p_wamid,
           http_status   = p_http_status,
           response_body = p_response_body,
           resolved_at   = now()
     WHERE id = p_intent_id
       AND state = 'intended';

    IF FOUND THEN
      v_settled := TRUE;
      v_enqueued := public.partner_emit_webhook_event(
        v_ws,
        'message.accepted',
        'message.accepted:' || p_wamid,
        jsonb_build_object(
          'account_id', 'acc_' || v_account::text,
          'platform', 'whatsapp',
          'message_id', p_wamid,
          'source', 'partner_api'
        ),
        'whatsapp',
        v_account,
        now()
      );
    END IF;
  END IF;

  RETURN jsonb_build_object('settled', v_settled, 'enqueued', v_enqueued);
END;
$$;

CREATE OR REPLACE FUNCTION public.partner_reconcile_dispatch_intent_sent(
  p_intent_id UUID,
  p_wamid     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state     TEXT;
  v_ws        UUID;
  v_account   UUID;
  v_reconciled BOOLEAN := FALSE;
  v_enqueued  INTEGER := 0;
BEGIN
  SELECT state, workspace_id, social_account_id
    INTO v_state, v_ws, v_account
    FROM public.partner_dispatch_intents
   WHERE id = p_intent_id
   FOR UPDATE;

  -- `failed` is excluded on purpose (a proven non-delivery cannot produce a
  -- status), matching the Phase 3 CAS exactly.
  IF v_state IN ('intended', 'indeterminate', 'sent') THEN
    UPDATE public.partner_dispatch_intents
       SET state       = 'reconciled_sent',
           wamid       = p_wamid,
           resolved_at = now()
     WHERE id = p_intent_id
       AND state IN ('intended', 'indeterminate', 'sent');

    IF FOUND THEN
      v_reconciled := TRUE;
      -- The occurrence id is shared with the settle. For a row that settled
      -- `sent` first, this insert is absorbed by the UNIQUE anchor (a no-op
      -- by construction). For an `intended`/`indeterminate` row -- the
      -- crashed attempt -- this is the FIRST proof of acceptance, and the
      -- event the partner was never going to get any other way.
      v_enqueued := public.partner_emit_webhook_event(
        v_ws,
        'message.accepted',
        'message.accepted:' || p_wamid,
        jsonb_build_object(
          'account_id', 'acc_' || v_account::text,
          'platform', 'whatsapp',
          'message_id', p_wamid,
          'source', 'partner_api'
        ),
        'whatsapp',
        v_account,
        now()
      );
    END IF;
  END IF;

  RETURN jsonb_build_object('reconciled', v_reconciled, 'enqueued', v_enqueued);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. account.reauthorization_required -- refresh failure escalation (6.4)
-- ---------------------------------------------------------------------------
-- ONE writer, pinned by the ledger: refresh-tokens' handleRefreshFailure
-- (the update that was :362). The whole failure-record write moves here so
-- the escalation and its fan-out are one statement.
--
-- Occurrence id: account.reauthorization_required:<account_id>:<epoch_us>.
-- The timestamp is load-bearing, not decoration: an account can be flipped,
-- repaired by an OAuth callback, and flipped AGAIN -- without a transition
-- discriminator the second flip would collide with the first and be silently
-- dropped. The escalation itself is guarded on the PREVIOUS value, so
-- re-running against an already-flagged account is not a transition and
-- emits nothing (a cron retry after a crash must not double-fire).
CREATE OR REPLACE FUNCTION public.partner_record_refresh_failure(
  p_account_id         UUID,
  p_failure_count      INTEGER,
  p_last_error         TEXT,
  p_escalate_reauth    BOOLEAN,
  p_last_alert_sent_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_was_reauth  BOOLEAN;
  v_platform    TEXT;
  v_ws          UUID;
  v_transition_at TIMESTAMPTZ;
  v_enqueued    INTEGER := 0;
BEGIN
  SELECT sa.needs_reauth, sa.platform,
         coalesce(
           sa.workspace_id,
           (SELECT w.id FROM public.workspaces w
             WHERE w.owner_id = sa.user_id AND w.is_personal LIMIT 1)
         )
    INTO v_was_reauth, v_platform, v_ws
    FROM public.social_accounts sa
   WHERE sa.id = p_account_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('transitioned', FALSE, 'enqueued', 0, 'account_found', FALSE);
  END IF;

  UPDATE public.social_accounts
     SET failure_count      = p_failure_count,
         last_refresh_error = p_last_error,
         updated_at         = now(),
         -- needs_reauth is only ever SET here, never cleared: the clearing
         -- paths are the OAuth callbacks, and only a completed reconnect may
         -- clear the health columns (the 2026-08-30 finding).
         needs_reauth       = CASE WHEN p_escalate_reauth THEN TRUE
                                   ELSE needs_reauth END,
         last_alert_sent_at = coalesce(p_last_alert_sent_at, last_alert_sent_at)
   WHERE id = p_account_id;

  IF p_escalate_reauth AND NOT v_was_reauth AND v_ws IS NOT NULL THEN
    v_transition_at := clock_timestamp();
    v_enqueued := public.partner_emit_webhook_event(
      v_ws,
      'account.reauthorization_required',
      'account.reauthorization_required:' || p_account_id::text || ':'
        || (extract(epoch FROM v_transition_at) * 1000000)::bigint::text,
      jsonb_build_object(
        'account_id', 'acc_' || p_account_id::text,
        'platform', v_platform,
        'failure_count', p_failure_count,
        'last_refresh_error', left(p_last_error, 300)
      ),
      v_platform,
      p_account_id,
      v_transition_at
    );
    RETURN jsonb_build_object('transitioned', TRUE, 'enqueued', v_enqueued, 'account_found', TRUE);
  END IF;

  RETURN jsonb_build_object('transitioned', FALSE, 'enqueued', 0, 'account_found', TRUE);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants -- the Phase 5 convention
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER, locked to service_role exactly like the Phase 5
-- functions. RLS stays on with no policies: the fail-closed default is the
-- contract, and these functions are the controlled openings in it.
DO $grants$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.partner_upsert_whatsapp_message(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TIMESTAMPTZ)',
    'public.partner_import_whatsapp_message_batch(UUID, JSONB)',
    'public.partner_apply_whatsapp_message_status(TEXT, TEXT, TEXT, TEXT)',
    'public.partner_settle_dispatch_intent_sent(UUID, TEXT, INTEGER, JSONB)',
    'public.partner_reconcile_dispatch_intent_sent(UUID, TEXT)',
    'public.partner_record_refresh_failure(UUID, INTEGER, TEXT, BOOLEAN, TIMESTAMPTZ)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END
$grants$;
