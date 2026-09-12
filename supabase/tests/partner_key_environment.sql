-- ============================================================================
-- partner_key_environment.sql — Phase 10.5 environment-bound keys
--
-- Proves the two-layer isolation (prefix + column) and the minting controls
-- that make staging keys unusable in production and vice versa, even when
-- the hash is present (restored dump). See 20260902180000.
--
-- Run with psql AS A SUPERUSER against a throwaway database with every
-- migration applied. NEVER against production.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== partner_key_environment: start ==='

CREATE TEMP TABLE env_ids (k TEXT PRIMARY KEY, id UUID NOT NULL);
INSERT INTO env_ids VALUES
  ('owner_a',  '55555555-5555-5555-5555-555555555551'),
  ('viewer_a', '55555555-5555-5555-5555-555555555552'),
  ('outsider', '55555555-5555-5555-5555-555555555553'),
  ('owner_b',  '55555555-5555-5555-5555-555555555554'),
  ('ws_a',     '66666666-6666-6666-6666-666666666661'),
  ('ws_b',     '66666666-6666-6666-6666-666666666662'),
  ('acct_a',   '77777777-7777-7777-7777-777777777771'),
  ('acct_b',   '77777777-7777-7777-7777-777777777772');

-- ---------------------------------------------------------------------------
-- Cleanup (before AND after)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.env_cleanup() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_ws uuid[] := ARRAY(SELECT id FROM env_ids WHERE k IN ('ws_a','ws_b'));
  v_us uuid[] := ARRAY(SELECT id FROM env_ids WHERE k IN ('owner_a','viewer_a','outsider','owner_b'));
BEGIN
  DELETE FROM public.partner_audit_logs WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_api_key_accounts WHERE workspace_id = ANY(v_ws);
  UPDATE public.partner_api_keys SET superseded_by_key_id = NULL WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_api_keys WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.social_accounts WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.workspaces WHERE id = ANY(v_ws);
  DELETE FROM public.workspace_members WHERE workspace_id = ANY(v_ws);
  DELETE FROM auth.users WHERE id = ANY(v_us);
END $$;

SELECT pg_temp.env_cleanup();

CREATE OR REPLACE FUNCTION pg_temp.act_as(p_user UUID) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', p_user::text, false)::void;
$$;

CREATE OR REPLACE FUNCTION pg_temp.must(p_cond BOOLEAN, p_label TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT p_cond THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_label; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------
DO $seed$
DECLARE
  v_owner_a  uuid := (SELECT id FROM env_ids WHERE k='owner_a');
  v_viewer_a uuid := (SELECT id FROM env_ids WHERE k='viewer_a');
  v_outsider uuid := (SELECT id FROM env_ids WHERE k='outsider');
  v_owner_b  uuid := (SELECT id FROM env_ids WHERE k='owner_b');
  v_ws_a     uuid := (SELECT id FROM env_ids WHERE k='ws_a');
  v_ws_b     uuid := (SELECT id FROM env_ids WHERE k='ws_b');
  v_acct_a   uuid := (SELECT id FROM env_ids WHERE k='acct_a');
  v_acct_b   uuid := (SELECT id FROM env_ids WHERE k='acct_b');
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_owner_a,  'env-owner-a@example.invalid'),
    (v_viewer_a, 'env-viewer-a@example.invalid'),
    (v_outsider, 'env-outsider@example.invalid'),
    (v_owner_b,  'env-owner-b@example.invalid')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspaces (id, name, owner_id) VALUES
    (v_ws_a, 'env-ws-a', v_owner_a),
    (v_ws_b, 'env-ws-b', v_owner_b)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
    (v_ws_a, v_owner_a,  'owner'),
    (v_ws_a, v_viewer_a, 'viewer'),
    (v_ws_b, v_owner_b,  'owner')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, access_token, workspace_id)
  VALUES
    (v_acct_a, v_owner_a, 'whatsapp', 'env-acct-a', 'seed-a', v_ws_a),
    (v_acct_b, v_owner_b, 'whatsapp', 'env-acct-b', 'seed-b', v_ws_b)
  ON CONFLICT (id) DO NOTHING;
END $seed$;

