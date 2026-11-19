-- supabase/tests/youtube_oauth_attempts.sql
-- YouTube OAuth attempt lifecycle (migration 20261119130000).
--
-- One transaction, synthetic fixtures, ROLLBACK. No provider calls, no real
-- tokens. Denials are asserted as SQLSTATE 42501 (insufficient_privilege) or
-- the stable YOA* codes, never as "zero rows returned": an RLS filter and a
-- revoked grant are different protections.
--
-- Fixtures:
--   yoa_owner  Alice, owns profiles P1 and P2.
--   yoa_other  Bob, owns profile P3 (foreign to Alice).
--
-- No assertion here is skipped, broadened or conditional.

\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE yoa_state (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON yoa_state TO PUBLIC;

DO $fixtures$
DECLARE
  u_owner uuid := '0ec00001-0000-4000-8000-000000000001';
  u_other uuid := '0ec00002-0000-4000-8000-000000000002';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (u_owner, 'yoa-owner-' || u_owner::text || '@example.invalid'),
    (u_other, 'yoa-other-' || u_other::text || '@example.invalid');

  INSERT INTO public.social_profiles (id, user_id, name)
  VALUES
    ('0ec10001-0000-4000-8000-000000000011', u_owner, 'YOA Owner Profile 1'),
    ('0ec10002-0000-4000-8000-000000000012', u_owner, 'YOA Owner Profile 2'),
    ('0ec10003-0000-4000-8000-000000000013', u_other, 'YOA Other Profile');
END
$fixtures$;

-- ---------------------------------------------------------------------------
-- Y1. Create: bound to user and profile, nonce returned once, digest only
--     stored, raw nonce present in no stored column.
-- ---------------------------------------------------------------------------
DO $y1$
DECLARE
  u_owner uuid := '0ec00001-0000-4000-8000-000000000001';
  p1 uuid := '0ec10001-0000-4000-8000-000000000011';
  v_result jsonb;
  v_nonce text;
  v_row public.youtube_oauth_attempts%ROWTYPE;
BEGIN
  v_result := public.create_youtube_oauth_attempt(u_owner, p1);
  v_nonce := v_result ->> 'nonce';

  ASSERT v_result ?& ARRAY['attempt_id', 'nonce', 'expires_at'],
    'Y1 create returns attempt_id, nonce and expires_at';
  ASSERT length(v_nonce) = 64, 'Y1 nonce carries 256 bits as 64 hex chars';

  SELECT * INTO v_row FROM public.youtube_oauth_attempts
   WHERE id = (v_result ->> 'attempt_id')::uuid;
  ASSERT FOUND, 'Y1 the attempt row exists';
  ASSERT v_row.user_id = u_owner, 'Y1 attempt is bound to the user';
  ASSERT v_row.social_profile_id = p1, 'Y1 attempt is bound to the profile';
  ASSERT v_row.status = 'pending' AND v_row.consumed_at IS NULL,
    'Y1 attempt starts pending and unconsumed';
  ASSERT v_row.nonce_digest = encode(sha256(convert_to(v_nonce, 'UTF8')), 'hex'),
    'Y1 stored value is the SHA-256 digest of the nonce';
  ASSERT v_row.expires_at > clock_timestamp() + interval '9 minutes'
     AND v_row.expires_at <= clock_timestamp() + interval '10 minutes 5 seconds',
    'Y1 default deadline is about 10 minutes';

  -- The raw nonce must appear in NO stored column of ANY row.
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.youtube_oauth_attempts a
     WHERE row_to_json(a)::text LIKE '%' || v_nonce || '%'
  ), 'Y1 the raw nonce is stored nowhere in the attempt table';

  INSERT INTO yoa_state VALUES ('y1', v_result);
END
$y1$;

-- ---------------------------------------------------------------------------
-- Y2. Create refusals.
-- ---------------------------------------------------------------------------
DO $y2$
DECLARE
  u_owner uuid := '0ec00001-0000-4000-8000-000000000001';
  p1 uuid := '0ec10001-0000-4000-8000-000000000011';
  p_foreign uuid := '0ec10003-0000-4000-8000-000000000013';
  v_count_before bigint;
