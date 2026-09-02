-- ============================================================================
-- partner_webhook_phase6_events.sql
--
-- Database proof for the Phase 6 event producers
-- (20260902130000_partner_webhook_phase6_events.sql). Everything asserted
-- here is a property enforced by POSTGRES, not by code:
--
--   * THE CRASH TEST, both directions, per event: the state change and the
--     delivery row commit together, and a rolled-back state change leaves no
--     delivery row. This is the D5(R1) exit criterion -- an enqueue in the
--     same transaction as the state change it reports.
--   * CARDINALITY: three matching subscriptions produce three rows,
--     non-matching subscriptions produce ZERO, and re-enqueuing the same
--     occurrence adds nothing.
--   * TENANCY: an event in workspace A never reaches workspace B.
--   * THE :765 TRAP: a statement whose rows commit either direction emits
--     only for the rows that are genuinely inbound and genuinely new.
--   * OCCURRENCE-IDENTITY: message.delivered/.read/.failed for ONE wamid are
--     three distinct rows (the collision the substrate record names), and a
--     repeat transition of one account is a new occurrence.
--
-- Self-cleaning and RE-RUNNABLE: every seeded row carries a per-run nonce.
-- ============================================================================

\set ON_ERROR_STOP on

-- --- Catalog: the allowlist widened to exactly the certified set ------------
DO $catalog$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint WHERE conname = 'partner_webhooks_events_certified';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'FAIL: the widened events CHECK is missing';
  END IF;
  IF v_def !~ 'message\.received' OR v_def !~ 'message\.accepted'
     OR v_def !~ 'account\.reauthorization_required' THEN
    RAISE EXCEPTION 'FAIL: the widened events CHECK is missing a certified event: %', v_def;
  END IF;
  -- account.connected/.disconnected stay OUT until their producer is real.
  IF v_def ~ 'account\.connected' OR v_def ~ 'account\.disconnected' THEN
    RAISE EXCEPTION 'FAIL: account.connected/.disconnected were advertised before their producer exists';
  END IF;
  RAISE NOTICE 'PASS: the events CHECK names exactly the Phase 6 certified set';
END
$catalog$;

-- --- The behavioural suite --------------------------------------------------
DO $suite$
DECLARE
  nonce  TEXT := replace(gen_random_uuid()::text, '-', '');
  usr    UUID;
  ws_a   UUID;
  ws_b   UUID;
  acct_a UUID;
  acct_b UUID;
  key_a  UUID;
  key_b  UUID;
  wh_1   UUID;   -- ws_a, no filters, subscribed to the message events
  wh_2   UUID;   -- ws_a, platform=whatsapp, account=acct_a, same events
  wh_3   UUID;   -- ws_a, subscribed to reauth only
  wh_b   UUID;   -- ws_b, no filters, all certified events (the tenancy probe)
  wh_off UUID;   -- ws_a, correct events, INACTIVE
  intent UUID;
  result JSONB;
  rows   INTEGER;
  n      INTEGER;
  n_after      INTEGER;
  msg_id TEXT;
  -- partner_upsert_whatsapp_message returns a 3-column row, not jsonb.
  v_rowid UUID;
  v_ins   BOOLEAN;
  v_enq   INTEGER;
