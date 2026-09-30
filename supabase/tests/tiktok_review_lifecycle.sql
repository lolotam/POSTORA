-- supabase/tests/tiktok_review_lifecycle.sql
-- TikTok review workspace, slice S0 (migration 20261002150000). One transaction,
-- synthetic fixtures, labelled ASSERTs, expected refusals in nested
-- BEGIN/EXCEPTION blocks, ROLLBACK, sentinel last. Assumes the migration
-- is already applied. No secrets and no real accounts.
--
-- Covers: draft creation + account ownership (T1), save/revision/media
-- tenancy (T2), reject/archive/restore (T3), submit validation (T4),
-- the 'now' submit snapshot (T5), request_id idempotency (T6), the
-- 'scheduled' submit + scheduler predicate (T7), dispatch compare-and-set
-- (T8), the authenticated grant/RLS surface (T9), webhook dedupe (T10)
-- and the exact function surface (T11).
BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures: two users, tiktok accounts (one inactive, one wrong platform),
-- one media file each, unlimited post + media quotas via overrides.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';
  u_b uuid := 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb';
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'tiktok-review-a-' || u_a::text || '@example.invalid'),
    (u_b, 'tiktok-review-b-' || u_b::text || '@example.invalid');

  -- Signup triggers insert quota rows with NULL limits; the override wins
  -- afterwards (-1 = unlimited), the same way media_upload_quota.sql seeds.
  INSERT INTO public.user_quotas
    (user_id, max_posts_per_day, max_posts_per_month, max_media_uploads_per_day)
  VALUES
    (u_a, -1, -1, -1),
    (u_b, -1, -1, -1)
  ON CONFLICT (user_id) DO UPDATE SET
    max_posts_per_day = EXCLUDED.max_posts_per_day,
    max_posts_per_month = EXCLUDED.max_posts_per_month,
    max_media_uploads_per_day = EXCLUDED.max_media_uploads_per_day;

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES
    ('a1a1a1a1-aaaa-4111-8111-aaaaaaaaaaaa', u_a, 'tiktok', 'tt-user-a', 'tt_user_a', 'tok-a', true),
    ('a2a2a2a2-aaaa-4111-8111-aaaaaaaaaaaa', u_a, 'tiktok', 'tt-user-a-off', 'tt_user_a_off', 'tok-a-off', false),
    ('a3a3a3a3-aaaa-4111-8111-aaaaaaaaaaaa', u_a, 'instagram', 'ig-user-a', 'ig_user_a', 'tok-a-ig', true),
    ('b1b1b1b1-bbbb-4111-8111-bbbbbbbbbbbb', u_b, 'tiktok', 'tt-user-b', 'tt_user_b', 'tok-b', true);

  INSERT INTO public.media_files (id, user_id, file_path, file_type)
  VALUES
    ('aa000001-aaaa-4111-8111-aaaaaaaaaaaa', u_a, 'tiktok-review/a.mp4', 'video'),
    ('bb000001-bbbb-4111-8111-bbbbbbbbbbbb', u_b, 'tiktok-review/b.mp4', 'video');
END $$;

-- T1: create_draft succeeds on the caller's own active tiktok account.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';
  acct_a_tt uuid := 'a1a1a1a1-aaaa-4111-8111-aaaaaaaaaaaa';
  acct_a_tt_off uuid := 'a2a2a2a2-aaaa-4111-8111-aaaaaaaaaaaa';
  acct_a_ig uuid := 'a3a3a3a3-aaaa-4111-8111-aaaaaaaaaaaa';
  acct_b_tt uuid := 'b1b1b1b1-bbbb-4111-8111-bbbbbbbbbbbb';
  v_draft public.tiktok_review_drafts%ROWTYPE;
BEGIN
  v_draft := public.tiktok_review_create_draft(u_a, acct_a_tt);
  ASSERT v_draft.state = 'pending_review', 'T1 new draft starts in pending_review';
  ASSERT v_draft.revision = 1, 'T1 new draft starts at revision 1';
  ASSERT v_draft.user_id = u_a, 'T1 new draft belongs to the caller';
  ASSERT v_draft.social_account_id = acct_a_tt, 'T1 new draft points at the account';
  ASSERT v_draft.media_file_id IS NULL, 'T1 new draft has no media yet';

  BEGIN
    PERFORM public.tiktok_review_create_draft(u_a, acct_b_tt);
    RAISE EXCEPTION 'T1 failed: draft on another user''s account was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM = 'TIKTOK_REVIEW_ACCOUNT_NOT_FOUND',
      'T1 cross-user account refusal, got: ' || SQLERRM;
    ASSERT SQLSTATE = 'P0001', 'T1 cross-user account SQLSTATE is P0001';
  END;

  BEGIN
    PERFORM public.tiktok_review_create_draft(u_a, acct_a_tt_off);
    RAISE EXCEPTION 'T1 failed: draft on an inactive account was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM = 'TIKTOK_REVIEW_ACCOUNT_NOT_FOUND',
      'T1 inactive account refusal, got: ' || SQLERRM;
  END;

  BEGIN
    PERFORM public.tiktok_review_create_draft(u_a, acct_a_ig);
    RAISE EXCEPTION 'T1 failed: draft on a non-tiktok account was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM = 'TIKTOK_REVIEW_ACCOUNT_NOT_FOUND',
      'T1 wrong-platform refusal, got: ' || SQLERRM;
  END;