BEGIN
  SELECT count(*) INTO v_count_before FROM public.youtube_oauth_attempts;

  BEGIN
    PERFORM public.create_youtube_oauth_attempt(u_owner, p_foreign);
    RAISE EXCEPTION 'Y2 a foreign profile was accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YOA02' THEN NULL;
  END;

  BEGIN
    PERFORM public.create_youtube_oauth_attempt(
      u_owner, '0ec1ffff-0000-4000-8000-00000000ffff');
    RAISE EXCEPTION 'Y2 a missing profile was accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YOA02' THEN NULL;
  END;

  BEGIN
    PERFORM public.create_youtube_oauth_attempt(NULL, p1);
    RAISE EXCEPTION 'Y2 a NULL user was accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YOA01' THEN NULL;
  END;

  BEGIN
    PERFORM public.create_youtube_oauth_attempt(u_owner, NULL);
    RAISE EXCEPTION 'Y2 a NULL profile was accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YOA01' THEN NULL;
  END;

  BEGIN
    PERFORM public.create_youtube_oauth_attempt(u_owner, p1, 59);
    RAISE EXCEPTION 'Y2 a 59 second ttl was accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YOA01' THEN NULL;
  END;

  BEGIN
    PERFORM public.create_youtube_oauth_attempt(u_owner, p1, 1801);
    RAISE EXCEPTION 'Y2 a 1801 second ttl was accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YOA01' THEN NULL;
  END;

  ASSERT (SELECT count(*) FROM public.youtube_oauth_attempts) = v_count_before,
    'Y2 no refused create left a row behind';
END
$y2$;

-- ---------------------------------------------------------------------------
-- Y3. Owner and profile mismatch, unknown and malformed nonces. A refusal
--     never consumes the attempt and never carries an attempt column.
-- ---------------------------------------------------------------------------
DO $y3$
DECLARE
  u_owner uuid := '0ec00001-0000-4000-8000-000000000001';
  u_other uuid := '0ec00002-0000-4000-8000-000000000002';
  p1 uuid := '0ec10001-0000-4000-8000-000000000011';
  p2 uuid := '0ec10002-0000-4000-8000-000000000012';
  v_nonce text := (SELECT v ->> 'nonce' FROM yoa_state WHERE k = 'y1');
  v_attempt uuid := (SELECT (v ->> 'attempt_id')::uuid FROM yoa_state WHERE k = 'y1');
  r jsonb;
BEGIN
  r := public.consume_youtube_oauth_attempt(v_nonce, u_other, p1);
  ASSERT r = '{"ok": false, "reason": "owner_mismatch"}'::jsonb,
    format('Y3 owner mismatch: got %s', r);

  r := public.consume_youtube_oauth_attempt(v_nonce, u_owner, p2);
  ASSERT r = '{"ok": false, "reason": "profile_mismatch"}'::jsonb,
    format('Y3 profile mismatch: got %s', r);

  r := public.consume_youtube_oauth_attempt(repeat('0', 64), u_owner, p1);
  ASSERT r = '{"ok": false, "reason": "not_found"}'::jsonb,
    format('Y3 unknown nonce: got %s', r);

  r := public.consume_youtube_oauth_attempt('   ', u_owner, p1);
  ASSERT r = '{"ok": false, "reason": "invalid_nonce"}'::jsonb,
    format('Y3 blank nonce: got %s', r);

  r := public.consume_youtube_oauth_attempt(repeat('a', 257), u_owner, p1);
  ASSERT r = '{"ok": false, "reason": "invalid_nonce"}'::jsonb,
    format('Y3 over-long nonce: got %s', r);

  r := public.consume_youtube_oauth_attempt(NULL, u_owner, p1);
  ASSERT r = '{"ok": false, "reason": "invalid_request"}'::jsonb,
    format('Y3 NULL nonce: got %s', r);
  r := public.consume_youtube_oauth_attempt(v_nonce, NULL, p1);
  ASSERT r = '{"ok": false, "reason": "invalid_request"}'::jsonb,
    format('Y3 NULL user: got %s', r);
  r := public.consume_youtube_oauth_attempt(v_nonce, u_owner, NULL);
  ASSERT r = '{"ok": false, "reason": "invalid_request"}'::jsonb,
    format('Y3 NULL profile: got %s', r);

  ASSERT (SELECT status FROM public.youtube_oauth_attempts WHERE id = v_attempt) = 'pending',
    'Y3 no refusal consumed the attempt';