-- ===========================================================================
-- E1 — column default is production and CHECK refuses sandbox
-- ===========================================================================
DO $e1$
DECLARE
  v_ws_a   uuid := (SELECT id FROM env_ids WHERE k='ws_a');
  v_acct_a uuid := (SELECT id FROM env_ids WHERE k='acct_a');
  v_owner  uuid := (SELECT id FROM env_ids WHERE k='owner_a');
  v_key    uuid;
BEGIN
  PERFORM pg_temp.act_as(v_owner);
  -- Default: no environment supplied => production
  v_key := public.create_partner_key(
    v_ws_a, v_acct_a, 'env default', 'pk_live_e001',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
    ARRAY['messages:send']);
  PERFORM pg_temp.must(
    (SELECT environment FROM public.partner_api_keys WHERE id = v_key) = 'production',
    'E1 default environment is production');
  -- Direct insert with sandbox must be refused by the CHECK
  BEGIN
    INSERT INTO public.partner_api_keys
      (workspace_id, social_account_id, name, key_prefix, key_hash, environment, scopes)
    VALUES (v_ws_a, v_acct_a, 'bad env', 'pk_live_e002',
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            'sandbox', ARRAY['messages:send']);
    RAISE EXCEPTION 'E1: sandbox environment was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS E1: column default is production and CHECK refuses sandbox';
END $e1$;

-- ===========================================================================
-- E2 — create with staging + pk_test_ succeeds and stamps row + audit
-- ===========================================================================
DO $e2$
DECLARE
  v_ws_a   uuid := (SELECT id FROM env_ids WHERE k='ws_a');
  v_acct_a uuid := (SELECT id FROM env_ids WHERE k='acct_a');
  v_owner  uuid := (SELECT id FROM env_ids WHERE k='owner_a');
  v_key    uuid;
BEGIN
  PERFORM pg_temp.act_as(v_owner);
  v_key := public.create_partner_key(
    v_ws_a, v_acct_a, 'env staging ok', 'pk_test_e010',
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    ARRAY['messages:send'], 60, NULL, NULL, 'req-e2', 'staging');
  PERFORM pg_temp.must(
    (SELECT environment FROM public.partner_api_keys WHERE id = v_key) = 'staging',
    'E2 row environment is staging');
  PERFORM pg_temp.must(
    (SELECT key_prefix FROM public.partner_api_keys WHERE id = v_key) = 'pk_test_e010',
    'E2 row prefix is pk_test_');
  PERFORM pg_temp.must(
    (SELECT metadata->>'environment' FROM public.partner_audit_logs
      WHERE key_id = v_key AND action = 'create') = 'staging',
    'E2 audit metadata carries staging');
  RAISE NOTICE 'PASS E2: staging + pk_test_ succeeds and stamps environment';
END $e2$;

-- ===========================================================================
-- E3 — mismatched prefix / environment and unknown env are refused
-- ===========================================================================
DO $e3$
DECLARE
  v_ws_a   uuid := (SELECT id FROM env_ids WHERE k='ws_a');
  v_acct_a uuid := (SELECT id FROM env_ids WHERE k='acct_a');
  v_owner  uuid := (SELECT id FROM env_ids WHERE k='owner_a');
