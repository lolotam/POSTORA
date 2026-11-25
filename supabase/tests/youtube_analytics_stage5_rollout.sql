-- YouTube Stage 5 analytics rollout SQL proof.
-- Runs as supabase_admin against the disposable baseline-plus-delta database.
-- Synthetic committed fixtures support real dblink interleavings and are removed
-- at the end. No provider calls and no real credentials are used.

\set ON_ERROR_STOP on
SET plpgsql.check_asserts = on;

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

SELECT to_regprocedure(
  'public.youtube_analytics_stage5_decide(uuid,uuid,text,bigint,uuid,text[],integer,boolean)'
) IS NOT NULL AS s5_migrated \gset

\if :s5_migrated
DELETE FROM public.youtube_analytics_purpose_consents;
DELETE FROM public.app_settings
 WHERE key IN ('youtube_analytics_stage5_rollout', 'youtube_analytics_stage5_scope_gate');
\ir ../migrations/20261125120000_youtube_stage5_analytics_rollout.sql
\endif

DO $seeding$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.app_settings
     WHERE key IN ('youtube_analytics_stage5_rollout', 'youtube_analytics_stage5_scope_gate')
  ), 'the migration seeds neither private key';
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_analytics_purpose_consents),
    'the migration seeds no acceptance event';
END
$seeding$;

CREATE FUNCTION pg_temp.s5_owner_a() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '6e5a0001-0000-4000-8000-000000000001'::uuid $$;
CREATE FUNCTION pg_temp.s5_owner_b() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '6e5a0002-0000-4000-8000-000000000002'::uuid $$;
CREATE FUNCTION pg_temp.s5_admin() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '6e5a0003-0000-4000-8000-000000000003'::uuid $$;
CREATE FUNCTION pg_temp.s5_main() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '6e5b0001-0000-4000-8000-000000000001'::uuid $$;
CREATE FUNCTION pg_temp.s5_second() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '6e5b0002-0000-4000-8000-000000000002'::uuid $$;
CREATE FUNCTION pg_temp.s5_foreign() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '6e5b0003-0000-4000-8000-000000000003'::uuid $$;
CREATE FUNCTION pg_temp.s5_non_youtube() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '6e5b0004-0000-4000-8000-000000000004'::uuid $$;
CREATE FUNCTION pg_temp.s5_inactive() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '6e5b0005-0000-4000-8000-000000000005'::uuid $$;
CREATE FUNCTION pg_temp.s5_composio() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '6e5b0006-0000-4000-8000-000000000006'::uuid $$;
CREATE FUNCTION pg_temp.s5_connection() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '6e5c0001-0000-4000-8000-000000000001'::uuid $$;
CREATE FUNCTION pg_temp.s5_workspace() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '6e5d0001-0000-4000-8000-000000000001'::uuid $$;

CREATE FUNCTION pg_temp.s5_allowlist(p_accounts uuid[] DEFAULT ARRAY[pg_temp.s5_main()])
RETURNS jsonb LANGUAGE sql IMMUTABLE AS
  $$ SELECT jsonb_build_object(
       'version', 1, 'mode', 'allowlist',
       'account_ids', COALESCE(to_jsonb(p_accounts), '[]'::jsonb)) $$;

CREATE FUNCTION pg_temp.s5_decide(
  p_owner uuid DEFAULT pg_temp.s5_owner_a(),
  p_account uuid DEFAULT pg_temp.s5_main(),
  p_with_credentials boolean DEFAULT false,
  p_version integer DEFAULT 1
) RETURNS jsonb LANGUAGE sql AS
  $$ SELECT public.youtube_analytics_stage5_decide(
       p_owner, p_account, NULL, NULL, NULL,
       ARRAY['scope.a', 'scope.b'], p_version, p_with_credentials) $$;

CREATE FUNCTION pg_temp.s5_bound_decide(
  p_owner uuid DEFAULT pg_temp.s5_owner_a(),
  p_account uuid DEFAULT pg_temp.s5_main(),
  p_with_credentials boolean DEFAULT false,
  p_version integer DEFAULT 1
) RETURNS jsonb LANGUAGE sql AS
  $$ SELECT public.youtube_analytics_stage5_decide(
       p_owner, p_account, sa.platform_user_id, sa.binding_generation,
       COALESCE(sa.binding_incarnation, '00000000-0000-0000-0000-000000000000'::uuid),
       ARRAY['scope.a', 'scope.b'], p_version, p_with_credentials)
     FROM public.social_accounts AS sa WHERE sa.id = p_account $$;

CREATE FUNCTION pg_temp.s5_accept(
  p_owner uuid DEFAULT pg_temp.s5_owner_a(),
  p_account uuid DEFAULT pg_temp.s5_main(),
  p_version integer DEFAULT 1,
  p_expected_revision text DEFAULT NULL
) RETURNS jsonb LANGUAGE sql AS
  $$ SELECT public.youtube_analytics_stage5_record_consent(
       p_owner, p_account, 'accepted', p_version, 'en',
       's5-accept-' || gen_random_uuid()::text, p_expected_revision) $$;

CREATE FUNCTION pg_temp.s5_withdraw(
  p_owner uuid DEFAULT pg_temp.s5_owner_a(),
  p_account uuid DEFAULT pg_temp.s5_main(),
  p_version integer DEFAULT 1
) RETURNS jsonb LANGUAGE sql AS
  $$ SELECT public.youtube_analytics_stage5_record_consent(
       p_owner, p_account, 'withdrawn', p_version, 'ar',
       's5-withdraw-' || gen_random_uuid()::text, NULL) $$;

CREATE FUNCTION pg_temp.s5_restore_main() RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  DELETE FROM public.youtube_token_refresh_leases
   WHERE social_account_id IN (pg_temp.s5_main(), pg_temp.s5_second(), pg_temp.s5_foreign());
  DELETE FROM public.youtube_analytics_purpose_consents
   WHERE owner_id IN (pg_temp.s5_owner_a(), pg_temp.s5_owner_b());
  UPDATE public.social_accounts
     SET platform = 'youtube', platform_user_id = 'UC-s5-main',
         auth_provider = 'native', connection_id = NULL,
         is_active = true, access_token = 's5-access-1', refresh_token = 's5-refresh-1',
         token_expires_at = clock_timestamp() + interval '1 hour',
         needs_reauth = false, failure_count = 0, last_refresh_error = NULL,
         account_metadata = '{"granted_scopes":["scope.a","scope.b"]}'::jsonb
   WHERE id = pg_temp.s5_main();
  INSERT INTO public.app_settings (key, value, description)
  VALUES ('youtube_analytics_stage5_rollout', pg_temp.s5_allowlist(), 'Stage 5 SQL suite')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description;
  PERFORM pg_temp.s5_accept();
END
$f$;

CREATE FUNCTION pg_temp.s5_condition_decision(p_conditions text[], p_bound boolean)
RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  v_channel text;
  v_generation bigint;
  v_incarnation uuid;
BEGIN
  PERFORM pg_temp.s5_restore_main();
  IF 'not_enabled' = ANY(p_conditions) THEN
    UPDATE public.app_settings
       SET value = '{"version":1,"mode":"off","account_ids":[]}'::jsonb
     WHERE key = 'youtube_analytics_stage5_rollout';
  END IF;
  IF 'consent_required' = ANY(p_conditions) THEN
    DELETE FROM public.youtube_analytics_purpose_consents WHERE owner_id = pg_temp.s5_owner_a();
  END IF;
  IF 'missing_scope' = ANY(p_conditions) THEN
    UPDATE public.social_accounts SET account_metadata = '{"granted_scopes":["scope.a"]}'::jsonb
     WHERE id = pg_temp.s5_main();
  END IF;
  IF 'reconnect_required' = ANY(p_conditions) THEN
    UPDATE public.social_accounts SET needs_reauth = true WHERE id = pg_temp.s5_main();
  END IF;
  IF 'provider_unsupported' = ANY(p_conditions) THEN
    UPDATE public.social_accounts
       SET auth_provider = 'composio', connection_id = pg_temp.s5_connection(),
           access_token = NULL, refresh_token = NULL
     WHERE id = pg_temp.s5_main();
  END IF;
  IF 'not_found' = ANY(p_conditions) THEN
    UPDATE public.social_accounts SET is_active = false WHERE id = pg_temp.s5_main();
  END IF;
  IF NOT p_bound THEN
    RETURN pg_temp.s5_decide();
  END IF;
  SELECT platform_user_id, binding_generation,
         COALESCE(binding_incarnation, '00000000-0000-0000-0000-000000000000'::uuid)
    INTO v_channel, v_generation, v_incarnation
    FROM public.social_accounts WHERE id = pg_temp.s5_main();
  IF 'connection_changed' = ANY(p_conditions) THEN
    v_incarnation := gen_random_uuid();
  END IF;
  RETURN public.youtube_analytics_stage5_decide(
    pg_temp.s5_owner_a(), pg_temp.s5_main(), v_channel, v_generation, v_incarnation,
    ARRAY['scope.a', 'scope.b'], 1, true);
END
$f$;

CREATE FUNCTION pg_temp.s5_sessions() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['s5_a', 's5_b', 's5_c'] LOOP
    BEGIN PERFORM extensions.dblink_disconnect(v_name); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM extensions.dblink_connect(
      v_name, format('dbname=%s user=%s application_name=%s', current_database(), current_user, v_name));
  END LOOP;
END
$f$;

CREATE FUNCTION pg_temp.s5_pid(p_session text) RETURNS integer LANGUAGE sql AS
  $$ SELECT pid FROM extensions.dblink(p_session, 'SELECT pg_backend_pid()') AS t(pid int) $$;

CREATE FUNCTION pg_temp.s5_wait_blocked_by(p_pid int, p_blocker int, p_label text)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_attempt integer := 0;
BEGIN
  LOOP
    PERFORM pg_stat_clear_snapshot();
    EXIT WHEN p_blocker = ANY(pg_blocking_pids(p_pid));
    v_attempt := v_attempt + 1;
    IF v_attempt > 100 THEN
      RAISE EXCEPTION '% was not blocked by % (blockers: %)', p_label, p_blocker, pg_blocking_pids(p_pid);
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
END
$f$;

