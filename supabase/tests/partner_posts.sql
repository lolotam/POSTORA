-- ============================================================================
-- partner_posts.sql
--
-- Database proof for Phase 8 Partner API Posts & Scheduling
-- (20260902150000_partner_api_posts.sql). Everything asserted here is a
-- property enforced by POSTGRES, not by edge code:
--
--   * CATALOG: partner_webhooks_events_certified names 'post.scheduled' (P1)
--     and does NOT name 'post.published' or 'post.failed' (P2 control).
--   * THE TRIGGER: covers all three attribution paths:
--       - G1: /v1 atomic create via partner_create_post(..., p_scheduled_at)
--       - G2: UI direct insert + UPDATE posts SET scheduled_at = ...
--             (covers all browser writers without frontend changes)
--       - G3: Unattributable (no binding, no accounts): commits and emits 0
--       - G4: Ambiguous (targets in 2 workspaces): commits and emits 0
--   * OCCURRENCE IDENTITY:
--       - O1: Rescheduling to a NEW time produces a SECOND delivery row
--       - O2: Writing the SAME scheduled_at produces NO new row (strict count)
--       - O3: Occurrence id is timezone-STABLE (always UTC formatted)
--   * TENANCY:
--       - N1: Workspace B subscription never receives Workspace A events
--   * THE CRON CONTRACT:
--       - X1: Row matches process-scheduled-posts pickup predicate verbatim:
--             status IN ('pending','scheduled') AND scheduled_at IS NOT NULL
--             AND scheduled_at <= now()
--   * CRASH TEST:
--       - K1: Both directions: rolled-back schedule write leaves no delivery;
--             committed write carries its deliveries.
--
-- Self-cleaning and RE-RUNNABLE via a per-run nonce.
-- ============================================================================

\set ON_ERROR_STOP on

-- ============================================================================
-- CATALOG ASSERTIONS (P1, P2)
-- ============================================================================
DO $catalog$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint WHERE conname = 'partner_webhooks_events_certified';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'FAIL: partner_webhooks_events_certified constraint is missing';
  END IF;

  -- P1: names post.scheduled
  IF v_def !~ 'post\.scheduled' THEN
    RAISE EXCEPTION 'FAIL: partner_webhooks_events_certified is missing post.scheduled: %', v_def;
  END IF;

  -- P2: does NOT name post.published or post.failed (uncertified until Phase 7 observation gate)
  IF v_def ~ 'post\.published' OR v_def ~ 'post\.failed' THEN
    RAISE EXCEPTION 'FAIL: post.published/post.failed were advertised before their observation gate: %', v_def;
  END IF;

  RAISE NOTICE 'PASS: catalog assertions P1 & P2 hold (post.scheduled certified; post.published/failed uncertified)';
END
$catalog$;

-- ============================================================================
-- THE BEHAVIOURAL SUITE
-- ============================================================================
DO $suite$
DECLARE
  nonce              TEXT := replace(gen_random_uuid()::text, '-', '');
  usr                UUID;
  admin_role_created BOOLEAN := false;
  ws_a               UUID;
  ws_b               UUID;
  acct_a1            UUID;
  acct_a2            UUID;
  acct_b             UUID;
  key_a              UUID;
  key_b              UUID;
  wh_a1              UUID;  -- ws_a, subscribed to post.scheduled, secret_version 1
  wh_a2              UUID;  -- ws_a, subscribed to post.scheduled, secret_version 2
  wh_b               UUID;  -- ws_b, subscribed to post.scheduled (tenancy probe)
  wh_off             UUID;  -- ws_a, subscribed to post.scheduled, is_active false
  post_g1            UUID;
  post_g2            UUID;
  post_g3            UUID;
  post_g4            UUID;
  post_x1            UUID;
  res_json           JSONB;
  count_before       INTEGER;
  count_after        INTEGER;
  n                  INTEGER;
  rows               INTEGER;
  t_sched            TIMESTAMPTZ;
  v_when_text        TEXT;
  v_occ_expected     TEXT;