BEGIN
  PERFORM pg_temp.act_as(v_owner);
  -- staging with pk_live_ → refuse
  BEGIN
    PERFORM public.create_partner_key(
      v_ws_a, v_acct_a, 'bad', 'pk_live_e020',
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      ARRAY['messages:send'], 60, NULL, NULL, NULL, 'staging');
    RAISE EXCEPTION 'E3a: staging + pk_live_ was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- production with pk_test_ → refuse
  BEGIN
    PERFORM public.create_partner_key(
      v_ws_a, v_acct_a, 'bad', 'pk_test_e021',
      'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      ARRAY['messages:send'], 60, NULL, NULL, NULL, 'production');
    RAISE EXCEPTION 'E3b: production + pk_test_ was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- unknown prefix → refuse
  BEGIN
    PERFORM public.create_partner_key(
      v_ws_a, v_acct_a, 'bad', 'pk_unknown_e022',
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      ARRAY['messages:send'], 60, NULL, NULL, NULL, 'production');
    RAISE EXCEPTION 'E3c: unknown prefix was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- sandbox environment → refuse
  BEGIN
    PERFORM public.create_partner_key(
      v_ws_a, v_acct_a, 'bad', 'pk_live_e023',
      '1111111111111111111111111111111111111111111111111111111111111111',
      ARRAY['messages:send'], 60, NULL, NULL, NULL, 'sandbox');
    RAISE EXCEPTION 'E3d: sandbox environment was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS E3: mismatched prefix/environment and unknown env are refused';
END $e3$;

-- ===========================================================================
-- E4 — old arity (without p_environment) still works and yields production
-- ===========================================================================
DO $e4$
DECLARE
  v_ws_a   uuid := (SELECT id FROM env_ids WHERE k='ws_a');
  v_acct_a uuid := (SELECT id FROM env_ids WHERE k='acct_a');
  v_owner  uuid := (SELECT id FROM env_ids WHERE k='owner_a');
  v_key    uuid;
BEGIN
  PERFORM pg_temp.act_as(v_owner);
  -- Call with the old 9-arg shape (no request_id, no environment) — the DEFAULTs cover it.
  -- Use named notation omitting the new param to exercise old callers.
  v_key := public.create_partner_key(
    v_ws_a, v_acct_a, 'old arity', 'pk_live_e030',
    '2222222222222222222222222222222222222222222222222222222222222222',
    ARRAY['messages:send']);
  PERFORM pg_temp.must(
    (SELECT environment FROM public.partner_api_keys WHERE id = v_key) = 'production',
    'E4 old arity yields production');
  RAISE NOTICE 'PASS E4: old arity without environment still works as production';
END $e4$;

-- ===========================================================================
-- E5 — rotate on staging key with pk_test_ successor keeps staging; pk_live_ refuses
-- ===========================================================================
DO $e5$
DECLARE
  v_ws_a   uuid := (SELECT id FROM env_ids WHERE k='ws_a');
  v_acct_a uuid := (SELECT id FROM env_ids WHERE k='acct_a');
  v_owner  uuid := (SELECT id FROM env_ids WHERE k='owner_a');
  v_old    uuid;
  v_new    uuid;
BEGIN
  PERFORM pg_temp.act_as(v_owner);
  v_old := public.create_partner_key(
    v_ws_a, v_acct_a, 'rotate staging', 'pk_test_e040',
    '3333333333333333333333333333333333333333333333333333333333333333',
    ARRAY['messages:send'], 60, NULL, NULL, 'req-e5', 'staging');
  -- Correct successor prefix keeps staging
  v_new := public.rotate_partner_key(
    v_old, 'pk_test_e041',
    '4444444444444444444444444444444444444444444444444444444444444444',
    60, 'req-e5-rot');
  PERFORM pg_temp.must(
    (SELECT environment FROM public.partner_api_keys WHERE id = v_new) = 'staging',
    'E5 successor retains staging environment');
  PERFORM pg_temp.must(
    (SELECT environment FROM public.partner_api_keys WHERE id = v_old) = 'staging',
    'E5 predecessor remains staging');
  -- pk_live_ successor on a staging predecessor must be refused
  -- Need a fresh staging key because v_old is already superseded
  v_old := public.create_partner_key(
    v_ws_a, v_acct_a, 'rotate staging 2', 'pk_test_e042',
    '5555555555555555555555555555555555555555555555555555555555555555',
    ARRAY['messages:send'], 60, NULL, NULL, 'req-e5b', 'staging');
  BEGIN
    PERFORM public.rotate_partner_key(
      v_old, 'pk_live_e043',
      '6666666666666666666666666666666666666666666666666666666666666666',
      60, 'req-e5-bad');
    RAISE EXCEPTION 'E5: staging key rotated with pk_live_ was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS E5: rotate inherits environment and enforces prefix agreement';
END $e5$;

-- ===========================================================================
-- E6 — rotate on production key with pk_live_ keeps production; pk_test_ refuses
-- ===========================================================================
DO $e6$
DECLARE
  v_ws_a   uuid := (SELECT id FROM env_ids WHERE k='ws_a');
  v_acct_a uuid := (SELECT id FROM env_ids WHERE k='acct_a');
  v_owner  uuid := (SELECT id FROM env_ids WHERE k='owner_a');
  v_old    uuid;
  v_new    uuid;
BEGIN
  PERFORM pg_temp.act_as(v_owner);
  v_old := public.create_partner_key(
    v_ws_a, v_acct_a, 'rotate prod', 'pk_live_e050',
    '7777777777777777777777777777777777777777777777777777777777777777',
    ARRAY['messages:send'], 60, NULL, NULL, 'req-e6', 'production');
  v_new := public.rotate_partner_key(
    v_old, 'pk_live_e051',
    '8888888888888888888888888888888888888888888888888888888888888888',
    60, 'req-e6-rot');
  PERFORM pg_temp.must(
    (SELECT environment FROM public.partner_api_keys WHERE id = v_new) = 'production',
    'E6 production successor retains production');
  v_old := public.create_partner_key(
    v_ws_a, v_acct_a, 'rotate prod 2', 'pk_live_e052',
    '9999999999999999999999999999999999999999999999999999999999999999',
    ARRAY['messages:send'], 60, NULL, NULL, 'req-e6b', 'production');
  BEGIN
    PERFORM public.rotate_partner_key(
      v_old, 'pk_test_e053',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0',
      60, 'req-e6-bad');
    RAISE EXCEPTION 'E6: production key rotated with pk_test_ was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS E6: production rotate keeps production and refuses pk_test_';
END $e6$;

-- ===========================================================================
-- E7 — exactly one create_partner_key exists. CREATE OR REPLACE with a new
-- parameter list ADDS an overload, and two overloads that both accept the
-- deployed 10-argument call make it "not unique": the lifecycle suite failed
-- that way on the first cut of this migration. The DROP is the fix; this is
-- what proves it stays fixed.
-- ===========================================================================
DO $e7a$
DECLARE
  v_overloads INTEGER;
BEGIN
  SELECT count(*) INTO v_overloads
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_partner_key';
  PERFORM pg_temp.must(v_overloads = 1,
    'E7 create_partner_key has exactly one overload (found ' || v_overloads || ')');
  PERFORM pg_temp.must(
    public.partner_key_environment_for_prefix('pk_live_x') = 'production'
    AND public.partner_key_environment_for_prefix('pk_test_x') = 'staging',
    'E7 the prefix rule maps both prefixes');
  BEGIN
    PERFORM public.partner_key_environment_for_prefix('pkXliveXx');
    RAISE EXCEPTION 'E7: LIKE wildcard matched a non-prefix (underscores must be literal)';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS E7a: one overload; the prefix rule is literal';
END $e7a$;

-- ---------------------------------------------------------------------------
-- E7c — the operator scripts run under a user JWT and read `environment`
-- before rotating; `authenticated` holds a column list, so the new column has
-- to be named in it. The widening must stay a column: key_hash never.
-- ---------------------------------------------------------------------------
DO $e7c$
BEGIN
  PERFORM pg_temp.must(
    has_column_privilege('authenticated', 'public.partner_api_keys', 'environment', 'SELECT'),
    'E7c authenticated may SELECT partner_api_keys.environment');
  PERFORM pg_temp.must(
    NOT has_column_privilege('authenticated', 'public.partner_api_keys', 'key_hash', 'SELECT'),
    'E7c authenticated still may NOT SELECT partner_api_keys.key_hash');
  PERFORM pg_temp.must(
    NOT has_table_privilege('authenticated', 'public.partner_api_keys', 'SELECT'),
    'E7c authenticated has no table-level SELECT on partner_api_keys');
  RAISE NOTICE 'PASS E7c: environment is client-readable, key_hash is not';
END $e7c$;

-- ---------------------------------------------------------------------------
-- E7b — grants: authenticated may EXECUTE both, anon may not. Checked via the
-- privilege view, so the result proves the GRANT surface and not the
-- membership predicate the functions apply internally.
-- ---------------------------------------------------------------------------
DO $e7$
BEGIN
  PERFORM pg_temp.must(
    has_function_privilege('authenticated',
      'public.create_partner_key(uuid, uuid, text, text, text, text[], integer, integer, timestamptz, text, text)',
      'EXECUTE'),
    'E7 authenticated may EXECUTE create_partner_key (new arity)');
  PERFORM pg_temp.must(
    NOT has_function_privilege('anon',
      'public.create_partner_key(uuid, uuid, text, text, text, text[], integer, integer, timestamptz, text, text)',
      'EXECUTE'),
    'E7 anon may NOT EXECUTE create_partner_key');
  PERFORM pg_temp.must(
    has_function_privilege('authenticated',
      'public.rotate_partner_key(uuid, text, text, integer, text)',
      'EXECUTE'),
    'E7 authenticated may EXECUTE rotate_partner_key');
  PERFORM pg_temp.must(
    NOT has_function_privilege('anon',
      'public.rotate_partner_key(uuid, text, text, integer, text)',
      'EXECUTE'),
    'E7 anon may NOT EXECUTE rotate_partner_key');
  RAISE NOTICE 'PASS E7: grants are correct (authenticated may, anon may not)';
END $e7$;

-- Also prove anon is actually blocked at execution, not just in the view:
-- SET ROLE must be at statement level (outside DO).
\echo '--- grant execution checks as anon ---'
SET ROLE anon;
DO $e7anon$
BEGIN
  BEGIN
    PERFORM public.create_partner_key(
      '66666666-6666-6666-6666-666666666661'::uuid,
      '77777777-7777-7777-7777-777777777771'::uuid,
      'grant test', 'pk_live_grant',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ARRAY['messages:send']);
    RAISE EXCEPTION 'E7 anon EXECUTED create_partner_key';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS E7 anon blocked from create_partner_key at execution';
  END;
  BEGIN
    PERFORM public.rotate_partner_key(
      '00000000-0000-0000-0000-000000000000'::uuid,
      'pk_live_grant2',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      60);
    RAISE EXCEPTION 'E7 anon EXECUTED rotate_partner_key';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS E7 anon blocked from rotate_partner_key at execution';
  END;
END $e7anon$;
RESET ROLE;

-- ===========================================================================
-- E8 — platform-tier environment isolation (20260910100000 defect A fix).
--
-- One principal holds a STAGING platform key and a PRODUCTION provisioned
-- workspace + account + workspace key. A staging platform key must neither
-- issue a production key in its own estate nor revoke a live production
-- key; the matching-environment path must still work. p_platform_key_id is
-- REQUIRED (no default): it is the environment anchor, not audit metadata.
-- ===========================================================================
CREATE TEMP TABLE e8_ids (k TEXT PRIMARY KEY, id UUID NOT NULL);
INSERT INTO e8_ids VALUES
  ('principal', 'e8000001-0000-4000-8000-000000000001'),
  ('owner',     'e8000001-0000-4000-8000-000000000002'),
  ('ws_prod',   'e8000001-0000-4000-8000-000000000003'),
  ('acct_prod', 'e8000001-0000-4000-8000-000000000004'),
  ('plat_stag', 'e8000001-0000-4000-8000-000000000005'),
  ('plat_prod', 'e8000001-0000-4000-8000-000000000006'),
  ('key_prod',  'e8000001-0000-4000-8000-000000000007');

CREATE OR REPLACE FUNCTION pg_temp.e8_cleanup() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_ws uuid[] := ARRAY(SELECT id FROM e8_ids WHERE k IN ('ws_prod'));
  v_us uuid[] := ARRAY(SELECT id FROM e8_ids WHERE k IN ('owner'));
  v_pr uuid[] := ARRAY(SELECT id FROM e8_ids WHERE k IN ('principal'));
  v_pk uuid[] := ARRAY(SELECT id FROM e8_ids WHERE k IN ('plat_stag','plat_prod'));
BEGIN
  DELETE FROM public.partner_audit_logs WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_api_key_accounts WHERE workspace_id = ANY(v_ws);
  UPDATE public.partner_api_keys SET superseded_by_key_id = NULL WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_api_keys WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_platform_keys WHERE id = ANY(v_pk);
  DELETE FROM public.partner_provisioned_workspaces WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.social_accounts WHERE workspace_id = ANY(v_ws);
  -- No explicit workspace_members delete: prevent_last_workspace_owner()
  -- refuses a direct delete of the last owner, but expressly permits the
  -- cascade from the workspace delete below.
  DELETE FROM public.workspaces WHERE id = ANY(v_ws);
  DELETE FROM public.partner_principals WHERE id = ANY(v_pr);
  DELETE FROM auth.users WHERE id = ANY(v_us);
END $$;

SELECT pg_temp.e8_cleanup();

DO $e8seed$
DECLARE
  v_pr    uuid := (SELECT id FROM e8_ids WHERE k='principal');
  v_owner uuid := (SELECT id FROM e8_ids WHERE k='owner');
  v_ws    uuid := (SELECT id FROM e8_ids WHERE k='ws_prod');
  v_acct  uuid := (SELECT id FROM e8_ids WHERE k='acct_prod');
  v_pstag uuid := (SELECT id FROM e8_ids WHERE k='plat_stag');
  v_pprod uuid := (SELECT id FROM e8_ids WHERE k='plat_prod');
  v_key   uuid := (SELECT id FROM e8_ids WHERE k='key_prod');
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_owner, 'e8-owner@example.invalid')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.partner_principals (id, name) VALUES
    (v_pr, 'e8 principal')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspaces (id, name, owner_id) VALUES
    (v_ws, 'e8-ws-prod', v_owner)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
    (v_ws, v_owner, 'owner')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, access_token, workspace_id)
  VALUES
    (v_acct, v_owner, 'whatsapp', 'e8-acct-prod', 'seed-e8', v_ws)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.partner_platform_keys
    (id, principal_id, name, environment, key_prefix, key_hash, scopes)
  VALUES
    (v_pstag, v_pr, 'e8 staging platform', 'staging', 'pl_test_e8stag',
     'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', '{}'),
    (v_pprod, v_pr, 'e8 production platform', 'production', 'pl_live_e8prod',
     'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', '{}')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.partner_provisioned_workspaces
    (workspace_id, principal_id, owner_user_id, environment, external_ref)
  VALUES (v_ws, v_pr, v_owner, 'production', 'e8-ext-prod')
  ON CONFLICT (workspace_id) DO NOTHING;

  INSERT INTO public.partner_api_keys
    (id, workspace_id, social_account_id, created_by, name, key_prefix, key_hash, environment, scopes)
  VALUES (v_key, v_ws, v_acct, v_owner, 'e8 prod key', 'pk_live_e800',
          'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3',
          'production', ARRAY['messages:send'])
  ON CONFLICT (id) DO NOTHING;
