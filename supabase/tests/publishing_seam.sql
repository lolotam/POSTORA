-- ============================================================================
-- publishing_seam.sql
--
-- Database proof for partner_settle_platform_post (20260902140000, Phase 7.4).
--
-- The properties here cannot be established in TypeScript, because each one is
-- enforced by Postgres:
--
--   * BOTH shapes 7.0 found -- settle an existing row, and insert one already
--     terminal. An operation that only did the first would silently miss three
--     of the five writers.
--   * the parent roll-up across targets
--   * per-TARGET occurrence ids, so two platforms of one post are two events
--     rather than a collision
--   * ATOMICITY IN BOTH DIRECTIONS -- Phase 7's crash-test exit criterion. A
--     committed status carries its delivery row; a rolled-back one leaves
--     nothing behind.
--   * an unattributable row (no account) emits nothing rather than guessing a
--     workspace
--
-- THE CHECK IS WIDENED INSIDE THIS TRANSACTION ONLY. post.published is a
-- Phase 8 event and is deliberately NOT certified yet, so no subscription can
-- exist to receive one -- which would make the crash criterion untestable. The
-- suite relaxes the constraint, proves the property, and restores it, and a
-- separate block at the end asserts the restoration. The published surface is
-- never widened; only the proof is.
--
-- Self-cleaning and re-runnable via a per-run nonce.
-- ============================================================================
\set ON_ERROR_STOP on

DO $suite$
DECLARE
  nonce    TEXT := replace(gen_random_uuid()::text, '-', '');
  usr      UUID;
  ws       UUID;
  acct_a   UUID;
  acct_b   UUID;
  key_id   UUID;
  wh       UUID;
  -- NOT named post_id: PL/pgSQL cannot tell a variable from the column of the
  -- same name, and `WHERE post_id = post_id` is an ambiguity error at best and
  -- a whole-table match at worst.
  the_post UUID;
  pp_a     UUID;
  pp_b     UUID;
  pp_c     UUID;
  res      JSONB;
  n        INTEGER;
  before_n INTEGER;
  old_def  TEXT;
  old_name TEXT;