CREATE FUNCTION pg_temp.s5_budget_key(p_kind text, p_at timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT 's5:youtube-analytics:budget:' || p_kind || ':'
       || to_char(p_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD') $$;

CREATE FUNCTION pg_temp.s5_budget_accepts(p_result jsonb, p_ceiling integer)
RETURNS boolean LANGUAGE sql IMMUTABLE AS
  $$ SELECT COALESCE((p_result ->> 'allowed')::boolean, false)
       AND COALESCE((p_result ->> 'count')::integer, 0) BETWEEN 1 AND p_ceiling $$;

-- Self-heal a previously interrupted run, then create committed fixtures.
DELETE FROM public.youtube_token_refresh_leases
 WHERE social_account_id IN (
   '6e5b0001-0000-4000-8000-000000000001', '6e5b0002-0000-4000-8000-000000000002',
   '6e5b0003-0000-4000-8000-000000000003', '6e5b0004-0000-4000-8000-000000000004',
   '6e5b0005-0000-4000-8000-000000000005', '6e5b0006-0000-4000-8000-000000000006',
   '6e5b0010-0000-4000-8000-000000000010', '6e5b0011-0000-4000-8000-000000000011');
DELETE FROM public.youtube_analytics_purpose_consents
 WHERE owner_id IN (pg_temp.s5_owner_a(), pg_temp.s5_owner_b(), pg_temp.s5_admin());
DELETE FROM public.social_accounts
 WHERE id IN (
   pg_temp.s5_main(), pg_temp.s5_second(), pg_temp.s5_foreign(), pg_temp.s5_non_youtube(),
   pg_temp.s5_inactive(), pg_temp.s5_composio(),
   '6e5b0010-0000-4000-8000-000000000010', '6e5b0011-0000-4000-8000-000000000011');
DELETE FROM public.connector_connections WHERE id = pg_temp.s5_connection();
DELETE FROM public.workspaces WHERE id = pg_temp.s5_workspace();
DELETE FROM public.app_settings
 WHERE key IN ('youtube_analytics_stage5_rollout', 'youtube_analytics_stage5_scope_gate', 'feature_s5_suite')
    OR description = 'Stage 5 SQL suite';
DELETE FROM public.rate_limit_buckets WHERE bucket_key LIKE 's5:%';
DELETE FROM auth.users WHERE id IN (pg_temp.s5_owner_a(), pg_temp.s5_owner_b(), pg_temp.s5_admin());

INSERT INTO auth.users (id, email) VALUES
  (pg_temp.s5_owner_a(), 's5-owner-a@example.invalid'),
  (pg_temp.s5_owner_b(), 's5-owner-b@example.invalid'),
  (pg_temp.s5_admin(), 's5-admin@example.invalid');
INSERT INTO public.user_roles (user_id, role) VALUES (pg_temp.s5_admin(), 'admin');

INSERT INTO public.workspaces (id, owner_id, name, is_personal)
VALUES (pg_temp.s5_workspace(), pg_temp.s5_owner_a(), 'S5 Suite', true);
INSERT INTO public.connector_connections (
  id, workspace_id, connector_type, toolkit, composio_auth_config_id, external_account_id, status
) VALUES (
  pg_temp.s5_connection(), pg_temp.s5_workspace(), 'youtube', 'youtube',
  'ac-s5-suite', 'ext-s5-suite', 'active');

INSERT INTO public.social_accounts (
  id, user_id, platform, platform_user_id, platform_username,
  access_token, refresh_token, token_expires_at, is_active, auth_provider,
  connection_id, needs_reauth, failure_count, account_metadata
) VALUES
  (pg_temp.s5_main(), pg_temp.s5_owner_a(), 'youtube', 'UC-s5-main', 's5-main',
   's5-access-1', 's5-refresh-1', clock_timestamp() + interval '1 hour', true, 'native',
   NULL, false, 0, '{"granted_scopes":["scope.a","scope.b"]}'::jsonb),
  (pg_temp.s5_second(), pg_temp.s5_owner_a(), 'youtube', 'UC-s5-second', 's5-second',
   's5-second-access', 's5-second-refresh', clock_timestamp() + interval '1 hour', true, 'native',
   NULL, false, 0, '{"granted_scopes":["scope.a","scope.b"]}'::jsonb),
  (pg_temp.s5_foreign(), pg_temp.s5_owner_b(), 'youtube', 'UC-s5-main', 's5-foreign',
   's5-foreign-access', 's5-foreign-refresh', clock_timestamp() + interval '1 hour', true, 'native',
   NULL, false, 0, '{"granted_scopes":["scope.a","scope.b"]}'::jsonb),
  (pg_temp.s5_non_youtube(), pg_temp.s5_owner_a(), 'facebook', 'fb-s5', 's5-facebook',
   's5-facebook-access', NULL, clock_timestamp() + interval '1 hour', true, 'native',
   NULL, false, 0, '{}'::jsonb),
  (pg_temp.s5_inactive(), pg_temp.s5_owner_a(), 'youtube', 'UC-s5-inactive', 's5-inactive',
   's5-inactive-access', 's5-inactive-refresh', clock_timestamp() + interval '1 hour', false, 'native',
   NULL, false, 0, '{}'::jsonb),
  (pg_temp.s5_composio(), pg_temp.s5_owner_a(), 'youtube', 'UC-s5-composio', 's5-composio',
   NULL, NULL, NULL, true, 'composio', pg_temp.s5_connection(), false, 0, '{}'::jsonb);

INSERT INTO public.app_settings (key, value, description) VALUES
  ('youtube_analytics_stage5_rollout', pg_temp.s5_allowlist(), 'Stage 5 SQL suite'),
  ('feature_s5_suite', 'true'::jsonb, 'Stage 5 SQL suite');

-- Old-code compatibility and the two-key privacy boundary.
SET ROLE authenticated;
SELECT set_config('request.jwt.claims',
  jsonb_build_object('sub', pg_temp.s5_owner_a(), 'role', 'authenticated')::text, false);
DO $ordinary_settings$
BEGIN
  ASSERT (SELECT count(*) FROM public.app_settings
           WHERE key IN ('youtube_analytics_stage5_rollout', 'youtube_analytics_stage5_scope_gate')) = 0,
    'a non-admin authenticated session reads neither protected key';
  ASSERT (SELECT count(*) FROM public.app_settings WHERE key = 'feature_s5_suite') = 1,
    'another feature setting remains readable';
  UPDATE public.app_settings SET value = 'false'::jsonb WHERE key = 'youtube_analytics_stage5_rollout';
  UPDATE public.app_settings SET key = 'youtube_analytics_stage5_scope_gate' WHERE key = 'feature_s5_suite';
  UPDATE public.app_settings SET key = 'feature_s5_stolen' WHERE key = 'youtube_analytics_stage5_rollout';
  DELETE FROM public.app_settings WHERE key = 'youtube_analytics_stage5_rollout';
  BEGIN
    INSERT INTO public.app_settings (key, value) VALUES ('youtube_analytics_stage5_scope_gate', '{}'::jsonb);
    RAISE EXCEPTION 'a non-admin inserted a protected key';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$ordinary_settings$;
RESET ROLE;

DO $ordinary_settings_unchanged$
BEGIN
  ASSERT (SELECT value FROM public.app_settings WHERE key = 'youtube_analytics_stage5_rollout')
      = pg_temp.s5_allowlist(), 'a non-admin update changed no protected value';
  ASSERT EXISTS (SELECT 1 FROM public.app_settings WHERE key = 'feature_s5_suite'),
    'a non-admin cannot rename another key into a protected key';
  ASSERT NOT EXISTS (SELECT 1 FROM public.app_settings WHERE key = 'feature_s5_stolen'),
    'a non-admin cannot rename a protected key out of the boundary';
END
$ordinary_settings_unchanged$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claims',
  jsonb_build_object('sub', pg_temp.s5_admin(), 'role', 'authenticated')::text, false);
DO $admin_settings$
BEGIN
  ASSERT (SELECT count(*) FROM public.app_settings WHERE key = 'youtube_analytics_stage5_rollout') = 1,
    'an admin acting through authenticated reads the rollout';
  UPDATE public.app_settings SET value = pg_temp.s5_allowlist(ARRAY[pg_temp.s5_main(), pg_temp.s5_second()])
   WHERE key = 'youtube_analytics_stage5_rollout';
  INSERT INTO public.app_settings (key, value, description)
  VALUES ('youtube_analytics_stage5_scope_gate', '{"version":1,"mode":"off","user_ids":[]}'::jsonb, 'Stage 5 SQL suite');
  UPDATE public.app_settings SET key = 'feature_s5_admin_rename' WHERE key = 'youtube_analytics_stage5_scope_gate';
  UPDATE public.app_settings SET key = 'youtube_analytics_stage5_scope_gate' WHERE key = 'feature_s5_admin_rename';
  DELETE FROM public.app_settings WHERE key = 'youtube_analytics_stage5_scope_gate';
  UPDATE public.app_settings SET value = 'false'::jsonb WHERE key = 'feature_s5_suite';
END
$admin_settings$;
RESET ROLE;

SET ROLE service_role;
DO $service_settings$
BEGIN
  ASSERT (SELECT count(*) FROM public.app_settings WHERE key = 'youtube_analytics_stage5_rollout') = 1,
    'service_role reads the private rollout';
  UPDATE public.app_settings SET value = pg_temp.s5_allowlist() WHERE key = 'youtube_analytics_stage5_rollout';
  INSERT INTO public.app_settings (key, value, description)
  VALUES ('youtube_analytics_stage5_scope_gate', '{"version":1,"mode":"off","user_ids":[]}'::jsonb, 'Stage 5 SQL suite');
  DELETE FROM public.app_settings WHERE key = 'youtube_analytics_stage5_scope_gate';
END
$service_settings$;
RESET ROLE;

SET ROLE anon;
SELECT set_config('request.jwt.claims', '{}', false);
DO $anon_settings$
BEGIN
  ASSERT (SELECT count(*) FROM public.app_settings
           WHERE key IN ('youtube_analytics_stage5_rollout', 'youtube_analytics_stage5_scope_gate')) = 0,
    'anon reads neither protected key';
  ASSERT (SELECT count(*) FROM public.app_settings WHERE key = 'feature_s5_suite') = 0,
    'the pre-existing anon boundary for other settings is unchanged';
  BEGIN
    INSERT INTO public.app_settings (key, value) VALUES ('youtube_analytics_stage5_rollout', '{}'::jsonb);
    RAISE EXCEPTION 'anon inserted a protected key';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$anon_settings$;
RESET ROLE;

-- Function, table, and narrow-role privileges.
DO $boundary$
DECLARE
  v_fn text;
  v_privilege text;
BEGIN
  ASSERT NOT (SELECT prosecdef FROM pg_proc
               WHERE oid = 'public.youtube_stage5_assign_binding_incarnation()'::regprocedure),
    'the incarnation trigger is SECURITY INVOKER';
  ASSERT (SELECT bool_and(p.prosecdef AND 'search_path=public, pg_temp' = ANY(p.proconfig))
           FROM pg_proc p WHERE p.oid IN (
             'public.youtube_analytics_stage5_parse_policy(jsonb,uuid)'::regprocedure,
             'public.youtube_analytics_stage5_record_consent(uuid,uuid,text,integer,text,text,text)'::regprocedure,
             'public.youtube_analytics_stage5_decide(uuid,uuid,text,bigint,uuid,text[],integer,boolean)'::regprocedure,
             'public.youtube_analytics_stage5_acquire_lease(uuid,uuid,text,bigint,uuid,text[],integer,integer)'::regprocedure,
             'public.youtube_analytics_stage5_store_token(uuid,uuid,text,bigint,uuid,uuid,text,timestamptz,text)'::regprocedure)),
    'exactly the five RPC/helper functions are SECURITY DEFINER with pinned paths';
  FOREACH v_fn IN ARRAY ARRAY[
    'public.youtube_analytics_stage5_parse_policy(jsonb,uuid)',
    'public.youtube_analytics_stage5_record_consent(uuid,uuid,text,integer,text,text,text)',
    'public.youtube_analytics_stage5_decide(uuid,uuid,text,bigint,uuid,text[],integer,boolean)',
    'public.youtube_analytics_stage5_acquire_lease(uuid,uuid,text,bigint,uuid,text[],integer,integer)',
    'public.youtube_analytics_stage5_store_token(uuid,uuid,text,bigint,uuid,uuid,text,timestamptz,text)',
    'public.youtube_stage5_assign_binding_incarnation()'
  ] LOOP
    ASSERT NOT has_function_privilege('anon', v_fn, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', v_fn, 'EXECUTE'),
      format('browser roles cannot execute %s', v_fn);
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.youtube_analytics_stage5_record_consent(uuid,uuid,text,integer,text,text,text)',
    'public.youtube_analytics_stage5_decide(uuid,uuid,text,bigint,uuid,text[],integer,boolean)',
    'public.youtube_analytics_stage5_acquire_lease(uuid,uuid,text,bigint,uuid,text[],integer,integer)',
    'public.youtube_analytics_stage5_store_token(uuid,uuid,text,bigint,uuid,uuid,text,timestamptz,text)'
  ] LOOP
    ASSERT has_function_privilege('service_role', v_fn, 'EXECUTE'), format('service_role executes %s', v_fn);
  END LOOP;
  ASSERT NOT has_function_privilege('service_role',
    'public.youtube_analytics_stage5_parse_policy(jsonb,uuid)', 'EXECUTE'),
    'the parser has no direct service caller';
  FOREACH v_privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
    FOREACH v_fn IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      ASSERT NOT has_table_privilege(v_fn, 'public.youtube_analytics_purpose_consents', v_privilege),
        format('%s holds no %s on the acceptance table', v_fn, v_privilege);
    END LOOP;
  END LOOP;
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.youtube_analytics_purpose_consents'::regclass)
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'youtube_analytics_purpose_consents'),
    'the acceptance table has RLS and no policies';
  ASSERT (
    SELECT array_agg(p.proname::text ORDER BY p.proname)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND position('youtube_analytics_purpose_consents' IN p.prosrc) > 0
  ) = ARRAY['youtube_analytics_stage5_decide', 'youtube_analytics_stage5_record_consent'],
    'only decide and record_consent touch the acceptance table';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
     WHERE c.conrelid = 'public.youtube_analytics_purpose_consents'::regclass
       AND c.contype = 'f' AND a.attname = 'social_account_id'),
    'social_account_id has no delete-mutating foreign key';
  ASSERT (SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p
            JOIN pg_roles r ON r.oid = p.proowner WHERE r.rolname = 'youtube_stage4_refresh')
      = ARRAY['store_youtube_refreshed_token','store_youtube_refreshed_token_with_lease','store_youtube_refreshed_token_with_lease_neutral'],
    'the narrow role still owns exactly three functions';
  ASSERT NOT has_column_privilege('youtube_stage4_refresh', 'public.social_accounts', 'binding_incarnation', 'UPDATE'),
    'the narrow role cannot update the incarnation';