BEGIN
  -- -------------------------------------------------------------------------
  -- Setup: seed user, workspaces, accounts, keys, and webhook subscriptions
  -- -------------------------------------------------------------------------
  SELECT id INTO usr FROM auth.users LIMIT 1;
  IF usr IS NULL THEN
    RAISE EXCEPTION 'the harness seeds one auth.users row; none found';
  END IF;

  -- Ensure usr has admin role so the post quota trigger does not block test seeding
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = usr AND role = 'admin'::public.app_role
  ) THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (usr, 'admin'::public.app_role);
    admin_role_created := true;
  END IF;

  INSERT INTO public.workspaces (name, owner_id, is_personal)
  VALUES ('posts-ws-a-' || nonce, usr, false) RETURNING id INTO ws_a;

  INSERT INTO public.workspaces (name, owner_id, is_personal)
  VALUES ('posts-ws-b-' || nonce, usr, false) RETURNING id INTO ws_b;

  INSERT INTO public.social_accounts (user_id, workspace_id, platform, platform_user_id, access_token, is_active)
  VALUES (usr, ws_a, 'facebook', 'fb-a1-' || nonce, 'tok', true) RETURNING id INTO acct_a1;

  INSERT INTO public.social_accounts (user_id, workspace_id, platform, platform_user_id, access_token, is_active)
  VALUES (usr, ws_a, 'instagram', 'ig-a2-' || nonce, 'tok', true) RETURNING id INTO acct_a2;

  INSERT INTO public.social_accounts (user_id, workspace_id, platform, platform_user_id, access_token, is_active)
  VALUES (usr, ws_b, 'facebook', 'fb-b-' || nonce, 'tok', true) RETURNING id INTO acct_b;

  INSERT INTO public.partner_api_keys (workspace_id, social_account_id, key_hash, key_prefix, name, scopes)
  VALUES (ws_a, acct_a1, 'hash-a-' || nonce, 'pk_live_aaaa', 'key-a',
          ARRAY['posts:write', 'posts:read', 'posts:schedule', 'webhooks:manage'])
  RETURNING id INTO key_a;

  INSERT INTO public.partner_api_keys (workspace_id, social_account_id, key_hash, key_prefix, name, scopes)
  VALUES (ws_b, acct_b, 'hash-b-' || nonce, 'pk_live_bbbb', 'key-b',
          ARRAY['posts:write', 'posts:read', 'posts:schedule', 'webhooks:manage'])
  RETURNING id INTO key_b;

  INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret, secret_version)
  VALUES (ws_a, key_a, 'https://hooks.example.com/posts-1', ARRAY['post.scheduled'], 'whsec_a1', 1)
  RETURNING id INTO wh_a1;

  INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret, secret_version)
  VALUES (ws_a, key_a, 'https://hooks.example.com/posts-2', ARRAY['post.scheduled'], 'whsec_a2', 2)
  RETURNING id INTO wh_a2;

  INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret)
  VALUES (ws_b, key_b, 'https://hooks.example.com/posts-b', ARRAY['post.scheduled'], 'whsec_b')
  RETURNING id INTO wh_b;

  INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret, is_active, disabled_reason)
  VALUES (ws_a, key_a, 'https://hooks.example.com/posts-off', ARRAY['post.scheduled'], 'whsec_off', false, 'disabled')
  RETURNING id INTO wh_off;

  -- ==========================================================================
  -- G1: /v1 atomic create via partner_create_post(..., p_scheduled_at)
  -- ==========================================================================
  t_sched := now() + interval '1 hour';
  res_json := public.partner_create_post(
    p_workspace_id => ws_a,
    p_key_id => key_a,
    p_user_id => usr,
    p_caption => 'g1 scheduled post ' || nonce,
    p_platforms => ARRAY['facebook', 'instagram'],
    p_media_file_ids => ARRAY[]::uuid[],
    p_selected_account_ids => ARRAY[acct_a1, acct_a2],
    p_scheduled_at => t_sched
  );
  post_g1 := (res_json->>'id')::uuid;
  IF post_g1 IS NULL THEN
    RAISE EXCEPTION 'FAIL G1: partner_create_post returned null id';
  END IF;

  -- Assert posts row exists with scheduled status and matching scheduled_at
  IF NOT EXISTS (
    SELECT 1 FROM public.posts
     WHERE id = post_g1 AND status = 'scheduled' AND scheduled_at = t_sched
  ) THEN
    RAISE EXCEPTION 'FAIL G1: posts row was not created with status=scheduled and scheduled_at';
  END IF;

  -- Assert partner_api_posts binding row exists
  IF NOT EXISTS (
    SELECT 1 FROM public.partner_api_posts
     WHERE post_id = post_g1 AND workspace_id = ws_a AND key_id = key_a
  ) THEN
    RAISE EXCEPTION 'FAIL G1: partner_api_posts binding row was not created';
  END IF;

  -- Assert one delivery row per matching active subscription in ws_a (wh_a1 and wh_a2 -> exactly 2)
  SELECT count(*) INTO rows FROM public.partner_webhook_deliveries
   WHERE event_type = 'post.scheduled' AND payload->>'post_id' = 'post_' || post_g1;
  IF rows <> 2 THEN
    RAISE EXCEPTION 'FAIL G1: expected 2 delivery rows for ws_a, got %', rows;
  END IF;

  -- Assert zero delivery rows in ws_b (tenancy) and zero for disabled webhook
  IF EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries
     WHERE workspace_id = ws_b AND payload->>'post_id' = 'post_' || post_g1
  ) THEN
    RAISE EXCEPTION 'FAIL G1: workspace B received a delivery for workspace A post';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries WHERE webhook_id = wh_off
  ) THEN
    RAISE EXCEPTION 'FAIL G1: disabled webhook received a delivery';
  END IF;
  RAISE NOTICE 'PASS G1: /v1 atomic create inserts post, binding row, and enqueues to active subscriptions';

  -- ==========================================================================
  -- G2: UI shape: direct insert with selected_account_ids, then update scheduled_at
  -- ==========================================================================
  t_sched := now() + interval '2 hours';
  INSERT INTO public.posts (
    user_id, caption, platforms, status, metadata, source
  ) VALUES (
    usr,
    'g2 ui post ' || nonce,
    ARRAY['facebook'],
    'pending',
    jsonb_build_object('selected_account_ids', jsonb_build_array(acct_a1::text)),
    'ui'
  ) RETURNING id INTO post_g2;

  -- Verify no partner_api_posts row exists for UI post
  IF EXISTS (SELECT 1 FROM public.partner_api_posts WHERE post_id = post_g2) THEN
    RAISE EXCEPTION 'FAIL G2: partner_api_posts row must not exist for UI-created post';
  END IF;

  -- Perform the schedule update that browser code executes
  UPDATE public.posts SET scheduled_at = t_sched, status = 'scheduled' WHERE id = post_g2;

  -- Assert deliveries were produced for ws_a (attributed through selected_account_ids)
  SELECT count(*) INTO rows FROM public.partner_webhook_deliveries
   WHERE workspace_id = ws_a AND payload->>'post_id' = 'post_' || post_g2;
  IF rows <> 2 THEN
    RAISE EXCEPTION 'FAIL G2: expected 2 delivery rows for UI-scheduled post, got %', rows;
  END IF;
  RAISE NOTICE 'PASS G2: UI-shaped post update is attributed via selected_account_ids and enqueues event';

  -- ==========================================================================
  -- G3: Unattributable post (no binding row, no selected_account_ids)
  -- ==========================================================================
  INSERT INTO public.posts (
    user_id, caption, platforms, status, metadata, source
  ) VALUES (
    usr,
    'g3 unattributable post ' || nonce,
    ARRAY['facebook'],
    'pending',
    '{}'::jsonb,
    'ui'
  ) RETURNING id INTO post_g3;

  SELECT count(*) INTO count_before FROM public.partner_webhook_deliveries
   WHERE workspace_id IN (ws_a, ws_b);

  UPDATE public.posts SET scheduled_at = now() + interval '3 hours', status = 'scheduled'
   WHERE id = post_g3;

  -- The update MUST commit
  IF (SELECT scheduled_at FROM public.posts WHERE id = post_g3) IS NULL THEN
    RAISE EXCEPTION 'FAIL G3: update failed to persist scheduled_at on unattributable post';
  END IF;

  -- And MUST emit zero delivery rows
  SELECT count(*) INTO count_after FROM public.partner_webhook_deliveries
   WHERE workspace_id IN (ws_a, ws_b);
  IF count_after <> count_before THEN
    RAISE EXCEPTION 'FAIL G3: unattributable post emitted % delivery row(s), expected 0',
      count_after - count_before;
  END IF;
  RAISE NOTICE 'PASS G3: unattributable post commits scheduled_at and produces zero delivery rows';

  -- ==========================================================================
  -- G4: Ambiguous post (selected_account_ids spans TWO workspaces)
  -- ==========================================================================
  INSERT INTO public.posts (
    user_id, caption, platforms, status, metadata, source
  ) VALUES (
    usr,
    'g4 ambiguous post ' || nonce,
    ARRAY['facebook'],
    'pending',
    jsonb_build_object('selected_account_ids', jsonb_build_array(acct_a1::text, acct_b::text)),
    'ui'
  ) RETURNING id INTO post_g4;

  SELECT count(*) INTO count_before FROM public.partner_webhook_deliveries
   WHERE workspace_id IN (ws_a, ws_b);

  UPDATE public.posts SET scheduled_at = now() + interval '4 hours', status = 'scheduled'
   WHERE id = post_g4;

  -- The update MUST commit
  IF (SELECT scheduled_at FROM public.posts WHERE id = post_g4) IS NULL THEN
    RAISE EXCEPTION 'FAIL G4: update failed to persist scheduled_at on ambiguous post';
  END IF;

  -- And MUST emit zero delivery rows (disagreement between workspaces = silent drop)
  SELECT count(*) INTO count_after FROM public.partner_webhook_deliveries
   WHERE workspace_id IN (ws_a, ws_b);
  IF count_after <> count_before THEN
    RAISE EXCEPTION 'FAIL G4: ambiguous targets emitted % delivery row(s), expected 0',
      count_after - count_before;
  END IF;
  RAISE NOTICE 'PASS G4: ambiguous targets in multiple workspaces commit and produce zero delivery rows';

  -- ==========================================================================
  -- OCCURRENCE IDENTITY (O1, O2, O3)
  -- ==========================================================================
  -- O1: Rescheduling to a NEW time produces a SECOND delivery row (a new occurrence)
  SELECT count(*) INTO count_before FROM public.partner_webhook_deliveries
   WHERE webhook_id = wh_a1 AND payload->>'post_id' = 'post_' || post_g1;

  UPDATE public.posts SET scheduled_at = now() + interval '5 hours' WHERE id = post_g1;

  SELECT count(*) INTO count_after FROM public.partner_webhook_deliveries
   WHERE webhook_id = wh_a1 AND payload->>'post_id' = 'post_' || post_g1;
  IF count_after <> count_before + 1 THEN
    RAISE EXCEPTION 'FAIL O1: rescheduling to new time did not produce a second delivery row (expected %, got %)',
      count_before + 1, count_after;
  END IF;

  SELECT count(DISTINCT event_occurrence_id) INTO n FROM public.partner_webhook_deliveries
   WHERE webhook_id = wh_a1 AND payload->>'post_id' = 'post_' || post_g1;
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL O1: expected 2 distinct event_occurrence_ids for post_g1, got %', n;
  END IF;
  RAISE NOTICE 'PASS O1: rescheduling to a new time produces a second distinct occurrence';

  -- O2: Writing the SAME scheduled_at again produces NO new row (strict count check)
  SELECT count(*) INTO count_before FROM public.partner_webhook_deliveries
   WHERE webhook_id = wh_a1;

  UPDATE public.posts SET scheduled_at = scheduled_at WHERE id = post_g1;
  UPDATE public.posts SET caption = 'rewritten caption ' || nonce WHERE id = post_g1;

  SELECT count(*) INTO count_after FROM public.partner_webhook_deliveries
   WHERE webhook_id = wh_a1;
  IF count_after <> count_before THEN
    RAISE EXCEPTION 'FAIL O2: writing same scheduled_at emitted % extra rows', count_after - count_before;
  END IF;
  RAISE NOTICE 'PASS O2: writing the same scheduled_at or other columns emits no new rows';

  -- O3: The occurrence id is timezone-STABLE (rendered strictly in UTC)
  DECLARE
    v_cur_sched TIMESTAMPTZ;
    v_latest_occ TEXT;
  BEGIN
    SET LOCAL timezone = 'Asia/Kuwait';

    -- The trigger must RENDER under the non-UTC session for this to prove
    -- anything: a mutant that drops `AT TIME ZONE 'UTC'` renders identically
    -- when the session is already UTC, and the first version of this test --
    -- which only rewrote the same instant, emitting nothing -- let exactly
    -- that mutant survive. So reschedule to a NEW time here, under Kuwait.
    UPDATE public.posts SET scheduled_at = scheduled_at + interval '7 hours' WHERE id = post_g1;
    SELECT scheduled_at INTO v_cur_sched FROM public.posts WHERE id = post_g1;

    -- Look the row up BY its expected id rather than picking "the latest":
    -- every delivery row written in this transaction shares one now(), so
    -- ORDER BY created_at cannot tell one occurrence from another.
    v_when_text := to_char(v_cur_sched AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
    v_occ_expected := 'post.scheduled:' || post_g1 || ':' || v_when_text;
    SELECT event_occurrence_id INTO v_latest_occ FROM public.partner_webhook_deliveries
     WHERE webhook_id = wh_a1 AND event_occurrence_id = v_occ_expected;
    IF v_latest_occ IS NULL THEN
      RAISE EXCEPTION 'FAIL O3: no delivery row carries the UTC-rendered occurrence id % (rows for this post: %)',
        v_occ_expected,
        (SELECT string_agg(event_occurrence_id, ', ') FROM public.partner_webhook_deliveries
          WHERE webhook_id = wh_a1 AND payload->>'post_id' = 'post_' || post_g1);
    END IF;

    SELECT count(*) INTO count_before FROM public.partner_webhook_deliveries WHERE webhook_id = wh_a1;
    UPDATE public.posts SET scheduled_at = v_cur_sched WHERE id = post_g1;
    SELECT count(*) INTO count_after FROM public.partner_webhook_deliveries WHERE webhook_id = wh_a1;
    IF count_after <> count_before THEN
      RAISE EXCEPTION 'FAIL O3: rewriting same instant under different timezone created duplicate delivery';
    END IF;

    RESET timezone;
    RAISE NOTICE 'PASS O3: occurrence id is timezone-stable and formatted strictly in UTC';
  END;

  -- ==========================================================================
  -- TENANCY (N1)
  -- ==========================================================================
  IF EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries
     WHERE workspace_id = ws_b
       AND (
         payload->>'post_id' = 'post_' || post_g1
         OR payload->>'post_id' = 'post_' || post_g2
       )
  ) THEN
    RAISE EXCEPTION 'FAIL N1: workspace B received workspace A post.scheduled event';
  END IF;
  RAISE NOTICE 'PASS N1: workspace B subscription never receives workspace A post.scheduled event';

  -- ==========================================================================
  -- THE CRON CONTRACT (X1)
  -- ==========================================================================
  res_json := public.partner_create_post(
    p_workspace_id => ws_a,
    p_key_id => key_a,
    p_user_id => usr,
    p_caption => 'x1 cron pickup post ' || nonce,
    p_platforms => ARRAY['facebook'],
    p_media_file_ids => ARRAY[]::uuid[],
    p_selected_account_ids => ARRAY[acct_a1],
    p_scheduled_at => now() - interval '1 minute'
  );
  post_x1 := (res_json->>'id')::uuid;

  IF NOT EXISTS (
    SELECT 1 FROM public.posts
     WHERE id = post_x1
       AND status IN ('pending','scheduled')
       AND scheduled_at IS NOT NULL
       AND scheduled_at <= now()
  ) THEN
    RAISE EXCEPTION 'FAIL X1: created post does not match process-scheduled-posts pickup predicate verbatim';
  END IF;
  RAISE NOTICE 'PASS X1: post created via partner_create_post matches the cron pickup predicate verbatim';

  -- ==========================================================================
  -- CRASH TEST (K1)
  -- ==========================================================================
  -- Direction B: a rolled-back schedule write leaves NO delivery row
  DECLARE
    post_rb UUID;
  BEGIN
    res_json := public.partner_create_post(
      p_workspace_id => ws_a,
      p_key_id => key_a,
      p_user_id => usr,
      p_caption => 'k1 rollback post ' || nonce,
      p_platforms => ARRAY['facebook'],
      p_media_file_ids => ARRAY[]::uuid[],
      p_selected_account_ids => ARRAY[acct_a1],
      p_scheduled_at => now() + interval '10 hours'
    );
    post_rb := (res_json->>'id')::uuid;
    IF post_rb IS NULL THEN
      RAISE EXCEPTION 'FAIL K1: partner_create_post returned null id in subtransaction';
    END IF;
    RAISE EXCEPTION 'k1 forced rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'k1 forced rollback' THEN
      RAISE EXCEPTION 'FAIL K1: unexpected error during rollback test: %', SQLERRM;
    END IF;
  END;

  IF EXISTS (
    SELECT 1 FROM public.posts WHERE caption = 'k1 rollback post ' || nonce
  ) THEN
    RAISE EXCEPTION 'FAIL K1: rolled-back post row survived in posts table';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries
     WHERE payload->>'post_id' IN (
       SELECT 'post_' || id::text FROM public.posts WHERE caption = 'k1 rollback post ' || nonce
     )
  ) THEN
    RAISE EXCEPTION 'FAIL K1: rolled-back delivery row survived';
  END IF;
  RAISE NOTICE 'PASS K1 direction B: a rolled-back schedule write leaves neither post nor delivery row';

  -- Direction A: committed schedule write carries its delivery row
  IF NOT EXISTS (
    SELECT 1 FROM public.posts p
      JOIN public.partner_webhook_deliveries d
        ON d.payload->>'post_id' = 'post_' || p.id::text
     WHERE p.id = post_g1 AND p.status = 'scheduled'
  ) THEN
    RAISE EXCEPTION 'FAIL K1 direction A: committed scheduled post has no matching delivery row';
  END IF;
  RAISE NOTICE 'PASS K1 direction A: committed scheduled post carries its delivery rows';

  -- -------------------------------------------------------------------------
  -- Cleanup
  -- -------------------------------------------------------------------------
  DELETE FROM public.partner_webhooks WHERE workspace_id IN (ws_a, ws_b);  -- cascades deliveries
  DELETE FROM public.partner_api_posts WHERE workspace_id IN (ws_a, ws_b);
  DELETE FROM public.posts WHERE user_id = usr AND caption LIKE '%' || nonce;
  DELETE FROM public.partner_api_keys WHERE id IN (key_a, key_b);
  DELETE FROM public.social_accounts WHERE id IN (acct_a1, acct_a2, acct_b);
  DELETE FROM public.workspaces WHERE id IN (ws_a, ws_b);
  IF admin_role_created THEN
    DELETE FROM public.user_roles WHERE user_id = usr AND role = 'admin'::public.app_role;
  END IF;
END
$suite$;

\echo '=== partner_posts: ALL CHECKS PASSED ==='