END $$;

-- T2: save_draft bumps the revision; stale revisions, foreign drafts and
-- foreign media are refused.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';
  u_b uuid := 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb';
  acct_a_tt uuid := 'a1a1a1a1-aaaa-4111-8111-aaaaaaaaaaaa';
  acct_b_tt uuid := 'b1b1b1b1-bbbb-4111-8111-bbbbbbbbbbbb';
  media_a uuid := 'aa000001-aaaa-4111-8111-aaaaaaaaaaaa';
  media_b uuid := 'bb000001-bbbb-4111-8111-bbbbbbbbbbbb';
  v_id uuid;
  v_b_id uuid;
  v_draft public.tiktok_review_drafts%ROWTYPE;
BEGIN
  v_draft := public.tiktok_review_create_draft(u_a, acct_a_tt);
  v_id := v_draft.id;

  v_draft := public.tiktok_review_save_draft(
    u_a, v_id, 1, 'hello', media_a, 12.5, '{"allowComment": true}'::jsonb);
  ASSERT v_draft.revision = 2, 'T2 save increments the revision';
  ASSERT v_draft.caption = 'hello', 'T2 save stores the caption';
  ASSERT v_draft.media_file_id = media_a, 'T2 save stores the media';
  ASSERT v_draft.state = 'pending_review', 'T2 save keeps pending_review';

  BEGIN
    PERFORM public.tiktok_review_save_draft(
      u_a, v_id, 1, 'stale', media_a, 12.5, '{}'::jsonb);
    RAISE EXCEPTION 'T2 failed: stale revision was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM = 'TIKTOK_REVIEW_REVISION_CONFLICT',
      'T2 stale revision refusal, got: ' || SQLERRM;
    ASSERT SQLSTATE = 'P0001', 'T2 stale revision SQLSTATE is P0001';
  END;

  v_draft := public.tiktok_review_create_draft(u_b, acct_b_tt);
  v_b_id := v_draft.id;
  BEGIN
    PERFORM public.tiktok_review_save_draft(
      u_a, v_b_id, 1, 'steal', media_a, NULL, '{}'::jsonb);
    RAISE EXCEPTION 'T2 failed: save on another user''s draft was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM = 'TIKTOK_REVIEW_NOT_FOUND',
      'T2 foreign draft refusal, got: ' || SQLERRM;
  END;

  BEGIN
    PERFORM public.tiktok_review_save_draft(
      u_a, v_id, 2, 'steal media', media_b, NULL, '{}'::jsonb);
    RAISE EXCEPTION 'T2 failed: foreign media_file_id was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLSTATE = '23503', 'T2 foreign media SQLSTATE is 23503';
    ASSERT SQLERRM LIKE '%tiktok_review_drafts_media_fkey%',
      'T2 foreign media fails on the media composite FK, got: ' || SQLERRM;
  END;
END $$;

-- T3: reject needs a reason; save re-opens; archive/restore round-trip;
-- archived drafts are frozen.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';
  acct_a_tt uuid := 'a1a1a1a1-aaaa-4111-8111-aaaaaaaaaaaa';
  media_a uuid := 'aa000001-aaaa-4111-8111-aaaaaaaaaaaa';
  v_id uuid;
  v_draft public.tiktok_review_drafts%ROWTYPE;
BEGIN
  v_draft := public.tiktok_review_create_draft(u_a, acct_a_tt);
  v_id := v_draft.id;

  BEGIN
    PERFORM public.tiktok_review_transition(u_a, v_id, 1, 'reject', '   ');
    RAISE EXCEPTION 'T3 failed: blank rejection reason was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM = 'TIKTOK_REVIEW_REASON_REQUIRED',
      'T3 blank reason refusal, got: ' || SQLERRM;
  END;

  v_draft := public.tiktok_review_transition(u_a, v_id, 1, 'reject', '  needs captions  ');
  ASSERT v_draft.state = 'rejected', 'T3 reject moves to rejected';
  ASSERT v_draft.revision = 2, 'T3 reject bumps the revision';
  ASSERT v_draft.rejection_reason = 'needs captions',
    'T3 reject stores the trimmed reason';

  v_draft := public.tiktok_review_save_draft(
    u_a, v_id, 2, 'fixed', media_a, NULL, '{}'::jsonb);
  ASSERT v_draft.state = 'pending_review', 'T3 save re-opens a rejected draft';
  ASSERT v_draft.revision = 3, 'T3 save after reject bumps the revision';
  ASSERT v_draft.rejection_reason IS NULL, 'T3 save clears the rejection reason';

  v_draft := public.tiktok_review_transition(u_a, v_id, 3, 'archive', NULL);
  ASSERT v_draft.state = 'archived', 'T3 archive moves to archived';
  ASSERT v_draft.revision = 4, 'T3 archive bumps the revision';

  BEGIN
    PERFORM public.tiktok_review_save_draft(
      u_a, v_id, 4, 'thaw', media_a, NULL, '{}'::jsonb);
    RAISE EXCEPTION 'T3 failed: save on an archived draft was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM = 'TIKTOK_REVIEW_INVALID_STATE',
      'T3 archived save refusal, got: ' || SQLERRM;
  END;

  v_draft := public.tiktok_review_transition(u_a, v_id, 4, 'restore', NULL);
  ASSERT v_draft.state = 'pending_review', 'T3 restore returns to pending_review';
  ASSERT v_draft.revision = 5, 'T3 restore bumps the revision';
