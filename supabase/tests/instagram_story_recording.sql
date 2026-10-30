-- supabase/tests/instagram_story_recording.sql
-- One platform_posts row per published Instagram story (migration 20261030150000).
-- One transaction, synthetic fixtures, labelled ASSERTs, ROLLBACK, sentinel last.
-- Assumes the migration is already applied. No secrets and no real accounts.
BEGIN;

DO $$
DECLARE
  u_a uuid := 'a7a7a7a7-1111-4111-8111-a7a7a7a7a7a7';
  u_b uuid := 'a7a7a7a7-2222-4222-8222-a7a7a7a7a7a7';
  acct_ig uuid := 'a7a7a7a7-3333-4333-8333-a7a7a7a7a7a7';
  acct_b uuid := 'a7a7a7a7-4444-4444-8444-a7a7a7a7a7a7';
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'story-recording-a@example.invalid'),
    (u_b, 'story-recording-b@example.invalid');
  INSERT INTO public.user_quotas (user_id, max_posts_per_day, max_posts_per_month, max_media_uploads_per_day)
  VALUES (u_a, -1, -1, -1)
  ON CONFLICT (user_id) DO UPDATE SET
    max_posts_per_day = EXCLUDED.max_posts_per_day,
    max_posts_per_month = EXCLUDED.max_posts_per_month,
    max_media_uploads_per_day = EXCLUDED.max_media_uploads_per_day;
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES
    (acct_ig, u_a, 'instagram', 'sr-ig', 'sr_ig', 'tok-ig', true),
    (acct_b, u_b, 'instagram', 'sr-b-ig', 'sr_b_ig', 'tok-b', true);
  INSERT INTO public.posts (id, user_id, platforms, status, processing_started_at) VALUES
    ('a7000000-0000-4000-8000-000000000001', u_a, ARRAY['instagram'], 'processing', now()),
    ('a7000000-0000-4000-8000-000000000002', u_a, ARRAY['instagram'], 'processing', now());
END $$;

-- S1-S4: the first call writes the story row; a repeat answers that row and writes nothing.
DO $$
DECLARE
  post_1 uuid := 'a7000000-0000-4000-8000-000000000001';
  acct_ig uuid := 'a7a7a7a7-3333-4333-8333-a7a7a7a7a7a7';
  v_first jsonb;
  v_again jsonb;
BEGIN
  v_first := public.record_published_story(post_1, acct_ig, 'story-1', 'https://ig/s1',
    jsonb_build_object('account_username', 'sr_ig', 'ig_post_subtype', 'reel'));
  ASSERT (v_first ->> 'recorded')::boolean, format('S1 the first call records the story (got %s)', v_first);
  ASSERT (SELECT status = 'success' AND platform = 'instagram' AND platform_post_url = 'https://ig/s1'
                 AND response_data ->> 'ig_post_subtype' = 'story'
                 AND response_data ->> 'account_username' = 'sr_ig'
            FROM public.platform_posts WHERE id = (v_first ->> 'platform_post_id')::uuid),
    'S2 the row is a successful Instagram row tagged as a story, whatever tag the caller passed';

  v_again := public.record_published_story(post_1, acct_ig, 'story-1', 'https://ig/s1', NULL);
  ASSERT NOT (v_again ->> 'recorded')::boolean AND v_again ->> 'platform_post_id' = v_first ->> 'platform_post_id',
    format('S3 a repeat answers the existing row (got %s)', v_again);
  ASSERT (SELECT count(*) FROM public.platform_posts WHERE post_id = post_1 AND platform_post_id = 'story-1') = 1,
    'S4 the story still has exactly one row';
  v_again := public.record_published_story(post_1, acct_ig, 'story-array', 'https://ig/sa', '["not", "an", "object"]'::jsonb);
  ASSERT (SELECT response_data = '{"ig_post_subtype": "story"}'::jsonb
            FROM public.platform_posts WHERE id = (v_again ->> 'platform_post_id')::uuid),
    'S6 metadata that is not an object is dropped, so the tag (and the index) still apply';
  ASSERT (SELECT status = 'completed' FROM public.posts WHERE id = post_1),
    'S5 the post rolls up from the story row, through the settle function';
END $$;