END
$boundary$;

-- Pure policy parsing, including the exact 200-entry boundary.
DO $parser$
DECLARE
  v_accounts jsonb;
  v_expected text;
  v_actual text;
  v_case record;
BEGIN
  FOR v_case IN SELECT * FROM (VALUES
    ('missing', NULL::jsonb, 'missing'),
    ('scalar', '1'::jsonb, 'invalid'),
    ('unknown key', '{"version":1,"mode":"all","account_ids":[],"extra":true}'::jsonb, 'invalid'),
    ('version', '{"version":2,"mode":"all","account_ids":[]}'::jsonb, 'invalid'),
    ('mode', '{"version":1,"mode":"everyone","account_ids":[]}'::jsonb, 'invalid'),
    ('accounts', '{"version":1,"mode":"all"}'::jsonb, 'invalid'),
    ('non uuid', '{"version":1,"mode":"allowlist","account_ids":["not-a-uuid"]}'::jsonb, 'invalid'),
    ('off', '{"version":1,"mode":"off","account_ids":[]}'::jsonb, 'off'),
    ('all', '{"version":1,"mode":"all","account_ids":[]}'::jsonb, 'ok'),
    ('not listed', pg_temp.s5_allowlist(ARRAY[pg_temp.s5_second()]), 'not_listed'),
    ('listed', pg_temp.s5_allowlist(), 'ok')
  ) AS cases(label, policy, expected)
  LOOP
    v_actual := public.youtube_analytics_stage5_parse_policy(v_case.policy, pg_temp.s5_main());
    ASSERT v_actual = v_case.expected, format('policy %s: expected %s, got %s', v_case.label, v_case.expected, v_actual);
  END LOOP;
  SELECT jsonb_agg(gen_random_uuid()::text) INTO v_accounts FROM generate_series(1, 200);
  v_actual := public.youtube_analytics_stage5_parse_policy(
    jsonb_build_object('version', 1, 'mode', 'all', 'account_ids', v_accounts), pg_temp.s5_main());
  ASSERT v_actual = 'ok', '200 entries are valid';
  SELECT jsonb_agg(gen_random_uuid()::text) INTO v_accounts FROM generate_series(1, 201);
  v_actual := public.youtube_analytics_stage5_parse_policy(
    jsonb_build_object('version', 1, 'mode', 'all', 'account_ids', v_accounts), pg_temp.s5_main());
  ASSERT v_actual = 'invalid', '201 entries invalidate the whole policy';
END
$parser$;

-- Incarnation assignment and non-reuse after delete/re-insert.
DO $incarnation$
DECLARE
  v_supplied uuid := '11111111-1111-4111-8111-111111111111';
  v_first uuid;
  v_second uuid;
  v_revision_first text;
  v_revision_second text;
  v_decision jsonb;
BEGIN
  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, access_token, is_active, auth_provider, binding_incarnation
  ) VALUES (
    '6e5b0010-0000-4000-8000-000000000010', pg_temp.s5_owner_a(), 'youtube', 'UC-s5-incarnation',
    'inc-access', true, 'native', v_supplied);
  SELECT binding_incarnation INTO v_first FROM public.social_accounts
   WHERE id = '6e5b0010-0000-4000-8000-000000000010';
  ASSERT v_first IS NOT NULL AND v_first <> v_supplied, 'an insert ignores the client incarnation';
  UPDATE public.social_accounts SET binding_incarnation = v_supplied
   WHERE id = '6e5b0010-0000-4000-8000-000000000010';
  ASSERT (SELECT binding_incarnation FROM public.social_accounts
           WHERE id = '6e5b0010-0000-4000-8000-000000000010') = v_first,
    'an update cannot change the incarnation';
  UPDATE public.social_accounts SET platform = 'facebook'
   WHERE id = '6e5b0010-0000-4000-8000-000000000010';
  ASSERT (SELECT binding_incarnation FROM public.social_accounts
           WHERE id = '6e5b0010-0000-4000-8000-000000000010') IS NULL,
    'switching away from YouTube clears the incarnation';
  UPDATE public.social_accounts SET platform = 'youtube'
   WHERE id = '6e5b0010-0000-4000-8000-000000000010';
  SELECT binding_incarnation INTO v_second FROM public.social_accounts
   WHERE id = '6e5b0010-0000-4000-8000-000000000010';
  ASSERT v_second IS NOT NULL AND v_second <> v_first, 'switching to YouTube assigns a fresh incarnation';

  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, access_token, is_active, auth_provider, binding_incarnation
  ) VALUES (
    '6e5b0011-0000-4000-8000-000000000011', pg_temp.s5_owner_a(), 'facebook', 'fb-incarnation',
    'fb-access', true, 'native', v_supplied);
  ASSERT (SELECT binding_incarnation FROM public.social_accounts
           WHERE id = '6e5b0011-0000-4000-8000-000000000011') IS NULL,
    'a non-YouTube insert is always NULL';

  UPDATE public.app_settings SET value = '{"version":1,"mode":"all","account_ids":[]}'::jsonb
   WHERE key = 'youtube_analytics_stage5_rollout';
  v_decision := pg_temp.s5_accept(pg_temp.s5_owner_a(), '6e5b0010-0000-4000-8000-000000000010');
  ASSERT (v_decision ->> 'ok')::boolean, format('incarnation account accepted: %s', v_decision);
  v_revision_first := v_decision ->> 'connection_revision';
  DELETE FROM public.social_accounts WHERE id = '6e5b0010-0000-4000-8000-000000000010';
  ASSERT (SELECT social_account_id FROM public.youtube_analytics_purpose_consents
           WHERE owner_id = pg_temp.s5_owner_a() AND channel_id = 'UC-s5-incarnation')
      = '6e5b0010-0000-4000-8000-000000000010',
    'account deletion leaves the historical account reference untouched';
  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, access_token, is_active, auth_provider
  ) VALUES (
    '6e5b0010-0000-4000-8000-000000000010', pg_temp.s5_owner_a(), 'youtube', 'UC-s5-incarnation',
    'inc-access-2', true, 'native');
  ASSERT (SELECT binding_incarnation FROM public.social_accounts
           WHERE id = '6e5b0010-0000-4000-8000-000000000010') <> v_second,
    'delete/re-insert never reuses the incarnation';
  v_decision := pg_temp.s5_decide(pg_temp.s5_owner_a(), '6e5b0010-0000-4000-8000-000000000010');
  ASSERT v_decision ->> 'reason' = 'ok' AND v_decision -> 'consent' ->> 'state' = 'accepted',
    'acceptance survives delete/re-insert by owner and channel';
  v_revision_second := v_decision ->> 'connection_revision';
  ASSERT v_revision_second <> v_revision_first, 'delete/re-insert changes the connection revision';

  UPDATE public.social_accounts SET access_token = 'inc-access-3'
   WHERE id = '6e5b0010-0000-4000-8000-000000000010';
  v_decision := pg_temp.s5_decide(pg_temp.s5_owner_a(), '6e5b0010-0000-4000-8000-000000000010');
  ASSERT v_decision ->> 'reason' = 'ok' AND v_decision ->> 'connection_revision' <> v_revision_second,
    'acceptance survives reconnect while the revision changes';

  ALTER TABLE public.social_accounts DISABLE TRIGGER trg_social_accounts_youtube_binding_incarnation;
  UPDATE public.social_accounts SET binding_incarnation = NULL
   WHERE id = '6e5b0010-0000-4000-8000-000000000010';
  ALTER TABLE public.social_accounts ENABLE TRIGGER trg_social_accounts_youtube_binding_incarnation;
  v_decision := pg_temp.s5_decide(pg_temp.s5_owner_a(), '6e5b0010-0000-4000-8000-000000000010');
  ASSERT v_decision ->> 'binding_incarnation' = '00000000-0000-0000-0000-000000000000',
    'an existing NULL incarnation reads as the all-zero UUID';
  ASSERT v_decision ->> 'connection_revision' = substr(encode(sha256(convert_to(
      '6e5b0010-0000-4000-8000-000000000010:00000000-0000-0000-0000-000000000000:'
      || (SELECT binding_generation::text FROM public.social_accounts
           WHERE id = '6e5b0010-0000-4000-8000-000000000010'), 'utf8')), 'hex'), 1, 32),
    'the NULL-incarnation revision uses the specified digest';
  DELETE FROM public.social_accounts WHERE id IN (
    '6e5b0010-0000-4000-8000-000000000010', '6e5b0011-0000-4000-8000-000000000011');
  PERFORM pg_temp.s5_restore_main();
END
$incarnation$;

-- Acceptance recording, state transitions, tenant isolation, and credentials.
DO $consent_and_decide$
DECLARE
  v_result jsonb;
  v_missing constant jsonb := pg_temp.s5_decide(pg_temp.s5_owner_a(), gen_random_uuid());
  v_revision text;
  v_count integer;
  v_pair record;
