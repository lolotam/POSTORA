-- ============================================================================
-- partner_webhook_outbox.sql
--
-- Database proof for the Phase 5 webhook substrate
-- (20260902120000_partner_webhooks.sql). Everything here is a property the
-- TypeScript tests CANNOT establish, because each one is enforced by Postgres
-- rather than by code:
--
--   * the cardinality invariant -- one row per (webhook, occurrence), three
--     rows for three subscriptions, distinct rows for distinct transitions
--   * composite-FK tenancy: a subscription cannot be attributed to another
--     workspace's key, nor filtered to another workspace's account
--   * the closed event allowlist, enforced as a CHECK and not only in TS
--   * the LEASE, which is the whole reason SKIP LOCKED is not sufficient:
--     a claimed row must stay unclaimable while its lease is live
--   * the settle ladder, exhaustion, and auto-disable-only-on-exhaustion
--   * redrive: exhausted rows only, and the endpoint re-enabled with them
--   * the grant surface (RLS on, no policies, service_role only)
--
-- Self-cleaning and RE-RUNNABLE: every seeded row carries a per-run nonce, so
-- a failed run leaves nothing that makes the next run fail for a different
-- reason. A suite nobody can re-run is a suite nobody re-runs while debugging.
-- ============================================================================
\set ON_ERROR_STOP on