END
$y3$;

-- ---------------------------------------------------------------------------
-- Y4. Happy path, then replay refused with a stable reason and no leak.
-- ---------------------------------------------------------------------------
DO $y4$
DECLARE
  u_owner uuid := '0ec00001-0000-4000-8000-000000000001';
  p1 uuid := '0ec10001-0000-4000-8000-000000000011';
  v_nonce text := (SELECT v ->> 'nonce' FROM yoa_state WHERE k = 'y1');
  v_attempt uuid := (SELECT (v ->> 'attempt_id')::uuid FROM yoa_state WHERE k = 'y1');
  r jsonb;
  v_row public.youtube_oauth_attempts%ROWTYPE;
BEGIN
  r := public.consume_youtube_oauth_attempt(v_nonce, u_owner, p1);
  ASSERT (r ->> 'ok')::boolean IS TRUE, format('Y4 owner consume succeeds: got %s', r);
  ASSERT (r ->> 'attempt_id')::uuid = v_attempt
     AND (r ->> 'user_id')::uuid = u_owner
     AND (r ->> 'social_profile_id')::uuid = p1,
    'Y4 success returns the bound attempt, user and profile';
  ASSERT NOT (r ? 'nonce_digest'), 'Y4 success never returns the digest';

  SELECT * INTO v_row FROM public.youtube_oauth_attempts WHERE id = v_attempt;
  ASSERT v_row.status = 'consumed' AND v_row.consumed_at IS NOT NULL,
    'Y4 the attempt is marked consumed';

  -- Replay with the correct owner and profile.
  r := public.consume_youtube_oauth_attempt(v_nonce, u_owner, p1);
  ASSERT r = '{"ok": false, "reason": "already_consumed"}'::jsonb,
    format('Y4 replay refused with no row leaked: got %s', r);

  -- The mismatch checks still outrank the lifecycle state on a used attempt.
  r := public.consume_youtube_oauth_attempt(
    v_nonce, '0ec00002-0000-4000-8000-000000000002', p1);
  ASSERT r = '{"ok": false, "reason": "owner_mismatch"}'::jsonb,
    'Y4 a stranger learns nothing about a used attempt';
END
$y4$;

-- ---------------------------------------------------------------------------
-- Y5. Expiry: refused with its own reason and the row is left untouched.
-- ---------------------------------------------------------------------------
DO $y5$
DECLARE
  u_owner uuid := '0ec00001-0000-4000-8000-000000000001';
  p1 uuid := '0ec10001-0000-4000-8000-000000000011';
  v_result jsonb := public.create_youtube_oauth_attempt(u_owner, p1, 60);
  v_nonce text := v_result ->> 'nonce';
  v_attempt uuid := (v_result ->> 'attempt_id')::uuid;
  r jsonb;
BEGIN
  UPDATE public.youtube_oauth_attempts
     SET created_at = clock_timestamp() - interval '2 hours',
         expires_at = clock_timestamp() - interval '1 hour'
   WHERE id = v_attempt;

  r := public.consume_youtube_oauth_attempt(v_nonce, u_owner, p1);
  ASSERT r = '{"ok": false, "reason": "expired"}'::jsonb,
    format('Y5 expired attempt refused: got %s', r);
  ASSERT (SELECT status FROM public.youtube_oauth_attempts WHERE id = v_attempt) = 'pending',
    'Y5 an expired refusal does not consume the row';
END
$y5$;

-- ---------------------------------------------------------------------------
-- Y6. A mismatched presenter cannot burn the owner's attempt: the owner can
--     still consume it afterwards.
-- ---------------------------------------------------------------------------
DO $y6$
DECLARE
  u_owner uuid := '0ec00001-0000-4000-8000-000000000001';
  u_other uuid := '0ec00002-0000-4000-8000-000000000002';
  p1 uuid := '0ec10001-0000-4000-8000-000000000011';
  p2 uuid := '0ec10002-0000-4000-8000-000000000012';
  v_result jsonb := public.create_youtube_oauth_attempt(u_owner, p1);
  v_nonce text := v_result ->> 'nonce';
  r jsonb;