BEGIN
  DELETE FROM public.youtube_analytics_purpose_consents WHERE owner_id = pg_temp.s5_owner_a();
  v_result := pg_temp.s5_decide();
  ASSERT v_result ->> 'reason' = 'consent_required' AND v_result -> 'consent' ->> 'state' = 'none',
    format('no event is consent_required/none: %s', v_result);
  ASSERT v_result ? 'credentials' = false, 'a refusal contains no credentials';

  ASSERT pg_temp.s5_accept(pg_temp.s5_owner_b(), pg_temp.s5_main()) ->> 'reason' = 'not_found',
    'a foreign owner cannot accept';
  ASSERT pg_temp.s5_accept(pg_temp.s5_owner_a(), gen_random_uuid()) ->> 'reason' = 'not_found',
    'a missing account cannot accept';
  ASSERT pg_temp.s5_accept(pg_temp.s5_owner_a(), pg_temp.s5_non_youtube()) ->> 'reason' = 'not_found',
    'a non-YouTube account cannot accept';
  ASSERT pg_temp.s5_accept(pg_temp.s5_owner_a(), pg_temp.s5_inactive()) ->> 'reason' = 'not_found',
    'an inactive account cannot accept';
  ASSERT pg_temp.s5_accept(pg_temp.s5_owner_a(), pg_temp.s5_composio()) ->> 'reason' = 'provider_unsupported',
    'a Composio account cannot accept';
  ASSERT pg_temp.s5_accept(pg_temp.s5_owner_a(), pg_temp.s5_second()) ->> 'reason' = 'not_enabled',
    'an unlisted account cannot accept';

  v_result := pg_temp.s5_withdraw(pg_temp.s5_owner_a(), pg_temp.s5_inactive());
  ASSERT (v_result ->> 'ok')::boolean AND (v_result ->> 'recorded')::boolean,
    'withdrawal is allowed for an inactive account';
  v_result := pg_temp.s5_withdraw(pg_temp.s5_owner_a(), pg_temp.s5_second());
  ASSERT (v_result ->> 'ok')::boolean, 'withdrawal is allowed for an unlisted account';
  v_result := pg_temp.s5_withdraw(pg_temp.s5_owner_a(), pg_temp.s5_composio());
  ASSERT (v_result ->> 'ok')::boolean, 'withdrawal is allowed for a Composio account';

  v_result := pg_temp.s5_accept();
  ASSERT (v_result ->> 'ok')::boolean AND (v_result ->> 'recorded')::boolean
     AND v_result ->> 'channel_id' = 'UC-s5-main',
    format('acceptance copies the owned row channel: %s', v_result);
  v_revision := v_result ->> 'connection_revision';
  ASSERT (SELECT count(*) FROM public.youtube_analytics_purpose_consents
           WHERE owner_id = pg_temp.s5_owner_a() AND channel_id = 'UC-s5-main' AND event = 'accepted') = 1,
    'one acceptance row exists';
  v_result := pg_temp.s5_accept();
  ASSERT (v_result ->> 'ok')::boolean AND NOT (v_result ->> 'recorded')::boolean,
    'repeating the same acceptance is idempotent';
  v_result := pg_temp.s5_accept(pg_temp.s5_owner_a(), pg_temp.s5_main(), 1, repeat('0', 32));
  ASSERT v_result ->> 'reason' = 'connection_changed', 'a stale expected revision refuses acceptance';
  v_result := pg_temp.s5_accept(pg_temp.s5_owner_a(), pg_temp.s5_main(), 1, v_revision);
  ASSERT (v_result ->> 'ok')::boolean, 'the displayed revision can bind acceptance';

  v_result := pg_temp.s5_decide(pg_temp.s5_owner_a(), pg_temp.s5_main(), false);
  ASSERT v_result ->> 'reason' = 'ok' AND NOT (v_result ? 'credentials'),
    'success without a credential request omits credentials';
  ASSERT v_result ->> 'connection_revision' = v_revision,
    'decide and record_consent compute the identical connection_revision';
  v_result := pg_temp.s5_decide(pg_temp.s5_owner_a(), pg_temp.s5_main(), true);
  ASSERT v_result ->> 'reason' = 'ok'
     AND v_result -> 'credentials' ->> 'access_token' = 's5-access-1'
     AND v_result -> 'credentials' ->> 'refresh_token' = 's5-refresh-1',
    'success with a request returns the snapshot credentials';
  v_result := pg_temp.s5_bound_decide();
  ASSERT v_result ->> 'reason' = 'ok', 'the same bound connection passes';

  v_result := pg_temp.s5_decide(pg_temp.s5_owner_a(), pg_temp.s5_main(), false, 2);
  ASSERT v_result ->> 'reason' = 'consent_required' AND v_result -> 'consent' ->> 'state' = 'outdated',
    'a purpose-version bump makes acceptance outdated';
  v_result := pg_temp.s5_withdraw(pg_temp.s5_owner_a(), pg_temp.s5_main(), 2);
  ASSERT (v_result ->> 'recorded')::boolean, 'withdrawal appends a new event';
  v_result := pg_temp.s5_decide(pg_temp.s5_owner_a(), pg_temp.s5_main(), false, 2);
  ASSERT v_result ->> 'reason' = 'consent_required' AND v_result -> 'consent' ->> 'state' = 'withdrawn',
    'the latest withdrawal controls';
  v_result := pg_temp.s5_withdraw(pg_temp.s5_owner_a(), pg_temp.s5_main(), 2);
  ASSERT NOT (v_result ->> 'recorded')::boolean, 'repeating withdrawal is idempotent';
  v_result := pg_temp.s5_accept(pg_temp.s5_owner_a(), pg_temp.s5_main(), 2);
  ASSERT (v_result ->> 'recorded')::boolean, 'the owner can accept the new version';

  ASSERT pg_temp.s5_decide(pg_temp.s5_owner_a(), pg_temp.s5_foreign()) = v_missing,
    'foreign and missing accounts return byte-identical decisions';
  ASSERT pg_temp.s5_decide(pg_temp.s5_owner_a(), pg_temp.s5_inactive()) = v_missing,
    'inactive and missing accounts return byte-identical decisions';
  ASSERT pg_temp.s5_decide(pg_temp.s5_owner_a(), pg_temp.s5_non_youtube()) = v_missing,
    'non-YouTube and missing accounts return byte-identical decisions';
  ASSERT pg_temp.s5_decide(pg_temp.s5_owner_b(), pg_temp.s5_main()) = v_missing,
    'crossed owner/account IDs reveal nothing';
  UPDATE public.app_settings SET value = pg_temp.s5_allowlist(ARRAY[pg_temp.s5_main(), pg_temp.s5_foreign()])
   WHERE key = 'youtube_analytics_stage5_rollout';
  ASSERT pg_temp.s5_decide(pg_temp.s5_owner_b(), pg_temp.s5_foreign()) ->> 'reason' = 'consent_required',
    'a second owner of the same channel has an independent none state';
  ASSERT (pg_temp.s5_accept(pg_temp.s5_owner_b(), pg_temp.s5_foreign()) ->> 'recorded')::boolean,
    'the second owner records their own acceptance';
  ASSERT pg_temp.s5_decide(pg_temp.s5_owner_b(), pg_temp.s5_foreign()) ->> 'reason' = 'ok';
  PERFORM pg_temp.s5_withdraw(pg_temp.s5_owner_b(), pg_temp.s5_foreign(), 2);
  ASSERT pg_temp.s5_decide(pg_temp.s5_owner_b(), pg_temp.s5_foreign(), false, 2) -> 'consent' ->> 'state' = 'withdrawn';
  ASSERT pg_temp.s5_decide(pg_temp.s5_owner_a(), pg_temp.s5_main(), false, 2) ->> 'reason' = 'ok',
    'the second owner withdrawal does not affect the first owner';

  FOR v_pair IN SELECT * FROM (VALUES
    (NULL::text, 1::bigint, NULL::uuid),
    ('UC-s5-main'::text, NULL::bigint, NULL::uuid),
    ('UC-s5-main'::text, 1::bigint, NULL::uuid)
  ) AS q(channel, generation, incarnation)
  LOOP
    v_result := public.youtube_analytics_stage5_decide(
      pg_temp.s5_owner_a(), pg_temp.s5_main(), v_pair.channel, v_pair.generation,
      v_pair.incarnation, ARRAY[]::text[], 2, false);
    ASSERT v_result ->> 'reason' = 'invalid_request', 'expected binding values are all-or-none';
    ASSERT NOT (v_result ? 'credentials'), 'invalid requests carry no credentials';
  END LOOP;

  UPDATE public.social_accounts SET needs_reauth = true WHERE id = pg_temp.s5_main();
  v_result := pg_temp.s5_decide(pg_temp.s5_owner_a(), pg_temp.s5_main(), true, 2);
  ASSERT v_result ->> 'reason' = 'reconnect_required' AND NOT (v_result ? 'credentials');
  UPDATE public.social_accounts SET needs_reauth = false, access_token = NULL, refresh_token = NULL
   WHERE id = pg_temp.s5_main();
  v_result := pg_temp.s5_decide(pg_temp.s5_owner_a(), pg_temp.s5_main(), true, 2);
  ASSERT v_result ->> 'reason' = 'reconnect_required', 'two missing tokens require reconnect';
  UPDATE public.social_accounts
     SET access_token = 's5-access-1', refresh_token = 's5-refresh-1',
         account_metadata = '{"granted_scopes":[]}'::jsonb
   WHERE id = pg_temp.s5_main();
  ASSERT pg_temp.s5_decide(pg_temp.s5_owner_a(), pg_temp.s5_main(), false, 2) ->> 'reason' = 'ok',
    'an empty recorded scope list is unknown and passes';
  UPDATE public.social_accounts SET account_metadata = '{"granted_scopes":["scope.a"]}'::jsonb
   WHERE id = pg_temp.s5_main();
  v_result := pg_temp.s5_decide(pg_temp.s5_owner_a(), pg_temp.s5_main(), true, 2);
  ASSERT v_result ->> 'reason' = 'missing_scope' AND NOT (v_result ? 'credentials');

  SELECT count(*) INTO v_count FROM public.youtube_analytics_purpose_consents
   WHERE owner_id = pg_temp.s5_owner_a() AND channel_id = 'UC-s5-main';
  ASSERT v_count = 3, 'acceptance history is append-only';
  ASSERT NOT EXISTS (
    SELECT 1 FROM (
      SELECT created_at, lag(created_at) OVER (ORDER BY created_at, id) AS previous
        FROM public.youtube_analytics_purpose_consents
       WHERE owner_id = pg_temp.s5_owner_a() AND channel_id = 'UC-s5-main') q
     WHERE previous IS NOT NULL AND created_at <= previous),
    'event timestamps are strictly increasing';
END
$consent_and_decide$;

-- Every possible pair of simultaneous decision conditions uses the specified
-- precedence. not_found and connection_changed are mutually exclusive modes.
DO $precedence$
DECLARE
  v_reasons text[] := ARRAY[
    'not_found', 'connection_changed', 'provider_unsupported', 'not_enabled',
    'consent_required', 'reconnect_required', 'missing_scope'];
  v_i integer;
  v_j integer;
  v_actual text;
  v_bound boolean;
BEGIN
  FOR v_i IN 1..array_length(v_reasons, 1) LOOP
    FOR v_j IN v_i + 1..array_length(v_reasons, 1) LOOP
      IF v_reasons[v_i] = 'not_found' AND v_reasons[v_j] = 'connection_changed' THEN
        CONTINUE;
      END IF;
      v_bound := v_reasons[v_i] = 'connection_changed' OR v_reasons[v_j] = 'connection_changed';
      v_actual := pg_temp.s5_condition_decision(ARRAY[v_reasons[v_i], v_reasons[v_j]], v_bound) ->> 'reason';
      ASSERT v_actual = v_reasons[v_i],
        format('precedence %s + %s: expected %s, got %s',
               v_reasons[v_i], v_reasons[v_j], v_reasons[v_i], v_actual);
    END LOOP;
  END LOOP;
  PERFORM pg_temp.s5_restore_main();
END
$precedence$;

-- Policy states all deny before consent, and admins receive no bypass.
DO $policy_decisions$
DECLARE
  v_case record;
  v_result jsonb;
  v_admin_acct constant uuid := '6e5b0013-0000-4000-8000-000000000013';
