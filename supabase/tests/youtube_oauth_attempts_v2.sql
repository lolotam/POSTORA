-- YouTube OAuth attempt v2: stored return URL and nonce-only consumption.
-- Sequential checks roll back. The two-session race uses committed synthetic
-- fixtures and removes them explicitly because dblink cannot see uncommitted rows.

\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE yoa_v2_state (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON yoa_v2_state TO PUBLIC;

DO $fixtures$
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    ('0ed00001-0000-4000-8000-000000000001', 'yoa-v2-owner@example.invalid');
  INSERT INTO public.social_profiles (id, user_id, name) VALUES
    ('0ed10001-0000-4000-8000-000000000011', '0ed00001-0000-4000-8000-000000000001', 'YOA v2 profile');
END
$fixtures$;

DO $create_and_consume$
DECLARE
  u uuid := '0ed00001-0000-4000-8000-000000000001';
  p uuid := '0ed10001-0000-4000-8000-000000000011';
  created jsonb;
  consumed jsonb;
  attempt_id uuid;
BEGIN
  created := public.create_youtube_oauth_attempt_v2(
    u, p, 'https://postora.cloud/profiles?from=test', 600);
  attempt_id := (created ->> 'attempt_id')::uuid;
  INSERT INTO yoa_v2_state VALUES ('created', created);

  ASSERT created ?& ARRAY['attempt_id', 'nonce', 'expires_at'],
    'V2 create returns the attempt and one-time state material';
  ASSERT length(created ->> 'nonce') = 64,
    'V2 create returns a 256-bit hex nonce';
  ASSERT (SELECT return_to FROM public.youtube_oauth_attempts WHERE id = attempt_id)
    = 'https://postora.cloud/profiles?from=test',
    'V2 create stores the validated return URL';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.youtube_oauth_attempts
     WHERE id = attempt_id
       AND row_to_json(youtube_oauth_attempts)::text LIKE '%' || (created ->> 'nonce') || '%'
  ), 'V2 stores no raw nonce';

  consumed := public.consume_youtube_oauth_attempt_by_nonce(created ->> 'nonce');
  ASSERT consumed = jsonb_build_object(
    'ok', true, 'user_id', u, 'social_profile_id', p,
    'return_to', 'https://postora.cloud/profiles?from=test'),
    format('V2 nonce-only consume returns only owner, profile and return URL: %s', consumed);
  ASSERT NOT (consumed ? 'nonce_digest') AND NOT (consumed ? 'nonce'),
    'V2 consume returns neither digest nor nonce';

  consumed := public.consume_youtube_oauth_attempt_by_nonce(
    (SELECT v ->> 'nonce' FROM yoa_v2_state WHERE k = 'created'));
  ASSERT consumed = '{"ok":false,"reason":"already_consumed"}'::jsonb,
    format('V2 replay refused: %s', consumed);
END
$create_and_consume$;

DO $refusals$
DECLARE
  u uuid := '0ed00001-0000-4000-8000-000000000001';
  p uuid := '0ed10001-0000-4000-8000-000000000011';
  created jsonb := public.create_youtube_oauth_attempt_v2(
    u, p, 'https://postora.cloud/profiles', 60);
  unknown jsonb := public.create_youtube_oauth_attempt_v2(
    u, p, 'https://postora.cloud/profiles', 600);
  result jsonb;
BEGIN
  UPDATE public.youtube_oauth_attempts
     SET created_at = clock_timestamp() - interval '2 hours',
         expires_at = clock_timestamp() - interval '1 hour'
   WHERE id = (created ->> 'attempt_id')::uuid;
  result := public.consume_youtube_oauth_attempt_by_nonce(created ->> 'nonce');
  ASSERT result = '{"ok":false,"reason":"expired"}'::jsonb,
    format('V2 expired attempt refused: %s', result);

  DELETE FROM public.youtube_oauth_attempts
   WHERE id = (unknown ->> 'attempt_id')::uuid;
  result := public.consume_youtube_oauth_attempt_by_nonce(unknown ->> 'nonce');
  ASSERT result = '{"ok":false,"reason":"not_found"}'::jsonb,
    format('V2 unknown nonce refused: %s', result);

  result := public.consume_youtube_oauth_attempt_by_nonce(substr(unknown ->> 'nonce', 1, 63));
  ASSERT result = '{"ok":false,"reason":"invalid_nonce"}'::jsonb,
    format('V2 wrong-length nonce refused: %s', result);
  result := public.consume_youtube_oauth_attempt_by_nonce(NULL);
  ASSERT result = '{"ok":false,"reason":"invalid_request"}'::jsonb,
    format('V2 NULL nonce refused: %s', result);

  BEGIN
    PERFORM public.create_youtube_oauth_attempt_v2(u, p, NULL, 600);
    RAISE EXCEPTION 'V2 create accepted a NULL return URL' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YOA01' THEN NULL;
  END;
  BEGIN
    PERFORM public.create_youtube_oauth_attempt_v2(
      u, '0ed1ffff-0000-4000-8000-00000000ffff', 'https://postora.cloud/profiles', 600);
    RAISE EXCEPTION 'V2 create accepted an unowned profile' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YOA02' THEN NULL;
  END;