END $$;

-- T4: submit validation — media, then schedule shape.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';
  acct_a_tt uuid := 'a1a1a1a1-aaaa-4111-8111-aaaaaaaaaaaa';
  media_a uuid := 'aa000001-aaaa-4111-8111-aaaaaaaaaaaa';
  v_bare uuid;
  v_ready uuid;
  v_draft public.tiktok_review_drafts%ROWTYPE;
BEGIN
  v_draft := public.tiktok_review_create_draft(u_a, acct_a_tt);
  v_bare := v_draft.id;
  BEGIN
    PERFORM public.tiktok_review_submit(
      u_a, v_bare, 1, 'd4000001-0000-4000-8000-000000000001', 'now', NULL, 'UTC');
    RAISE EXCEPTION 'T4 failed: submit without media was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM = 'TIKTOK_REVIEW_MEDIA_REQUIRED',
      'T4 media refusal, got: ' || SQLERRM;
  END;

  v_draft := public.tiktok_review_create_draft(u_a, acct_a_tt);
  v_ready := v_draft.id;
  PERFORM public.tiktok_review_save_draft(
    u_a, v_ready, 1, 'caption', media_a, 8, '{}'::jsonb);

  BEGIN
    PERFORM public.tiktok_review_submit(
      u_a, v_ready, 2, 'd4000002-0000-4000-8000-000000000002',
      'scheduled', now() - interval '1 hour', 'UTC');
    RAISE EXCEPTION 'T4 failed: scheduled submit in the past was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM = 'TIKTOK_REVIEW_SCHEDULE_INVALID',
      'T4 past schedule refusal, got: ' || SQLERRM;
  END;

  BEGIN
    PERFORM public.tiktok_review_submit(
      u_a, v_ready, 2, 'd4000003-0000-4000-8000-000000000003',
      'now', now() + interval '1 hour', 'UTC');
    RAISE EXCEPTION 'T4 failed: now-mode submit with a time was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM = 'TIKTOK_REVIEW_SCHEDULE_INVALID',
      'T4 now-with-time refusal, got: ' || SQLERRM;
  END;
END $$;

-- T5: a 'now' submit creates the posts row from the locked draft.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';
  acct_a_tt uuid := 'a1a1a1a1-aaaa-4111-8111-aaaaaaaaaaaa';
  media_a uuid := 'aa000001-aaaa-4111-8111-aaaaaaaaaaaa';
  req_now uuid := 'c1000001-0000-4000-8000-000000000001';
  v_id uuid;
  v_res jsonb;
  v_sub_id uuid;
  v_post_id uuid;
  v_post public.posts%ROWTYPE;
  v_posts_before integer;
  v_draft public.tiktok_review_drafts%ROWTYPE;