BEGIN
  PERFORM pg_temp.s5_restore_main();
  FOR v_case IN SELECT * FROM (VALUES
    ('missing', NULL::jsonb),
    ('invalid', 'null'::jsonb),
    ('off', '{"version":1,"mode":"off","account_ids":[]}'::jsonb),
    ('not_listed', pg_temp.s5_allowlist(ARRAY[pg_temp.s5_second()]))
  ) AS q(label, policy)
  LOOP
    IF v_case.policy IS NULL THEN
      DELETE FROM public.app_settings WHERE key = 'youtube_analytics_stage5_rollout';
    ELSE
      INSERT INTO public.app_settings (key, value, description)
      VALUES ('youtube_analytics_stage5_rollout', v_case.policy, 'Stage 5 SQL suite')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description;
    END IF;
    v_result := pg_temp.s5_decide();
    ASSERT v_result ->> 'reason' = 'not_enabled' AND NOT (v_result ? 'credentials'),
      format('policy %s denies even when consent is accepted: %s', v_case.label, v_result);
  END LOOP;

  -- Admins receive no bypass on decide when their account is not admitted by policy.
  DELETE FROM public.social_accounts WHERE id = v_admin_acct;
  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, access_token, refresh_token, is_active, auth_provider
  ) VALUES (
    v_admin_acct, pg_temp.s5_admin(), 'youtube', 'UC-s5-admin-chan', 's5-admin-acc', 's5-admin-ref', true, 'native');
  INSERT INTO public.app_settings (key, value, description)
  VALUES ('youtube_analytics_stage5_rollout', pg_temp.s5_allowlist(ARRAY[pg_temp.s5_main()]), 'Stage 5 SQL suite')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description;
  v_result := pg_temp.s5_decide(pg_temp.s5_admin(), v_admin_acct, true);
  ASSERT v_result ->> 'reason' = 'not_enabled' AND NOT (v_result ? 'credentials'),
    format('an admin owner receives no bypass on decide: %s', v_result);
  DELETE FROM public.social_accounts WHERE id = v_admin_acct;
  PERFORM pg_temp.s5_restore_main();
END
$policy_decisions$;


CREATE FUNCTION pg_temp.s5_acquire_text(p_account uuid, p_ttl integer DEFAULT 60)
RETURNS text LANGUAGE sql AS
  $$ SELECT format(
       'SELECT public.youtube_analytics_stage5_acquire_lease(%L::uuid, %L::uuid, %L, %s, %L::uuid, %L::text[], 1, %s)::text',
       pg_temp.s5_owner_a(), p_account, sa.platform_user_id, sa.binding_generation,
       COALESCE(sa.binding_incarnation, '00000000-0000-0000-0000-000000000000'::uuid),
       '{scope.a,scope.b}', p_ttl)
     FROM public.social_accounts AS sa WHERE sa.id = p_account $$;

CREATE FUNCTION pg_temp.s5_store_text(
  p_account uuid,
  p_lease uuid,
  p_access text,
  p_refresh text DEFAULT NULL
) RETURNS text LANGUAGE sql AS
  $$ SELECT format(
       'SELECT public.youtube_analytics_stage5_store_token(%L::uuid, %L::uuid, %L, %s, %L::uuid, %L::uuid, %L, %L::timestamptz, %L::text)::text',
       pg_temp.s5_owner_a(), p_account, sa.platform_user_id, sa.binding_generation,
       COALESCE(sa.binding_incarnation, '00000000-0000-0000-0000-000000000000'::uuid),
       p_lease, p_access, clock_timestamp() + interval '1 hour', p_refresh)
     FROM public.social_accounts AS sa WHERE sa.id = p_account $$;

CREATE FUNCTION pg_temp.s5_no_locks(p_session text) RETURNS boolean LANGUAGE sql AS
  $$ SELECT NOT EXISTS (
       SELECT 1 FROM pg_locks
        WHERE pid = pg_temp.s5_pid(p_session)
          AND locktype IN ('relation', 'tuple', 'transactionid', 'advisory')) $$;

-- Account deletion is immutable history; owner deletion alone cascades it.
DO $acceptance_delete_modes$
DECLARE
  v_owner constant uuid := '6e5a0004-0000-4000-8000-000000000004';
  v_account constant uuid := '6e5b0012-0000-4000-8000-000000000012';
  v_result jsonb;
BEGIN
  DELETE FROM public.social_accounts WHERE id = v_account;
  DELETE FROM auth.users WHERE id = v_owner;
  PERFORM pg_temp.s5_restore_main();
  INSERT INTO auth.users (id, email) VALUES (v_owner, 's5-owner-delete@example.invalid');
  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, access_token, is_active, auth_provider
  ) VALUES (
    v_account, v_owner, 'youtube', 'UC-s5-delete-owner', 's5-delete-access', true, 'native');
  UPDATE public.app_settings SET value = '{"version":1,"mode":"all","account_ids":[]}'::jsonb
   WHERE key = 'youtube_analytics_stage5_rollout';
  v_result := pg_temp.s5_accept(v_owner, v_account);
  ASSERT (v_result ->> 'recorded')::boolean, format('temporary owner accepted: %s', v_result);
  DELETE FROM public.social_accounts WHERE id = v_account;
  ASSERT EXISTS (
    SELECT 1 FROM public.youtube_analytics_purpose_consents
     WHERE owner_id = v_owner AND channel_id = 'UC-s5-delete-owner'
       AND social_account_id = v_account),
    'account deletion leaves the historical acceptance untouched';
  DELETE FROM auth.users WHERE id = v_owner;
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_analytics_purpose_consents WHERE owner_id = v_owner),
    'owner deletion cascades the acceptance history';
  PERFORM pg_temp.s5_restore_main();
END
$acceptance_delete_modes$;

-- A committed withdrawal wins at the very next decision checkpoint.
DO $withdrawal_checkpoints$
DECLARE
  v_checkpoint text;
  v_before jsonb;
  v_after jsonb;
BEGIN
  FOREACH v_checkpoint IN ARRAY ARRAY[
    'admission_to_credential_release', 'credential_release_to_attempt', 'attempt_to_final_response'
  ] LOOP
    PERFORM pg_temp.s5_restore_main();
    v_before := pg_temp.s5_decide(pg_temp.s5_owner_a(), pg_temp.s5_main(), true);
    ASSERT v_before ->> 'reason' = 'ok' AND v_before ? 'credentials',
      format('%s starts admitted: %s', v_checkpoint, v_before);
    PERFORM pg_temp.s5_withdraw();
    v_after := pg_temp.s5_decide(pg_temp.s5_owner_a(), pg_temp.s5_main(), true);
    ASSERT v_after ->> 'reason' = 'consent_required'
       AND v_after -> 'consent' ->> 'state' = 'withdrawn'
       AND NOT (v_after ? 'credentials'),
      format('%s refuses at the next decide: %s', v_checkpoint, v_after);
  END LOOP;
  PERFORM pg_temp.s5_restore_main();
END
$withdrawal_checkpoints$;

-- Concurrent acceptance of one owner/channel serializes on the function's
-- account and advisory locks: exactly one acceptance is durable.
SELECT pg_temp.s5_restore_main();
DELETE FROM public.youtube_analytics_purpose_consents WHERE owner_id = pg_temp.s5_owner_a();
UPDATE public.app_settings
   SET value = pg_temp.s5_allowlist(ARRAY[pg_temp.s5_main()])
 WHERE key = 'youtube_analytics_stage5_rollout';
SELECT pg_temp.s5_sessions();
DO $concurrent_duplicate_acceptances$
DECLARE
  v_pid_b integer;
  v_a text;
  v_b text;
BEGIN
  PERFORM extensions.dblink_exec('s5_a', 'BEGIN');
  SELECT res INTO v_a FROM extensions.dblink('s5_a', format(
    'SELECT public.youtube_analytics_stage5_record_consent(%L::uuid, %L::uuid, ''accepted'', 1, ''en'', ''s5-race-accept-a'', NULL)::text',
    pg_temp.s5_owner_a(), pg_temp.s5_main())) AS t(res text);
  v_pid_b := pg_temp.s5_pid('s5_b');
  PERFORM extensions.dblink_send_query('s5_b', format(
    'SELECT public.youtube_analytics_stage5_record_consent(%L::uuid, %L::uuid, ''accepted'', 1, ''en'', ''s5-race-accept-b'', NULL)::text',
    pg_temp.s5_owner_a(), pg_temp.s5_main()));
  PERFORM pg_temp.s5_wait_blocked_by(v_pid_b, pg_temp.s5_pid('s5_a'), 'duplicate acceptance');
  ASSERT position('pg_advisory_xact_lock' IN (
    SELECT prosrc FROM pg_proc
     WHERE oid = 'public.youtube_analytics_stage5_record_consent(uuid,uuid,text,integer,text,text,text)'::regprocedure)) > 0,
    'the consent writer guards the owner/channel history with an advisory lock';
  PERFORM extensions.dblink_exec('s5_a', 'COMMIT');
  SELECT res INTO v_b FROM extensions.dblink_get_result('s5_b') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s5_b') AS t(res text);

  ASSERT (v_a::jsonb ->> 'recorded')::boolean, format('the first acceptance won: %s', v_a);
  ASSERT (v_b::jsonb ->> 'ok')::boolean AND NOT (v_b::jsonb ->> 'recorded')::boolean,
    format('the serialized duplicate is idempotent: %s', v_b);
  ASSERT (SELECT count(*) FROM public.youtube_analytics_purpose_consents
           WHERE owner_id = pg_temp.s5_owner_a() AND channel_id = 'UC-s5-main') = 1,
    'concurrent duplicate acceptance inserts exactly one row';
END
$concurrent_duplicate_acceptances$;
SELECT pg_temp.s5_restore_main();

-- A withdrawal queued behind an open acceptance must see that acceptance and
-- append a new withdrawal, rather than treating the prior withdrawal as current.
SELECT pg_temp.s5_withdraw();
SELECT pg_temp.s5_sessions();
DO $overlap_accept_withdraw$
DECLARE
  v_pid_b integer;
  v_a text;
  v_b text;
  v_latest text;
BEGIN
  ASSERT (SELECT count(*) FROM public.youtube_analytics_purpose_consents
           WHERE owner_id = pg_temp.s5_owner_a() AND channel_id = 'UC-s5-main') = 2,
    'the race starts with accepted then withdrawn history';

  PERFORM extensions.dblink_exec('s5_a', 'BEGIN');
  SELECT res INTO v_a FROM extensions.dblink('s5_a', format(
    'SELECT public.youtube_analytics_stage5_record_consent(%L::uuid, %L::uuid, ''accepted'', 1, ''en'', ''s5-overlap-accept'', NULL)::text',
    pg_temp.s5_owner_a(), pg_temp.s5_main())) AS t(res text);
  v_pid_b := pg_temp.s5_pid('s5_b');
  PERFORM extensions.dblink_send_query('s5_b', format(
    'SELECT public.youtube_analytics_stage5_record_consent(%L::uuid, %L::uuid, ''withdrawn'', 1, ''ar'', ''s5-overlap-withdraw'', NULL)::text',
    pg_temp.s5_owner_a(), pg_temp.s5_main()));
  PERFORM pg_temp.s5_wait_blocked_by(v_pid_b, pg_temp.s5_pid('s5_a'), 'overlapping withdrawal');
  PERFORM extensions.dblink_exec('s5_a', 'COMMIT');
  SELECT res INTO v_b FROM extensions.dblink_get_result('s5_b') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s5_b') AS t(res text);

  ASSERT (v_a::jsonb ->> 'recorded')::boolean, format('the acceptance commits first: %s', v_a);
  ASSERT (v_b::jsonb ->> 'recorded')::boolean,
    format('withdrawal sees the new acceptance and records another row: %s', v_b);
  SELECT event INTO v_latest FROM public.youtube_analytics_purpose_consents
   WHERE owner_id = pg_temp.s5_owner_a() AND channel_id = 'UC-s5-main'
   ORDER BY created_at DESC, id DESC LIMIT 1;
  ASSERT v_latest = 'withdrawn', 'the final consent state is withdrawn';
  ASSERT (SELECT count(*) FROM public.youtube_analytics_purpose_consents
           WHERE owner_id = pg_temp.s5_owner_a() AND channel_id = 'UC-s5-main') = 4,
    'the overlapping accept and withdraw are both append-only events';
  ASSERT pg_temp.s5_decide() ->> 'reason' = 'consent_required', 'the final decision refuses';