-- --- Catalog: the objects exist and say what they should ---------------------
DO $catalog$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint WHERE conname = 'partner_webhook_deliveries_occurrence_key';
  IF v_def IS NULL OR v_def !~ 'UNIQUE \(webhook_id, event_occurrence_id\)' THEN
    RAISE EXCEPTION 'FAIL: the dedup anchor is missing or is not (webhook_id, event_occurrence_id): %', v_def;
  END IF;
  RAISE NOTICE 'PASS: UNIQUE (webhook_id, event_occurrence_id) is the dedup anchor';

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partner_webhooks_key_in_workspace'
  ) THEN
    RAISE EXCEPTION 'FAIL: the composite key-tenancy FK is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partner_webhook_deliveries_webhook_in_workspace'
  ) THEN
    RAISE EXCEPTION 'FAIL: the composite delivery-tenancy FK is missing';
  END IF;
  RAISE NOTICE 'PASS: both composite tenancy FKs are present';

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'partner_webhook_deliveries_claimable_idx'
  ) THEN
    RAISE EXCEPTION 'FAIL: the claim predicate has no index';
  END IF;

  -- RLS on with NO policies is the contract: every access path is service-role
  -- or SECURITY DEFINER, so the fail-closed default IS the security model. A
  -- policy appearing here would silently widen it.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE relname = 'partner_webhooks') THEN
    RAISE EXCEPTION 'FAIL: RLS is not enabled on partner_webhooks';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename IN ('partner_webhooks','partner_webhook_deliveries')) THEN
    RAISE EXCEPTION 'FAIL: a policy exists where the model expects none';
  END IF;
  IF has_table_privilege('anon', 'public.partner_webhooks', 'SELECT')
     OR has_table_privilege('authenticated', 'public.partner_webhook_deliveries', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL: anon or authenticated can read the webhook tables';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.partner_webhooks', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL: service_role cannot write partner_webhooks';
  END IF;
  RAISE NOTICE 'PASS: RLS on, no policies, service_role only';
END
$catalog$;

-- --- The behavioural suite --------------------------------------------------
DO $suite$
DECLARE
  nonce   TEXT := replace(gen_random_uuid()::text, '-', '');
  usr     UUID;
  ws_a    UUID;
  ws_b    UUID;
  acct_a  UUID;
  acct_b  UUID;
  key_a   UUID;
  key_b   UUID;
  wh_1    UUID;
  wh_2    UUID;
  wh_3    UUID;
  del_1   UUID;
  claimed INTEGER;
  status  TEXT;
  next_at TIMESTAMPTZ;
  redriven INTEGER;
  rot_secret TEXT;
  rot_prev TEXT;
  rot_version INTEGER;
  rot_prev_version INTEGER;
BEGIN
  SELECT id INTO usr FROM auth.users LIMIT 1;
  IF usr IS NULL THEN RAISE EXCEPTION 'the harness seeds one auth.users row; none found'; END IF;

  INSERT INTO public.workspaces (name, owner_id, is_personal)
  VALUES ('wh-a-' || nonce, usr, false) RETURNING id INTO ws_a;
  INSERT INTO public.workspaces (name, owner_id, is_personal)
  VALUES ('wh-b-' || nonce, usr, false) RETURNING id INTO ws_b;

  INSERT INTO public.social_accounts (user_id, workspace_id, platform, platform_user_id, access_token, is_active)
  VALUES (usr, ws_a, 'whatsapp', 'phone-a-' || nonce, 'tok', true) RETURNING id INTO acct_a;
  INSERT INTO public.social_accounts (user_id, workspace_id, platform, platform_user_id, access_token, is_active)
  VALUES (usr, ws_b, 'whatsapp', 'phone-b-' || nonce, 'tok', true) RETURNING id INTO acct_b;

  INSERT INTO public.partner_api_keys (workspace_id, social_account_id, key_hash, key_prefix, name, scopes)
  VALUES (ws_a, acct_a, 'hash-a-' || nonce, 'pk_live_aaaa', 'key-a', ARRAY['webhooks:manage'])
  RETURNING id INTO key_a;
  INSERT INTO public.partner_api_keys (workspace_id, social_account_id, key_hash, key_prefix, name, scopes)
  VALUES (ws_b, acct_b, 'hash-b-' || nonce, 'pk_live_bbbb', 'key-b', ARRAY['webhooks:manage'])
  RETURNING id INTO key_b;

  -- ==========================================================================
  -- 1. Tenancy: the composite FKs make a cross-workspace subscription
  --    unrepresentable, not merely discouraged.
  -- ==========================================================================
  BEGIN
    INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret)
    VALUES (ws_a, key_b, 'https://hooks.example.com/x', ARRAY['webhook.test'], 'whsec_x');
    RAISE EXCEPTION 'FAIL: workspace A accepted a subscription attributed to workspace B''s key';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: cross-workspace key attribution refused';
  END;

  BEGIN
    INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret, social_account_id)
    VALUES (ws_a, key_a, 'https://hooks.example.com/x', ARRAY['webhook.test'], 'whsec_x', acct_b);
    RAISE EXCEPTION 'FAIL: a subscription was filtered to another workspace''s account';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: cross-workspace account filter refused';
  END;

  -- ==========================================================================
  -- 2. The closed event allowlist is a CHECK, not only a TypeScript constant.
  -- ==========================================================================
  -- A name that no phase will ever certify. This used to be
  -- 'message.received', which Phase 6 legitimately certified -- so the
  -- assertion started failing for the RIGHT reason and had to be re-anchored
  -- on a value the allowlist can never contain rather than on whichever
  -- event happens to be uncertified this month.
  BEGIN
    INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret)
    VALUES (ws_a, key_a, 'https://hooks.example.com/x', ARRAY['not.a.real.event'], 'whsec_x');
    RAISE EXCEPTION 'FAIL: an uncertified event was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: only certified events may be subscribed to';
  END;

  BEGIN
    INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret)
    VALUES (ws_a, key_a, 'https://hooks.example.com/x', ARRAY[]::TEXT[], 'whsec_x');
    RAISE EXCEPTION 'FAIL: a subscription to nothing was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: a subscription must name at least one event';
  END;

  BEGIN
    INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret)
    VALUES (ws_a, key_a, 'http://hooks.example.com/x', ARRAY['webhook.test'], 'whsec_x');
    RAISE EXCEPTION 'FAIL: a plaintext target was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: the target must be HTTPS';
  END;

  -- The previous-secret trio moves together or not at all: a previous secret
  -- with no expiry never ages out, and an expiry with no secret verifies
  -- nothing.
  INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret)
  VALUES (ws_a, key_a, 'https://hooks.example.com/1', ARRAY['webhook.test'], 'whsec_1')
  RETURNING id INTO wh_1;
  BEGIN
    UPDATE public.partner_webhooks SET previous_secret = 'whsec_old' WHERE id = wh_1;
    RAISE EXCEPTION 'FAIL: a previous secret was accepted with no expiry';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: the previous-secret trio is all-or-nothing';
  END;

  -- ==========================================================================
  -- 3. Cardinality -- the invariant the plan's exit criteria turn on.
  -- ==========================================================================
  INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret)
  VALUES (ws_a, key_a, 'https://hooks.example.com/2', ARRAY['webhook.test'], 'whsec_2')
  RETURNING id INTO wh_2;
  INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret)
  VALUES (ws_a, key_a, 'https://hooks.example.com/3', ARRAY['webhook.test'], 'whsec_3')
  RETURNING id INTO wh_3;

  -- Three subscriptions, ONE occurrence, THREE rows. Deduplication is per
  -- subscription because delivery is.
  INSERT INTO public.partner_webhook_deliveries
    (webhook_id, workspace_id, event_type, event_occurrence_id, payload, secret_version)
  VALUES
    (wh_1, ws_a, 'webhook.test', 'webhook.test:' || nonce, '{}', 1),
    (wh_2, ws_a, 'webhook.test', 'webhook.test:' || nonce, '{}', 1),
    (wh_3, ws_a, 'webhook.test', 'webhook.test:' || nonce, '{}', 1);
  RAISE NOTICE 'PASS: one occurrence fanned out to three subscriptions is three rows';

  -- The same occurrence again on the SAME subscription is refused. This is the
  -- constraint a "delivered at least once" test would pass without.
  BEGIN
    INSERT INTO public.partner_webhook_deliveries
      (webhook_id, workspace_id, event_type, event_occurrence_id, payload, secret_version)
    VALUES (wh_1, ws_a, 'webhook.test', 'webhook.test:' || nonce, '{}', 1);
    RAISE EXCEPTION 'FAIL: the same occurrence was enqueued twice for one subscription';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: one row per (subscription, occurrence)';
  END;

  -- Distinct TRANSITIONS of one resource are distinct occurrences. Keyed on
  -- the resource alone, the second of these would collide with the first --
  -- the outbox discarding exactly the events it exists to guarantee.
  INSERT INTO public.partner_webhook_deliveries
    (webhook_id, workspace_id, event_type, event_occurrence_id, payload, secret_version)
  VALUES
    (wh_1, ws_a, 'webhook.test', 'message.delivered:wamid.' || nonce, '{}', 1),
    (wh_1, ws_a, 'webhook.test', 'message.read:wamid.' || nonce, '{}', 1);
  RAISE NOTICE 'PASS: distinct transitions of one resource are distinct rows';

  -- ==========================================================================
  -- 4. The LEASE. This is why FOR UPDATE SKIP LOCKED alone is not enough:
  --    it does not reserve a row past the commit, so a predicate that only
  --    reads status re-admits a just-claimed row and two cron ticks run it
  --    side by side.
  -- ==========================================================================
  DELETE FROM public.partner_webhook_deliveries WHERE webhook_id IN (wh_2, wh_3);
  DELETE FROM public.partner_webhook_deliveries WHERE webhook_id = wh_1;
  INSERT INTO public.partner_webhook_deliveries
    (webhook_id, workspace_id, event_type, event_occurrence_id, payload, secret_version)
  VALUES (wh_1, ws_a, 'webhook.test', 'lease:' || nonce, '{}', 1)
  RETURNING id INTO del_1;

  SELECT count(*) INTO claimed
    FROM public.claim_partner_webhook_deliveries(10, 90, 6);
  IF claimed <> 1 THEN RAISE EXCEPTION 'FAIL: expected to claim 1 row, claimed %', claimed; END IF;

  SELECT count(*) INTO claimed
    FROM public.claim_partner_webhook_deliveries(10, 90, 6);
  IF claimed <> 0 THEN
    RAISE EXCEPTION 'FAIL: a leased row was claimed again -- the lease is not excluding';
  END IF;
  RAISE NOTICE 'PASS: a live lease excludes a second claim';

  IF (SELECT attempts FROM public.partner_webhook_deliveries WHERE id = del_1) <> 1 THEN
    RAISE EXCEPTION 'FAIL: the claim did not charge an attempt';
  END IF;
  RAISE NOTICE 'PASS: claiming charges exactly one attempt';

  -- A LAPSED lease is reclaimable -- the recovery half of the same property.
  UPDATE public.partner_webhook_deliveries
     SET lease_expires_at = now() - interval '1 minute' WHERE id = del_1;
  SELECT count(*) INTO claimed FROM public.claim_partner_webhook_deliveries(10, 90, 6);
  IF claimed <> 1 THEN
    RAISE EXCEPTION 'FAIL: a lapsed lease was not reclaimed -- a killed worker loses the event';
  END IF;
  RAISE NOTICE 'PASS: a lapsed lease is reclaimed (a killed worker recovers)';

  -- ==========================================================================
  -- 5. Settle: the ladder, exhaustion, and auto-disable ONLY on exhaustion.
  -- ==========================================================================
  status := public.settle_partner_webhook_delivery(del_1, false, 500, 'boom', 300, 6);
  IF status <> 'pending' THEN RAISE EXCEPTION 'FAIL: a mid-ladder failure settled as %', status; END IF;
  SELECT next_attempt_at INTO next_at FROM public.partner_webhook_deliveries WHERE id = del_1;
  IF next_at <= now() THEN RAISE EXCEPTION 'FAIL: the backoff did not push the next attempt out'; END IF;
  IF NOT (SELECT is_active FROM public.partner_webhooks WHERE id = wh_1) THEN
    RAISE EXCEPTION 'FAIL: one failure disabled the endpoint -- a deploy window would take a partner down';
  END IF;
  IF (SELECT consecutive_failures FROM public.partner_webhooks WHERE id = wh_1) <> 1 THEN
    RAISE EXCEPTION 'FAIL: the failure was not counted on the subscription';
  END IF;
  RAISE NOTICE 'PASS: a mid-ladder failure retries and does NOT disable the endpoint';

  -- Now spend the ladder.
  UPDATE public.partner_webhook_deliveries SET attempts = 6 WHERE id = del_1;
  status := public.settle_partner_webhook_delivery(del_1, false, 500, 'boom', 0, 6);
  IF status <> 'exhausted' THEN RAISE EXCEPTION 'FAIL: the ladder did not exhaust, settled as %', status; END IF;
  IF (SELECT is_active FROM public.partner_webhooks WHERE id = wh_1) THEN
    RAISE EXCEPTION 'FAIL: exhaustion did not disable the endpoint';
  END IF;
  IF (SELECT disabled_reason FROM public.partner_webhooks WHERE id = wh_1) IS NULL THEN
    RAISE EXCEPTION 'FAIL: the endpoint was disabled with no reason recorded';
  END IF;
  RAISE NOTICE 'PASS: exhaustion disables the endpoint, visibly';

  -- A disabled endpoint's rows are not retried.
  UPDATE public.partner_webhook_deliveries
     SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE id = del_1;
  SELECT count(*) INTO claimed FROM public.claim_partner_webhook_deliveries(10, 90, 6);
  IF claimed <> 0 THEN RAISE EXCEPTION 'FAIL: a disabled endpoint''s backlog was claimed'; END IF;
  RAISE NOTICE 'PASS: a disabled endpoint is not retried';

  -- ==========================================================================
  -- 6. Redrive: exhausted rows only, and the endpoint comes back with them.
  -- ==========================================================================
  UPDATE public.partner_webhook_deliveries SET status = 'exhausted', attempts = 6 WHERE id = del_1;
  INSERT INTO public.partner_webhook_deliveries
    (webhook_id, workspace_id, event_type, event_occurrence_id, payload, secret_version, status)
  VALUES (wh_1, ws_a, 'webhook.test', 'delivered:' || nonce, '{}', 1, 'delivered');

  SELECT count(*) INTO redriven FROM public.redrive_partner_webhook_deliveries(wh_1, 100);
  IF redriven <> 1 THEN
    RAISE EXCEPTION 'FAIL: redrive touched % rows; a delivered row is not lost and must not be re-sent', redriven;
  END IF;
  IF NOT (SELECT is_active FROM public.partner_webhooks WHERE id = wh_1) THEN
    -- Resetting rows without re-enabling the endpoint returns an encouraging
    -- count and delivers nothing, because the claim requires an active webhook.
    RAISE EXCEPTION 'FAIL: redrive left the endpoint disabled, so it delivers nothing';
  END IF;
  RAISE NOTICE 'PASS: redrive resets exhausted rows only and re-enables the endpoint';

  -- ==========================================================================
  -- 7. The backlog probe reports what it claims to.
  -- ==========================================================================
  UPDATE public.partner_webhook_deliveries
     SET status = 'delivering', lease_expires_at = now() - interval '5 minutes'
   WHERE id = del_1;
  IF (SELECT stuck_lease_count FROM public.partner_webhook_backlog()) < 1 THEN
    RAISE EXCEPTION 'FAIL: a lapsed lease on a delivering row is not reported as stuck';
  END IF;
  RAISE NOTICE 'PASS: the backlog probe sees a stuck lease';

  -- ==========================================================================
  -- 7b. Rotation is ONE statement, and the chain it writes is usable.
  -- ==========================================================================
  UPDATE public.partner_webhook_deliveries SET status = 'delivered' WHERE webhook_id = wh_1;
  PERFORM public.rotate_partner_webhook_secret(wh_1, ws_a, 'whsec_second', 24);
  SELECT secret, secret_version, previous_secret, previous_secret_version
    INTO rot_secret, rot_version, rot_prev, rot_prev_version
    FROM public.partner_webhooks WHERE id = wh_1;
  IF rot_secret <> 'whsec_second' OR rot_version <> 2
     OR rot_prev <> 'whsec_1' OR rot_prev_version <> 1 THEN
    RAISE EXCEPTION 'FAIL: rotation wrote %/% with previous %/%',
      rot_secret, rot_version, rot_prev, rot_prev_version;
  END IF;
  IF (SELECT previous_secret_expires_at FROM public.partner_webhooks WHERE id = wh_1) <= now() THEN
    RAISE EXCEPTION 'FAIL: the overlap window is already over';
  END IF;
  RAISE NOTICE 'PASS: rotation supersedes the old secret atomically';

  -- Another workspace cannot rotate it. Zero rows, not an exception: the
  -- caller answers resource_not_found, the same as for an id that never was.
  IF EXISTS (SELECT 1 FROM public.rotate_partner_webhook_secret(wh_1, ws_b, 'whsec_evil', 24)) THEN
    RAISE EXCEPTION 'FAIL: another workspace rotated this subscription''s secret';
  END IF;
  IF (SELECT secret FROM public.partner_webhooks WHERE id = wh_1) <> 'whsec_second' THEN
    RAISE EXCEPTION 'FAIL: a cross-workspace rotation changed the secret anyway';
  END IF;
  RAISE NOTICE 'PASS: rotation is workspace-scoped inside the lock';

  -- ==========================================================================
  -- 7c. Nothing may strand in 'delivering'.
  -- ==========================================================================
  --
  -- A worker that dies between the claim and the settle on the FINAL allowed
  -- attempt leaves a row the claim cannot see (attempts is at the ceiling),
  -- settle never reached, and redrive ignores (it takes exhausted rows only).
  UPDATE public.partner_webhooks SET is_active = TRUE, disabled_at = NULL,
         disabled_reason = NULL WHERE id = wh_1;
  DELETE FROM public.partner_webhook_deliveries WHERE webhook_id = wh_1;
  INSERT INTO public.partner_webhook_deliveries
    (webhook_id, workspace_id, event_type, event_occurrence_id, payload, secret_version,
     status, attempts, lease_expires_at)
  VALUES (wh_1, ws_a, 'webhook.test', 'stranded:' || nonce, '{}', 1,
          'delivering', 6, now() - interval '5 minutes')
  RETURNING id INTO del_1;

  SELECT count(*) INTO claimed FROM public.claim_partner_webhook_deliveries(10, 90, 6);
  IF claimed <> 0 THEN
    RAISE EXCEPTION 'FAIL: premise broken -- the claim CAN see a row at the attempt ceiling';
  END IF;

  SELECT count(*) INTO claimed FROM public.reap_stuck_partner_webhook_deliveries(6);
  IF claimed <> 1 THEN
    RAISE EXCEPTION 'FAIL: the stranded row was not reaped';
  END IF;
  IF (SELECT d.status FROM public.partner_webhook_deliveries d WHERE d.id = del_1) <> 'exhausted' THEN
    RAISE EXCEPTION 'FAIL: the reaped row is not in a terminal state';
  END IF;
  IF (SELECT is_active FROM public.partner_webhooks WHERE id = wh_1) THEN
    RAISE EXCEPTION 'FAIL: reaping did not disable the endpoint, so it fails this way for ever';
  END IF;
  RAISE NOTICE 'PASS: a stranded delivery is reaped into exhausted and disables its endpoint';

  -- The control. Without it, a reaper that marked EVERYTHING exhausted would
  -- pass every assertion above.
  UPDATE public.partner_webhooks SET is_active = TRUE WHERE id = wh_1;
  UPDATE public.partner_webhook_deliveries
     SET status = 'delivering', attempts = 2, lease_expires_at = now() + interval '1 minute'
   WHERE id = del_1;
  SELECT count(*) INTO claimed FROM public.reap_stuck_partner_webhook_deliveries(6);
  IF claimed <> 0 THEN
    RAISE EXCEPTION 'FAIL: the reaper took a row with a LIVE lease below the ceiling';
  END IF;
  RAISE NOTICE 'PASS: the reaper leaves live work alone';

  -- ==========================================================================
  -- 8. Deleting a subscription takes its undelivered backlog with it.
  -- ==========================================================================
  DELETE FROM public.partner_webhooks WHERE id = wh_1;
  IF EXISTS (SELECT 1 FROM public.partner_webhook_deliveries WHERE webhook_id = wh_1) THEN
    RAISE EXCEPTION 'FAIL: deliveries outlived their subscription -- an outbox nothing drains';
  END IF;
  RAISE NOTICE 'PASS: deleting a subscription cascades its deliveries';

  -- --- cleanup ------------------------------------------------------------
  DELETE FROM public.partner_webhooks WHERE workspace_id IN (ws_a, ws_b);
  DELETE FROM public.partner_api_keys WHERE id IN (key_a, key_b);
  DELETE FROM public.social_accounts WHERE id IN (acct_a, acct_b);
  DELETE FROM public.workspaces WHERE id IN (ws_a, ws_b);
END
$suite$;

\echo '=== partner_webhook_outbox: ALL CHECKS PASSED ==='