END $e8seed$;

-- E8a — a staging platform key cannot mint in the production estate, in
-- either direction: production key in production workspace, or staging key
-- against a production workspace. Both raise no_data_found (nothing
-- enumerable), never a distinct error.
DO $e8a$
DECLARE
  v_pr    uuid := (SELECT id FROM e8_ids WHERE k='principal');
  v_owner uuid := (SELECT id FROM e8_ids WHERE k='owner');
  v_ws    uuid := (SELECT id FROM e8_ids WHERE k='ws_prod');
  v_acct  uuid := (SELECT id FROM e8_ids WHERE k='acct_prod');
  v_pstag uuid := (SELECT id FROM e8_ids WHERE k='plat_stag');
BEGIN
  PERFORM pg_temp.act_as(v_owner);
  BEGIN
    PERFORM public.issue_partner_key_in_estate(
      v_pr, v_ws, v_acct, 'e8 cross-env', 'pk_live_e801',
      'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4',
      ARRAY['messages:send'], v_pstag, 60, NULL, NULL, 'production', 'req-e8a');
    RAISE EXCEPTION 'E8a: a staging platform key minted a production key in its own estate';
  EXCEPTION WHEN no_data_found THEN
    NULL;
  END;
  BEGIN
    PERFORM public.issue_partner_key_in_estate(
      v_pr, v_ws, v_acct, 'e8 cross-env staging', 'pk_test_e802',
      'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5',
      ARRAY['messages:send'], v_pstag, 60, NULL, NULL, 'staging', 'req-e8a2');
    RAISE EXCEPTION 'E8a: a staging issue against a production workspace was accepted';
  EXCEPTION WHEN no_data_found THEN
    NULL;
  END;
  RAISE NOTICE 'PASS E8a: staging platform key cannot mint across environments (no_data_found both ways)';