BEGIN
  v_draft := public.tiktok_review_create_draft(u_a, acct_a_tt);
  v_id := v_draft.id;
  PERFORM public.tiktok_review_save_draft(
    u_a, v_id, 1, 'hello tiktok', media_a, 12.5,
    '{"privacy": "PUBLIC_TO_EVERYONE", "allowComment": true, "allowDuet": false,
      "allowStitch": true, "disclose": true, "yourBrand": true,
      "brandedContent": false, "aiGenerated": false}'::jsonb);

  SELECT count(*) INTO v_posts_before FROM public.posts WHERE user_id = u_a;

  v_res := public.tiktok_review_submit(u_a, v_id, 2, req_now, 'now', NULL, 'UTC');
  ASSERT v_res->>'created' = 'true', 'T5 first submit reports created true';
  ASSERT v_res->>'mode' = 'now', 'T5 submit echoes the mode';
  ASSERT (v_res->'scheduled_at') = 'null'::jsonb, 'T5 now-mode scheduled_at is JSON null';
  ASSERT v_res->>'dispatch_state' = 'pending_dispatch',
    'T5 now-mode submission waits for dispatch';
  v_sub_id := (v_res->>'submission_id')::uuid;
  v_post_id := (v_res->>'post_id')::uuid;

  SELECT * INTO v_post FROM public.posts WHERE id = v_post_id;
  ASSERT v_post.status = 'pending', 'T5 now-mode post is pending';
  ASSERT v_post.scheduled_at IS NULL, 'T5 now-mode post has no scheduled_at';
  ASSERT v_post.source = 'tiktok_review', 'T5 post source is tiktok_review';
  ASSERT v_post.platforms = ARRAY['tiktok'], 'T5 post targets tiktok only';
  ASSERT v_post.caption = 'hello tiktok', 'T5 post caption is the draft caption';
  ASSERT v_post.media_file_ids = ARRAY[media_a], 'T5 post carries the draft media';
  ASSERT v_post.metadata->>'tiktok_privacy_level' = 'PUBLIC_TO_EVERYONE',
    'T5 privacy passes through from settings';
  ASSERT v_post.metadata->>'tiktok_title' = 'hello tiktok',
    'T5 tiktok_title mirrors the caption';
  ASSERT v_post.metadata->>'schedule_timezone' = 'UTC',
    'T5 schedule_timezone is stored';
  ASSERT v_post.metadata->>'tiktok_review_submission_id' = v_sub_id::text,
    'T5 metadata links the submission';
  ASSERT v_post.metadata->>'tiktok_your_brand' = 'true',
    'T5 your_brand is disclose AND yourBrand';
  ASSERT (v_post.metadata ? 'tiktok_branded_content')
    AND v_post.metadata->>'tiktok_branded_content' = 'false',
    'T5 branded_content false is present as JSON false, not absent';

  ASSERT (SELECT count(*) FROM public.posts WHERE user_id = u_a) = v_posts_before + 1,
    'T5 submit inserts exactly one posts row';
  ASSERT (SELECT d.state FROM public.tiktok_review_drafts d WHERE d.id = v_id) = 'submitted',
    'T5 the draft is consumed';
  ASSERT (SELECT s.dispatch_state FROM public.tiktok_review_submissions s
           WHERE s.id = v_sub_id) = 'pending_dispatch',
    'T5 submission dispatch_state is pending_dispatch';
END $$;

-- T6: replaying the same request_id returns the same rows with created
-- false; a new request_id on the consumed draft is refused.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';
  req_now uuid := 'c1000001-0000-4000-8000-000000000001';
  req_other uuid := 'c1000002-0000-4000-8000-000000000002';
  v_sub_id uuid;
  v_post_id uuid;
  v_draft_id uuid;
  v_rev integer;
  v_posts_before integer;
  v_res jsonb;
BEGIN
  SELECT s.id, s.post_id, s.draft_id INTO v_sub_id, v_post_id, v_draft_id
  FROM public.tiktok_review_submissions s
  WHERE s.user_id = u_a AND s.request_id = req_now;
  ASSERT v_sub_id IS NOT NULL, 'T6 the T5 submission exists';
  SELECT d.revision INTO v_rev FROM public.tiktok_review_drafts d WHERE d.id = v_draft_id;
  SELECT count(*) INTO v_posts_before FROM public.posts WHERE user_id = u_a;

  v_res := public.tiktok_review_submit(u_a, v_draft_id, v_rev, req_now, 'now', NULL, 'UTC');
  ASSERT v_res->>'created' = 'false', 'T6 replay reports created false';
  ASSERT (v_res->>'submission_id')::uuid = v_sub_id,
    'T6 replay returns the same submission_id';
  ASSERT (v_res->>'post_id')::uuid = v_post_id,
    'T6 replay returns the same post_id';
  ASSERT (SELECT count(*) FROM public.posts WHERE user_id = u_a) = v_posts_before,
    'T6 replay inserts no second posts row';

  BEGIN
    PERFORM public.tiktok_review_submit(u_a, v_draft_id, v_rev, req_other, 'now', NULL, 'UTC');
    RAISE EXCEPTION 'T6 failed: second request_id on a submitted draft was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM = 'TIKTOK_REVIEW_INVALID_STATE',
      'T6 second request refusal, got: ' || SQLERRM;
  END;
END $$;

-- T7: a 'scheduled' submit lands in the scheduler's shape but is not due
-- yet; the T5 'now' post is never due (no scheduled_at).
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';
  acct_a_tt uuid := 'a1a1a1a1-aaaa-4111-8111-aaaaaaaaaaaa';
  media_a uuid := 'aa000001-aaaa-4111-8111-aaaaaaaaaaaa';
  req_sched uuid := 'c1000003-0000-4000-8000-000000000003';
  req_now uuid := 'c1000001-0000-4000-8000-000000000001';
  v_id uuid;
  v_res jsonb;
  v_post_id uuid;
  v_now_post_id uuid;
  v_post public.posts%ROWTYPE;
  v_draft public.tiktok_review_drafts%ROWTYPE;
