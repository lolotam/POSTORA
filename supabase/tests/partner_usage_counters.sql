-- ============================================================================
-- partner_usage_counters.sql — Phase 10.1 split counters
--
-- Proves the four RPCs implement the bucket semantics the plan pins:
--   reserve → reserved +1, total +1, cap includes reserved;
--   confirm → reserved -1, confirmed +1, total unchanged;
--   indeterminate → reserved -1, indeterminate +1, total unchanged;
--   release → reserved -1, total -1, floored;
--   monthly reset zeroes all four on the next reserve;
--   backfill is idempotent;
--   only service_role may execute the RPCs.
--
-- Self-cleaning, re-runnable, terminal sentinel for the harness.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== partner_usage_counters: start ==='

CREATE OR REPLACE FUNCTION pg_temp.must(p_cond BOOLEAN, p_label TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT p_cond THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_label; END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.cleanup() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.partner_api_keys WHERE key_prefix LIKE 'pk_uc_%';
  DELETE FROM public.social_accounts WHERE platform_user_id LIKE 'uc-%';
  DELETE FROM public.workspaces WHERE name LIKE 'uc-ws-%';
END $$;

SELECT pg_temp.cleanup();

-- Seed one user, one workspace, one account for the suite.
DO $seed$
DECLARE
  v_user UUID;
  v_ws   UUID;
  v_acct UUID;
BEGIN
  SELECT id INTO v_user FROM auth.users LIMIT 1;
  IF v_user IS NULL THEN RAISE EXCEPTION 'harness seeds one auth.users row; none found'; END IF;

  INSERT INTO public.workspaces (id, name, owner_id)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'uc-ws-1', v_user)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.social_accounts (id, user_id, workspace_id, platform, platform_user_id, access_token, is_active)
  VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', v_user, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'whatsapp', 'uc-1', 'tok', true)
  ON CONFLICT (id) DO NOTHING;
END $seed$;