END
$overlap_accept_withdraw$;
SELECT pg_temp.s5_restore_main();

-- The production decision is one VOLATILE SQL statement with one reference to
-- each source relation. This shape is what gives it one statement snapshot.
DO $decision_source_shape$
DECLARE
  v_source text;
  v_language text;
  v_volatility "char";
BEGIN
  SELECT p.prosrc, l.lanname, p.provolatile
    INTO v_source, v_language, v_volatility
    FROM pg_proc AS p JOIN pg_language AS l ON l.oid = p.prolang
   WHERE p.oid = 'public.youtube_analytics_stage5_decide(uuid,uuid,text,bigint,uuid,text[],integer,boolean)'::regprocedure;
  ASSERT v_language = 'sql' AND v_volatility = 'v', 'decide is LANGUAGE sql VOLATILE';
  ASSERT position(';' IN v_source) = 0, 'decide contains a single SQL statement';
  ASSERT (SELECT count(*) FROM regexp_matches(v_source, 'public\.social_accounts', 'g')) = 1,
    'decide reads social_accounts exactly once';
  ASSERT (SELECT count(*) FROM regexp_matches(v_source, 'public\.app_settings', 'g')) = 1,
    'decide reads app_settings exactly once';
  ASSERT (SELECT count(*) FROM regexp_matches(v_source, 'public\.youtube_analytics_purpose_consents', 'g')) = 1,
    'decide reads the consent table exactly once';
END
$decision_source_shape$;

-- Discriminating snapshot proof. The mutant lives only in dblink session A's
-- pg_temp schema. It reads the account, waits at an advisory barrier, then reads
-- policy and consent. Session B commits across that barrier and produces a
-- mixed answer. The production function ignores the barrier and completes
-- coherently before B can commit across any such internal barrier.
SELECT pg_temp.s5_restore_main();
SELECT pg_temp.s5_sessions();
DO $snapshot_race_mutant$
DECLARE
  v_barrier constant bigint := 6505001;
  v_generation bigint;
  v_pid_a integer;
  v_pid_c integer;
  v_mutant text;
  v_ddl text := $mutant$
CREATE FUNCTION pg_temp.s5_snapshot_mutant(p_owner uuid, p_account uuid, p_barrier bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $function$
DECLARE
  v_generation bigint;
  v_policy jsonb;
  v_consent text;
BEGIN
  SELECT sa.binding_generation INTO v_generation
    FROM public.social_accounts AS sa
   WHERE sa.id = p_account AND sa.user_id = p_owner;
  PERFORM pg_advisory_xact_lock(p_barrier);
  SELECT s.value, c.event INTO v_policy, v_consent
    FROM (SELECT 1) AS seed
    LEFT JOIN public.app_settings AS s
      ON s.key = 'youtube_analytics_stage5_rollout'
    LEFT JOIN LATERAL (
      SELECT c0.event FROM public.youtube_analytics_purpose_consents AS c0
       WHERE c0.owner_id = p_owner
         AND c0.channel_id = (SELECT sa.platform_user_id FROM public.social_accounts AS sa WHERE sa.id = p_account)
       ORDER BY c0.created_at DESC, c0.id DESC LIMIT 1
    ) AS c ON true;
  RETURN jsonb_build_object(
    'binding_generation', v_generation,
    'policy_mode', v_policy ->> 'mode',
    'consent_event', COALESCE(v_consent, 'none'));
END
$function$;
$mutant$;
BEGIN
  SELECT binding_generation INTO v_generation FROM public.social_accounts WHERE id = pg_temp.s5_main();
  PERFORM extensions.dblink_exec('s5_a', v_ddl);
  PERFORM extensions.dblink_exec('s5_c', 'BEGIN');
  PERFORM * FROM extensions.dblink('s5_c', format('SELECT pg_advisory_xact_lock(%s)::text', v_barrier)) AS t(res text);
  v_pid_a := pg_temp.s5_pid('s5_a');
  v_pid_c := pg_temp.s5_pid('s5_c');
  PERFORM extensions.dblink_send_query('s5_a', format(
    'SELECT pg_temp.s5_snapshot_mutant(%L::uuid, %L::uuid, %s)::text',
    pg_temp.s5_owner_a(), pg_temp.s5_main(), v_barrier));
  PERFORM pg_temp.s5_wait_blocked_by(v_pid_a, v_pid_c, 'two-statement snapshot mutant');
  PERFORM extensions.dblink_exec('s5_b', format(
    'UPDATE public.social_accounts SET access_token = ''s5-snapshot-reconnect'' WHERE id = %L::uuid',
    pg_temp.s5_main()));
  PERFORM extensions.dblink_exec('s5_b',
    'UPDATE public.app_settings SET value = ''{"version":1,"mode":"off","account_ids":[]}''::jsonb WHERE key = ''youtube_analytics_stage5_rollout''');
  PERFORM * FROM extensions.dblink('s5_b', format(
    'SELECT public.youtube_analytics_stage5_record_consent(%L::uuid, %L::uuid, ''withdrawn'', 1, ''ar'', ''s5-snapshot-withdraw'', NULL)::text',
    pg_temp.s5_owner_a(), pg_temp.s5_main())) AS t(res text);
  PERFORM extensions.dblink_exec('s5_c', 'COMMIT');
  SELECT res INTO v_mutant FROM extensions.dblink_get_result('s5_a') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s5_a') AS t(res text);
  ASSERT (v_mutant::jsonb ->> 'binding_generation')::bigint = v_generation
     AND v_mutant::jsonb ->> 'policy_mode' = 'off'
     AND v_mutant::jsonb ->> 'consent_event' = 'withdrawn',
    format('the mutant mixes the old account snapshot with new policy and consent: %s', v_mutant);
END
$snapshot_race_mutant$;

SELECT pg_temp.s5_restore_main();
SELECT pg_temp.s5_sessions();
DO $snapshot_race_production$
DECLARE
  v_barrier constant bigint := 6505001;
  v_production text;
BEGIN
  PERFORM extensions.dblink_exec('s5_c', 'BEGIN');
  PERFORM * FROM extensions.dblink('s5_c', format('SELECT pg_advisory_xact_lock(%s)::text', v_barrier)) AS t(res text);
  PERFORM extensions.dblink_send_query('s5_a', format(
    'SELECT public.youtube_analytics_stage5_decide(%L::uuid, %L::uuid, NULL, NULL, NULL, %L::text[], 1, false)::text',
    pg_temp.s5_owner_a(), pg_temp.s5_main(), '{scope.a,scope.b}'));
  SELECT res INTO v_production FROM extensions.dblink_get_result('s5_a') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s5_a') AS t(res text);
  ASSERT (v_production::jsonb ->> 'ok')::boolean,
    format('the one-statement decision completes coherently without an interleaving barrier: %s', v_production);
  PERFORM extensions.dblink_exec('s5_b',
    'UPDATE public.app_settings SET value = ''{"version":1,"mode":"off","account_ids":[]}''::jsonb WHERE key = ''youtube_analytics_stage5_rollout''');
  PERFORM extensions.dblink_exec('s5_c', 'COMMIT');
  ASSERT (v_production::jsonb ->> 'ok')::boolean,
    'session B cannot commit between two production decision reads';
END
$snapshot_race_production$;
SELECT pg_temp.s5_restore_main();

-- (i) A browser disconnect commits while store_token waits for the account row.
SELECT pg_temp.s5_sessions();
DO $store_waits_for_disconnect$
DECLARE
  v_lease jsonb;
  v_store text;
  v_pid_a integer;
  v_pid_b integer;
  v_result text;
BEGIN
  SELECT (res::jsonb) INTO v_lease FROM extensions.dblink('s5_a', pg_temp.s5_acquire_text(pg_temp.s5_main())) AS t(res text);
  ASSERT (v_lease ->> 'ok')::boolean, format('(i) lease acquired: %s', v_lease);
  v_store := pg_temp.s5_store_text(
    pg_temp.s5_main(), (v_lease ->> 'lease_token')::uuid, 's5-disconnect-must-not-store');

  PERFORM extensions.dblink_exec('s5_a', 'BEGIN');
  PERFORM extensions.dblink_exec('s5_a', format(
    'UPDATE public.social_accounts SET is_active = false WHERE id = %L::uuid', pg_temp.s5_main()));
  v_pid_a := pg_temp.s5_pid('s5_a');
  v_pid_b := pg_temp.s5_pid('s5_b');
  PERFORM extensions.dblink_send_query('s5_b', v_store);
  PERFORM pg_temp.s5_wait_blocked_by(v_pid_b, v_pid_a, '(i) store_token behind browser disconnect');
  PERFORM extensions.dblink_exec('s5_a', 'COMMIT');
  SELECT res INTO v_result FROM extensions.dblink_get_result('s5_b') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s5_b') AS t(res text);

  ASSERT v_result::jsonb = '{"ok":false,"reason":"connection_changed"}'::jsonb,
    format('(i) store refuses after the disconnect commits: %s', v_result);
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = pg_temp.s5_main()) = 's5-access-1',
    '(i) the new access token was not written';
  ASSERT (SELECT count(*) FROM public.youtube_token_refresh_leases
           WHERE social_account_id = pg_temp.s5_main()) = 1,
    '(i) the refused store neither consumes nor replaces the lease';
END
$store_waits_for_disconnect$;
SELECT pg_temp.s5_restore_main();

-- (ii) A reconnect before acquire_lease advances the generation and refuses.
DO $reconnect_before_acquire$
DECLARE
  v_acquire text;
  v_result jsonb;
BEGIN
  PERFORM pg_temp.s5_restore_main();
  v_acquire := pg_temp.s5_acquire_text(pg_temp.s5_main());
  UPDATE public.social_accounts SET access_token = 's5-reconnect-before-acquire'
   WHERE id = pg_temp.s5_main();
  EXECUTE v_acquire INTO v_result;
  ASSERT v_result = '{"ok":false,"reason":"connection_changed"}'::jsonb,
    format('(ii) the admitted generation cannot acquire after reconnect: %s', v_result);
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_token_refresh_leases
                      WHERE social_account_id = pg_temp.s5_main()),
    '(ii) no lease is written';
  PERFORM pg_temp.s5_restore_main();
END
$reconnect_before_acquire$;

-- (iii) A disconnect without a token change is also a changed binding.
DO $disconnect_before_acquire$
DECLARE
  v_acquire text;
  v_result jsonb;
BEGIN
  PERFORM pg_temp.s5_restore_main();
  v_acquire := pg_temp.s5_acquire_text(pg_temp.s5_main());
  UPDATE public.social_accounts SET is_active = false WHERE id = pg_temp.s5_main();
  EXECUTE v_acquire INTO v_result;
  ASSERT v_result = '{"ok":false,"reason":"connection_changed"}'::jsonb,
    format('(iii) browser disconnect refuses acquire: %s', v_result);
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_token_refresh_leases
                      WHERE social_account_id = pg_temp.s5_main()),
    '(iii) the lease table remains untouched';
  PERFORM pg_temp.s5_restore_main();
END
$disconnect_before_acquire$;

-- (iv) Publishing and Stage 5 share one lease; two Stage 5 acquirers get one token.
SELECT pg_temp.s5_restore_main();
DO $lease_exclusion_part1$
DECLARE
  v_publishing jsonb;
  v_stage5 jsonb;