BEGIN
  PERFORM public.consume_youtube_oauth_attempt(v_nonce, u_other, p1);
  PERFORM public.consume_youtube_oauth_attempt(v_nonce, u_owner, p2);
  r := public.consume_youtube_oauth_attempt(v_nonce, u_owner, p1);
  ASSERT (r ->> 'ok')::boolean IS TRUE,
    format('Y6 owner still consumes after refused strangers: got %s', r);
END
$y6$;

-- ---------------------------------------------------------------------------
-- Y7. Purge: removes old expired and old consumed rows, keeps live ones,
--     honours the limit, and rejects a bad limit.
-- ---------------------------------------------------------------------------
DO $y7$
DECLARE
  u_owner uuid := '0ec00001-0000-4000-8000-000000000001';
  p1 uuid := '0ec10001-0000-4000-8000-000000000011';
  v_live uuid := (public.create_youtube_oauth_attempt(u_owner, p1) ->> 'attempt_id')::uuid;
  v_old_exp uuid := (public.create_youtube_oauth_attempt(u_owner, p1) ->> 'attempt_id')::uuid;
  v_old_used uuid := (public.create_youtube_oauth_attempt(u_owner, p1) ->> 'attempt_id')::uuid;
  v_recent_exp uuid := (public.create_youtube_oauth_attempt(u_owner, p1) ->> 'attempt_id')::uuid;
  v_removed integer;
BEGIN
  UPDATE public.youtube_oauth_attempts
     SET created_at = clock_timestamp() - interval '5 hours',
         expires_at = clock_timestamp() - interval '4 hours'
   WHERE id = v_old_exp;
  UPDATE public.youtube_oauth_attempts
     SET status = 'consumed', consumed_at = clock_timestamp() - interval '3 hours'
   WHERE id = v_old_used;
  UPDATE public.youtube_oauth_attempts
     SET created_at = clock_timestamp() - interval '20 minutes',
         expires_at = clock_timestamp() - interval '10 minutes'
   WHERE id = v_recent_exp;

  BEGIN
    PERFORM public.purge_expired_youtube_oauth_attempts(0);
    RAISE EXCEPTION 'Y7 limit 0 was accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YOA01' THEN NULL;
  END;
  BEGIN
    PERFORM public.purge_expired_youtube_oauth_attempts(NULL);
    RAISE EXCEPTION 'Y7 NULL limit was accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YOA01' THEN NULL;
  END;

  -- Limit 1 removes exactly one of the two purgeable rows.
  v_removed := public.purge_expired_youtube_oauth_attempts(1);
  ASSERT v_removed = 1, format('Y7 limit 1 removed %s rows', v_removed);

  v_removed := public.purge_expired_youtube_oauth_attempts(1000);
  ASSERT EXISTS (SELECT 1 FROM public.youtube_oauth_attempts WHERE id = v_live),
    'Y7 a live pending attempt survives the sweep';
  ASSERT EXISTS (SELECT 1 FROM public.youtube_oauth_attempts WHERE id = v_recent_exp),
    'Y7 an attempt expired within the grace hour survives';
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_oauth_attempts WHERE id = v_old_exp),
    'Y7 an attempt expired over an hour ago is removed';
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_oauth_attempts WHERE id = v_old_used),
    'Y7 an attempt consumed over an hour ago is removed';
END
$y7$;

-- ---------------------------------------------------------------------------
-- Y8. Structural boundary: RLS on, no policy, no PUBLIC grants.
-- ---------------------------------------------------------------------------
DO $y8$
BEGIN
  ASSERT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'public.youtube_oauth_attempts'::regclass),
    'Y8 RLS is enabled';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'youtube_oauth_attempts'),
    'Y8 no policy exists for any role';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_class c, aclexplode(c.relacl) x
     WHERE c.oid = 'public.youtube_oauth_attempts'::regclass
       AND x.grantee = 0),
    'Y8 PUBLIC holds no table privilege';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
     WHERE p.oid IN (
       'public.create_youtube_oauth_attempt(uuid, uuid, integer)'::regprocedure,
       'public.consume_youtube_oauth_attempt(text, uuid, uuid)'::regprocedure,
       'public.purge_expired_youtube_oauth_attempts(integer)'::regprocedure)
       AND x.grantee = 0),
    'Y8 PUBLIC holds no EXECUTE on the RPCs';
  ASSERT (SELECT bool_and(p.prosecdef AND 'search_path=public, pg_temp' = ANY (p.proconfig))
            FROM pg_proc p
           WHERE p.oid IN (
             'public.create_youtube_oauth_attempt(uuid, uuid, integer)'::regprocedure,
             'public.consume_youtube_oauth_attempt(text, uuid, uuid)'::regprocedure,
             'public.purge_expired_youtube_oauth_attempts(integer)'::regprocedure)),
    'Y8 every RPC is SECURITY DEFINER with a pinned search_path';