END $e8a$;

-- E8b — revoking a production key with a staging platform key revokes
-- nothing: returns FALSE and the key stays live.
DO $e8b$
DECLARE
  v_pr    uuid := (SELECT id FROM e8_ids WHERE k='principal');
  v_owner uuid := (SELECT id FROM e8_ids WHERE k='owner');
  v_key   uuid := (SELECT id FROM e8_ids WHERE k='key_prod');
  v_pstag uuid := (SELECT id FROM e8_ids WHERE k='plat_stag');
BEGIN
  PERFORM pg_temp.act_as(v_owner);
  PERFORM pg_temp.must(
    public.revoke_partner_key_in_estate(v_pr, v_key, 'e8 hostile', v_pstag, 'req-e8b') = FALSE,
    'E8b cross-environment revoke returns FALSE');
  PERFORM pg_temp.must(
    (SELECT revoked_at FROM public.partner_api_keys WHERE id = v_key) IS NULL,
    'E8b production key stays live after the staging revoke attempt');
  RAISE NOTICE 'PASS E8b: staging platform key cannot revoke a production key';
END $e8b$;

-- E8c — the matching-environment path still works end to end, and the
-- estate link records the requested environment.
DO $e8c$
DECLARE
  v_pr    uuid := (SELECT id FROM e8_ids WHERE k='principal');
  v_owner uuid := (SELECT id FROM e8_ids WHERE k='owner');
  v_ws    uuid := (SELECT id FROM e8_ids WHERE k='ws_prod');
  v_acct  uuid := (SELECT id FROM e8_ids WHERE k='acct_prod');
  v_pprod uuid := (SELECT id FROM e8_ids WHERE k='plat_prod');
  v_new   uuid;