BEGIN
  SELECT id INTO usr FROM auth.users LIMIT 1;
  IF usr IS NULL THEN RAISE EXCEPTION 'the harness seeds one auth.users row; none found'; END IF;

  INSERT INTO public.workspaces (name, owner_id, is_personal)
  VALUES ('seam-' || nonce, usr, false) RETURNING id INTO ws;

  INSERT INTO public.social_accounts (user_id, workspace_id, platform, platform_user_id, access_token, is_active)
  VALUES (usr, ws, 'facebook', 'fb-' || nonce, 'tok', true) RETURNING id INTO acct_a;
  INSERT INTO public.social_accounts (user_id, workspace_id, platform, platform_user_id, access_token, is_active)
  VALUES (usr, ws, 'instagram', 'ig-' || nonce, 'tok', true) RETURNING id INTO acct_b;

  INSERT INTO public.partner_api_keys (workspace_id, social_account_id, key_hash, key_prefix, name, scopes)
  VALUES (ws, acct_a, 'hash-' || nonce, 'pk_live_seam', 'seam', ARRAY['webhooks:manage'])
  RETURNING id INTO key_id;

  -- Widen the allowlist for the duration of this transaction only.
  SELECT conname, pg_get_constraintdef(oid) INTO old_name, old_def
    FROM pg_constraint
   WHERE conrelid = 'public.partner_webhooks'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%events%'
   LIMIT 1;
  IF old_def IS NULL THEN
    RAISE EXCEPTION 'FAIL: no CHECK constrains partner_webhooks.events -- the allowlist is not enforced';
  END IF;
  EXECUTE 'ALTER TABLE public.partner_webhooks DROP CONSTRAINT ' || quote_ident(old_name);
  ALTER TABLE public.partner_webhooks
    ADD CONSTRAINT partner_webhooks_events_check_seamtest
    CHECK (cardinality(events) > 0);

  INSERT INTO public.partner_webhooks (workspace_id, created_by_key_id, url, events, secret)
  VALUES (ws, key_id, 'https://hooks.example.com/seam', ARRAY['post.published','post.failed'], 'whsec_seam')
  RETURNING id INTO wh;

  INSERT INTO public.posts (user_id, caption, platforms, status)
  VALUES (usr, 'seam ' || nonce, ARRAY['facebook','instagram'], 'processing')
  RETURNING id INTO the_post;

  -- Both targets exist as pending rows before either settles. That is what
  -- makes the roll-up assertions below mean something -- see the note on the
  -- as-you-go limitation at the end of section 3.
  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status)
  VALUES (the_post, acct_a, 'facebook', 'pending') RETURNING id INTO pp_a;
  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status)
  VALUES (the_post, acct_b, 'instagram', 'pending') RETURNING id INTO pp_b;

  -- ==========================================================================
  -- 1. Shape 1 -- settle an EXISTING row.
  -- ==========================================================================
  res := public.partner_settle_platform_post(
    pp_a, NULL, NULL, NULL, 'success', 'fbpost-' || nonce, 'https://fb.example/1', NULL, NULL
  );
  IF (res->>'settled')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: settling an existing row reported %', res;
  END IF;
  IF (res->>'enqueued')::int <> 1 THEN
    RAISE EXCEPTION 'FAIL: expected 1 delivery row for the settle, got %', res->>'enqueued';
  END IF;
  IF (SELECT p.status FROM public.platform_posts p WHERE p.id = pp_a) <> 'success' THEN
    RAISE EXCEPTION 'FAIL: the row did not reach success';
  END IF;
  RAISE NOTICE 'PASS: shape 1 -- an existing row settles and emits';

  -- The parent is NOT completed: instagram is still pending.
  IF (SELECT p.status FROM public.posts p WHERE p.id = the_post) <> 'processing' THEN
    RAISE EXCEPTION 'FAIL: the post completed while a target was still pending';
  END IF;
  RAISE NOTICE 'PASS: a partially settled post stays processing';

  -- Re-settling is a no-op, and says so.
  res := public.partner_settle_platform_post(
    pp_a, NULL, NULL, NULL, 'failed', NULL, NULL, 'should not apply', NULL
  );
  IF (res->>'settled')::boolean IS NOT FALSE OR (res->>'enqueued')::int <> 0 THEN
    RAISE EXCEPTION 'FAIL: a terminal row was re-settled: %', res;
  END IF;
  IF (SELECT p.status FROM public.platform_posts p WHERE p.id = pp_a) <> 'success' THEN
    RAISE EXCEPTION 'FAIL: re-settling overwrote a terminal status';
  END IF;
  RAISE NOTICE 'PASS: a terminal row is not re-settled and not re-emitted';

  -- ==========================================================================
  -- 2. The roll-up, once every target has reported.
  -- ==========================================================================
  res := public.partner_settle_platform_post(
    pp_b, NULL, NULL, NULL, 'failed', NULL, NULL, 'rate limited', NULL
  );
  IF (res->>'enqueued')::int <> 1 THEN
    RAISE EXCEPTION 'FAIL: the failing target did not emit: %', res;
  END IF;
  -- `completed`, not `failed`: a two-target post where one platform worked is
  -- not a failed post, and the per-target truth lives in platform_posts where
  -- D11 says it belongs.
  IF (SELECT p.status FROM public.posts p WHERE p.id = the_post) <> 'completed' THEN
    RAISE EXCEPTION 'FAIL: one success among the targets did not complete the post, got %',
      (SELECT p.status FROM public.posts p WHERE p.id = the_post);
  END IF;
  RAISE NOTICE 'PASS: one success among the targets completes the post';

  -- ==========================================================================
  -- 3. Shape 2 -- the row is BORN terminal (three of the five writers).
  -- ==========================================================================
  res := public.partner_settle_platform_post(
    NULL, the_post, acct_a, 'facebook', 'failed', NULL, NULL, 'second attempt failed', NULL
  );
  pp_c := (res->>'platform_post_id')::uuid;
  IF pp_c IS NULL OR (res->>'enqueued')::int <> 1 THEN
    RAISE EXCEPTION 'FAIL: an insert-shaped settle did not create and emit: %', res;
  END IF;
  IF (SELECT p.status FROM public.platform_posts p WHERE p.id = pp_c) <> 'failed' THEN
    RAISE EXCEPTION 'FAIL: the born-terminal row is not failed';
  END IF;
  RAISE NOTICE 'PASS: shape 2 -- a row born terminal settles and emits';

  -- NOTE, deliberately not asserted as desirable: the roll-up counts the rows
  -- that EXIST, so a publish that creates its rows as each platform finishes
  -- can complete the parent before later platforms have rows at all. That is
  -- exactly what process-post does today (index.ts:980 reads the same set and
  -- draws the same conclusion), and Phase 7 is an architectural boundary, not
  -- a behavioural fix -- reproducing it is the correct move here. Phase 8
  -- publishes per-target status, which is the honest answer for partners.

  -- ==========================================================================
  -- 4. Per-TARGET occurrence ids. Keyed on the post, the second target would
  --    collide with the first and be silently dropped.
  -- ==========================================================================
  SELECT count(DISTINCT event_occurrence_id) INTO n
    FROM public.partner_webhook_deliveries WHERE webhook_id = wh;
  IF n <> 3 THEN
    RAISE EXCEPTION 'FAIL: three targets produced % distinct occurrences, expected 3', n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries
     WHERE webhook_id = wh AND event_occurrence_id = 'post.published:' || pp_a::text
  ) OR NOT EXISTS (
    SELECT 1 FROM public.partner_webhook_deliveries
     WHERE webhook_id = wh AND event_occurrence_id = 'post.failed:' || pp_b::text
  ) THEN
    RAISE EXCEPTION 'FAIL: the occurrence ids are not per-target';
  END IF;
  RAISE NOTICE 'PASS: one post, three targets, three distinct occurrences';

  -- ==========================================================================
  -- 5. THE CRASH CRITERION, both directions.
  -- ==========================================================================
  SELECT count(*) INTO before_n FROM public.partner_webhook_deliveries WHERE webhook_id = wh;
  BEGIN
    PERFORM public.partner_settle_platform_post(
      NULL, the_post, acct_a, 'facebook', 'success', 'x-' || nonce, 'https://fb.example/2', NULL, NULL
    );
    -- Force the subtransaction to roll back, standing in for a crash between
    -- the status write and the commit.
    RAISE EXCEPTION 'rollback-probe';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'rollback-probe' THEN RAISE; END IF;
  END;

  SELECT count(*) INTO n FROM public.partner_webhook_deliveries WHERE webhook_id = wh;
  IF n <> before_n THEN
    RAISE EXCEPTION 'FAIL: a rolled-back settle left % orphan delivery row(s)', n - before_n;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.platform_posts p
     WHERE p.post_id = the_post AND p.platform_post_id = 'x-' || nonce
  ) THEN
    RAISE EXCEPTION 'FAIL: a rolled-back settle left its platform_posts row';
  END IF;
  RAISE NOTICE 'PASS: crash direction B -- a rolled-back settle leaves neither row';

  -- Direction A: the status and its delivery row are present TOGETHER.
  -- Asserted explicitly rather than left implied by the counts above.
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_posts p
      JOIN public.partner_webhook_deliveries d
        ON d.event_occurrence_id = 'post.published:' || p.id::text
     WHERE p.id = pp_a AND p.status = 'success'
  ) THEN
    RAISE EXCEPTION 'FAIL: crash direction A -- a committed status has no delivery row';
  END IF;
  RAISE NOTICE 'PASS: crash direction A -- a committed status carries its delivery row';

  -- ==========================================================================
  -- 6. An unattributable row emits nothing rather than guessing a workspace.
  -- ==========================================================================
  SELECT count(*) INTO before_n FROM public.partner_webhook_deliveries WHERE webhook_id = wh;
  res := public.partner_settle_platform_post(
    NULL, the_post, NULL, 'tiktok', 'failed', NULL, NULL, 'no account', NULL
  );
  IF (res->>'enqueued')::int <> 0 THEN
    RAISE EXCEPTION 'FAIL: a row with no account was attributed to a workspace anyway';
  END IF;
  IF (SELECT count(*) FROM public.partner_webhook_deliveries WHERE webhook_id = wh) <> before_n THEN
    RAISE EXCEPTION 'FAIL: an unattributable settle still enqueued';
  END IF;
  -- ...but it DID settle. Refusing to emit must not mean refusing to record.
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_posts p
     WHERE p.id = (res->>'platform_post_id')::uuid AND p.status = 'failed'
  ) THEN
    RAISE EXCEPTION 'FAIL: an unattributable settle did not write its row';
  END IF;
  RAISE NOTICE 'PASS: an unattributable row is recorded but not emitted';

  -- ==========================================================================
  -- 6b. A cross-tenant pairing is refused BEFORE anything is written.
  -- ==========================================================================
  --
  -- platform_posts has two INDEPENDENT foreign keys, so post-of-A with
  -- account-of-B is a structurally valid row. The function would then roll up
  -- A's post while deriving the event's workspace from B's account -- A's post
  -- details delivered to B's webhook.
  DECLARE
    other_user UUID;
    other_ws   UUID;
    other_acct UUID;
    rows_before INTEGER;
  BEGIN
    -- A second owner. auth.users is seeded with one row, so make another.
    INSERT INTO auth.users (id, email, instance_id, aud, role)
    VALUES (gen_random_uuid(), 'seam-' || nonce || '@example.invalid',
            '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
    RETURNING id INTO other_user;
    INSERT INTO public.workspaces (name, owner_id, is_personal)
    VALUES ('seam-other-' || nonce, other_user, false) RETURNING id INTO other_ws;
    INSERT INTO public.social_accounts (user_id, workspace_id, platform, platform_user_id, access_token, is_active)
    VALUES (other_user, other_ws, 'facebook', 'other-' || nonce, 'tok', true)
    RETURNING id INTO other_acct;

    SELECT count(*) INTO rows_before FROM public.platform_posts p WHERE p.post_id = the_post;
    BEGIN
      PERFORM public.partner_settle_platform_post(
        NULL, the_post, other_acct, 'facebook', 'success', NULL, NULL, NULL, NULL
      );
      RAISE EXCEPTION 'FAIL: a cross-tenant pairing was accepted';
    EXCEPTION WHEN foreign_key_violation THEN
      NULL;  -- the refusal, raised with this errcode on purpose
    END;
    -- Refusing must mean refusing to WRITE, not merely refusing to emit.
    IF (SELECT count(*) FROM public.platform_posts p WHERE p.post_id = the_post) <> rows_before THEN
      RAISE EXCEPTION 'FAIL: the refused pairing still created a row';
    END IF;
    RAISE NOTICE 'PASS: a cross-tenant pairing is refused before any write';

    -- CONTROL: the same call with the RIGHT owner's account still works, so
    -- the assertion above cannot be satisfied by a function that refuses
    -- everything.
    PERFORM public.partner_settle_platform_post(
      NULL, the_post, acct_a, 'facebook', 'success', NULL, NULL, NULL, NULL
    );
    IF (SELECT count(*) FROM public.platform_posts p WHERE p.post_id = the_post) <> rows_before + 1 THEN
      RAISE EXCEPTION 'FAIL: the control settle did not write its row';
    END IF;
    RAISE NOTICE 'PASS: control -- the correctly paired account still settles';

    DELETE FROM public.social_accounts a WHERE a.id = other_acct;
    DELETE FROM public.workspaces w WHERE w.id = other_ws;
    DELETE FROM auth.users u WHERE u.id = other_user;
  END;

  -- ==========================================================================
  -- 7. A non-terminal status is refused.
  -- ==========================================================================
  BEGIN
    PERFORM public.partner_settle_platform_post(
      NULL, the_post, acct_a, 'facebook', 'pending', NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'FAIL: pending was accepted as a terminal status';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS: a non-terminal status is refused';
  END;

  -- --- cleanup, and RESTORE the allowlist ---------------------------------
  DELETE FROM public.partner_webhooks WHERE workspace_id = ws;
  ALTER TABLE public.partner_webhooks DROP CONSTRAINT partner_webhooks_events_check_seamtest;
  EXECUTE 'ALTER TABLE public.partner_webhooks ADD CONSTRAINT ' || quote_ident(old_name) ||
          ' ' || old_def;

  DELETE FROM public.platform_posts p WHERE p.post_id = the_post;
  DELETE FROM public.posts p WHERE p.id = the_post;
  DELETE FROM public.partner_api_keys k WHERE k.id = key_id;
  DELETE FROM public.social_accounts a WHERE a.id IN (acct_a, acct_b);
  DELETE FROM public.workspaces w WHERE w.id = ws;
END
$suite$;

-- The allowlist must be back exactly as it was. A suite that widened the
-- published surface and forgot to restore it would be worse than no suite, so
-- the restoration is asserted rather than assumed.
DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_webhooks'::regclass
       AND conname = 'partner_webhooks_events_check_seamtest'
  ) THEN
    RAISE EXCEPTION 'FAIL: the test constraint survived the suite';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_webhooks'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%webhook.test%'
  ) THEN
    RAISE EXCEPTION 'FAIL: the certified-event allowlist was not restored';
  END IF;
  RAISE NOTICE 'PASS: the allowlist is restored exactly as it was';
END
$verify$;

\echo '=== publishing_seam: ALL CHECKS PASSED ==='