BEGIN
  v_publishing := public.acquire_youtube_refresh_lease(pg_temp.s5_main(), 60);
  ASSERT (v_publishing ->> 'ok')::boolean, format('(iv) publishing holds the lease: %s', v_publishing);
  EXECUTE pg_temp.s5_acquire_text(pg_temp.s5_main()) INTO v_stage5;
  ASSERT v_stage5 ->> 'reason' = 'lease_held' AND (v_stage5 ->> 'lease_token') IS NULL,
    format('(iv) Stage 5 cannot take a publishing lease: %s', v_stage5);
  ASSERT (SELECT count(*) FROM public.youtube_token_refresh_leases
           WHERE social_account_id = pg_temp.s5_main()) = 1,
    '(iv) no second lease row exists';
  ASSERT public.release_youtube_refresh_lease(
    pg_temp.s5_main(), (v_publishing ->> 'lease_token')::uuid),
    '(iv) publishing releases its own lease';
END
$lease_exclusion_part1$;

SELECT pg_temp.s5_sessions();
DO $lease_exclusion_part2$
DECLARE
  v_acquire text;
  v_a text;
  v_b text;
BEGIN
  v_acquire := pg_temp.s5_acquire_text(pg_temp.s5_main());
  PERFORM extensions.dblink_send_query('s5_a', v_acquire);
  PERFORM extensions.dblink_send_query('s5_b', v_acquire);
  SELECT res INTO v_a FROM extensions.dblink_get_result('s5_a') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s5_a') AS t(res text);
  SELECT res INTO v_b FROM extensions.dblink_get_result('s5_b') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s5_b') AS t(res text);
  ASSERT ((v_a::jsonb ->> 'ok')::boolean)::integer + ((v_b::jsonb ->> 'ok')::boolean)::integer = 1,
    format('(iv) exactly one Stage 5 acquirer wins: A=%s B=%s', v_a, v_b);
  ASSERT (CASE WHEN (v_a::jsonb ->> 'ok')::boolean THEN v_b ELSE v_a END)::jsonb ->> 'reason' = 'lease_held',
    '(iv) the second Stage 5 acquirer sees lease_held';
  ASSERT (SELECT count(*) FROM public.youtube_token_refresh_leases
           WHERE social_account_id = pg_temp.s5_main()) = 1,
    '(iv) concurrent acquirers still leave one lease';
END
$lease_exclusion_part2$;
SELECT pg_temp.s5_restore_main();

-- (v) Losing rollout admission or consent after acquire does not invalidate a
-- token already issued for the still-identical connection; the next decide refuses.
DO $withdrawal_between_acquire_store$
DECLARE
  v_mode text;
  v_lease jsonb;
  v_result jsonb;
  v_expected text;
BEGIN
  FOREACH v_mode IN ARRAY ARRAY['rollout', 'consent'] LOOP
    PERFORM pg_temp.s5_restore_main();
    EXECUTE pg_temp.s5_acquire_text(pg_temp.s5_main()) INTO v_lease;
    ASSERT (v_lease ->> 'ok')::boolean, format('(v) %s case lease: %s', v_mode, v_lease);
    IF v_mode = 'rollout' THEN
      UPDATE public.app_settings SET value = '{"version":1,"mode":"off","account_ids":[]}'::jsonb
       WHERE key = 'youtube_analytics_stage5_rollout';
      v_expected := 'not_enabled';
    ELSE
      PERFORM pg_temp.s5_withdraw();
      v_expected := 'consent_required';
    END IF;
    EXECUTE pg_temp.s5_store_text(
      pg_temp.s5_main(), (v_lease ->> 'lease_token')::uuid,
      's5-store-after-' || v_mode) INTO v_result;
    ASSERT v_result = '{"ok":true}'::jsonb,
      format('(v) %s withdrawal still permits the bound store: %s', v_mode, v_result);
    v_result := pg_temp.s5_decide();
    ASSERT v_result ->> 'reason' = v_expected,
      format('(v) %s withdrawal refuses the next decide: %s', v_mode, v_result);
  END LOOP;
  PERFORM pg_temp.s5_restore_main();
END
$withdrawal_between_acquire_store$;

-- (vi) Health changed after acquire is not reset by the neutral token store.
DO $needs_reauth_between_acquire_store$
DECLARE
  v_lease jsonb;
  v_result jsonb;
BEGIN
  PERFORM pg_temp.s5_restore_main();
  EXECUTE pg_temp.s5_acquire_text(pg_temp.s5_main()) INTO v_lease;
  UPDATE public.social_accounts SET needs_reauth = true WHERE id = pg_temp.s5_main();
  EXECUTE pg_temp.s5_store_text(
    pg_temp.s5_main(), (v_lease ->> 'lease_token')::uuid, 's5-store-with-needs-reauth') INTO v_result;
  ASSERT v_result = '{"ok":true}'::jsonb, format('(vi) store succeeds: %s', v_result);
  v_result := pg_temp.s5_decide();
  ASSERT v_result ->> 'reason' = 'reconnect_required',
    format('(vi) decide refuses afterwards: %s', v_result);
  ASSERT (SELECT needs_reauth FROM public.social_accounts WHERE id = pg_temp.s5_main()),
    '(vi) the neutral store leaves needs_reauth set';
  PERFORM pg_temp.s5_restore_main();
END
$needs_reauth_between_acquire_store$;

-- (vii) Both RPCs return from their own transaction with no database lock held.
SELECT pg_temp.s5_restore_main();
SELECT pg_temp.s5_sessions();
DO $no_lock_after_return$
DECLARE
  v_lease text;
  v_store text;
BEGIN
  SELECT res INTO v_lease FROM extensions.dblink(
    's5_a', pg_temp.s5_acquire_text(pg_temp.s5_main())) AS t(res text);
  ASSERT (v_lease::jsonb ->> 'ok')::boolean, format('(vii) acquire returned: %s', v_lease);
  ASSERT pg_temp.s5_no_locks('s5_a'), '(vii) acquire_lease holds no lock after return';
  v_store := pg_temp.s5_store_text(
    pg_temp.s5_main(), (v_lease::jsonb ->> 'lease_token')::uuid, 's5-no-lock-store');
  SELECT res INTO v_store FROM extensions.dblink('s5_b', v_store) AS t(res text);
  ASSERT v_store::jsonb = '{"ok":true}'::jsonb, format('(vii) store returned: %s', v_store);
  ASSERT pg_temp.s5_no_locks('s5_b'), '(vii) store_token holds no lock after return';
END
$no_lock_after_return$;
SELECT pg_temp.s5_restore_main();

-- (viii) Stage 5 reaches the narrow trusted writer: identity and all health and
-- scope state survive, while only the credential columns change.
DO $stage5_health_and_binding_neutral$
DECLARE
  v_lease jsonb;
  v_generation bigint;
  v_incarnation uuid;
  v_metadata constant jsonb := '{"granted_scopes":["scope.a","scope.b"],"suite_keep":"unchanged"}'::jsonb;
  v_result jsonb;
BEGIN
  PERFORM pg_temp.s5_restore_main();
  EXECUTE pg_temp.s5_acquire_text(pg_temp.s5_main()) INTO v_lease;
  SELECT binding_generation, binding_incarnation INTO v_generation, v_incarnation
    FROM public.social_accounts WHERE id = pg_temp.s5_main();
  UPDATE public.social_accounts
     SET needs_reauth = true, failure_count = 7, last_refresh_error = 's5-health-sentinel',
         account_metadata = v_metadata
   WHERE id = pg_temp.s5_main();
  EXECUTE pg_temp.s5_store_text(
    pg_temp.s5_main(), (v_lease ->> 'lease_token')::uuid,
    's5-neutral-access', 's5-neutral-refresh') INTO v_result;
  ASSERT v_result = '{"ok":true}'::jsonb, format('(viii) neutral store succeeded: %s', v_result);
  ASSERT (SELECT binding_generation FROM public.social_accounts WHERE id = pg_temp.s5_main()) = v_generation,
    '(viii) binding_generation is preserved by the narrow refresh authority';
  ASSERT (SELECT binding_incarnation FROM public.social_accounts WHERE id = pg_temp.s5_main()) = v_incarnation,
    '(viii) binding_incarnation is preserved';
  ASSERT (SELECT needs_reauth FROM public.social_accounts WHERE id = pg_temp.s5_main())
     AND (SELECT failure_count FROM public.social_accounts WHERE id = pg_temp.s5_main()) = 7
     AND (SELECT last_refresh_error FROM public.social_accounts WHERE id = pg_temp.s5_main()) = 's5-health-sentinel',
    '(viii) health fields are untouched';
  ASSERT (SELECT account_metadata FROM public.social_accounts WHERE id = pg_temp.s5_main()) = v_metadata,
    '(viii) granted scopes and unrelated metadata are untouched';
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = pg_temp.s5_main()) = 's5-neutral-access'
     AND (SELECT refresh_token FROM public.social_accounts WHERE id = pg_temp.s5_main()) = 's5-neutral-refresh',
    '(viii) only the requested credentials rotate';
  PERFORM pg_temp.s5_restore_main();
END
$stage5_health_and_binding_neutral$;

-- (ix) Cross-owner calls on acquire_lease and store_token are refused, and
-- every non-ok decide reason refuses acquire_lease without writing a lease.
DO $wrapper_owner_and_decide_refusals$
DECLARE
  v_channel text;
  v_generation bigint;
  v_incarnation uuid;
  v_lease jsonb;
  v_result jsonb;
BEGIN
  PERFORM pg_temp.s5_restore_main();
  SELECT platform_user_id, binding_generation,
         COALESCE(binding_incarnation, '00000000-0000-0000-0000-000000000000'::uuid)
    INTO v_channel, v_generation, v_incarnation
    FROM public.social_accounts WHERE id = pg_temp.s5_main();

  -- Foreign owner B calling acquire_lease on owner A's account:
  v_result := public.youtube_analytics_stage5_acquire_lease(
    pg_temp.s5_owner_b(), pg_temp.s5_main(), v_channel, v_generation, v_incarnation,
    ARRAY['scope.a', 'scope.b'], 1, 60);
  ASSERT v_result = '{"ok":false,"reason":"connection_changed"}'::jsonb,
    format('foreign owner acquire_lease refused: %s', v_result);
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_token_refresh_leases WHERE social_account_id = pg_temp.s5_main()),
    'foreign owner acquire_lease writes no lease';

  -- Owner A acquires a valid lease, then foreign owner B tries to store_token with that lease:
  EXECUTE pg_temp.s5_acquire_text(pg_temp.s5_main()) INTO v_lease;
  ASSERT (v_lease ->> 'ok')::boolean, format('owner A lease acquired: %s', v_lease);
  v_result := public.youtube_analytics_stage5_store_token(
    pg_temp.s5_owner_b(), pg_temp.s5_main(), v_channel, v_generation, v_incarnation,
    (v_lease ->> 'lease_token')::uuid, 'foreign-hijack-access', clock_timestamp() + interval '1 hour', 'foreign-hijack-refresh');
  ASSERT v_result = '{"ok":false,"reason":"connection_changed"}'::jsonb,
    format('foreign owner store_token refused: %s', v_result);
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = pg_temp.s5_main()) = 's5-access-1',
    'foreign owner store_token wrote nothing';
  ASSERT (SELECT count(*) FROM public.youtube_token_refresh_leases WHERE social_account_id = pg_temp.s5_main()) = 1,
    'foreign owner store_token did not consume owner A lease';

  -- Rollout off refuses acquire_lease:
  PERFORM pg_temp.s5_restore_main();
  UPDATE public.app_settings SET value = '{"version":1,"mode":"off","account_ids":[]}'::jsonb
   WHERE key = 'youtube_analytics_stage5_rollout';
  EXECUTE pg_temp.s5_acquire_text(pg_temp.s5_main()) INTO v_result;
  ASSERT v_result = '{"ok":false,"reason":"not_enabled"}'::jsonb,
    format('acquire_lease with rollout off: %s', v_result);
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_token_refresh_leases WHERE social_account_id = pg_temp.s5_main());

  -- Consent withdrawn refuses acquire_lease:
  PERFORM pg_temp.s5_restore_main();
  PERFORM pg_temp.s5_withdraw();
  EXECUTE pg_temp.s5_acquire_text(pg_temp.s5_main()) INTO v_result;
  ASSERT v_result = '{"ok":false,"reason":"consent_required"}'::jsonb,
    format('acquire_lease with consent withdrawn: %s', v_result);
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_token_refresh_leases WHERE social_account_id = pg_temp.s5_main());

  -- Stale purpose version refuses acquire_lease:
  PERFORM pg_temp.s5_restore_main();
  v_result := public.youtube_analytics_stage5_acquire_lease(
    pg_temp.s5_owner_a(), pg_temp.s5_main(), v_channel, v_generation, v_incarnation,
    ARRAY['scope.a', 'scope.b'], 2, 60);
  ASSERT v_result = '{"ok":false,"reason":"consent_required"}'::jsonb,
    format('acquire_lease with newer purpose version: %s', v_result);
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_token_refresh_leases WHERE social_account_id = pg_temp.s5_main());

  -- needs_reauth refuses acquire_lease:
  PERFORM pg_temp.s5_restore_main();
  UPDATE public.social_accounts SET needs_reauth = true WHERE id = pg_temp.s5_main();
  EXECUTE pg_temp.s5_acquire_text(pg_temp.s5_main()) INTO v_result;
  ASSERT v_result = '{"ok":false,"reason":"reconnect_required"}'::jsonb,
    format('acquire_lease with needs_reauth: %s', v_result);
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_token_refresh_leases WHERE social_account_id = pg_temp.s5_main());

  -- Missing required scope refuses acquire_lease:
  PERFORM pg_temp.s5_restore_main();
  UPDATE public.social_accounts SET account_metadata = '{"granted_scopes":["scope.a"]}'::jsonb
   WHERE id = pg_temp.s5_main();
  EXECUTE pg_temp.s5_acquire_text(pg_temp.s5_main()) INTO v_result;
  ASSERT v_result = '{"ok":false,"reason":"missing_scope"}'::jsonb,
    format('acquire_lease with missing scope: %s', v_result);
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_token_refresh_leases WHERE social_account_id = pg_temp.s5_main());

  PERFORM pg_temp.s5_restore_main();