BEGIN
  PERFORM pg_temp.act_as(v_owner);
  PERFORM pg_temp.must(
    (SELECT environment FROM public.partner_provisioned_workspaces WHERE workspace_id = v_ws) = 'production',
    'E8c estate link records the requested environment');
  v_new := public.issue_partner_key_in_estate(
    v_pr, v_ws, v_acct, 'e8 matching env', 'pk_live_e803',
    'f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6',
    ARRAY['messages:send'], v_pprod, 60, NULL, NULL, 'production', 'req-e8c');
  PERFORM pg_temp.must(v_new IS NOT NULL,
    'E8c matching-environment issue succeeds');
  PERFORM pg_temp.must(
    public.revoke_partner_key_in_estate(v_pr, v_new, 'e8 matching revoke', v_pprod, 'req-e8c2') = TRUE,
    'E8c matching-environment revoke succeeds');
  RAISE NOTICE 'PASS E8c: matching-environment issue and revoke succeed';
END $e8c$;

-- E8d — exactly one of each estate function exists. Dropping a DEFAULT
-- keeps the type list, but any CREATE that adds an overload (rather than
-- CREATE OR REPLACE) makes the handler's named-parameter call ambiguous:
-- the E7 single-overload check proved this failure mode once already.
DO $e8d$
DECLARE
  v_n INTEGER;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'issue_partner_key_in_estate';
  PERFORM pg_temp.must(v_n = 1,
    'E8d issue_partner_key_in_estate has exactly one overload (found ' || v_n || ')');
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'revoke_partner_key_in_estate';
  PERFORM pg_temp.must(v_n = 1,
    'E8d revoke_partner_key_in_estate has exactly one overload (found ' || v_n || ')');
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'provision_partner_tenant';
  PERFORM pg_temp.must(v_n = 1,
    'E8d provision_partner_tenant has exactly one overload (found ' || v_n || ')');
  RAISE NOTICE 'PASS E8d: one overload each for the three estate functions';
END $e8d$;

SELECT pg_temp.e8_cleanup();
DROP FUNCTION IF EXISTS pg_temp.e8_cleanup();

SELECT pg_temp.env_cleanup();
DROP FUNCTION IF EXISTS pg_temp.act_as(UUID);
DROP FUNCTION IF EXISTS pg_temp.must(BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS pg_temp.env_cleanup();

\echo '=== partner_key_environment: ALL CHECKS PASSED ==='