-- Helper to create a key with known state.
CREATE OR REPLACE FUNCTION pg_temp.make_key(
  p_id UUID, p_quota INTEGER, p_reserved INTEGER DEFAULT 0, p_confirmed INTEGER DEFAULT 0, p_indet INTEGER DEFAULT 0, p_total INTEGER DEFAULT 0, p_reset TIMESTAMPTZ DEFAULT date_trunc('month', now())
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.partner_api_keys WHERE id = p_id;
  INSERT INTO public.partner_api_keys (id, workspace_id, social_account_id, key_hash, key_prefix, name, monthly_quota, usage_reserved, usage_confirmed, usage_indeterminate, current_usage_count, last_reset_at)
  VALUES (p_id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 'hash-' || p_id::text, 'pk_uc_' || substring(p_id::text,1,4), 'uc-key', p_quota, p_reserved, p_confirmed, p_indet, p_total, p_reset);
END $$;

-- ---------------------------------------------------------------------------
-- 1. reserve -> reserved=1, confirmed=0, total=1; confirm -> reserved=0, confirmed=1, total=1
-- ---------------------------------------------------------------------------
DO $t1$
DECLARE
  v_key UUID := 'cccccccc-cccc-cccc-cccc-cccccccccc01';
  v_rec RECORD;
BEGIN
  PERFORM pg_temp.make_key(v_key, NULL, 0,0,0,0);
  SELECT * INTO v_rec FROM public.reserve_partner_quota(v_key);
  PERFORM pg_temp.must(v_rec.allowed = true, 'T1 reserve allowed');
  PERFORM pg_temp.must(v_rec.usage_count = 1, 'T1 reserve total 1');
  PERFORM pg_temp.must((SELECT usage_reserved FROM public.partner_api_keys WHERE id=v_key)=1, 'T1 reserved=1');
  PERFORM pg_temp.must((SELECT usage_confirmed FROM public.partner_api_keys WHERE id=v_key)=0, 'T1 confirmed=0');
  PERFORM pg_temp.must((SELECT current_usage_count FROM public.partner_api_keys WHERE id=v_key)=1, 'T1 total 1');

  PERFORM public.confirm_partner_quota(v_key);
  PERFORM pg_temp.must((SELECT usage_reserved FROM public.partner_api_keys WHERE id=v_key)=0, 'T1 after confirm reserved=0');
  PERFORM pg_temp.must((SELECT usage_confirmed FROM public.partner_api_keys WHERE id=v_key)=1, 'T1 after confirm confirmed=1');
  PERFORM pg_temp.must((SELECT current_usage_count FROM public.partner_api_keys WHERE id=v_key)=1, 'T1 after confirm total still 1');
  RAISE NOTICE 'PASS T1: reserve then confirm moves the bucket without changing the total';
END $t1$;

-- ---------------------------------------------------------------------------
-- 2. reserve -> indeterminate -> reserved=0, indeterminate=1, total=1
-- ---------------------------------------------------------------------------
DO $t2$
DECLARE
  v_key UUID := 'cccccccc-cccc-cccc-cccc-cccccccccc02';
  v_rec RECORD;
BEGIN
  PERFORM pg_temp.make_key(v_key, NULL, 0,0,0,0);
  SELECT * INTO v_rec FROM public.reserve_partner_quota(v_key);
  PERFORM public.indeterminate_partner_quota(v_key);
  PERFORM pg_temp.must((SELECT usage_reserved FROM public.partner_api_keys WHERE id=v_key)=0, 'T2 reserved 0 after indeterminate');
  PERFORM pg_temp.must((SELECT usage_indeterminate FROM public.partner_api_keys WHERE id=v_key)=1, 'T2 indeterminate 1');
  PERFORM pg_temp.must((SELECT current_usage_count FROM public.partner_api_keys WHERE id=v_key)=1, 'T2 total 1 after indeterminate');
  RAISE NOTICE 'PASS T2: indeterminate moves reserved to indeterminate, total unchanged';
END $t2$;

-- ---------------------------------------------------------------------------
-- 3. reserve -> release -> all zero, total 0; release below zero floors at 0
-- ---------------------------------------------------------------------------
DO $t3$
DECLARE
  v_key UUID := 'cccccccc-cccc-cccc-cccc-cccccccccc03';
  v_rec RECORD;
BEGIN
  PERFORM pg_temp.make_key(v_key, NULL, 0,0,0,0);
  SELECT * INTO v_rec FROM public.reserve_partner_quota(v_key);
  PERFORM public.release_partner_quota(v_key);
  PERFORM pg_temp.must((SELECT usage_reserved FROM public.partner_api_keys WHERE id=v_key)=0, 'T3 reserve 0 after release');
  PERFORM pg_temp.must((SELECT current_usage_count FROM public.partner_api_keys WHERE id=v_key)=0, 'T3 total 0 after release');
  -- second release floors
  PERFORM public.release_partner_quota(v_key);
  PERFORM pg_temp.must((SELECT usage_reserved FROM public.partner_api_keys WHERE id=v_key)=0, 'T3 second release still 0');
  PERFORM pg_temp.must((SELECT current_usage_count FROM public.partner_api_keys WHERE id=v_key)=0, 'T3 second release total still 0');
  RAISE NOTICE 'PASS T3: release floors at zero';
END $t3$;

-- ---------------------------------------------------------------------------
-- 4. quota 2: two reserves allowed, third refused (total 3), after release total 2
-- ---------------------------------------------------------------------------
DO $t4$
DECLARE
  v_key UUID := 'cccccccc-cccc-cccc-cccc-cccccccccc04';
  r1 RECORD; r2 RECORD; r3 RECORD;
BEGIN
  PERFORM pg_temp.make_key(v_key, 2, 0,0,0,0);
  SELECT * INTO r1 FROM public.reserve_partner_quota(v_key);
  SELECT * INTO r2 FROM public.reserve_partner_quota(v_key);
  SELECT * INTO r3 FROM public.reserve_partner_quota(v_key);
  PERFORM pg_temp.must(r1.allowed = true, 'T4 first reserve allowed');
  PERFORM pg_temp.must(r2.allowed = true, 'T4 second reserve allowed');
  PERFORM pg_temp.must(r3.allowed = false, 'T4 third reserve refused');
  PERFORM pg_temp.must(r3.usage_count = 3, 'T4 third reserve total 3');
  PERFORM pg_temp.must((SELECT current_usage_count FROM public.partner_api_keys WHERE id=v_key)=3, 'T4 total 3 after three reserves');
  PERFORM public.release_partner_quota(v_key);
  PERFORM pg_temp.must((SELECT current_usage_count FROM public.partner_api_keys WHERE id=v_key)=2, 'T4 after one release total 2');
  RAISE NOTICE 'PASS T4: quota enforcement counts reserved and reports refusal';
END $t4$;

-- ---------------------------------------------------------------------------
-- 5. the cap counts RESERVED units: quota 1, one reserve outstanding, second refused
-- ---------------------------------------------------------------------------
DO $t5$
DECLARE
  v_key UUID := 'cccccccc-cccc-cccc-cccc-cccccccccc05';
  r1 RECORD; r2 RECORD;
BEGIN
  PERFORM pg_temp.make_key(v_key, 1, 0,0,0,0);
  SELECT * INTO r1 FROM public.reserve_partner_quota(v_key);
  PERFORM pg_temp.must(r1.allowed = true, 'T5 first reserve allowed under quota 1');
  SELECT * INTO r2 FROM public.reserve_partner_quota(v_key);
  PERFORM pg_temp.must(r2.allowed = false, 'T5 second reserve refused while one is still reserved');
  -- clean the extra unit so the key does not stay over quota for later tests
  PERFORM public.release_partner_quota(v_key);
  PERFORM public.release_partner_quota(v_key);
  RAISE NOTICE 'PASS T5: outstanding reserved counts toward the cap';
END $t5$;

-- ---------------------------------------------------------------------------
-- 6. monthly reset: stale buckets are zeroed on the next reserve
-- ---------------------------------------------------------------------------
DO $t6$
DECLARE
  v_key UUID := 'cccccccc-cccc-cccc-cccc-cccccccccc06';
  v_rec RECORD;
  v_old TIMESTAMPTZ := date_trunc('month', now()) - interval '1 month' - interval '1 day';
BEGIN
  PERFORM pg_temp.make_key(v_key, NULL, 2, 3, 1, 6, v_old);
  SELECT * INTO v_rec FROM public.reserve_partner_quota(v_key);
  PERFORM pg_temp.must((SELECT usage_reserved FROM public.partner_api_keys WHERE id=v_key)=1, 'T6 reserved 1 after reset');
  PERFORM pg_temp.must((SELECT usage_confirmed FROM public.partner_api_keys WHERE id=v_key)=0, 'T6 confirmed 0 after reset');
  PERFORM pg_temp.must((SELECT usage_indeterminate FROM public.partner_api_keys WHERE id=v_key)=0, 'T6 indeterminate 0 after reset');
  PERFORM pg_temp.must((SELECT current_usage_count FROM public.partner_api_keys WHERE id=v_key)=1, 'T6 total 1 after reset');
  PERFORM pg_temp.must((SELECT last_reset_at FROM public.partner_api_keys WHERE id=v_key)=date_trunc('month', now()), 'T6 last_reset_at bumped');
  RAISE NOTICE 'PASS T6: monthly reset zeroes all buckets on the next reserve';
END $t6$;

-- ---------------------------------------------------------------------------
-- 7. backfill: current_usage_count=5, usage_confirmed=0 -> usage_confirmed=5, idempotent
-- ---------------------------------------------------------------------------
DO $t7$
DECLARE
  v_key UUID := 'cccccccc-cccc-cccc-cccc-cccccccccc07';
BEGIN
  -- The pre-migration shape: a charged total with every bucket still empty.
  PERFORM pg_temp.make_key(v_key, NULL, 0,0,0,5);
  -- The migration's backfill statement, verbatim. A copy, so it can drift
  -- from 20260902170000_partner_usage_counters.sql: if you change one,
  -- change both.
  UPDATE public.partner_api_keys SET usage_confirmed = current_usage_count
   WHERE usage_reserved = 0 AND usage_confirmed = 0 AND usage_indeterminate = 0 AND current_usage_count > 0;
  PERFORM pg_temp.must((SELECT usage_confirmed FROM public.partner_api_keys WHERE id=v_key)=5, 'T7 backfill set confirmed to 5');
  UPDATE public.partner_api_keys SET usage_confirmed = current_usage_count
   WHERE usage_reserved = 0 AND usage_confirmed = 0 AND usage_indeterminate = 0 AND current_usage_count > 0;
  PERFORM pg_temp.must((SELECT usage_confirmed FROM public.partner_api_keys WHERE id=v_key)=5, 'T7 backfill is idempotent');

  -- A key with a live reservation must NOT be backfilled: its total already
  -- contains the reserved unit, and copying it would charge that unit twice.
  PERFORM pg_temp.make_key(v_key, NULL, 1,0,0,1);
  UPDATE public.partner_api_keys SET usage_confirmed = current_usage_count
   WHERE usage_reserved = 0 AND usage_confirmed = 0 AND usage_indeterminate = 0 AND current_usage_count > 0;
  PERFORM pg_temp.must((SELECT usage_confirmed FROM public.partner_api_keys WHERE id=v_key)=0, 'T7 a reserved unit is not copied into confirmed');
  PERFORM pg_temp.must((SELECT current_usage_count FROM public.partner_api_keys WHERE id=v_key)=1, 'T7 total untouched by the guarded backfill');
  RAISE NOTICE 'PASS T7: backfill is correct, idempotent, and skips keys with live buckets';
END $t7$;

DO $prepgrant$
BEGIN
  PERFORM pg_temp.make_key('cccccccc-cccc-cccc-cccc-cccccccccc08'::uuid, NULL, 0,0,0,0);
END $prepgrant$;

-- ---------------------------------------------------------------------------
-- 8. grants: service_role may, authenticated and anon may not
--    SET ROLE must be at statement level (outside DO), because role changes
--    are not allowed inside a DO block.
-- ---------------------------------------------------------------------------
\echo '--- grant checks as authenticated ---'
SET ROLE authenticated;
DO $gauth$
BEGIN
  BEGIN
    PERFORM public.reserve_partner_quota('cccccccc-cccc-cccc-cccc-cccccccccc08'::uuid);
    RAISE EXCEPTION 'FAIL: authenticated executed reserve_partner_quota';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS grant: authenticated cannot reserve';
  END;
  BEGIN
    PERFORM public.release_partner_quota('cccccccc-cccc-cccc-cccc-cccccccccc08'::uuid);
    RAISE EXCEPTION 'FAIL: authenticated executed release_partner_quota';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS grant: authenticated cannot release';
  END;
  BEGIN
    PERFORM public.confirm_partner_quota('cccccccc-cccc-cccc-cccc-cccccccccc08'::uuid);
    RAISE EXCEPTION 'FAIL: authenticated executed confirm_partner_quota';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS grant: authenticated cannot confirm';
  END;
  BEGIN
    PERFORM public.indeterminate_partner_quota('cccccccc-cccc-cccc-cccc-cccccccccc08'::uuid);
    RAISE EXCEPTION 'FAIL: authenticated executed indeterminate_partner_quota';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS grant: authenticated cannot indeterminate';
  END;
END $gauth$;
RESET ROLE;

\echo '--- grant checks as anon ---'
SET ROLE anon;
DO $ganon$
BEGIN
  BEGIN
    PERFORM public.reserve_partner_quota('cccccccc-cccc-cccc-cccc-cccccccccc08'::uuid);
    RAISE EXCEPTION 'FAIL: anon executed reserve_partner_quota';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS grant: anon cannot reserve';
  END;
END $ganon$;
RESET ROLE;

\echo '--- grant checks as service_role ---'
SET ROLE service_role;
DO $gservice$
DECLARE
  v_key UUID := 'cccccccc-cccc-cccc-cccc-cccccccccc08';
BEGIN
  PERFORM public.reserve_partner_quota(v_key);
  PERFORM public.release_partner_quota(v_key);
  PERFORM public.confirm_partner_quota(v_key);
  PERFORM public.indeterminate_partner_quota(v_key);
  RAISE NOTICE 'PASS grant: service_role can execute all four';
END $gservice$;
RESET ROLE;

SELECT pg_temp.cleanup();
DROP FUNCTION IF EXISTS pg_temp.make_key(UUID, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS pg_temp.must(BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS pg_temp.cleanup();

-- AI display counters share this post-migration suite. The transaction keeps
-- clock boundaries exact and rolls back the users, logs, role, and JWT settings.
BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('17100000-0000-4000-8000-000000000001', 'ai-counts-a@example.invalid'),
  ('17100000-0000-4000-8000-000000000002', 'ai-counts-b@example.invalid');

-- Caption boundaries: inside/exactly at 1h, just outside 1h, exactly at 24h,
-- and just outside 24h. Image/hashtag counts differ to catch column swaps.
INSERT INTO public.api_logs (user_id, endpoint, method, created_at)
SELECT '17100000-0000-4000-8000-000000000001'::uuid, endpoint, 'POST', now() - age
FROM (VALUES
  ('generate-caption', interval '30 minutes'),
  ('generate-caption', interval '1 hour'),
  ('generate-caption', interval '1 hour 0.000001 seconds'),
  ('generate-caption', interval '24 hours'),
  ('generate-caption', interval '24 hours 0.000001 seconds'),
  ('generate-image', interval '10 minutes'),
  ('generate-image', interval '3 hours'),
  ('generate-hashtags', interval '2 hours'),
  ('generate-hashtags', interval '4 hours'),
  ('/generate-caption', interval '10 minutes'),
  ('post-create', interval '10 minutes')
) AS logs(endpoint, age);

INSERT INTO public.api_logs (user_id, endpoint, method, created_at)
SELECT '17100000-0000-4000-8000-000000000002'::uuid, endpoint, 'POST', now()
FROM (VALUES ('generate-caption'), ('generate-image'), ('generate-hashtags')) AS logs(endpoint);

DO $ai_counts_signature$
BEGIN
  IF to_regprocedure('public.get_ai_rate_limit_counts()') IS NULL
     OR to_regprocedure('public.get_ai_rate_limit_counts(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: AI counts RPC must have only the zero-argument signature';
  END IF;
END $ai_counts_signature$;

SET LOCAL ROLE authenticated;
-- Clear the legacy subject GUC so auth.uid() reads the PostgREST claims JSON.
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claims', '{"sub":"17100000-0000-4000-8000-000000000001","role":"authenticated"}', true);

DO $ai_counts_owner$
DECLARE
  v_counts integer[];
BEGIN
  SELECT ARRAY[caption_hour, caption_day, image_hour, image_day, hashtag_hour, hashtag_day]
    INTO STRICT v_counts FROM public.get_ai_rate_limit_counts();
  IF v_counts IS DISTINCT FROM ARRAY[2, 4, 1, 2, 0, 2] THEN
    RAISE EXCEPTION 'FAIL: AI counts for A were %, expected {2,4,1,2,0,2}', v_counts;
  END IF;
  RAISE NOTICE 'PASS AI counts: own rows, endpoint names, and inclusive hour/day boundaries';
END $ai_counts_owner$;

SELECT set_config('request.jwt.claims', '{}', true);
DO $ai_counts_no_identity$
DECLARE
  v_counts integer[];
BEGIN
  IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'FAIL: expected a missing JWT subject'; END IF;
  SELECT ARRAY[caption_hour, caption_day, image_hour, image_day, hashtag_hour, hashtag_day]
    INTO STRICT v_counts FROM public.get_ai_rate_limit_counts();
  IF v_counts IS DISTINCT FROM ARRAY[0, 0, 0, 0, 0, 0] THEN
    RAISE EXCEPTION 'FAIL: missing subject returned AI counts %', v_counts;
  END IF;
  RAISE NOTICE 'PASS AI counts: missing subject returns six zeros';
END $ai_counts_no_identity$;

RESET ROLE;
SET LOCAL ROLE anon;
DO $ai_counts_anon$
BEGIN
  BEGIN
    PERFORM public.get_ai_rate_limit_counts();
    RAISE EXCEPTION 'FAIL: anon executed AI counts RPC';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS AI counts: anon cannot execute';
  END;
END $ai_counts_anon$;
RESET ROLE;
ROLLBACK;

\echo '=== partner_usage_counters: ALL CHECKS PASSED ==='