END
$refusals$;

DO $privileges$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
     WHERE p.oid IN (
       'public.create_youtube_oauth_attempt_v2(uuid, uuid, text, integer)'::regprocedure,
       'public.consume_youtube_oauth_attempt_by_nonce(text)'::regprocedure)
       AND x.grantee = 0),
    'V2 PUBLIC holds no EXECUTE on the RPCs';
  ASSERT NOT has_function_privilege('anon',
    'public.create_youtube_oauth_attempt_v2(uuid,uuid,text,integer)', 'EXECUTE'),
    'V2 anon cannot create attempts';
  ASSERT NOT has_function_privilege('authenticated',
    'public.create_youtube_oauth_attempt_v2(uuid,uuid,text,integer)', 'EXECUTE'),
    'V2 authenticated cannot create attempts';
  -- PUBLIC EXECUTE checked above for both RPCs.
  ASSERT NOT has_function_privilege('anon',
    'public.consume_youtube_oauth_attempt_by_nonce(text)', 'EXECUTE'),
    'V2 anon cannot consume attempts';
  ASSERT NOT has_function_privilege('authenticated',
    'public.consume_youtube_oauth_attempt_by_nonce(text)', 'EXECUTE'),
    'V2 authenticated cannot consume attempts';
  ASSERT has_function_privilege('service_role',
    'public.create_youtube_oauth_attempt_v2(uuid,uuid,text,integer)', 'EXECUTE'),
    'V2 service role can create attempts';
  ASSERT has_function_privilege('service_role',
    'public.consume_youtube_oauth_attempt_by_nonce(text)', 'EXECUTE'),
    'V2 service role can consume attempts';
END
$privileges$;

ROLLBACK;

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
CREATE TEMP TABLE yoa_v2_race_state (k text PRIMARY KEY, v jsonb);
CREATE TEMP TABLE yoa_v2_race_results (result jsonb);

BEGIN;
INSERT INTO auth.users (id, email) VALUES
  ('0ed00001-0000-4000-8000-000000000001', 'yoa-v2-owner@example.invalid');
INSERT INTO public.social_profiles (id, user_id, name) VALUES
  ('0ed10001-0000-4000-8000-000000000011', '0ed00001-0000-4000-8000-000000000001', 'YOA v2 race profile');
INSERT INTO yoa_v2_race_state
SELECT 'attempt', public.create_youtube_oauth_attempt_v2(
  '0ed00001-0000-4000-8000-000000000001',
  '0ed10001-0000-4000-8000-000000000011',
  'https://postora.cloud/profiles', 600);
COMMIT;

SELECT extensions.dblink_connect('yoa_v2_a',
  'dbname=' || current_database() || ' user=' || current_user || ' application_name=yoa_v2_a');
SELECT extensions.dblink_connect('yoa_v2_b',
  'dbname=' || current_database() || ' user=' || current_user || ' application_name=yoa_v2_b');
SELECT extensions.dblink_send_query('yoa_v2_a', format(
  'SELECT public.consume_youtube_oauth_attempt_by_nonce(%L)',
  (SELECT v ->> 'nonce' FROM yoa_v2_race_state WHERE k = 'attempt')));
SELECT extensions.dblink_send_query('yoa_v2_b', format(
  'SELECT public.consume_youtube_oauth_attempt_by_nonce(%L)',
  (SELECT v ->> 'nonce' FROM yoa_v2_race_state WHERE k = 'attempt')));
INSERT INTO yoa_v2_race_results
SELECT result FROM extensions.dblink_get_result('yoa_v2_a') AS r(result jsonb);
INSERT INTO yoa_v2_race_results
SELECT result FROM extensions.dblink_get_result('yoa_v2_b') AS r(result jsonb);

DO $race$
BEGIN
  ASSERT (SELECT count(*) FROM yoa_v2_race_results WHERE (result ->> 'ok')::boolean) = 1,
    'V2 concurrent consume has exactly one winner';
  ASSERT (SELECT count(*) FROM yoa_v2_race_results
           WHERE result = '{"ok":false,"reason":"already_consumed"}'::jsonb) = 1,
    'V2 concurrent loser is refused as a replay';
END
$race$;

SELECT extensions.dblink_disconnect('yoa_v2_a');
SELECT extensions.dblink_disconnect('yoa_v2_b');
DELETE FROM auth.users WHERE id = '0ed00001-0000-4000-8000-000000000001';

\echo '=== youtube_oauth_attempts_v2: ALL CHECKS PASSED ==='