END
$y8$;

-- ---------------------------------------------------------------------------
-- Y9. Browser roles are refused everywhere, including the OWNER with a
--     matching JWT.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE yoa_denied (ord int PRIMARY KEY, stmt text NOT NULL) ON COMMIT DROP;
GRANT ALL ON yoa_denied TO PUBLIC;
INSERT INTO yoa_denied VALUES
  (1, 'SELECT count(*) FROM public.youtube_oauth_attempts'),
  (2, 'INSERT INTO public.youtube_oauth_attempts (user_id, social_profile_id, nonce_digest, expires_at) '
      'VALUES (''0ec00001-0000-4000-8000-000000000001'', ''0ec10001-0000-4000-8000-000000000011'', '
      'repeat(''a'', 64), clock_timestamp() + interval ''5 minutes'')'),
  (3, 'UPDATE public.youtube_oauth_attempts SET status = ''pending'''),
  (4, 'DELETE FROM public.youtube_oauth_attempts'),
  (5, 'SELECT public.create_youtube_oauth_attempt(''0ec00001-0000-4000-8000-000000000001'', '
      '''0ec10001-0000-4000-8000-000000000011'')'),
  (6, 'SELECT public.consume_youtube_oauth_attempt(repeat(''a'', 64), '
      '''0ec00001-0000-4000-8000-000000000001'', ''0ec10001-0000-4000-8000-000000000011'')'),
  (7, 'SELECT public.purge_expired_youtube_oauth_attempts(10)');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '0ec00001-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $y9a$
DECLARE
  stmt text;
  n integer;
BEGIN
  FOR n, stmt IN SELECT d.ord, d.stmt FROM yoa_denied d ORDER BY d.ord LOOP
    BEGIN
      EXECUTE stmt;
      RAISE EXCEPTION 'Y9 failed: the owning authenticated role ran statement %: %', n, stmt
        USING ERRCODE = 'assert_failure';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
  END LOOP;
END
$y9a$;

RESET ROLE;

SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.role', 'anon', true);

DO $y9b$
DECLARE
  stmt text;
  n integer;
BEGIN
  FOR n, stmt IN SELECT d.ord, d.stmt FROM yoa_denied d ORDER BY d.ord LOOP
    BEGIN
      EXECUTE stmt;
      RAISE EXCEPTION 'Y9 failed: the anonymous role ran statement %: %', n, stmt
        USING ERRCODE = 'assert_failure';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
  END LOOP;
END
$y9b$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- Y10. The service role runs the RPCs and may read, but cannot write the
--      table directly.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $y10$
DECLARE
  u_owner uuid := '0ec00001-0000-4000-8000-000000000001';
  p1 uuid := '0ec10001-0000-4000-8000-000000000011';
  v_result jsonb;
  r jsonb;
BEGIN
  v_result := public.create_youtube_oauth_attempt(u_owner, p1);
  r := public.consume_youtube_oauth_attempt(v_result ->> 'nonce', u_owner, p1);
  ASSERT (r ->> 'ok')::boolean IS TRUE, 'Y10 the service role completes the lifecycle';
  PERFORM public.purge_expired_youtube_oauth_attempts(10);
  ASSERT (SELECT count(*) FROM public.youtube_oauth_attempts) >= 1,
    'Y10 the service role reads the table';

  BEGIN
    UPDATE public.youtube_oauth_attempts SET status = 'pending';
    RAISE EXCEPTION 'Y10 the service role updated the table directly'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  BEGIN
    DELETE FROM public.youtube_oauth_attempts;
    RAISE EXCEPTION 'Y10 the service role deleted from the table directly'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END
$y10$;

RESET ROLE;

ROLLBACK;

\echo '=== youtube_oauth_attempts: ALL CHECKS PASSED ==='