END
$wrapper_owner_and_decide_refusals$;

-- Real rate-limit buckets: exact 48-hour exhaustion, fail-closed debit results,
-- cleanup, and independent shared/per-user keys.
DO $budget_buckets$
DECLARE
  v_ceiling constant integer := 3;
  v_window constant integer := 172800;
  v_at constant timestamptz := '2026-01-15 12:00:00+00';
  v_endpoint constant text := 's5:youtube-analytics:budget:data';
  v_identifier text := to_char(v_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD');
  v_live_key text;
  v_result jsonb;
  v_i integer;
  v_deleted integer;
  v_keys text[];
BEGIN
  DELETE FROM public.rate_limit_buckets WHERE bucket_key LIKE 's5:%';
  v_live_key := pg_temp.s5_budget_key('data', v_at);
  FOR v_i IN 1..v_ceiling LOOP
    v_result := public.check_rate_limit(v_endpoint, v_identifier, v_ceiling, v_window);
    ASSERT pg_temp.s5_budget_accepts(v_result, v_ceiling)
       AND (v_result ->> 'count')::integer = v_i
       AND (v_result ->> 'remaining')::integer = v_ceiling - v_i,
      format('budget debit %s of exactly %s: %s', v_i, v_ceiling, v_result);
  END LOOP;
  ASSERT EXISTS (
    SELECT 1 FROM public.rate_limit_buckets
     WHERE bucket_key = v_live_key AND count = v_ceiling
       AND expires_at = window_start + interval '48 hours'),
    'the live bucket uses the Pacific key and a 48-hour expiry';
  v_result := public.check_rate_limit(v_endpoint, v_identifier, v_ceiling, v_window);
  ASSERT NOT (v_result ->> 'allowed')::boolean
     AND (v_result ->> 'count')::integer = v_ceiling
     AND (v_result ->> 'remaining')::integer = 0
     AND NOT pg_temp.s5_budget_accepts(v_result, v_ceiling),
    format('debit N+1 is refused at exact exhaustion: %s', v_result);
  ASSERT NOT pg_temp.s5_budget_accepts('{"allowed":true,"count":0,"remaining":3,"retry_after":0}'::jsonb, v_ceiling),
    'a vanished-row count of zero is rejected by the debit helper';

  ASSERT pg_temp.s5_budget_key('data', '2026-01-15 07:59:59+00') = 's5:youtube-analytics:budget:data:2026-01-14'
     AND pg_temp.s5_budget_key('data', '2026-01-15 08:00:01+00') = 's5:youtube-analytics:budget:data:2026-01-15',
    'Pacific midnight splits the budget keys';
  ASSERT pg_temp.s5_budget_key('data', '2026-03-08 09:59:59+00') = 's5:youtube-analytics:budget:data:2026-03-08'
     AND pg_temp.s5_budget_key('data', '2026-03-08 10:00:01+00') = 's5:youtube-analytics:budget:data:2026-03-08'
     AND pg_temp.s5_budget_key('data', '2026-03-09 06:59:59+00') = 's5:youtube-analytics:budget:data:2026-03-08'
     AND pg_temp.s5_budget_key('data', '2026-03-09 07:00:01+00') = 's5:youtube-analytics:budget:data:2026-03-09',
    'spring-forward uses the Pacific date on both sides of the transition and midnight';
  ASSERT pg_temp.s5_budget_key('data', '2026-11-01 08:59:59+00') = 's5:youtube-analytics:budget:data:2026-11-01'
     AND pg_temp.s5_budget_key('data', '2026-11-01 09:00:01+00') = 's5:youtube-analytics:budget:data:2026-11-01'
     AND pg_temp.s5_budget_key('data', '2026-11-02 07:59:59+00') = 's5:youtube-analytics:budget:data:2026-11-01'
     AND pg_temp.s5_budget_key('data', '2026-11-02 08:00:01+00') = 's5:youtube-analytics:budget:data:2026-11-02',
    'fall-back uses the Pacific date on both sides of the transition and midnight';

  INSERT INTO public.rate_limit_buckets (bucket_key, count, window_start, expires_at)
  VALUES ('s5:expired-bucket', 1, clock_timestamp() - interval '3 days', clock_timestamp() - interval '1 day');
  v_deleted := public.cleanup_rate_limit_buckets();
  ASSERT v_deleted >= 1, 'cleanup deleted at least the synthetic expired bucket';
  ASSERT NOT EXISTS (SELECT 1 FROM public.rate_limit_buckets WHERE bucket_key = 's5:expired-bucket'),
    'cleanup removes expired buckets';
  ASSERT EXISTS (SELECT 1 FROM public.rate_limit_buckets WHERE bucket_key = v_live_key),
    'cleanup leaves the live 48-hour bucket';

  v_keys := ARRAY[
    pg_temp.s5_budget_key('data', v_at),
    pg_temp.s5_budget_key('analytics', v_at),
    's5:youtube-analytics:user:' || pg_temp.s5_owner_a()::text,
    's5:youtube-analytics:user:' || pg_temp.s5_owner_b()::text
  ];
  ASSERT (SELECT count(DISTINCT key) FROM unnest(v_keys) AS q(key)) = 4,
    'the two shared budgets and the two per-user buckets have separate keys';
  v_result := public.check_rate_limit('s5:youtube-analytics:budget:analytics', v_identifier, 2, v_window);
  ASSERT pg_temp.s5_budget_accepts(v_result, 2), format('analytics budget has its own counter: %s', v_result);
  v_result := public.check_rate_limit('s5:youtube-analytics:user', pg_temp.s5_owner_a()::text, 2, 60);
  ASSERT pg_temp.s5_budget_accepts(v_result, 2), format('owner A has an independent user bucket: %s', v_result);
  v_result := public.check_rate_limit('s5:youtube-analytics:user', pg_temp.s5_owner_b()::text, 2, 60);
  ASSERT pg_temp.s5_budget_accepts(v_result, 2), format('owner B has an independent user bucket: %s', v_result);
  ASSERT (SELECT count(*) FROM public.rate_limit_buckets WHERE bucket_key = ANY(v_keys)) = 4,
    'all four independent bucket keys exist';
END
$budget_buckets$;

DO $budget_browser_privileges$
DECLARE
  v_role text;
  v_privilege text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      ASSERT NOT has_table_privilege(v_role, 'public.rate_limit_buckets', v_privilege),
        format('%s cannot %s rate_limit_buckets', v_role, v_privilege);
    END LOOP;
  END LOOP;
END
$budget_browser_privileges$;

-- Remove every committed fixture and close every real session.
SELECT extensions.dblink_disconnect('s5_a');
SELECT extensions.dblink_disconnect('s5_b');
SELECT extensions.dblink_disconnect('s5_c');
DELETE FROM public.youtube_token_refresh_leases
 WHERE social_account_id IN (
   '6e5b0001-0000-4000-8000-000000000001', '6e5b0002-0000-4000-8000-000000000002',
   '6e5b0003-0000-4000-8000-000000000003', '6e5b0004-0000-4000-8000-000000000004',
   '6e5b0005-0000-4000-8000-000000000005', '6e5b0006-0000-4000-8000-000000000006',
   '6e5b0010-0000-4000-8000-000000000010', '6e5b0011-0000-4000-8000-000000000011',
   '6e5b0012-0000-4000-8000-000000000012');
DELETE FROM public.youtube_analytics_purpose_consents;
DELETE FROM public.social_accounts
 WHERE id IN (
   '6e5b0001-0000-4000-8000-000000000001', '6e5b0002-0000-4000-8000-000000000002',
   '6e5b0003-0000-4000-8000-000000000003', '6e5b0004-0000-4000-8000-000000000004',
   '6e5b0005-0000-4000-8000-000000000005', '6e5b0006-0000-4000-8000-000000000006',
   '6e5b0010-0000-4000-8000-000000000010', '6e5b0011-0000-4000-8000-000000000011',
   '6e5b0012-0000-4000-8000-000000000012');
DELETE FROM public.connector_connections WHERE id = '6e5c0001-0000-4000-8000-000000000001';
DELETE FROM public.workspaces WHERE id = '6e5d0001-0000-4000-8000-000000000001';
DELETE FROM public.app_settings
 WHERE key IN ('youtube_analytics_stage5_rollout', 'youtube_analytics_stage5_scope_gate')
    OR description = 'Stage 5 SQL suite';
DELETE FROM public.rate_limit_buckets WHERE bucket_key LIKE 's5:%';
DELETE FROM public.user_roles
 WHERE user_id IN (
   '6e5a0001-0000-4000-8000-000000000001', '6e5a0002-0000-4000-8000-000000000002',
   '6e5a0003-0000-4000-8000-000000000003', '6e5a0004-0000-4000-8000-000000000004');
DELETE FROM auth.users
 WHERE id IN (
   '6e5a0001-0000-4000-8000-000000000001', '6e5a0002-0000-4000-8000-000000000002',
   '6e5a0003-0000-4000-8000-000000000003', '6e5a0004-0000-4000-8000-000000000004');

DO $final_state$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.app_settings
     WHERE key IN ('youtube_analytics_stage5_rollout', 'youtube_analytics_stage5_scope_gate')),
    'both Stage 5 settings keys are absent after cleanup';
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_analytics_purpose_consents),
    'the acceptance table is empty after cleanup';
END
$final_state$;

\echo '=== youtube_analytics_stage5_rollout: ALL CHECKS PASSED ==='