BEGIN
  v_draft := public.tiktok_review_create_draft(u_a, acct_a_tt);
  v_id := v_draft.id;
  PERFORM public.tiktok_review_save_draft(
    u_a, v_id, 1, 'later', media_a, 9, '{}'::jsonb);

  v_res := public.tiktok_review_submit(
    u_a, v_id, 2, req_sched, 'scheduled', now() + interval '2 hours', 'Asia/Kuwait');
  ASSERT v_res->>'created' = 'true', 'T7 scheduled submit reports created true';
  ASSERT v_res->>'dispatch_state' = 'scheduled',
    'T7 scheduled submission waits for the scheduler';
  v_post_id := (v_res->>'post_id')::uuid;

  SELECT * INTO v_post FROM public.posts WHERE id = v_post_id;
  ASSERT v_post.status = 'scheduled', 'T7 scheduled post has status scheduled';
  ASSERT v_post.scheduled_at IS NOT NULL AND v_post.scheduled_at > now(),
    'T7 scheduled post carries the future time';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.posts p
    WHERE p.id = v_post_id
      AND p.status IN ('pending', 'scheduled')
      AND p.scheduled_at IS NOT NULL
      AND p.scheduled_at <= now()
  ), 'T7 the scheduler predicate does not select the future post now';

  SELECT s.post_id INTO v_now_post_id
  FROM public.tiktok_review_submissions s
  WHERE s.user_id = u_a AND s.request_id = req_now;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.posts p
    WHERE p.id = v_now_post_id
      AND p.status IN ('pending', 'scheduled')
      AND p.scheduled_at IS NOT NULL
      AND p.scheduled_at <= now()
  ), 'T7 the now-mode post (scheduled_at null) is never scheduler-selected';
END $$;

-- T8: set_dispatch_state is a compare-and-set on the current state.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';
  req_now uuid := 'c1000001-0000-4000-8000-000000000001';
  v_sub_id uuid;
BEGIN
  SELECT s.id INTO v_sub_id
  FROM public.tiktok_review_submissions s
  WHERE s.user_id = u_a AND s.request_id = req_now;

  ASSERT public.tiktok_review_set_dispatch_state(
      v_sub_id, ARRAY['pending_dispatch'], 'dispatching') = true,
    'T8 pending_dispatch -> dispatching swaps';
  ASSERT (SELECT s.dispatch_state FROM public.tiktok_review_submissions s
           WHERE s.id = v_sub_id) = 'dispatching',
    'T8 the new dispatch_state is stored';
  ASSERT public.tiktok_review_set_dispatch_state(
      v_sub_id, ARRAY['pending_dispatch'], 'dispatching') = false,
    'T8 repeating the same compare-and-set swaps nothing';
END $$;

-- T9: the browser surface. As user A: own drafts/submissions visible, B's
-- invisible; no writes; no RPC execute; no webhook-event reads.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa',
                    'role', 'authenticated')::text, true);

DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.tiktok_review_drafts) >= 1,
    'T9 user A reads their own drafts';
  ASSERT NOT EXISTS (SELECT 1 FROM public.tiktok_review_drafts
                      WHERE user_id <> 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'),
    'T9 user A sees no other user''s drafts';
  ASSERT (SELECT count(*) FROM public.tiktok_review_submissions) >= 1,
    'T9 user A reads their own submissions';
  ASSERT NOT EXISTS (SELECT 1 FROM public.tiktok_review_submissions
                      WHERE user_id <> 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'),
    'T9 user A sees no other user''s submissions';

  BEGIN
    INSERT INTO public.tiktok_review_drafts (user_id, social_account_id)
    VALUES ('a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa',
            'a1a1a1a1-aaaa-4111-8111-aaaaaaaaaaaa');
    RAISE EXCEPTION 'T9 failed: authenticated INSERT on drafts was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501', 'T9 draft INSERT SQLSTATE is 42501';
  END;

  BEGIN
    UPDATE public.tiktok_review_drafts SET caption = 'hijack'
    WHERE user_id = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';
    RAISE EXCEPTION 'T9 failed: authenticated UPDATE on drafts was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501', 'T9 draft UPDATE SQLSTATE is 42501';
  END;

  BEGIN
    DELETE FROM public.tiktok_review_drafts
    WHERE user_id = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';
    RAISE EXCEPTION 'T9 failed: authenticated DELETE on drafts was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501', 'T9 draft DELETE SQLSTATE is 42501';
  END;

  BEGIN
    -- Fixed literals, not gen_random_uuid(): arguments are evaluated before
    -- the permission check, and the authenticated role must not depend on
    -- the extensions schema being in its search_path for this refusal.
    PERFORM public.tiktok_review_submit(
      'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa', 'd9000001-0000-4000-8000-000000000001', 1,
      'd9000002-0000-4000-8000-000000000002', 'now', NULL, 'UTC');
    RAISE EXCEPTION 'T9 failed: authenticated EXECUTE of submit was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501', 'T9 submit EXECUTE SQLSTATE is 42501';
  END;

  BEGIN
    PERFORM 1 FROM public.tiktok_webhook_events LIMIT 1;
    RAISE EXCEPTION 'T9 failed: authenticated SELECT on webhook events was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501', 'T9 webhook events SELECT SQLSTATE is 42501';
  END;
END $$;

RESET ROLE;

-- T10: webhook events dedupe on (event, publish_id, create_time).
DO $$
BEGIN
  INSERT INTO public.tiktok_webhook_events
    (event, user_openid, publish_id, create_time)
  VALUES ('post.publish.complete', 'openid-1', 'pub-1', 1728000001);

  INSERT INTO public.tiktok_webhook_events
    (event, user_openid, publish_id, create_time)
  VALUES ('post.publish.complete', 'openid-1', 'pub-1', 1728000001)
  ON CONFLICT (event, publish_id, create_time) DO NOTHING;

  ASSERT (SELECT count(*) FROM public.tiktok_webhook_events
           WHERE event = 'post.publish.complete'
             AND publish_id = 'pub-1'
             AND create_time = 1728000001) = 1,
    'T10 the retried webhook delivery leaves exactly one row';
END $$;

-- T11: exactly one function per RPC name; RLS on; browser roles locked out.
DO $$
DECLARE
  v_names text[] := ARRAY[
    'tiktok_review_create_draft',
    'tiktok_review_save_draft',
    'tiktok_review_transition',
    'tiktok_review_submit',
    'tiktok_review_set_dispatch_state'];
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY v_names LOOP
    ASSERT (SELECT count(*) FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = v_name) = 1,
      'T11 exactly one pg_proc row for ' || v_name;
  END LOOP;

  ASSERT NOT has_function_privilege(
      'anon', 'public.tiktok_review_submit(uuid,uuid,integer,uuid,text,timestamptz,text)',
      'EXECUTE'),
    'T11 anon cannot EXECUTE submit';
  ASSERT NOT has_function_privilege(
      'authenticated', 'public.tiktok_review_submit(uuid,uuid,integer,uuid,text,timestamptz,text)',
      'EXECUTE'),
    'T11 authenticated cannot EXECUTE submit';
  ASSERT NOT has_function_privilege(
      'authenticated', 'public.tiktok_review_create_draft(uuid,uuid)', 'EXECUTE'),
    'T11 authenticated cannot EXECUTE create_draft';
  ASSERT NOT has_function_privilege(
      'authenticated', 'public.tiktok_review_save_draft(uuid,uuid,integer,text,uuid,numeric,jsonb)',
      'EXECUTE'),
    'T11 authenticated cannot EXECUTE save_draft';
  ASSERT NOT has_function_privilege(
      'authenticated', 'public.tiktok_review_transition(uuid,uuid,integer,text,text)',
      'EXECUTE'),
    'T11 authenticated cannot EXECUTE transition';
  ASSERT NOT has_function_privilege(
      'authenticated', 'public.tiktok_review_set_dispatch_state(uuid,text[],text)',
      'EXECUTE'),
    'T11 authenticated cannot EXECUTE set_dispatch_state';
  ASSERT has_function_privilege(
      'service_role', 'public.tiktok_review_submit(uuid,uuid,integer,uuid,text,timestamptz,text)',
      'EXECUTE'),
    'T11 service_role can EXECUTE submit';

  ASSERT has_table_privilege(
      'authenticated', 'public.tiktok_review_drafts', 'SELECT'),
    'T11 authenticated holds SELECT on drafts';
  ASSERT NOT has_table_privilege(
      'authenticated', 'public.tiktok_review_drafts', 'INSERT'),
    'T11 authenticated holds no INSERT on drafts';
  ASSERT NOT has_table_privilege(
      'authenticated', 'public.tiktok_review_drafts', 'UPDATE'),
    'T11 authenticated holds no UPDATE on drafts';
  ASSERT NOT has_table_privilege(
      'authenticated', 'public.tiktok_review_drafts', 'DELETE'),
    'T11 authenticated holds no DELETE on drafts';
  ASSERT NOT has_table_privilege(
      'authenticated', 'public.tiktok_webhook_events', 'SELECT'),
    'T11 authenticated holds no SELECT on webhook events';

  ASSERT (SELECT c.relrowsecurity FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'tiktok_review_drafts'),
    'T11 RLS is enabled on drafts';
  ASSERT (SELECT c.relrowsecurity FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'tiktok_review_submissions'),
    'T11 RLS is enabled on submissions';
  ASSERT (SELECT c.relrowsecurity FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'tiktok_webhook_events'),
    'T11 RLS is enabled on webhook events';
  ASSERT (SELECT count(*) FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'tiktok_review_drafts') = 1,
    'T11 drafts carry exactly one policy';
  ASSERT (SELECT count(*) FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'tiktok_review_submissions') = 1,
    'T11 submissions carry exactly one policy';
  ASSERT (SELECT count(*) FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'tiktok_webhook_events') = 0,
    'T11 webhook events carry no policies';
END $$;

-- T12: the 'publishing' claim is a single-claim atomic UPDATE; a second
-- identical claim swaps nothing, and unknown states are refused.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';
  acct_a_tt uuid := 'a1a1a1a1-aaaa-4111-8111-aaaaaaaaaaaa';
  media_a uuid := 'aa000001-aaaa-4111-8111-aaaaaaaaaaaa';
  req_claim uuid := 'c1000004-0000-4000-8000-000000000004';
  v_id uuid;
  v_sub_id uuid;
  v_n integer;
  v_res jsonb;
  v_draft public.tiktok_review_drafts%ROWTYPE;
BEGIN
  v_draft := public.tiktok_review_create_draft(u_a, acct_a_tt);
  v_id := v_draft.id;
  PERFORM public.tiktok_review_save_draft(
    u_a, v_id, 1, 'claim me', media_a, 9, '{}'::jsonb);

  v_res := public.tiktok_review_submit(
    u_a, v_id, 2, req_claim, 'now', NULL, 'UTC');
  v_sub_id := (v_res->>'submission_id')::uuid;
  ASSERT v_res->>'dispatch_state' = 'pending_dispatch',
    'T12 new submission waits for dispatch';

  ASSERT public.tiktok_review_set_dispatch_state(
      v_sub_id, ARRAY['pending_dispatch'], 'dispatching') = true,
    'T12 pending_dispatch -> dispatching swaps';

  UPDATE public.tiktok_review_submissions SET dispatch_state='publishing'
  WHERE id = v_sub_id
    AND dispatch_state IN ('dispatching','scheduled')
    AND provider_publish_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  ASSERT v_n = 1, 'T12 first publishing claim swaps exactly one row';
  ASSERT (SELECT s.dispatch_state FROM public.tiktok_review_submissions s
           WHERE s.id = v_sub_id) = 'publishing',
    'T12 the submission is publishing after the claim';

  UPDATE public.tiktok_review_submissions SET dispatch_state='publishing'
  WHERE id = v_sub_id
    AND dispatch_state IN ('dispatching','scheduled')
    AND provider_publish_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  ASSERT v_n = 0, 'T12 repeating the publishing claim swaps zero rows';

  BEGIN
    UPDATE public.tiktok_review_submissions SET dispatch_state='bogus'
    WHERE id = v_sub_id;
    RAISE EXCEPTION 'T12 failed: bogus dispatch_state was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLSTATE = '23514', 'T12 bogus dispatch_state SQLSTATE is 23514';
  END;
END $$;

-- T13: a throttling write of last_status_check_at alone leaves updated_at
-- alone (it is the staleness clock); a dispatch_state change moves it.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';
  acct_a_tt uuid := 'a1a1a1a1-aaaa-4111-8111-aaaaaaaaaaaa';
  media_a uuid := 'aa000001-aaaa-4111-8111-aaaaaaaaaaaa';
  v_past timestamptz := '2020-01-01T00:00:00Z';
  v_draft public.tiktok_review_drafts%ROWTYPE;
  v_sub uuid;
BEGIN
  v_draft := public.tiktok_review_create_draft(u_a, acct_a_tt);
  PERFORM public.tiktok_review_save_draft(u_a, v_draft.id, 1, 'clock', media_a, 9, '{}'::jsonb);
  v_sub := (public.tiktok_review_submit(
    u_a, v_draft.id, 2, 'c1000013-0000-4000-8000-000000000013', 'now', NULL, 'UTC')
    ->>'submission_id')::uuid;

  UPDATE public.tiktok_review_submissions SET updated_at = v_past WHERE id = v_sub;
  ASSERT (SELECT updated_at FROM public.tiktok_review_submissions WHERE id = v_sub) = v_past,
    'T13 updated_at can be pinned for the test';

  UPDATE public.tiktok_review_submissions SET last_status_check_at = now() WHERE id = v_sub;
  ASSERT (SELECT updated_at FROM public.tiktok_review_submissions WHERE id = v_sub) = v_past,
    'T13 a last_status_check_at-only write does not move updated_at';

  UPDATE public.tiktok_review_submissions SET dispatch_state = 'dispatching' WHERE id = v_sub;
  ASSERT (SELECT updated_at FROM public.tiktok_review_submissions WHERE id = v_sub) > v_past,
    'T13 a dispatch_state change moves updated_at';
END $$;

-- T14: a request_id belongs to the draft it was first used with.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';
  acct_a_tt uuid := 'a1a1a1a1-aaaa-4111-8111-aaaaaaaaaaaa';
  media_a uuid := 'aa000001-aaaa-4111-8111-aaaaaaaaaaaa';
  req uuid := 'c1000014-0000-4000-8000-000000000014';
  v_one public.tiktok_review_drafts%ROWTYPE;
  v_two public.tiktok_review_drafts%ROWTYPE;
BEGIN
  v_one := public.tiktok_review_create_draft(u_a, acct_a_tt);
  PERFORM public.tiktok_review_save_draft(u_a, v_one.id, 1, 'first', media_a, 9, '{}'::jsonb);
  PERFORM public.tiktok_review_submit(u_a, v_one.id, 2, req, 'now', NULL, 'UTC');

  v_two := public.tiktok_review_create_draft(u_a, acct_a_tt);
  PERFORM public.tiktok_review_save_draft(u_a, v_two.id, 1, 'second', media_a, 9, '{}'::jsonb);
  BEGIN
    PERFORM public.tiktok_review_submit(u_a, v_two.id, 2, req, 'now', NULL, 'UTC');
    RAISE EXCEPTION 'T14 failed: request_id reused across drafts was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM = 'TIKTOK_REVIEW_REQUEST_REUSED', 'T14 reuse refusal, got: ' || SQLERRM;
  END;
  ASSERT (SELECT state FROM public.tiktok_review_drafts WHERE id = v_two.id) = 'pending_review',
    'T14 the second draft was not consumed';
END $$;

-- T15: reopen only when nothing reached TikTok, or TikTok reported FAILED.
DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';
  acct_a_tt uuid := 'a1a1a1a1-aaaa-4111-8111-aaaaaaaaaaaa';
  media_a uuid := 'aa000001-aaaa-4111-8111-aaaaaaaaaaaa';
  v_draft public.tiktok_review_drafts%ROWTYPE;
  v_res jsonb;
  v_sub uuid;
  v_post uuid;
  v_rev integer;
BEGIN
  v_draft := public.tiktok_review_create_draft(u_a, acct_a_tt);
  PERFORM public.tiktok_review_save_draft(u_a, v_draft.id, 1, 'reopen', media_a, 9, '{}'::jsonb);

  BEGIN
    PERFORM public.tiktok_review_transition(u_a, v_draft.id, 2, 'reopen', NULL);
    RAISE EXCEPTION 'T15 failed: reopen of a pending_review draft was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM = 'TIKTOK_REVIEW_INVALID_STATE', 'T15 not-submitted refusal, got: ' || SQLERRM;
  END;

  v_res := public.tiktok_review_submit(
    u_a, v_draft.id, 2, 'c1000015-0000-4000-8000-000000000015', 'now', NULL, 'UTC');
  v_sub := (v_res->>'submission_id')::uuid;
  v_post := (v_res->>'post_id')::uuid;

  UPDATE public.tiktok_review_submissions SET dispatch_state = 'publishing' WHERE id = v_sub;
  BEGIN
    PERFORM public.tiktok_review_transition(u_a, v_draft.id, 2, 'reopen', NULL);
    RAISE EXCEPTION 'T15 failed: reopen while publishing was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM = 'TIKTOK_REVIEW_INVALID_STATE', 'T15 publishing refusal, got: ' || SQLERRM;
  END;

  UPDATE public.tiktok_review_submissions
  SET dispatch_state = 'dispatched', provider_publish_id = 'v_pub_t15'
  WHERE id = v_sub;
  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status)
  VALUES (v_post, acct_a_tt, 'tiktok', 'pending');
  BEGIN
    PERFORM public.tiktok_review_transition(u_a, v_draft.id, 2, 'reopen', NULL);
    RAISE EXCEPTION 'T15 failed: reopen with a pending TikTok row was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM = 'TIKTOK_REVIEW_INVALID_STATE', 'T15 pending-row refusal, got: ' || SQLERRM;
  END;

  UPDATE public.platform_posts SET status = 'failed' WHERE post_id = v_post;
  v_draft := public.tiktok_review_transition(u_a, v_draft.id, 2, 'reopen', NULL);
  ASSERT v_draft.state = 'pending_review', 'T15 TikTok-failed attempt reopens to pending_review';
  ASSERT v_draft.revision = 3, 'T15 reopen bumps the revision (consent invalidated)';

  -- Second round: nothing reached TikTok (no publish id, no row).
  v_rev := v_draft.revision;
  v_res := public.tiktok_review_submit(
    u_a, v_draft.id, v_rev, 'c1000016-0000-4000-8000-000000000016', 'now', NULL, 'UTC');
  v_sub := (v_res->>'submission_id')::uuid;
  UPDATE public.tiktok_review_submissions SET dispatch_state = 'needs_attention' WHERE id = v_sub;
  v_draft := public.tiktok_review_transition(u_a, v_draft.id, v_rev, 'reopen', NULL);
  ASSERT v_draft.state = 'pending_review' AND v_draft.revision = v_rev + 1,
    'T15 needs_attention with no publish id reopens';
END $$;

ROLLBACK;

\echo '=== tiktok_review_lifecycle: ALL CHECKS PASSED ==='