-- I1-I3: the unique index holds the line for every row showing the story, and only those.
DO $$
DECLARE
  post_1 uuid := 'a7000000-0000-4000-8000-000000000001';
  acct_ig uuid := 'a7a7a7a7-3333-4333-8333-a7a7a7a7a7a7';
  v_refused boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.platform_posts (post_id, social_account_id, platform, platform_post_id, status, response_data)
    VALUES (post_1, acct_ig, 'instagram', 'story-1', 'success', '{"ig_post_subtype": "story"}'::jsonb);
  EXCEPTION WHEN unique_violation THEN
    v_refused := true;
  END;
  ASSERT v_refused, 'I1 a second story row for the same post, account and story id is refused';

  v_refused := false;
  BEGIN
    INSERT INTO public.platform_posts (post_id, social_account_id, platform, platform_post_id, status, response_data)
    VALUES (post_1, acct_ig, 'instagram', 'story-1', 'success', '{"story_recorded_on_reel_row": true}'::jsonb);
  EXCEPTION WHEN unique_violation THEN
    v_refused := true;
  END;
  ASSERT v_refused, 'I2 a reel row settled as a story that already has its row is refused too';

  INSERT INTO public.platform_posts (post_id, social_account_id, platform, platform_post_id, status, response_data)
  VALUES (post_1, acct_ig, 'instagram', 'story-1', 'success', '{"ig_post_subtype": "reel"}'::jsonb);
  ASSERT (SELECT count(*) FROM public.platform_posts WHERE post_id = post_1 AND platform_post_id = 'story-1') = 2,
    'I3 rows that do not show a story are outside the index';
END $$;

-- R1-R2: a reel row already settled as the story counts as recorded.
DO $$
DECLARE
  post_2 uuid := 'a7000000-0000-4000-8000-000000000002';
  acct_ig uuid := 'a7a7a7a7-3333-4333-8333-a7a7a7a7a7a7';
  v_reel uuid;
  v_result jsonb;
BEGIN
  INSERT INTO public.platform_posts (post_id, social_account_id, platform, platform_post_id, status, response_data)
  VALUES (post_2, acct_ig, 'instagram', 'story-2', 'success', '{"story_recorded_on_reel_row": true}'::jsonb)
  RETURNING id INTO v_reel;
  v_result := public.record_published_story(post_2, acct_ig, 'story-2', 'https://ig/s2', NULL);
  ASSERT NOT (v_result ->> 'recorded')::boolean AND (v_result ->> 'platform_post_id')::uuid = v_reel,
    format('R1 the reel row that shows the story is answered (got %s)', v_result);
  ASSERT (SELECT count(*) FROM public.platform_posts WHERE post_id = post_2) = 1,
    'R2 no second row is written for it';
END $$;

-- T1-T3: another tenant's account, or a missing story id, is refused and writes nothing.
DO $$
DECLARE
  post_2 uuid := 'a7000000-0000-4000-8000-000000000002';
  acct_b uuid := 'a7a7a7a7-4444-4444-8444-a7a7a7a7a7a7';
  acct_ig uuid := 'a7a7a7a7-3333-4333-8333-a7a7a7a7a7a7';
  v_refused boolean := false;
BEGIN
  BEGIN
    PERFORM public.record_published_story(post_2, acct_b, 'story-b', 'https://ig/sb', NULL);
  EXCEPTION WHEN foreign_key_violation THEN
    v_refused := true;
  END;
  ASSERT v_refused, 'T1 a cross-tenant pairing raises foreign_key_violation';
  ASSERT NOT EXISTS (SELECT 1 FROM public.platform_posts WHERE social_account_id = acct_b),
    'T2 the refused pairing wrote no row';

  v_refused := false;
  BEGIN
    PERFORM public.record_published_story(post_2, acct_ig, '', 'https://ig/empty', NULL);
  EXCEPTION WHEN invalid_parameter_value THEN
    v_refused := true;
  END;
  ASSERT v_refused, 'T3 an empty story id is refused';
END $$;

-- G1-G4: only the service role may call it, and it runs with a pinned search_path.
DO $$
BEGIN
  ASSERT NOT has_function_privilege('authenticated', 'public.record_published_story(uuid, uuid, text, text, jsonb)', 'EXECUTE'),
    'G1 authenticated cannot record a story';
  ASSERT NOT has_function_privilege('anon', 'public.record_published_story(uuid, uuid, text, text, jsonb)', 'EXECUTE'),
    'G2 anon cannot record a story';
  ASSERT has_function_privilege('service_role', 'public.record_published_story(uuid, uuid, text, text, jsonb)', 'EXECUTE'),
    'G3 the service role can record a story';
  ASSERT (SELECT prosecdef AND 'search_path=public' = ANY (proconfig)
            FROM pg_proc WHERE oid = 'public.record_published_story(uuid, uuid, text, text, jsonb)'::regprocedure),
    'G4 the function is SECURITY DEFINER with search_path pinned';
END $$;

ROLLBACK;

\echo '=== instagram_story_recording: ALL CHECKS PASSED ==='