BEGIN
  SELECT id INTO usr FROM auth.users LIMIT 1;
  IF usr IS NULL THEN RAISE EXCEPTION 'the harness seeds one auth.users row; none found'; END IF;

  INSERT INTO public.workspaces (name, owner_id, is_personal)
  VALUES ('p6-ws-a-' || nonce, usr, false) RETURNING id INTO ws_a;
  INSERT INTO public.workspaces (name, owner_id, is_personal)
  VALUES ('p6-ws-b-' || nonce, usr, false) RETURNING id INTO ws_b;

  INSERT INTO public.social_accounts (user_id, workspace_id, platform, platform_user_id, access_token, is_active)
  VALUES (usr, ws_a, 'whatsapp', 'p6-a-' || nonce, 'tok', true) RETURNING id INTO acct_a;
  INSERT INTO public.social_accounts (user_id, workspace_id, platform, platform_user_id, access_token, is_active)
  VALUES (usr, ws_b, 'whatsapp', 'p6-b-' || nonce, 'tok', true) RETURNING id INTO acct_b;

  INSERT INTO public.partner_api_keys (workspace_id, social_account_id, key_hash, key_prefix, name, scopes)
  VALUES (ws_a, acct_a, 'p6-hash-a-' || nonce, 'pk_live_aaaa', 'p6-key-a', ARRAY['webhooks:manage'])
  RETURNING id INTO key_a;
  INSERT INTO public.partner_api_keys (workspace_id, social_account_id, key_hash, key_prefix, name, scopes)
  VALUES (ws_b, acct_b, 'p6-hash-b-' || nonce, 'pk_live_bbbb', 'p6-key-b', ARRAY['webhooks:manage'])
  RETURNING id INTO key_b;

  -- The subscriptions. The two message-listeners differ by filter so the
  -- narrowing rules are exercised on real rows, not just absence.
  INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret)
  VALUES (ws_a, key_a, 'https://hooks.example.com/p6-1',
          ARRAY['message.received','message.delivered','message.read','message.failed','message.accepted'],
          'whsec_1')
  RETURNING id INTO wh_1;
  INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret, platform, social_account_id, secret_version)
  VALUES (ws_a, key_a, 'https://hooks.example.com/p6-2',
          ARRAY['message.received','message.delivered','message.read','message.failed','message.accepted'],
          'whsec_2', 'whatsapp', acct_a, 3)
  RETURNING id INTO wh_2;
  INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret)
  VALUES (ws_a, key_a, 'https://hooks.example.com/p6-3',
          ARRAY['account.reauthorization_required'], 'whsec_3')
  RETURNING id INTO wh_3;
  INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret)
  VALUES (ws_b, key_b, 'https://hooks.example.com/p6-b',
          ARRAY['message.received','message.accepted','message.delivered','message.read','message.failed',
                'account.reauthorization_required'], 'whsec_b')
  RETURNING id INTO wh_b;
  INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret, is_active, disabled_reason)
  VALUES (ws_a, key_a, 'https://hooks.example.com/p6-off',
          ARRAY['message.received'], 'whsec_off', false, 'retry ladder exhausted')
  RETURNING id INTO wh_off;

  -- ==========================================================================
  -- 0. The gate on advertising an event, both directions.
  -- ==========================================================================
  BEGIN
    INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret)
    VALUES (ws_a, key_a, 'https://hooks.example.com/p6-uncertified', ARRAY['account.connected'], 'whsec_x');
    RAISE EXCEPTION 'FAIL: account.connected was accepted before its producer exists';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: account.connected is still refused (no certified producer yet)';
  END;

  -- ==========================================================================
  -- 1. message.received -- single inbound persist (partner_upsert_whatsapp_message)
  -- ==========================================================================
  msg_id := 'wamid.p6.' || nonce;
  SELECT * INTO v_rowid, v_ins, v_enq FROM public.partner_upsert_whatsapp_message(
    ws_a, usr, acct_a, 'p6_conv_1', msg_id,
    '+15550000001', 'Alice', '+15550000999', 'hello', 'text',
    null, null, null, 'inbound', 'received', now()
  );
  IF v_ins IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: the first persist of a message id must insert';
  END IF;

  -- Cardinality: TWO matching subscriptions in ws_a (wh_1 unfiltered, wh_2
  -- filtered to exactly this account) -> TWO rows. Not one, not three.
  SELECT count(*) INTO rows FROM public.partner_webhook_deliveries
   WHERE event_occurrence_id = 'message.received:' || msg_id;
  IF rows <> 2 THEN
    RAISE EXCEPTION 'FAIL: expected 2 message.received rows (2 matching subs), got %', rows;
  END IF;
  RAISE NOTICE 'PASS: one occurrence fanned out to the matching subscriptions only';

  -- The account filter must match THIS account, and the secret version is
  -- captured per subscription at enqueue (wh_2 was rotated to 3).
  IF NOT EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries
     WHERE webhook_id = wh_2 AND event_occurrence_id = 'message.received:' || msg_id
       AND secret_version = 3
  ) THEN
    RAISE EXCEPTION 'FAIL: the enqueued row did not capture its subscription''s secret_version';
  END IF;
  RAISE NOTICE 'PASS: each row captures its own subscription''s secret_version';

  -- TENANCY: workspace B's unfiltered, fully-subscribed webhook gets nothing.
  IF EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries d
     WHERE d.workspace_id = ws_b
       AND d.event_occurrence_id = 'message.received:' || msg_id
  ) THEN
    RAISE EXCEPTION 'FAIL: workspace A''s event reached workspace B''s subscription';
  END IF;
  -- And the INACTIVE subscription gets nothing.
  IF EXISTS (SELECT 1 FROM public.partner_webhook_deliveries WHERE webhook_id = wh_off) THEN
    RAISE EXCEPTION 'FAIL: a disabled endpoint was enqueued to';
  END IF;
  RAISE NOTICE 'PASS: tenancy and is_active hold (zero rows for ws_b and for the disabled endpoint)';

  -- Duplicate: a redelivery inserts nothing and emits nothing.
  SELECT * INTO v_rowid, v_ins, v_enq FROM public.partner_upsert_whatsapp_message(
    ws_a, usr, acct_a, 'p6_conv_1', msg_id,
    '+15550000001', 'Alice', '+15550000999', 'hello again', 'text',
    null, null, null, 'inbound', 'received', now()
  );
  IF v_ins IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL: a duplicate message id must not insert';
  END IF;
  SELECT count(*) INTO rows FROM public.partner_webhook_deliveries
   WHERE event_occurrence_id = 'message.received:' || msg_id;
  IF rows <> 2 THEN
    RAISE EXCEPTION 'FAIL: a duplicate persist changed the delivery count from 2 to %', rows;
  END IF;
  RAISE NOTICE 'PASS: a duplicate message id enqueues nothing (the occurrence anchor holds)';

  -- THE OTHER HALF of the matching rules: an account filter that DISAGREES
  -- excludes. wh_2 is filtered to acct_a; an occurrence on acct_b...
  -- acct_b lives in ws_b, so ws_a subscriptions must not match it at all.
  SELECT * INTO v_rowid, v_ins, v_enq FROM public.partner_upsert_whatsapp_message(
    ws_b, usr, acct_b, 'p6_conv_b', 'wamid.p6.b.' || nonce,
    '+15550000002', 'Bob', '+15550000998', 'hi', 'text',
    null, null, null, 'inbound', 'received', now()
  );
  IF v_ins IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: the ws_b message must insert';
  END IF;
  -- ws_b has its OWN subscribed webhook, so the event lands there -- but NOT
  -- on any ws_a subscription (this is the tenancy assertion with teeth).
  IF EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries
     WHERE workspace_id = ws_a AND event_occurrence_id = 'message.received:wamid.p6.b.' || nonce
  ) THEN
    RAISE EXCEPTION 'FAIL: an account-filter mismatch delivered anyway (filter did not narrow)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries
     WHERE workspace_id = ws_b AND event_occurrence_id = 'message.received:wamid.p6.b.' || nonce
  ) THEN
    RAISE EXCEPTION 'FAIL: the CONTROL failed -- ws_b''s own matching subscription got nothing';
  END IF;
  RAISE NOTICE 'PASS: account filters narrow (control: the owning workspace still receives)';

  -- THE :765 TRAP, single-statement form: the SAME function persisting an
  -- OUTBOUND row must insert it and emit NOTHING.
  SELECT * INTO v_rowid, v_ins, v_enq FROM public.partner_upsert_whatsapp_message(
    ws_a, usr, acct_a, 'p6_conv_1', 'wamid.p6.out.' || nonce,
    '+15550000999', 'You', '+15550000001', 'an owner echo', 'text',
    null, null, null, 'outbound', 'sent', now()
  );
  IF v_ins IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: the outbound row itself must insert (only the EVENT is gated)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries
     WHERE event_occurrence_id = 'message.received:wamid.p6.out.' || nonce
  ) THEN
    RAISE EXCEPTION 'FAIL: an outbound row produced a message.received event';
  END IF;
  RAISE NOTICE 'PASS: an outbound row through the same statement emits ZERO events';

  -- THE CRASH TEST, both directions. A plpgsql block with an EXCEPTION
  -- clause is a SUBTRANSACTION: raising inside it rolls back everything the
  -- block wrote, including the writes made inside the SQL function it
  -- called. That is a faithful "process died after the state change but
  -- before anything settled" simulation in one session.
  --
  -- Direction B: force the rollback, and NEITHER the message row NOR the
  -- delivery row may exist.
  BEGIN
    SELECT * INTO v_rowid, v_ins, v_enq FROM public.partner_upsert_whatsapp_message(
      ws_a, usr, acct_a, 'p6_conv_1', 'wamid.p6.rollback.' || nonce,
      '+15550000001', 'Alice', '+15550000999', 'rolled back', 'text',
      null, null, null, 'inbound', 'received', now()
    );
    IF v_ins IS NOT TRUE THEN
      RAISE EXCEPTION 'FAIL: rollback-direction insert did not happen inside the txn';
    END IF;
    RAISE EXCEPTION 'p6 forced rollback';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM <> 'p6 forced rollback' THEN
        RAISE EXCEPTION 'FAIL: the rollback-direction crash test raised %', SQLERRM;
      END IF;
  END;
  IF EXISTS (
    SELECT 1 FROM public.whatsapp_messages WHERE message_id = 'wamid.p6.rollback.' || nonce
  ) THEN
    RAISE EXCEPTION 'FAIL: the rolled-back message row survived';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries
     WHERE event_occurrence_id = 'message.received:wamid.p6.rollback.' || nonce
  ) THEN
    RAISE EXCEPTION 'FAIL: a delivery row survived its state change being rolled back';
  END IF;
  RAISE NOTICE 'PASS: crash direction B -- a rolled-back insert leaves no delivery row';

  -- Direction A (the control): the same call NOT rolled back leaves BOTH.
  SELECT * INTO v_rowid, v_ins, v_enq FROM public.partner_upsert_whatsapp_message(
    ws_a, usr, acct_a, 'p6_conv_1', 'wamid.p6.commit.' || nonce,
    '+15550000001', 'Alice', '+15550000999', 'committed', 'text',
    null, null, null, 'inbound', 'received', now()
  );
  IF v_ins IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: the committed-direction insert did not happen';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_messages WHERE message_id = 'wamid.p6.commit.' || nonce
  ) OR NOT EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries
     WHERE event_occurrence_id = 'message.received:wamid.p6.commit.' || nonce
  ) THEN
    RAISE EXCEPTION 'FAIL: the committed direction lost either the row or the delivery';
  END IF;
  RAISE NOTICE 'PASS: crash direction A -- a committed insert carries its delivery row';

  -- ==========================================================================
  -- 2. message.received -- the history bulk upsert (:765), mixed directions.
  -- ==========================================================================
  DECLARE
    batch JSONB := jsonb_build_array(
      jsonb_build_object('user_id', usr, 'social_account_id', acct_a, 'conversation_id', 'p6_conv_h',
        'message_id', 'wamid.p6.h1.' || nonce, 'from_phone', '+15550000001', 'from_name', 'Alice',
        'to_phone', '+15550000999', 'message_text', 'history in 1', 'message_type', 'text',
        'media_url', null, 'media_type', null, 'media_metadata', null,
        'direction', 'inbound', 'status', 'received', 'timestamp', now()),
      jsonb_build_object('user_id', usr, 'social_account_id', acct_a, 'conversation_id', 'p6_conv_h',
        'message_id', 'wamid.p6.h2.' || nonce, 'from_phone', '+15550000999', 'from_name', 'You',
        'to_phone', '+15550000001', 'message_text', 'history out 1', 'message_type', 'text',
        'media_url', null, 'media_type', null, 'media_metadata', null,
        'direction', 'outbound', 'status', 'sent', 'timestamp', now()),
      jsonb_build_object('user_id', usr, 'social_account_id', acct_a, 'conversation_id', 'p6_conv_h',
        'message_id', 'wamid.p6.h3.' || nonce, 'from_phone', '+15550000001', 'from_name', 'Alice',
        'to_phone', '+15550000999', 'message_text', 'history in 2', 'message_type', 'text',
        'media_url', null, 'media_type', null, 'media_metadata', null,
        'direction', 'inbound', 'status', 'received', 'timestamp', now())
    );
  BEGIN
    SELECT * INTO n FROM public.partner_import_whatsapp_message_batch(ws_a, batch);
    IF n <> 3 THEN
      RAISE EXCEPTION 'FAIL: the mixed batch inserted % rows, expected 3', n;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.partner_webhook_deliveries
       WHERE event_occurrence_id = 'message.received:wamid.p6.h2.' || nonce
    ) THEN
      RAISE EXCEPTION 'FAIL: the history batch emitted for its OUTBOUND row (the :765 trap)';
    END IF;
    SELECT count(*) INTO rows FROM public.partner_webhook_deliveries
     WHERE event_occurrence_id IN ('message.received:wamid.p6.h1.' || nonce,
                                   'message.received:wamid.p6.h3.' || nonce);
    IF rows <> 4 THEN
      RAISE EXCEPTION 'FAIL: expected 4 rows (2 inbound rows x 2 matching subs), got %', rows;
    END IF;
    RAISE NOTICE 'PASS: the mixed-direction batch emits for its inbound rows ONLY';

    -- Re-importing the same batch: 0 inserted, 0 new deliveries.
    SELECT * INTO n FROM public.partner_import_whatsapp_message_batch(ws_a, batch);
    IF n <> 0 THEN
      RAISE EXCEPTION 'FAIL: a re-imported batch inserted % rows, expected 0', n;
    END IF;
    SELECT count(*) INTO rows FROM public.partner_webhook_deliveries
     WHERE event_occurrence_id IN ('message.received:wamid.p6.h1.' || nonce,
                                   'message.received:wamid.p6.h3.' || nonce);
    IF rows <> 4 THEN
      RAISE EXCEPTION 'FAIL: a re-import changed the delivery count from 4 to %', rows;
    END IF;
    RAISE NOTICE 'PASS: a re-imported batch enqueues nothing';

    -- Crash direction B for the batch producer: everything the statement
    -- wrote (the message row and its delivery rows) vanishes together.
    DECLARE
      rb_batch JSONB := jsonb_build_array(
        jsonb_build_object('user_id', usr, 'social_account_id', acct_a, 'conversation_id', 'p6_conv_h',
          'message_id', 'wamid.p6.rb1.' || nonce, 'from_phone', '+15550000001', 'from_name', 'Alice',
          'to_phone', '+15550000999', 'message_text', 'rb in', 'message_type', 'text',
          'media_url', null, 'media_type', null, 'media_metadata', null,
          'direction', 'inbound', 'status', 'received', 'timestamp', now())
      );
    BEGIN
      SELECT * INTO n FROM public.partner_import_whatsapp_message_batch(ws_a, rb_batch);
      IF n <> 1 THEN
        RAISE EXCEPTION 'FAIL: the rollback batch inserted % rows, expected 1', n;
      END IF;
      RAISE EXCEPTION 'p6 forced rollback';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM <> 'p6 forced rollback' THEN
          RAISE EXCEPTION 'FAIL: the batch rollback test raised %', SQLERRM;
        END IF;
    END;
    IF EXISTS (
      SELECT 1 FROM public.whatsapp_messages WHERE message_id = 'wamid.p6.rb1.' || nonce
    ) OR EXISTS (
      SELECT 1 FROM public.partner_webhook_deliveries
       WHERE event_occurrence_id = 'message.received:wamid.p6.rb1.' || nonce
    ) THEN
      RAISE EXCEPTION 'FAIL: a rolled-back batch left a message row or a delivery row behind';
    END IF;
    RAISE NOTICE 'PASS: crash direction B -- a rolled-back batch leaves nothing behind';
  END;

  -- ==========================================================================
  -- 3. message.delivered / .read / .failed -- the status callback.
  --    THE OCCURRENCE-ID COLLISION TEST: one wamid, three transitions, three
  --    rows. Keyed on the resource alone the second would be dropped.
  -- ==========================================================================
  SELECT count(*) INTO rows FROM public.partner_apply_whatsapp_message_status(
    'wamid.p6.' || nonce, 'delivered', null, null
  );
  IF rows <> 1 THEN
    RAISE EXCEPTION 'FAIL: the delivered status reported % matched rows, expected 1', rows;
  END IF;
  SELECT count(*) INTO rows FROM public.partner_webhook_deliveries
   WHERE event_occurrence_id = 'message.delivered:wamid.p6.' || nonce;
  IF rows <> 2 THEN
    RAISE EXCEPTION 'FAIL: expected 2 message.delivered rows (2 matching subs), got %', rows;
  END IF;
  RAISE NOTICE 'PASS: a delivered transition fans out';

  SELECT count(*) INTO rows FROM public.partner_apply_whatsapp_message_status(
    'wamid.p6.' || nonce, 'read', null, null
  );
  IF rows <> 1 THEN
    RAISE EXCEPTION 'FAIL: the read status reported % matched rows, expected 1', rows;
  END IF;
  SELECT count(*) INTO rows FROM public.partner_webhook_deliveries
   WHERE event_occurrence_id = 'message.read:wamid.p6.' || nonce;
  IF rows <> 2 THEN
    RAISE EXCEPTION 'FAIL: the read transition of the same message did not get its own rows';
  END IF;
  RAISE NOTICE 'PASS: read after delivered on ONE wamid is a DISTINCT occurrence';

  SELECT count(*) INTO n FROM public.partner_apply_whatsapp_message_status(
    'wamid.p6.' || nonce, 'failed', '131047', 'outside the 24h window'
  );
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: the failed status reported % matched rows, expected 1', n;
  END IF;
  SELECT count(*) INTO rows FROM public.partner_webhook_deliveries
   WHERE event_occurrence_id = 'message.failed:wamid.p6.' || nonce;
  IF rows <> 2 THEN
    RAISE EXCEPTION 'FAIL: the failed transition did not get its own rows';
  END IF;
  -- The error fields landed on the message row, matching the old handler.
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_messages
     WHERE message_id = 'wamid.p6.' || nonce AND error_code = '131047'
  ) THEN
    RAISE EXCEPTION 'FAIL: the status update itself did not apply';
  END IF;
  RAISE NOTICE 'PASS: a failed transition carries its error fields';

  -- The reauth-only subscription must never receive a message event.
  IF EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries WHERE webhook_id = wh_3
     AND event_type <> 'account.reauthorization_required'
  ) THEN
    RAISE EXCEPTION 'FAIL: a subscription received an event it is not subscribed to';
  END IF;
  RAISE NOTICE 'PASS: the events-array filter holds';

  -- A 'sent' status is NOT an event (D6 R1: message.sent was renamed
  -- message.accepted; its certified producer is the dispatch settle).
  -- Counted BEFORE and AFTER rather than against an expected total.
  --
  -- The first version of this assertion expected 6 (delivered + read + failed,
  -- x2 subscriptions) and matched with LIKE 'message.%:wamid...', which also
  -- matches `message.received:` for the same wamid -- so it read 8 and failed
  -- for a reason that had nothing to do with 'sent'. An expected-total
  -- assertion has to be re-derived every time a phase certifies another event;
  -- a before/after equality says the thing actually meant -- "this transition
  -- changes nothing" -- and stays true however the vocabulary grows.
  SELECT count(*) INTO n FROM public.partner_webhook_deliveries
   WHERE event_occurrence_id LIKE '%:wamid.p6.' || nonce;

  SELECT count(*) INTO rows FROM public.partner_apply_whatsapp_message_status(
    'wamid.p6.' || nonce, 'sent', null, null
  );

  SELECT count(*) INTO n_after FROM public.partner_webhook_deliveries
   WHERE event_occurrence_id LIKE '%:wamid.p6.' || nonce;
  IF n_after <> n THEN
    RAISE EXCEPTION 'FAIL: a ''sent'' status enqueued % event(s); it must enqueue none', n_after - n;
  END IF;
  RAISE NOTICE 'PASS: a sent status updates the row and emits ZERO events';

  -- Crash direction B for the status transition (same subtransaction
  -- rollback technique as above).
  BEGIN
    SELECT count(*) INTO rows FROM public.partner_apply_whatsapp_message_status(
      'wamid.p6.commit.' || nonce, 'delivered', null, null
    );
    RAISE EXCEPTION 'p6 forced rollback';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM <> 'p6 forced rollback' THEN
        RAISE EXCEPTION 'FAIL: the status rollback test raised %', SQLERRM;
      END IF;
  END;
  IF EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries
     WHERE event_occurrence_id = 'message.delivered:wamid.p6.commit.' || nonce
  ) THEN
    RAISE EXCEPTION 'FAIL: a rolled-back status transition left a delivery row';
  END IF;
  IF (SELECT status FROM public.whatsapp_messages WHERE message_id = 'wamid.p6.commit.' || nonce) <> 'received' THEN
    RAISE EXCEPTION 'FAIL: a rolled-back status transition changed the message row';
  END IF;
  RAISE NOTICE 'PASS: crash direction B -- a rolled-back status leaves no row and no delivery';

  -- An unknown wamid: no rows, no event, no error.
  SELECT count(*) INTO rows FROM public.partner_apply_whatsapp_message_status(
    'wamid.p6.neverexisted.' || nonce, 'delivered', null, null
  );
  IF rows <> 0 THEN
    RAISE EXCEPTION 'FAIL: an unknown wamid reported % rows', rows;
  END IF;
  RAISE NOTICE 'PASS: an unknown wamid is a no-op';

  -- ==========================================================================
  -- 4. message.accepted -- the D13 dispatch settle and its echo reconcile.
  -- ==========================================================================
  -- The settle: intended -> sent emits.
  INSERT INTO public.partner_dispatch_intents (
    id, workspace_id, key_id, social_account_id, idempotency_key, state, request_summary
  ) VALUES (
    gen_random_uuid(), ws_a, key_a, acct_a, 'p6-ik-' || nonce, 'intended',
    jsonb_build_object('recipient_phone', '96512345678', 'template_name', 't_v1')
  ) RETURNING id INTO intent;

  SELECT * INTO result FROM public.partner_settle_dispatch_intent_sent(
    intent, 'wamid.p6.accepted.' || nonce, 200,
    jsonb_build_object('success', true)
  );
  IF (result->>'settled')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: the settle did not transition the intent';
  END IF;
  IF (SELECT state FROM public.partner_dispatch_intents WHERE id = intent) <> 'sent' THEN
    RAISE EXCEPTION 'FAIL: the settle did not persist state=sent';
  END IF;
  SELECT count(*) INTO rows FROM public.partner_webhook_deliveries
   WHERE event_occurrence_id = 'message.accepted:wamid.p6.accepted.' || nonce;
  IF rows <> 2 THEN
    RAISE EXCEPTION 'FAIL: expected 2 message.accepted rows, got %', rows;
  END IF;
  RAISE NOTICE 'PASS: the dispatch settle emits message.accepted with the intent state change';

  -- Settling again (the CAS half): no second transition, no new rows.
  SELECT * INTO result FROM public.partner_settle_dispatch_intent_sent(
    intent, 'wamid.p6.accepted.' || nonce, 200, jsonb_build_object('success', true)
  );
  IF (result->>'settled')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL: a second settle of the same intent must be a no-op';
  END IF;
  SELECT count(*) INTO rows FROM public.partner_webhook_deliveries
   WHERE event_occurrence_id = 'message.accepted:wamid.p6.accepted.' || nonce;
  IF rows <> 2 THEN
    RAISE EXCEPTION 'FAIL: a second settle changed the delivery count';
  END IF;
  RAISE NOTICE 'PASS: a repeat settle is a no-op';

  -- The echo reconcile of the SAME send: reconciled_sent, and the SHARED
  -- occurrence id means no duplicate rows -- the anchor absorbs it.
  SELECT * INTO result FROM public.partner_reconcile_dispatch_intent_sent(
    intent, 'wamid.p6.accepted.' || nonce
  );
  IF (result->>'reconciled')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: the reconcile of a sent row must transition to reconciled_sent';
  END IF;
  IF (SELECT state FROM public.partner_dispatch_intents WHERE id = intent) <> 'reconciled_sent' THEN
    RAISE EXCEPTION 'FAIL: the reconcile did not persist reconciled_sent';
  END IF;
  SELECT count(*) INTO rows FROM public.partner_webhook_deliveries
   WHERE event_occurrence_id = 'message.accepted:wamid.p6.accepted.' || nonce;
  IF rows <> 2 THEN
    RAISE EXCEPTION 'FAIL: the echo reconcile of an already-settled send duplicated the event';
  END IF;
  RAISE NOTICE 'PASS: reconcile after settle transitions the row and emits nothing new';

  -- The crashed-attempt path: an intent left `intended` (its attempt died
  -- after the provider call) gets its message.accepted from the ECHO -- this
  -- is the D13 escalation path resolving into an event.
  INSERT INTO public.partner_dispatch_intents (
    id, workspace_id, key_id, social_account_id, idempotency_key, state, request_summary
  ) VALUES (
    gen_random_uuid(), ws_a, key_a, acct_a, 'p6-ik2-' || nonce, 'intended',
    jsonb_build_object('recipient_phone', '96512345678', 'template_name', 't_v1')
  ) RETURNING id INTO intent;

  SELECT * INTO result FROM public.partner_reconcile_dispatch_intent_sent(
    intent, 'wamid.p6.echo.' || nonce
  );
  IF (result->>'reconciled')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: an intended row must reconcile on a positive echo';
  END IF;
  SELECT count(*) INTO rows FROM public.partner_webhook_deliveries
   WHERE event_occurrence_id = 'message.accepted:wamid.p6.echo.' || nonce;
  IF rows <> 2 THEN
    RAISE EXCEPTION 'FAIL: the crashed attempt''s echo produced % rows, expected 2', rows;
  END IF;
  RAISE NOTICE 'PASS: a crashed attempt''s message.accepted arrives via the echo';

  -- Crash direction B for the settle.
  BEGIN
    INSERT INTO public.partner_dispatch_intents (
      id, workspace_id, key_id, social_account_id, idempotency_key, state, request_summary
    ) VALUES (
      gen_random_uuid(), ws_a, key_a, acct_a, 'p6-ik3-' || nonce, 'intended',
      jsonb_build_object('recipient_phone', '96512345678', 'template_name', 't_v1')
    ) RETURNING id INTO intent;
    SELECT * INTO result FROM public.partner_settle_dispatch_intent_sent(
      intent, 'wamid.p6.rb.' || nonce, 200, jsonb_build_object('success', true)
    );
    IF (result->>'settled')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'FAIL: the rollback-direction settle did not happen inside the txn';
    END IF;
    RAISE EXCEPTION 'p6 forced rollback';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM <> 'p6 forced rollback' THEN
        RAISE EXCEPTION 'FAIL: the settle rollback test raised %', SQLERRM;
      END IF;
  END;
  IF EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries
     WHERE event_occurrence_id = 'message.accepted:wamid.p6.rb.' || nonce
  ) THEN
    RAISE EXCEPTION 'FAIL: a rolled-back settle left a delivery row';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.partner_dispatch_intents WHERE idempotency_key = 'p6-ik3-' || nonce
  ) THEN
    RAISE EXCEPTION 'FAIL: the rolled-back intent insert survived';
  END IF;
  RAISE NOTICE 'PASS: crash direction B -- a rolled-back settle leaves the outbox untouched';

  -- ==========================================================================
  -- 5. account.reauthorization_required -- repeat transitions distinguished.
  -- ==========================================================================
  -- First escalation: false -> true emits.
  SELECT * INTO result FROM public.partner_record_refresh_failure(
    acct_a, 3, 'refresh token invalid', true, null
  );
  IF (result->>'transitioned')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: the first escalation must be a transition';
  END IF;
  IF NOT (SELECT needs_reauth FROM public.social_accounts WHERE id = acct_a) THEN
    RAISE EXCEPTION 'FAIL: the escalation did not set needs_reauth';
  END IF;
  SELECT count(*) INTO rows FROM public.partner_webhook_deliveries
   WHERE event_occurrence_id LIKE 'account.reauthorization_required:' || acct_a || ':%';
  IF rows <> 1 THEN
    RAISE EXCEPTION 'FAIL: expected 1 reauth row (wh_3 only), got %', rows;
  END IF;
  IF (SELECT failure_count FROM public.social_accounts WHERE id = acct_a) <> 3 THEN
    RAISE EXCEPTION 'FAIL: the failure count was not recorded';
  END IF;
  RAISE NOTICE 'PASS: the first false->true transition emits (and only to the reauth subscriber)';

  -- The crash-retry case: a cron retry re-records the SAME failure against an
  -- already-flagged account. Not a transition, no second row.
  SELECT * INTO result FROM public.partner_record_refresh_failure(
    acct_a, 3, 'refresh token invalid', true, null
  );
  IF (result->>'transitioned')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL: re-escalating an already-flagged account must not be a transition';
  END IF;
  SELECT count(*) INTO rows FROM public.partner_webhook_deliveries
   WHERE event_occurrence_id LIKE 'account.reauthorization_required:' || acct_a || ':%';
  IF rows <> 1 THEN
    RAISE EXCEPTION 'FAIL: a cron retry duplicated the reauth event';
  END IF;
  RAISE NOTICE 'PASS: a cron retry against a flagged account emits nothing';

  -- Non-escalating failure: the state change happens, the event does not.
  UPDATE public.social_accounts SET needs_reauth = false WHERE id = acct_a;
  SELECT * INTO result FROM public.partner_record_refresh_failure(
    acct_a, 1, 'transient network error', false, null
  );
  IF (result->>'transitioned')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL: a non-escalating failure reported a transition';
  END IF;
  IF (SELECT needs_reauth FROM public.social_accounts WHERE id = acct_a) THEN
    RAISE EXCEPTION 'FAIL: a non-escalating failure set the flag';
  END IF;
  IF (SELECT failure_count FROM public.social_accounts WHERE id = acct_a) <> 1 THEN
    RAISE EXCEPTION 'FAIL: the failure count was not recorded on the non-escalating path';
  END IF;
  RAISE NOTICE 'PASS: a non-escalating failure records its count and emits nothing';

  -- Flip, repair, flip AGAIN: the second flip is a NEW occurrence (the
  -- timestamp discriminator), not a duplicate the anchor silently drops.
  SELECT * INTO result FROM public.partner_record_refresh_failure(
    acct_a, 4, 'refresh token invalid again', true, null
  );
  IF (result->>'transitioned')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: the second flip after repair must be a transition';
  END IF;
  SELECT count(*) INTO rows FROM public.partner_webhook_deliveries
   WHERE event_occurrence_id LIKE 'account.reauthorization_required:' || acct_a || ':%';
  IF rows <> 2 THEN
    RAISE EXCEPTION 'FAIL: the second flip produced % rows total, expected 2 distinct occurrences', rows;
  END IF;
  SELECT count(DISTINCT event_occurrence_id) INTO n FROM public.partner_webhook_deliveries
   WHERE event_occurrence_id LIKE 'account.reauthorization_required:' || acct_a || ':%';
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL: the two flips did not get DISTINCT occurrence ids';
  END IF;
  RAISE NOTICE 'PASS: flip -> repair -> flip yields two distinct occurrences';

  -- Crash direction B.
  BEGIN
    UPDATE public.social_accounts SET needs_reauth = false WHERE id = acct_a;
    SELECT * INTO result FROM public.partner_record_refresh_failure(
      acct_a, 5, 'rolled back', true, null
    );
    IF (result->>'transitioned')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'FAIL: the rollback-direction escalation did not happen inside the txn';
    END IF;
    RAISE EXCEPTION 'p6 forced rollback';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM <> 'p6 forced rollback' THEN
        RAISE EXCEPTION 'FAIL: the reauth rollback test raised %', SQLERRM;
      END IF;
  END;
  IF EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries
     WHERE event_occurrence_id LIKE 'account.reauthorization_required:' || acct_a || ':%'
       AND payload->>'last_refresh_error' = 'rolled back'
  ) THEN
    RAISE EXCEPTION 'FAIL: a rolled-back escalation left a delivery row';
  END IF;
  RAISE NOTICE 'PASS: crash direction B -- a rolled-back escalation leaves no delivery';

  -- Tenancy: escalating ws_b's account reaches ws_b's subscription only.
  SELECT * INTO result FROM public.partner_record_refresh_failure(
    acct_b, 3, 'ws b token invalid', true, null
  );
  IF (result->>'transitioned')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: the ws_b escalation must be a transition';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries
     WHERE workspace_id = ws_b
       AND event_occurrence_id LIKE 'account.reauthorization_required:' || acct_b || ':%'
  ) THEN
    RAISE EXCEPTION 'FAIL: the CONTROL failed -- ws_b''s own subscription got nothing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries
     WHERE workspace_id = ws_a
       AND event_occurrence_id LIKE 'account.reauthorization_required:' || acct_b || ':%'
  ) THEN
    RAISE EXCEPTION 'FAIL: ws_b''s reauth event reached a ws_a subscription';
  END IF;
  RAISE NOTICE 'PASS: the reauth event stays inside its account''s workspace';

  -- ==========================================================================
  -- 6. Direct fan-out cardinality on the helper (the F1/F2/F3 style proof,
  --    asserted where the constraint actually lives).
  -- ==========================================================================
  -- wh_1, wh_2 match; wh_3 (wrong events), wh_b (wrong workspace) and wh_off
  -- (inactive) do not. Three subscriptions would match an UNFILTERED
  -- occurrence -- so build one more subscription to make the count 3.
  INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret)
  VALUES (ws_a, key_a, 'https://hooks.example.com/p6-4',
          ARRAY['webhook.test','message.accepted'], 'whsec_4');

  SELECT * INTO n FROM public.partner_emit_webhook_event(
    ws_a, 'message.accepted', 'message.accepted:p6-cardinality-' || nonce,
    jsonb_build_object('k', 1), 'whatsapp', acct_a, now()
  );
  IF n <> 3 THEN
    RAISE EXCEPTION 'FAIL: three matching subscriptions produced % rows, expected 3', n;
  END IF;
  -- Re-enqueuing the same occurrence adds nothing.
  SELECT * INTO n FROM public.partner_emit_webhook_event(
    ws_a, 'message.accepted', 'message.accepted:p6-cardinality-' || nonce,
    jsonb_build_object('k', 1), 'whatsapp', acct_a, now()
  );
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: re-enqueuing the same occurrence added % rows', n;
  END IF;
  -- A platform-filtered occurrence that disagrees: wh_2 (platform=whatsapp)
  -- must NOT match a 'facebook' occurrence, and the unfiltered ones must.
  SELECT * INTO n FROM public.partner_emit_webhook_event(
    ws_a, 'message.accepted', 'message.accepted:p6-platform-' || nonce,
    jsonb_build_object('k', 1), 'facebook', acct_a, now()
  );
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL: a facebook-platform occurrence matched % subscriptions, expected the 2 unfiltered', n;
  END IF;
  RAISE NOTICE 'PASS: direct fan-out cardinality, dedup and platform narrowing hold';

  -- --- cleanup --------------------------------------------------------------
  DELETE FROM public.partner_webhooks WHERE workspace_id IN (ws_a, ws_b);  -- cascades deliveries
  DELETE FROM public.partner_dispatch_intents WHERE workspace_id IN (ws_a, ws_b);
  DELETE FROM public.whatsapp_messages WHERE social_account_id IN (acct_a, acct_b)
    AND conversation_id LIKE 'p6_conv_%';
  DELETE FROM public.social_accounts WHERE id IN (acct_a, acct_b);
  DELETE FROM public.partner_api_keys WHERE id IN (key_a, key_b);
  DELETE FROM public.workspaces WHERE id IN (ws_a, ws_b);
END
$suite$;

\echo '=== partner_webhook_phase6_events: ALL CHECKS PASSED ==='
