-- supabase/tests/youtube_comment_operations.sql
-- YouTube Stage 4 comment operations (migration 20261122130000).
--
-- Synthetic fixtures, no provider calls, no real tokens. The receipt
-- functions, the binding-generation trigger, the digest keys and the rollout
-- evaluator are exercised as the deployed roles would reach them: the
-- service role executes the RPCs, `authenticated` plays the browser path
-- under RLS with request.jwt.claims, and the narrow refresh authority is
-- proven structurally from the catalog.
--
-- Blocks S1-S13 run in a single transaction that rolls back.
-- The R blocks commit synthetic fixtures so two real dblink sessions can
-- race on the same rows with a fixed interleaving, and delete those fixtures
-- explicitly before exiting.
--
-- Digest note: the TS handler joins the canonical logical string with U+0000
-- separators, which Postgres text cannot hold, so the cross-check of the
-- handler's HMAC formula builds the bytea the same way TextEncoder does.

\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

-- A previously killed run may have committed the race fixtures before its
-- cleanup; remove them so this suite is self-healing. The rolled-back part
-- re-creates everything it needs.
DELETE FROM public.youtube_comment_operations
 WHERE owner_id IN ('6e9a0001-0000-4000-8000-000000000001', '6e8a0001-0000-4000-8000-000000000001');
-- The rotation fixtures of the R blocks are committed: a killed run may have
-- left an extra key version, or version 1 retired. Receipts first (a version
-- a receipt references cannot be deleted), then the fixtures.
UPDATE public.youtube_comment_digest_keys SET retired_at = NULL WHERE version = 1;
DELETE FROM public.youtube_comment_digest_keys WHERE version > 1;
DELETE FROM public.social_accounts
 WHERE id IN ('6e9b0001-0000-4000-8000-000000000001', '6e8b0006-0000-4000-8000-000000000006');
DELETE FROM public.connector_connections
 WHERE id::text LIKE '6e8c000%';
DELETE FROM public.workspaces
 WHERE id IN ('6e9d0001-0000-4000-8000-000000000001', '6e8d0001-0000-4000-8000-000000000001', '6e8d0002-0000-4000-8000-000000000002');
DELETE FROM auth.users
 WHERE id IN ('6e9a0001-0000-4000-8000-000000000001', '6e8a0001-0000-4000-8000-000000000001', '6e8a0002-0000-4000-8000-000000000002');

-- The two helpers every claim below depends on. They are session temp functions:
-- nothing here outlives the psql session.
--
-- pg_temp.s4_map(digest): the digest map the claim requires, the same intent
-- digest under every retained key version. It stands for what the single-digest
-- form used to express; the cases that test rotation build explicit
-- per-version maps instead.
CREATE FUNCTION pg_temp.s4_map(p_digest text) RETURNS jsonb LANGUAGE sql AS
  $$ SELECT jsonb_object_agg(k.version::text, p_digest) FROM public.youtube_comment_digest_keys AS k $$;

-- pg_temp.s4_next_version(): the next key version number nobody ever used. A
-- deleted version number is never issued again, so a case that rotates keys
-- cannot name a literal: it asks the watermark.
CREATE FUNCTION pg_temp.s4_next_version() RETURNS int LANGUAGE sql AS
  $$ SELECT GREATEST(
            COALESCE((SELECT max(version) FROM public.youtube_comment_digest_keys), 0),
            COALESCE((SELECT last_version FROM public.youtube_comment_digest_key_watermark), 0)) + 1 $$;

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures (rolled back with the whole first part).
-- ---------------------------------------------------------------------------
DO $fixtures$
DECLARE
  u_a   uuid := '6e8a0001-0000-4000-8000-000000000001';
  u_b   uuid := '6e8a0002-0000-4000-8000-000000000002';
  a_a1  uuid := '6e8b0001-0000-4000-8000-000000000001';
  a_a3  uuid := '6e8b0003-0000-4000-8000-000000000003';
  a_a4  uuid := '6e8b0004-0000-4000-8000-000000000004';
  a_a5  uuid := '6e8b0005-0000-4000-8000-000000000005';
  a_b1  uuid := '6e8b0101-0000-4000-8000-000000000001';
  a_b2  uuid := '6e8b0102-0000-4000-8000-000000000002';
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 's4-owner-a@example.invalid'),
    (u_b, 's4-owner-b@example.invalid');

  -- connector_connections rows for every connection_id the suite names:
  -- the column is a uuid with a real foreign key, not decoration.
  INSERT INTO public.workspaces (id, owner_id, name, is_personal) VALUES
    ('6e8d0001-0000-4000-8000-000000000001', u_a, 'S4 Suite A', true),
    ('6e8d0002-0000-4000-8000-000000000002', u_b, 'S4 Suite B', true);

  INSERT INTO public.connector_connections (
    id, workspace_id, connector_type, toolkit, composio_auth_config_id, external_account_id, status
  ) VALUES
    ('6e8c0001-0000-4000-8000-000000000001', '6e8d0001-0000-4000-8000-000000000001', 'youtube', 'youtube', 'ac-s4-delta', 'ext-s4-delta', 'active'),
    ('6e8c0002-0000-4000-8000-000000000002', '6e8d0001-0000-4000-8000-000000000001', 'youtube', 'youtube', 'ac-s4-changed', 'ext-s4-changed', 'active'),
    ('6e8c0003-0000-4000-8000-000000000003', '6e8d0001-0000-4000-8000-000000000001', 'youtube', 'youtube', 'ac-s4-alpha', 'ext-s4-alpha', 'active'),
    ('6e8c0004-0000-4000-8000-000000000004', '6e8d0001-0000-4000-8000-000000000001', 'youtube', 'youtube', 'ac-r4', 'ext-r4', 'active');

  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, platform_username,
    access_token, refresh_token, token_expires_at, is_active, auth_provider,
    connection_id, needs_reauth, failure_count, account_metadata
  ) VALUES
    -- a1: the main admitted native account (read+held+write, ban off).
    (a_a1, u_a, 'youtube', 'UC-s4-alpha', 's4-alpha',
     'alpha-access-1', 'alpha-refresh-1', clock_timestamp() + interval '1 hour',
     true, 'native', NULL, false, 0, '{"channel_title":"Alpha"}'::jsonb),
    -- a3: the second admitted native account (ban on).
    (a_a3, u_a, 'youtube', 'UC-s4-gamma', 's4-gamma',
     'gamma-access-1', 'gamma-refresh-1', clock_timestamp() + interval '1 hour',
     true, 'native', NULL, false, 0, '{}'::jsonb),
    -- a4: the Composio account of the same owner.
    (a_a4, u_a, 'youtube', 'UC-s4-delta', 's4-delta',
     NULL, NULL, NULL, true, 'composio', '6e8c0001-0000-4000-8000-000000000001', false, 0, '{}'::jsonb),
    -- a5: a non-YouTube row of the same owner.
    (a_a5, u_a, 'facebook', 'fb-s4-1', 's4-fb',
     'fb-access', NULL, clock_timestamp() + interval '1 hour', true, 'native',
     NULL, false, 0, '{}'::jsonb),
    -- b1: owner B on the SAME channel as a1 (fences are per owner).
    (a_b1, u_b, 'youtube', 'UC-s4-alpha', 's4-alpha-b',
     'alphab-access-1', 'alphab-refresh-1', clock_timestamp() + interval '1 hour',
     true, 'native', NULL, false, 0, '{}'::jsonb),
    -- b2: owner B's own second channel.
    (a_b2, u_b, 'youtube', 'UC-s4-beta', 's4-beta',
     'beta-access-1', 'beta-refresh-1', clock_timestamp() + interval '1 hour',
     true, 'native', NULL, false, 0, '{}'::jsonb);

  INSERT INTO public.app_settings (key, value, description) VALUES
    ('feature_youtube_comments', 'true'::jsonb, 'Stage 4 suite tile flag'),
    ('youtube_comments_stage4_rollout',
     jsonb_build_object(
       'version', 1,
       'accounts', jsonb_build_object(
         a_a1::text, jsonb_build_object('read', true, 'held', true, 'write', true, 'ban', false),
         a_a3::text, jsonb_build_object('read', true, 'held', true, 'write', true, 'ban', true),
         a_b1::text, jsonb_build_object('read', true, 'held', true, 'write', true, 'ban', false)
       )
     ),
     'Stage 4 suite rollout policy')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
END
$fixtures$;

CREATE TEMP TABLE s4_gen (account uuid PRIMARY KEY, generation bigint NOT NULL) ON COMMIT DROP;
INSERT INTO s4_gen
  SELECT id, binding_generation FROM public.social_accounts
   WHERE platform = 'youtube';

-- ---------------------------------------------------------------------------
-- S1. Old-code compatibility and the generation-authority matrix.
-- ---------------------------------------------------------------------------
DO $s1$
DECLARE
  u_a  uuid := '6e8a0001-0000-4000-8000-000000000001';
  a_a1 uuid := '6e8b0001-0000-4000-8000-000000000001';
  a_a3 uuid := '6e8b0003-0000-4000-8000-000000000003';
  a_a4 uuid := '6e8b0004-0000-4000-8000-000000000004';
  a_a5 uuid := '6e8b0005-0000-4000-8000-000000000005';
  v_gen_before bigint;
  v_gen_after  bigint;
  v_ok         boolean;
  v_json       jsonb;
  v_provider   text;
  v_connection uuid;
  v_lease      jsonb;
  v_expires    timestamptz;
BEGIN
  SELECT binding_generation INTO v_gen_before FROM public.social_accounts WHERE id = a_a1;

  -- 1. the plain trusted refresh keeps the generation (rotated tokens and all)
  SELECT token_expires_at INTO v_expires FROM public.social_accounts WHERE id = a_a1;
  v_ok := public.store_youtube_refreshed_token(
    a_a1, 'alpha-refresh-1', 'alpha-access-1', v_expires,
    'alpha-access-2', clock_timestamp() + interval '2 hours');
  ASSERT v_ok IS TRUE, 'S1.1 store_youtube_refreshed_token succeeded';
  SELECT binding_generation INTO v_gen_after FROM public.social_accounts WHERE id = a_a1;
  ASSERT v_gen_after = v_gen_before, format('S1.1 plain refresh kept the generation: %s -> %s', v_gen_before, v_gen_after);
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = a_a1) = 'alpha-access-2',
    'S1.1 the refresh actually wrote the new access token';

  -- 2. the lease variant without a new refresh token keeps the generation
  v_lease := public.acquire_youtube_refresh_lease(a_a1, 60);
  ASSERT (v_lease ->> 'ok')::boolean, 'S1.2 lease acquired';
  v_json := public.store_youtube_refreshed_token_with_lease(
    a_a1, (v_lease ->> 'lease_token')::uuid,
    'alpha-access-3', clock_timestamp() + interval '3 hours',
    NULL, NULL);
  ASSERT (v_json ->> 'ok')::boolean, format('S1.2 lease refresh ok: %s', v_json);
  SELECT binding_generation INTO v_gen_after FROM public.social_accounts WHERE id = a_a1;
  ASSERT v_gen_after = v_gen_before, 'S1.2 lease refresh without rotation kept the generation';
  ASSERT (SELECT refresh_token FROM public.social_accounts WHERE id = a_a1) = 'alpha-refresh-1',
    'S1.2 an omitted refresh token preserved the stored one';

  -- 3. the lease variant WITH a rotated refresh token keeps the generation
  v_lease := public.acquire_youtube_refresh_lease(a_a1, 60);
  v_json := public.store_youtube_refreshed_token_with_lease(
    a_a1, (v_lease ->> 'lease_token')::uuid,
    'alpha-access-4', clock_timestamp() + interval '4 hours',
    'alpha-refresh-2', NULL);
  ASSERT (v_json ->> 'ok')::boolean, format('S1.3 rotated lease refresh ok: %s', v_json);
  SELECT binding_generation INTO v_gen_after FROM public.social_accounts WHERE id = a_a1;
  ASSERT v_gen_after = v_gen_before, 'S1.3 a rotated refresh token through the lease variant kept the generation';
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_token_refresh_leases WHERE social_account_id = a_a1),
    'S1.3 the lease closed (the existing credential-change trigger still fired)';

  -- 4. the browser path: a metadata-only update keeps the generation
  UPDATE s4_gen SET generation = v_gen_before WHERE account = a_a1;
  -- (SET LOCAL ROLE cannot run inside a DO block; S1b below covers the
  --  browser-path writes. Here: the service-role health writes.)
  UPDATE public.social_accounts
     SET needs_reauth = true, failure_count = 2, last_refresh_error = 'suite probe'
   WHERE id = a_a1;
  SELECT binding_generation INTO v_gen_after FROM public.social_accounts WHERE id = a_a1;
  ASSERT v_gen_after = v_gen_before, 'S1.4 needs_reauth/failure_count writes kept the generation';
  UPDATE public.social_accounts SET needs_reauth = false, failure_count = 0, last_refresh_error = NULL
   WHERE id = a_a1;

  -- 5. a direct service-role credential change advances it by one
  UPDATE public.social_accounts SET access_token = 'alpha-access-5' WHERE id = a_a1;
  SELECT binding_generation INTO v_gen_after FROM public.social_accounts WHERE id = a_a1;
  ASSERT v_gen_after = v_gen_before + 1, format('S1.5 a superuser credential change advanced the generation: %s -> %s', v_gen_before, v_gen_after);
  UPDATE s4_gen SET generation = v_gen_after WHERE account = a_a1;

  -- 6. disconnect (is_active false) advances it
  UPDATE public.social_accounts SET is_active = false WHERE id = a_a1;
  SELECT binding_generation INTO v_gen_after FROM public.social_accounts WHERE id = a_a1;
  ASSERT v_gen_after = (SELECT generation FROM s4_gen WHERE account = a_a1) + 1, 'S1.6 disconnect advanced the generation';

  -- 7. re-activation advances it again
  UPDATE public.social_accounts SET is_active = true WHERE id = a_a1;
  SELECT binding_generation INTO v_gen_after FROM public.social_accounts WHERE id = a_a1;
  ASSERT v_gen_after = (SELECT generation FROM s4_gen WHERE account = a_a1) + 2, 'S1.7 re-activation advanced the generation again';
  UPDATE s4_gen SET generation = v_gen_after WHERE account = a_a1;

  -- 8. native re-consent, the exact upsert shape youtube-oauth performs
  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, platform_username,
    access_token, refresh_token, token_expires_at, is_active, auth_provider,
    connection_id, connected_at
  ) VALUES (
    a_a1, u_a, 'youtube', 'UC-s4-alpha', 's4-alpha',
    'alpha-access-6', 'alpha-refresh-6', clock_timestamp() + interval '6 hours',
    true, 'native', NULL, clock_timestamp()
  )
  ON CONFLICT (user_id, platform, platform_user_id) DO UPDATE SET
    access_token = EXCLUDED.access_token,
    refresh_token = EXCLUDED.refresh_token,
    token_expires_at = EXCLUDED.token_expires_at,
    is_active = EXCLUDED.is_active,
    auth_provider = 'native',
    connection_id = NULL,
    connected_at = EXCLUDED.connected_at,
    updated_at = clock_timestamp();
  SELECT binding_generation, auth_provider, connection_id
    INTO v_gen_after, v_provider, v_connection
    FROM public.social_accounts WHERE id = a_a1;
  ASSERT v_gen_after = (SELECT generation FROM s4_gen WHERE account = a_a1) + 1, 'S1.8 native re-consent advanced the generation';
  ASSERT v_provider = 'native',
    'S1.8 native re-consent left the row unambiguously native';
  ASSERT v_connection IS NULL,
    'S1.8 native re-consent cleared the connection id';
  UPDATE s4_gen SET generation = v_gen_after WHERE account = a_a1;

  -- 9. Composio activation advances it and marks the row Composio
  UPDATE public.social_accounts
     SET access_token = NULL, refresh_token = NULL,
         auth_provider = 'composio', connection_id = '6e8c0003-0000-4000-8000-000000000003'
   WHERE id = a_a1;
  SELECT binding_generation INTO v_gen_after FROM public.social_accounts WHERE id = a_a1;
  ASSERT v_gen_after = (SELECT generation FROM s4_gen WHERE account = a_a1) + 1, 'S1.9 native -> Composio advanced the generation';
  UPDATE s4_gen SET generation = v_gen_after WHERE account = a_a1;

  -- 10. Composio -> native again, and a connection_id change alone
  UPDATE public.social_accounts
     SET access_token = 'alpha-access-7', auth_provider = 'native', connection_id = NULL
   WHERE id = a_a1;
  SELECT binding_generation INTO v_gen_after FROM public.social_accounts WHERE id = a_a1;
  ASSERT v_gen_after = (SELECT generation FROM s4_gen WHERE account = a_a1) + 1, 'S1.10 Composio -> native advanced the generation';
  UPDATE s4_gen SET generation = v_gen_after WHERE account = a_a1;

  UPDATE public.social_accounts SET connection_id = '6e8c0002-0000-4000-8000-000000000002' WHERE id = a_a4;
  SELECT binding_generation INTO v_gen_after FROM public.social_accounts WHERE id = a_a4;
  ASSERT v_gen_after = (SELECT generation FROM s4_gen WHERE account = a_a4) + 1,
    'S1.10 a connection_id change alone advanced the generation';

  -- 11. a client-supplied generation is ignored on insert and on update
  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, access_token, is_active, auth_provider, binding_generation
  ) VALUES (
    '6e8b0006-0000-4000-8000-000000000006', u_a, 'youtube', 'UC-s4-epsilon',
    'epsilon-access', true, 'native', 99
  );
  SELECT binding_generation INTO v_gen_after FROM public.social_accounts
   WHERE id = '6e8b0006-0000-4000-8000-000000000006';
  ASSERT v_gen_after = 1, format('S1.11 a supplied insert generation was overwritten: %s', v_gen_after);

  UPDATE public.social_accounts SET binding_generation = 99
   WHERE id = '6e8b0006-0000-4000-8000-000000000006';
  SELECT binding_generation INTO v_gen_after FROM public.social_accounts
   WHERE id = '6e8b0006-0000-4000-8000-000000000006';
  ASSERT v_gen_after = 1, format('S1.11 a supplied update generation was ignored: %s', v_gen_after);

  -- 12. the generation never decreases, and non-YouTube rows never move
  SELECT binding_generation INTO v_gen_before FROM public.social_accounts WHERE id = a_a5;
  UPDATE public.social_accounts SET avatar_url = 'https://example.invalid/a.png' WHERE id = a_a5;
  SELECT binding_generation INTO v_gen_after FROM public.social_accounts WHERE id = a_a5;
  ASSERT v_gen_after = v_gen_before,
    'S1.12 a non-YouTube row never changes generation';

  -- 13. delete and re-create yields a new row at 1 and strands old receipts
  DELETE FROM public.social_accounts WHERE id = a_a3;
  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, access_token, is_active, auth_provider
  ) VALUES (
    a_a3, u_a, 'youtube', 'UC-s4-gamma', 'gamma-access-2', true, 'native'
  );
  SELECT binding_generation INTO v_gen_after FROM public.social_accounts WHERE id = a_a3;
  ASSERT v_gen_after = 1, 'S1.13 a re-created row starts at generation 1';
END
$s1$;

-- S1b. The browser path under RLS: metadata keeps the binding, credentials
-- and the disconnect move it, exactly as the trigger's authority states.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"6e8a0001-0000-4000-8000-000000000001","role":"authenticated"}', true);

UPDATE public.social_accounts
   SET account_metadata = account_metadata || '{"ui_hint":"moved"}'::jsonb
 WHERE id = '6e8b0001-0000-4000-8000-000000000001';

UPDATE public.social_accounts
   SET is_active = false
 WHERE id = '6e8b0006-0000-4000-8000-000000000006';

RESET ROLE;

DO $s1b$
DECLARE
  a_a1 uuid := '6e8b0001-0000-4000-8000-000000000001';
  a_e  uuid := '6e8b0006-0000-4000-8000-000000000006';
BEGIN
  -- a1's metadata-only write kept the generation recorded at the end of S1
  ASSERT (SELECT binding_generation FROM public.social_accounts WHERE id = a_a1)
      = (SELECT generation FROM s4_gen WHERE account = a_a1),
    'S1b a metadata-only browser update kept the generation';
  -- epsilon was inserted at 1 (S1.11 overwrote the supplied 99 and ignored
  -- the direct 99 update), so the browser disconnect advanced it to exactly 2
  ASSERT (SELECT binding_generation FROM public.social_accounts WHERE id = a_e) = 2,
    'S1b the browser disconnect advanced the generation';
  UPDATE s4_gen SET generation = binding_generation FROM public.social_accounts
   WHERE s4_gen.account = public.social_accounts.id;
END
$s1b$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"6e8a0001-0000-4000-8000-000000000001","role":"authenticated"}', true);

UPDATE public.social_accounts
   SET access_token = 'alpha-access-browser'
 WHERE id = '6e8b0001-0000-4000-8000-000000000001';

-- Cross-owner denial under the same RLS: B's claims on the row must fail.
UPDATE public.social_accounts
   SET access_token = 'beta-hijack'
 WHERE id = '6e8b0101-0000-4000-8000-000000000001';

RESET ROLE;

DO $s1c$
DECLARE
  a_a1 uuid := '6e8b0001-0000-4000-8000-000000000001';
  a_b1 uuid := '6e8b0101-0000-4000-8000-000000000001';
BEGIN
  ASSERT (SELECT binding_generation FROM public.social_accounts WHERE id = a_a1)
      = (SELECT generation FROM s4_gen WHERE account = a_a1) + 1,
    'S1c a browser credential change advanced the generation';
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = a_b1) = 'alphab-access-1',
    'S1c the cross-owner browser write changed nothing';
  ASSERT (SELECT binding_generation FROM public.social_accounts WHERE id = a_b1)
      = (SELECT generation FROM s4_gen WHERE account = a_b1),
    'S1c the cross-owner browser write moved no generation';
END
$s1c$;

-- ---------------------------------------------------------------------------
-- S2. The trusted-writer authority, read from the catalog.
-- ---------------------------------------------------------------------------
DO $s2$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'youtube_stage4_refresh'
       AND NOT rolcanlogin AND NOT rolsuper AND rolbypassrls
  ), 'S2 the narrow refresh authority is NOLOGIN and BYPASSRLS';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
      JOIN pg_roles member ON member.oid = m.member
      JOIN pg_roles granted ON granted.oid = m.roleid
     WHERE member.rolname = 'youtube_stage4_refresh'
        OR granted.rolname = 'youtube_stage4_refresh'
  ), 'S2 the narrow authority is a member of nothing and has no member';

  ASSERT (
    SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE r.rolname = 'youtube_stage4_refresh'
  ) = ARRAY['store_youtube_refreshed_token', 'store_youtube_refreshed_token_with_lease', 'store_youtube_refreshed_token_with_lease_neutral'],
    'S2 the narrow authority owns EXACTLY the three trusted refresh functions';

  ASSERT NOT has_schema_privilege('youtube_stage4_refresh', 'public', 'CREATE'),
    'S2 the narrow authority holds no CREATE on the public schema';

  -- SELECT on the table, UPDATE only per column (R11 lists the columns): the
  -- table-level UPDATE privilege must NOT be held.
  ASSERT has_table_privilege('youtube_stage4_refresh', 'public.social_accounts', 'SELECT')
     AND NOT has_table_privilege('youtube_stage4_refresh', 'public.social_accounts', 'UPDATE')
     AND NOT has_table_privilege('youtube_stage4_refresh', 'public.social_accounts', 'INSERT')
     AND NOT has_table_privilege('youtube_stage4_refresh', 'public.social_accounts', 'DELETE'),
    'S2 the narrow authority holds only the table privileges the refresh bodies need';

  ASSERT NOT (SELECT prosecdef FROM pg_proc
               WHERE oid = 'public.youtube_stage4_assign_binding_generation()'::regprocedure),
    'S2 the binding-generation trigger function is SECURITY INVOKER';
END
$s2$;

-- ---------------------------------------------------------------------------
-- S3. Privileges: the browser roles reach nothing.
-- ---------------------------------------------------------------------------
DO $s3$
DECLARE
  a_a1 uuid := '6e8b0001-0000-4000-8000-000000000001';
BEGIN
  ASSERT NOT has_function_privilege('authenticated', 'public.youtube_comment_op_claim(uuid,uuid,text,bigint,uuid,text,jsonb,text,jsonb,text,text,jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.youtube_comment_op_claim(uuid,uuid,text,bigint,uuid,text,jsonb,text,jsonb,text,text,jsonb)', 'EXECUTE'),
    'S3 browser roles hold no EXECUTE on the claim';
  ASSERT NOT has_function_privilege('authenticated', 'public.youtube_comment_op_status(uuid,uuid,uuid)', 'EXECUTE'),
    'S3 browser roles hold no EXECUTE on the status';
  ASSERT NOT has_table_privilege('authenticated', 'public.youtube_comment_operations', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'public.youtube_comment_operations', 'INSERT')
     AND NOT has_table_privilege('anon', 'public.youtube_comment_operations', 'SELECT')
     AND NOT has_table_privilege('service_role', 'public.youtube_comment_operations', 'SELECT'),
    'S3 neither browser roles nor the service role read the receipt table directly';
  ASSERT NOT has_table_privilege('authenticated', 'public.youtube_comment_digest_keys', 'SELECT'),
    'S3 browser roles cannot read the digest keys';
END
$s3$;

-- The actual authenticated attempt on the claim must fail closed.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"6e8a0001-0000-4000-8000-000000000001","role":"authenticated"}', true);

DO $s3b$
BEGIN
  PERFORM public.youtube_comment_op_claim(
    '6e8a0001-0000-4000-8000-000000000001',
    '6e8b0001-0000-4000-8000-000000000001',
    'UC-s4-alpha', 1,
    '00000000-0000-4000-8000-0000000000e1',
    'create_thread',
    '{"video_id":"vid-s4-1"}'::jsonb,
    repeat('a', 64),
    '{}'::jsonb,
    'write', 's3-probe',
    jsonb_build_object('1', repeat('a', 64)));
  RAISE EXCEPTION 'S3b the browser executed the claim';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
END
$s3b$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S3b. The service role holds EXECUTE on every public Stage 4 RPC, and the
-- browser roles hold none: the suite runs as the function owner, which would
-- pass even if a grant were lost, so the catalog is asserted directly.
DO $s3b$
DECLARE
  v_fn text;
  v_role text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.youtube_comments_stage4_rollout_state()',
    'public.youtube_comments_stage4_capability_status(uuid)',
    'public.youtube_comments_stage4_admits(uuid, text)',
    'public.youtube_comment_digest_keys()',
    'public.youtube_comment_op_claim(uuid, uuid, text, bigint, uuid, text, jsonb, text, jsonb, text, text, jsonb)',
    'public.youtube_comment_op_mark_dispatched(uuid, uuid, uuid, text, bigint)',
    'public.youtube_comment_op_settle(uuid, uuid, uuid, text, text, text, text, text)',
    'public.youtube_comment_op_status(uuid, uuid, uuid)'
  ] LOOP
    ASSERT has_function_privilege('service_role', v_fn, 'EXECUTE'),
      format('S3b service_role can execute %s', v_fn);
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      ASSERT NOT has_function_privilege(v_role, v_fn, 'EXECUTE'),
        format('S3b %s cannot execute %s', v_role, v_fn);
    END LOOP;
  END LOOP;
END
$s3b$;

-- S4. Tenant isolation under the service role.
-- ---------------------------------------------------------------------------
DO $s4$
DECLARE
  u_a  uuid := '6e8a0001-0000-4000-8000-000000000001';
  u_b  uuid := '6e8a0002-0000-4000-8000-000000000002';
  a_a1 uuid := '6e8b0001-0000-4000-8000-000000000001';
  a_a4 uuid := '6e8b0004-0000-4000-8000-000000000004';
  a_a5 uuid := '6e8b0005-0000-4000-8000-000000000005';
  a_b1 uuid := '6e8b0101-0000-4000-8000-000000000001';
  a_missing uuid := '6e8bffff-0000-4000-8000-00000000ffff';
  r jsonb;
BEGIN
  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha',
    (SELECT binding_generation FROM public.social_accounts WHERE id = a_a1),
    '00000000-0000-4000-8000-000000000101',
    'create_thread', '{"video_id":"vid-s4-1"}'::jsonb,
    repeat('a', 64),
    (SELECT jsonb_object_agg(k.version::text, encode(extensions.hmac(
       convert_to('logical','utf8') || '\x00'::bytea || convert_to('1','utf8') || '\x00'::bytea
       || convert_to('UC-s4-alpha','utf8') || '\x00'::bytea
       || convert_to('vid-s4-1','utf8') || '\x00'::bytea
       || convert_to('','utf8') || '\x00'::bytea
       || convert_to('First!','utf8'), k.key, 'sha256'), 'hex'))
     FROM public.youtube_comment_digest_keys k),
    'write', 's4-a1',
    pg_temp.s4_map(repeat('a', 64)));
  ASSERT (r ->> 'ok')::boolean, format('S4 owner A claimed on a1: %s', r);

  -- crossed owner: B claims A's account
  r := public.youtube_comment_op_claim(
    u_b, a_a1, 'UC-s4-alpha',
    (SELECT binding_generation FROM public.social_accounts WHERE id = a_a1),
    '00000000-0000-4000-8000-000000000102',
    'create_thread', '{"video_id":"vid-s4-1"}'::jsonb,
    repeat('b', 64), '{}'::jsonb, 'write', 's4-b-on-a1',
    pg_temp.s4_map(repeat('b', 64)));
  ASSERT r ->> 'reason' = 'not_found', format('S4 a crossed owner and account was refused: %s', r);

  -- missing account
  r := public.youtube_comment_op_claim(
    u_a, a_missing, 'UC-s4-alpha', 1,
    '00000000-0000-4000-8000-000000000103',
    'create_thread', '{"video_id":"vid-s4-1"}'::jsonb,
    repeat('c', 64), '{}'::jsonb, 'write', 's4-missing',
    pg_temp.s4_map(repeat('c', 64)));
  ASSERT r ->> 'reason' = 'not_found', format('S4 a missing account was refused identically: %s', r);

  -- the Composio row and the facebook row are not native YouTube rows
  r := public.youtube_comment_op_claim(
    u_a, a_a4, 'UC-s4-delta',
    (SELECT binding_generation FROM public.social_accounts WHERE id = a_a4),
    '00000000-0000-4000-8000-000000000104',
    'create_thread', '{"video_id":"vid-s4-1"}'::jsonb,
    repeat('d', 64), '{}'::jsonb, 'write', 's4-composio',
    pg_temp.s4_map(repeat('d', 64)));
  ASSERT r ->> 'reason' = 'not_found', format('S4 a Composio row was refused identically: %s', r);

  r := public.youtube_comment_op_claim(
    u_a, a_a5, 'fb-s4-1',
    (SELECT binding_generation FROM public.social_accounts WHERE id = a_a5),
    '00000000-0000-4000-8000-000000000105',
    'create_thread', '{"video_id":"vid-s4-1"}'::jsonb,
    repeat('e', 64), '{}'::jsonb, 'write', 's4-facebook',
    pg_temp.s4_map(repeat('e', 64)));
  ASSERT r ->> 'reason' = 'not_found', format('S4 a facebook row was refused identically: %s', r);

  -- two owners on the SAME channel id are separate fence domains
  r := public.youtube_comment_op_claim(
    u_b, a_b1, 'UC-s4-alpha',
    (SELECT binding_generation FROM public.social_accounts WHERE id = a_b1),
    '00000000-0000-4000-8000-000000000106',
    'create_thread', '{"video_id":"vid-s4-1"}'::jsonb,
    repeat('f', 64),
    (SELECT jsonb_object_agg(k.version::text, encode(extensions.hmac(
       convert_to('logical','utf8') || '\x00'::bytea || convert_to('1','utf8') || '\x00'::bytea
       || convert_to('UC-s4-alpha','utf8') || '\x00'::bytea
       || convert_to('vid-s4-1','utf8') || '\x00'::bytea
       || convert_to('','utf8') || '\x00'::bytea
       || convert_to('First!','utf8'), k.key, 'sha256'), 'hex'))
     FROM public.youtube_comment_digest_keys k),
    'write', 's4-b1',
    pg_temp.s4_map(repeat('f', 64)));
  ASSERT (r ->> 'ok')::boolean,
    format('S4 owner B on the same channel is a separate fence domain: %s', r);
END
$s4$;

-- ---------------------------------------------------------------------------
-- S5. Expected-value validation and token authority.
-- ---------------------------------------------------------------------------
DO $s5$
DECLARE
  u_a  uuid := '6e8a0001-0000-4000-8000-000000000001';
  a_a1 uuid := '6e8b0001-0000-4000-8000-000000000001';
  r jsonb;
  v_token uuid;
BEGIN
  -- wrong expected channel
  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-WRONG',
    (SELECT binding_generation FROM public.social_accounts WHERE id = a_a1),
    '00000000-0000-4000-8000-000000000201',
    'create_thread', '{"video_id":"vid-s4-2"}'::jsonb,
    repeat('1', 64), '{}'::jsonb, 'write', 's5-channel',
    pg_temp.s4_map(repeat('1', 64)));
  ASSERT r ->> 'reason' = 'not_found', format('S5 a wrong expected channel was refused: %s', r);

  -- wrong expected generation
  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha',
    (SELECT binding_generation FROM public.social_accounts WHERE id = a_a1) + 5,
    '00000000-0000-4000-8000-000000000202',
    'create_thread', '{"video_id":"vid-s4-2"}'::jsonb,
    repeat('2', 64), '{}'::jsonb, 'write', 's5-generation',
    pg_temp.s4_map(repeat('2', 64)));
  ASSERT r ->> 'reason' = 'not_found', format('S5 a wrong expected generation was refused: %s', r);

  -- a spoofed token cannot mark or settle
  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha',
    (SELECT binding_generation FROM public.social_accounts WHERE id = a_a1),
    '00000000-0000-4000-8000-000000000203',
    'edit', '{"video_id":"vid-s4-2","comment_id":"cmt-s4-2"}'::jsonb,
    repeat('3', 64), '{}'::jsonb, 'write', 's5-token',
    pg_temp.s4_map(repeat('3', 64)));
  ASSERT (r ->> 'ok')::boolean, format('S5 claim ok: %s', r);
  v_token := (r ->> 'attempt_token')::uuid;

  r := public.youtube_comment_op_mark_dispatched(
    u_a, '00000000-0000-4000-8000-000000000203', gen_random_uuid(),
    'UC-s4-alpha', (SELECT binding_generation FROM public.social_accounts WHERE id = a_a1));
  ASSERT r ->> 'reason' = 'invalid_token', format('S5 a spoofed token cannot mark: %s', r);

  r := public.youtube_comment_op_settle(
    u_a, '00000000-0000-4000-8000-000000000203', gen_random_uuid(),
    'refused', 'probe', 'http_4xx', NULL, NULL);
  ASSERT r ->> 'reason' = 'invalid_token', format('S5 a spoofed token cannot settle: %s', r);

  ASSERT (SELECT state FROM public.youtube_comment_operations
           WHERE owner_id = u_a AND operation_id = '00000000-0000-4000-8000-000000000203') = 'claimed',
    'S5 the spoofed attempts changed nothing';
END
$s5$;

-- ---------------------------------------------------------------------------
-- S6. The per-key fence.
-- ---------------------------------------------------------------------------
DO $s6$
DECLARE
  u_a  uuid := '6e8a0001-0000-4000-8000-000000000001';
  a_a1 uuid := '6e8b0001-0000-4000-8000-000000000001';
  op   uuid := '00000000-0000-4000-8000-000000000301';
  r jsonb;
BEGIN
  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha',
    (SELECT binding_generation FROM public.social_accounts WHERE id = a_a1),
    op, 'edit', '{"video_id":"vid-s4-3","comment_id":"cmt-s4-3"}'::jsonb,
    repeat('6', 64), '{}'::jsonb, 'write', 's6-1',
    pg_temp.s4_map(repeat('6', 64)));
  ASSERT (r ->> 'ok')::boolean AND (r ->> 'attempt_token') IS NOT NULL,
    format('S6 the first claim of a key wins the token: %s', r);

  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha',
    (SELECT binding_generation FROM public.social_accounts WHERE id = a_a1),
    op, 'edit', '{"video_id":"vid-s4-3","comment_id":"cmt-s4-3"}'::jsonb,
    repeat('6', 64), '{}'::jsonb, 'write', 's6-2',
    pg_temp.s4_map(repeat('6', 64)));
  ASSERT r ->> 'reason' = 'already_recorded' AND r ->> 'attempt_token' IS NULL,
    format('S6 the same key and intent returns the existing state with no token: %s', r);

  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha',
    (SELECT binding_generation FROM public.social_accounts WHERE id = a_a1),
    op, 'edit', '{"video_id":"vid-s4-3","comment_id":"cmt-s4-3"}'::jsonb,
    repeat('7', 64), '{}'::jsonb, 'write', 's6-3',
    pg_temp.s4_map(repeat('7', 64)));
  ASSERT r ->> 'reason' = 'conflict',
    format('S6 the same key with a different intent is a conflict: %s', r);
END
$s6$;

-- ---------------------------------------------------------------------------
-- S7. The logical fence: unresolved, recent confirmation, rebinding.
-- ---------------------------------------------------------------------------
DO $s7$
DECLARE
  u_a  uuid := '6e8a0001-0000-4000-8000-000000000001';
  a_a1 uuid := '6e8b0001-0000-4000-8000-000000000001';
  r jsonb;
  v_gen bigint;
  v_logical jsonb;
BEGIN
  SELECT binding_generation INTO v_gen FROM public.social_accounts WHERE id = a_a1;
  v_logical := (SELECT jsonb_object_agg(k.version::text, encode(extensions.hmac(
       convert_to('logical','utf8') || '\x00'::bytea || convert_to('1','utf8') || '\x00'::bytea
       || convert_to('UC-s4-alpha','utf8') || '\x00'::bytea
       || convert_to('vid-s4-7','utf8') || '\x00'::bytea
       || convert_to('','utf8') || '\x00'::bytea
       || convert_to('Same deliberate text','utf8'), k.key, 'sha256'), 'hex'))
     FROM public.youtube_comment_digest_keys k);

  -- unresolved: a dispatched create blocks the same logical operation
  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha', v_gen,
    '00000000-0000-4000-8000-000000000401',
    'create_thread', '{"video_id":"vid-s4-7"}'::jsonb,
    repeat('a', 64), v_logical, 'write', 's7-1',
    pg_temp.s4_map(repeat('a', 64)));
  ASSERT (r ->> 'ok')::boolean, format('S7 first logical claim ok: %s', r);
  r := public.youtube_comment_op_mark_dispatched(
    u_a, '00000000-0000-4000-8000-000000000401', (r ->> 'attempt_token')::uuid,
    'UC-s4-alpha', v_gen);
  ASSERT (r ->> 'ok')::boolean, 'S7 first logical claim marked dispatched';

  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha', v_gen,
    '00000000-0000-4000-8000-000000000402',
    'create_thread', '{"video_id":"vid-s4-7"}'::jsonb,
    repeat('b', 64), v_logical, 'write', 's7-2',
    pg_temp.s4_map(repeat('b', 64)));
  ASSERT r ->> 'reason' = 'possible_duplicate',
    format('S7 an unresolved identical logical operation is refused under a new key: %s', r);

  -- settle it, then the recent-confirmation fence carries the comment id
  r := public.youtube_comment_op_settle(
    u_a, '00000000-0000-4000-8000-000000000401', (
      SELECT attempt_token FROM public.youtube_comment_operations
       WHERE owner_id = u_a AND operation_id = '00000000-0000-4000-8000-000000000401'),
    'confirmed', NULL, 'none', 'th-s4-7', 'cmt-s4-7');
  ASSERT (r ->> 'ok')::boolean, 'S7 the first logical operation settled confirmed';

  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha', v_gen,
    '00000000-0000-4000-8000-000000000403',
    'create_thread', '{"video_id":"vid-s4-7"}'::jsonb,
    repeat('c', 64), v_logical, 'write', 's7-3',
    pg_temp.s4_map(repeat('c', 64)));
  ASSERT r ->> 'reason' = 'recently_posted' AND r ->> 'result_comment_id' = 'cmt-s4-7'
    AND r ->> 'result_thread_id' = 'th-s4-7',
    format('S7 a recent confirmation under the live binding carries the comment id and the thread id: %s', r);

  -- after the 10 minute window a deliberate identical comment is allowed
  UPDATE public.youtube_comment_operations
     SET settled_at = clock_timestamp() - interval '11 minutes'
   WHERE owner_id = u_a AND operation_id = '00000000-0000-4000-8000-000000000401';
  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha', v_gen,
    '00000000-0000-4000-8000-000000000404',
    'create_thread', '{"video_id":"vid-s4-7"}'::jsonb,
    repeat('d', 64), v_logical, 'write', 's7-4',
    pg_temp.s4_map(repeat('d', 64)));
  ASSERT (r ->> 'ok')::boolean,
    format('S7 after the recent-confirmation window the same text is allowed again: %s', r);

  -- a reply to reply A and a reply to reply B in one thread with the same
  -- text are the SAME logical operation (the canonical parent is top-level)
  DECLARE
    v_reply_logical jsonb := (SELECT jsonb_object_agg(k.version::text, encode(extensions.hmac(
       convert_to('logical','utf8') || '\x00'::bytea || convert_to('1','utf8') || '\x00'::bytea
       || convert_to('UC-s4-alpha','utf8') || '\x00'::bytea
       || convert_to('vid-s4-7','utf8') || '\x00'::bytea
       || convert_to('cmt-top-s4-7','utf8') || '\x00'::bytea
       || convert_to('A threaded answer','utf8'), k.key, 'sha256'), 'hex'))
     FROM public.youtube_comment_digest_keys k);
  BEGIN
    r := public.youtube_comment_op_claim(
      u_a, a_a1, 'UC-s4-alpha', v_gen,
      '00000000-0000-4000-8000-000000000405',
      'reply', '{"video_id":"vid-s4-7","parent_comment_id":"cmt-top-s4-7"}'::jsonb,
      repeat('e', 64), v_reply_logical, 'write', 's7-5',
    pg_temp.s4_map(repeat('e', 64)));
    ASSERT (r ->> 'ok')::boolean, format('S7 reply to reply A claimed: %s', r);
    r := public.youtube_comment_op_claim(
      u_a, a_a1, 'UC-s4-alpha', v_gen,
      '00000000-0000-4000-8000-000000000406',
      'reply', '{"video_id":"vid-s4-7","parent_comment_id":"cmt-top-s4-7"}'::jsonb,
      repeat('f', 64), v_reply_logical, 'write', 's7-6',
    pg_temp.s4_map(repeat('f', 64)));
    ASSERT r ->> 'reason' = 'possible_duplicate',
      format('S7 the same text to a different reply in the thread is the same logical operation: %s', r);
  END;

  -- across a binding change the recent-confirmation refusal is the bare reason.
  -- The never-dispatched claim 404 above would answer first with the unresolved
  -- fence and mask the confirmed receipt, so it is closed as refused.
  UPDATE public.youtube_comment_operations
     SET state = 'refused', reason = 'suite_closed', settled_at = clock_timestamp()
   WHERE owner_id = u_a AND operation_id = '00000000-0000-4000-8000-000000000404';
  UPDATE public.youtube_comment_operations
     SET settled_at = clock_timestamp()
   WHERE owner_id = u_a AND operation_id = '00000000-0000-4000-8000-000000000401';
  UPDATE public.social_accounts SET is_active = false WHERE id = a_a1;
  UPDATE public.social_accounts SET is_active = true WHERE id = a_a1;
  SELECT binding_generation INTO v_gen FROM public.social_accounts WHERE id = a_a1;
  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha', v_gen,
    '00000000-0000-4000-8000-000000000407',
    'create_thread', '{"video_id":"vid-s4-7"}'::jsonb,
    repeat('g', 64), v_logical, 'write', 's7-7',
    pg_temp.s4_map(repeat('g', 64)));
  ASSERT r ->> 'reason' = 'recently_posted' AND r ->> 'result_comment_id' IS NULL
    AND r ->> 'result_thread_id' IS NULL AND (r - 'ok' - 'reason') = '{}'::jsonb,
    format('S7 across a binding change the fence refusal is the bare recently_posted, with no id of either kind: %s', r);
END
$s7$;

-- ---------------------------------------------------------------------------
-- S8. Key rotation: an unresolved row written under version 1 still blocks.
-- ---------------------------------------------------------------------------
DO $s8$
DECLARE
  u_a  uuid := '6e8a0001-0000-4000-8000-000000000001';
  a_a1 uuid := '6e8b0001-0000-4000-8000-000000000001';
  v_gen bigint;
  r jsonb;
  v_d1 text;
  v_d2 text;
  v_ver int := pg_temp.s4_next_version();
BEGIN
  SELECT binding_generation INTO v_gen FROM public.social_accounts WHERE id = a_a1;

  -- an unresolved row under key version 1
  v_d1 := encode(extensions.hmac(
       convert_to('logical','utf8') || '\x00'::bytea || convert_to('1','utf8') || '\x00'::bytea
       || convert_to('UC-s4-alpha','utf8') || '\x00'::bytea
       || convert_to('vid-s4-8','utf8') || '\x00'::bytea
       || convert_to('','utf8') || '\x00'::bytea
       || convert_to('Rotated key text','utf8'),
       (SELECT key FROM public.youtube_comment_digest_keys WHERE version = 1), 'sha256'), 'hex');
  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha', v_gen,
    '00000000-0000-4000-8000-000000000501',
    'create_thread', '{"video_id":"vid-s4-8"}'::jsonb,
    repeat('1', 64),
    jsonb_build_object('1', v_d1), 'write', 's8-1',
    pg_temp.s4_map(repeat('1', 64)));
  ASSERT (r ->> 'ok')::boolean, format('S8 the version-1 claim landed: %s', r);
  r := public.youtube_comment_op_mark_dispatched(
    u_a, '00000000-0000-4000-8000-000000000501', (r ->> 'attempt_token')::uuid,
    'UC-s4-alpha', v_gen);
  ASSERT (r ->> 'ok')::boolean, 'S8 the version-1 claim is dispatched';

  -- rotate: add a new version, retire nothing
  INSERT INTO public.youtube_comment_digest_keys (version, key)
  VALUES (v_ver, sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'utf8')));

  -- the digest keys reader returns both, newest active
  r := public.youtube_comment_digest_keys();
  ASSERT (r ->> 'active_version')::int = v_ver
     AND (SELECT count(*) FROM jsonb_array_elements(r -> 'keys')) = 2,
    format('S8 the digest key reader returns both versions: %s', r);

  -- a claim carrying the logical digest under BOTH versions still blocks
  v_d2 := encode(extensions.hmac(
       convert_to('logical','utf8') || '\x00'::bytea || convert_to('1','utf8') || '\x00'::bytea
       || convert_to('UC-s4-alpha','utf8') || '\x00'::bytea
       || convert_to('vid-s4-8','utf8') || '\x00'::bytea
       || convert_to('','utf8') || '\x00'::bytea
       || convert_to('Rotated key text','utf8'),
       (SELECT key FROM public.youtube_comment_digest_keys WHERE version = v_ver), 'sha256'), 'hex');
  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha', v_gen,
    '00000000-0000-4000-8000-000000000502',
    'create_thread', '{"video_id":"vid-s4-8"}'::jsonb,
    repeat('2', 64),
    jsonb_build_object('1', v_d1, v_ver::text, v_d2), 'write', 's8-2',
    pg_temp.s4_map(repeat('2', 64)));
  ASSERT r ->> 'reason' = 'possible_duplicate',
    format('S8 evidence written under version 1 still blocks after rotation: %s', r);

  -- a referenced version cannot be removed
  BEGIN
    DELETE FROM public.youtube_comment_digest_keys WHERE version = 1;
    RAISE EXCEPTION 'S8 a referenced digest key version was deleted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'youtube_stage4_guard_digest_keys%' THEN RAISE; END IF;
  END;
END
$s8$;

-- ---------------------------------------------------------------------------
-- S9. Timeouts, stale claims and pruning.
-- ---------------------------------------------------------------------------
DO $s9$
DECLARE
  u_a  uuid := '6e8a0001-0000-4000-8000-000000000001';
  a_a1 uuid := '6e8b0001-0000-4000-8000-000000000001';
  v_gen bigint;
  r jsonb;
  i int;
BEGIN
  SELECT binding_generation INTO v_gen FROM public.social_accounts WHERE id = a_a1;

  -- a claimed receipt older than 120 s is closed by the next claim
  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha', v_gen,
    '00000000-0000-4000-8000-000000000601',
    'edit', '{"video_id":"vid-s4-9","comment_id":"cmt-s4-9"}'::jsonb,
    repeat('9', 64), '{}'::jsonb, 'write', 's9-stale',
    pg_temp.s4_map(repeat('9', 64)));
  ASSERT (r ->> 'ok')::boolean, 'S9 the stale claim landed';
  UPDATE public.youtube_comment_operations
     SET claimed_at = clock_timestamp() - interval '121 seconds'
   WHERE owner_id = u_a AND operation_id = '00000000-0000-4000-8000-000000000601';

  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha', v_gen,
    '00000000-0000-4000-8000-000000000602',
    'edit', '{"video_id":"vid-s4-9b","comment_id":"cmt-s4-9b"}'::jsonb,
    repeat('8', 64), '{}'::jsonb, 'write', 's9-next',
    pg_temp.s4_map(repeat('8', 64)));
  ASSERT (r ->> 'ok')::boolean, 'S9 the next claim proceeded';
  ASSERT (SELECT state FROM public.youtube_comment_operations
           WHERE owner_id = u_a AND operation_id = '00000000-0000-4000-8000-000000000601') = 'refused'
     AND (SELECT reason FROM public.youtube_comment_operations
           WHERE owner_id = u_a AND operation_id = '00000000-0000-4000-8000-000000000601') = 'abandoned_before_dispatch',
    'S9 the stale claim was closed as never sent';

  -- a dispatched receipt older than 90 s reads as indeterminate
  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha', v_gen,
    '00000000-0000-4000-8000-000000000603',
    'edit', '{"video_id":"vid-s4-9c","comment_id":"cmt-s4-9c"}'::jsonb,
    repeat('7', 64), '{}'::jsonb, 'write', 's9-conv',
    pg_temp.s4_map(repeat('7', 64)));
  r := public.youtube_comment_op_mark_dispatched(
    u_a, '00000000-0000-4000-8000-000000000603', (r ->> 'attempt_token')::uuid,
    'UC-s4-alpha', v_gen);
  UPDATE public.youtube_comment_operations
     SET dispatched_at = clock_timestamp() - interval '91 seconds'
   WHERE owner_id = u_a AND operation_id = '00000000-0000-4000-8000-000000000603';
  r := public.youtube_comment_op_status(u_a, a_a1, '00000000-0000-4000-8000-000000000603');
  ASSERT (r ->> 'ok')::boolean AND r ->> 'state' = 'indeterminate',
    format('S9 a dispatched receipt older than 90 s reads as indeterminate: %s', r);

  -- (These two fixtures write the digest key version 0 an edit receipt carries: the claim writes
  -- 0 there for edit and moderate, and the key version CHECK of 20261124120000 requires it.)
  -- pruning removes ONLY never-dispatched refused rows older than 30 days,
  -- at most 20 per claim, same owner; a dispatched row is never deleted
  FOR i IN 1..25 LOOP
    INSERT INTO public.youtube_comment_operations (
      owner_id, operation_id, social_account_id, account_ref, channel_id,
      binding_generation, auth_provider, action, video_id, comment_id,
      intent_digest, digest_key_version, state, attempt_token,
      reason, settled_at, claimed_at
    ) VALUES (
      u_a, ('00000000-0000-4000-8000-' || lpad((700 + i)::text, 12, '0'))::uuid, a_a1, a_a1, 'UC-s4-alpha',
      v_gen, 'native', 'edit', 'vid-s4-9', 'cmt-s4-prune',
      repeat('p', 64), 0, 'refused', gen_random_uuid(),
      'commentTextTooLong', clock_timestamp() - interval '31 days',
      clock_timestamp() - interval '31 days'
    );
  END LOOP;

  INSERT INTO public.youtube_comment_operations (
    owner_id, operation_id, social_account_id, account_ref, channel_id,
    binding_generation, auth_provider, action, video_id, comment_id,
    intent_digest, digest_key_version, state, attempt_token,
    reason, provider_class, settled_at, dispatched_at, claimed_at
  ) VALUES (
    u_a, '00000000-0000-4000-8000-000000000799', a_a1, a_a1, 'UC-s4-alpha',
    v_gen, 'native', 'edit', 'vid-s4-9', 'cmt-s4-keep',
    repeat('q', 64), 0, 'indeterminate', gen_random_uuid(),
    'http_5xx', 'http_5xx', clock_timestamp() - interval '40 days',
    clock_timestamp() - interval '40 days', clock_timestamp() - interval '40 days'
  );

  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha', v_gen,
    '00000000-0000-4000-8000-000000000604',
    'edit', '{"video_id":"vid-s4-9d","comment_id":"cmt-s4-9d"}'::jsonb,
    repeat('6', 64), '{}'::jsonb, 'write', 's9-prune',
    pg_temp.s4_map(repeat('6', 64)));
  ASSERT (r ->> 'ok')::boolean, 'S9 the pruning claim proceeded';
  ASSERT (SELECT count(*) FROM public.youtube_comment_operations
           WHERE owner_id = u_a AND video_id = 'vid-s4-9' AND comment_id = 'cmt-s4-prune') = 5,
    'S9 pruning removed at most 20 never-dispatched refused rows';
  ASSERT EXISTS (SELECT 1 FROM public.youtube_comment_operations
                  WHERE owner_id = u_a AND operation_id = '00000000-0000-4000-8000-000000000799'),
    'S9 a dispatched row is never deleted, however old';
END
$s9$;

-- ---------------------------------------------------------------------------
-- S10. Late resolution and the settlement rules.
-- ---------------------------------------------------------------------------
DO $s10$
DECLARE
  u_a  uuid := '6e8a0001-0000-4000-8000-000000000001';
  a_a1 uuid := '6e8b0001-0000-4000-8000-000000000001';
  v_gen bigint;
  r jsonb;
  v_token uuid;
  v_rot int := (SELECT max(version) FROM public.youtube_comment_digest_keys);
  -- A reply claim must carry a logical digest; each test uses a distinct
  -- synthetic one so these cases never collide with each other's fences.
  -- S8 rotated the active version inside this transaction (v_rot), so the
  -- digests are carried under every retained version, exactly as the
  -- handler does.
  v_dig_a jsonb := jsonb_build_object('1', repeat('A', 64), v_rot::text, repeat('A', 64));
  v_dig_b jsonb := jsonb_build_object('1', repeat('B', 64), v_rot::text, repeat('B', 64));
  v_dig_c jsonb := jsonb_build_object('1', repeat('C', 64), v_rot::text, repeat('C', 64));
BEGIN
  SELECT binding_generation INTO v_gen FROM public.social_accounts WHERE id = a_a1;

  -- dispatched -> indeterminate (5xx) -> late confirmed by the token holder
  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha', v_gen,
    '00000000-0000-4000-8000-000000000801',
    'reply', '{"video_id":"vid-s4-10","parent_comment_id":"cmt-top-10"}'::jsonb,
    repeat('1', 64), v_dig_a, 'write', 's10-1',
    pg_temp.s4_map(repeat('1', 64)));
  ASSERT (r ->> 'ok')::boolean, format('S10 claim: %s', r);
  v_token := (r ->> 'attempt_token')::uuid;
  PERFORM public.youtube_comment_op_mark_dispatched(
    u_a, '00000000-0000-4000-8000-000000000801', v_token, 'UC-s4-alpha', v_gen);
  r := public.youtube_comment_op_settle(
    u_a, '00000000-0000-4000-8000-000000000801', v_token,
    'indeterminate', 'http_5xx', 'http_5xx', NULL, NULL);
  ASSERT (r ->> 'ok')::boolean AND r ->> 'state' = 'indeterminate', 'S10 settled indeterminate';

  r := public.youtube_comment_op_settle(
    u_a, '00000000-0000-4000-8000-000000000801', v_token,
    'confirmed', NULL, 'none', NULL, 'cmt-late-10');
  ASSERT (r ->> 'ok')::boolean AND r ->> 'state' = 'confirmed',
    format('S10 the token holder resolved indeterminate -> confirmed late: %s', r);

  -- a 5xx class is refused as a reason for `refused`
  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha', v_gen,
    '00000000-0000-4000-8000-000000000802',
    'reply', '{"video_id":"vid-s4-10","parent_comment_id":"cmt-top-10b"}'::jsonb,
    repeat('2', 64), v_dig_b, 'write', 's10-2',
    pg_temp.s4_map(repeat('2', 64)));
  v_token := (r ->> 'attempt_token')::uuid;
  PERFORM public.youtube_comment_op_mark_dispatched(
    u_a, '00000000-0000-4000-8000-000000000802', v_token, 'UC-s4-alpha', v_gen);
  r := public.youtube_comment_op_settle(
    u_a, '00000000-0000-4000-8000-000000000802', v_token,
    'refused', 'http_5xx', 'http_5xx', NULL, NULL);
  ASSERT r ->> 'reason' = 'invalid_outcome',
    format('S10 a 5xx cannot be recorded as a refusal: %s', r);

  r := public.youtube_comment_op_settle(
    u_a, '00000000-0000-4000-8000-000000000802', v_token,
    'refused', 'quota', 'http_4xx', NULL, NULL);
  ASSERT (r ->> 'ok')::boolean AND r ->> 'state' = 'refused',
    'S10 a 4xx CAN be recorded as a refusal after dispatch';

  -- a non-holder cannot settle an indeterminate row
  r := public.youtube_comment_op_settle(
    u_a, '00000000-0000-4000-8000-000000000801', gen_random_uuid(),
    'refused', 'probe', 'http_4xx', NULL, NULL);
  ASSERT r ->> 'reason' = 'invalid_token', 'S10 a non-holder cannot settle';

  -- a late settlement racing the 90 second conversion converges in both orders
  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha', v_gen,
    '00000000-0000-4000-8000-000000000803',
    'reply', '{"video_id":"vid-s4-10","parent_comment_id":"cmt-top-10c"}'::jsonb,
    repeat('3', 64), v_dig_c, 'write', 's10-3',
    pg_temp.s4_map(repeat('3', 64)));
  v_token := (r ->> 'attempt_token')::uuid;
  PERFORM public.youtube_comment_op_mark_dispatched(
    u_a, '00000000-0000-4000-8000-000000000803', v_token, 'UC-s4-alpha', v_gen);
  UPDATE public.youtube_comment_operations
     SET dispatched_at = clock_timestamp() - interval '91 seconds'
   WHERE owner_id = u_a AND operation_id = '00000000-0000-4000-8000-000000000803';
  r := public.youtube_comment_op_status(u_a, a_a1, '00000000-0000-4000-8000-000000000803');
  ASSERT r ->> 'state' = 'indeterminate', 'S10 the conversion ran first';
  r := public.youtube_comment_op_settle(
    u_a, '00000000-0000-4000-8000-000000000803', v_token,
    'confirmed', NULL, 'none', NULL, 'cmt-race-10');
  ASSERT (r ->> 'ok')::boolean AND r ->> 'state' = 'confirmed',
    'S10 the late settlement still resolved after the conversion';
  r := public.youtube_comment_op_status(u_a, a_a1, '00000000-0000-4000-8000-000000000803');
  ASSERT r ->> 'state' = 'confirmed', 'S10 the settled state is what status reports';
END
$s10$;

-- ---------------------------------------------------------------------------
-- S11. The rollout evaluator.
-- ---------------------------------------------------------------------------
DO $s11$
DECLARE
  u_a  uuid := '6e8a0001-0000-4000-8000-000000000001';
  a_a1 uuid := '6e8b0001-0000-4000-8000-000000000001';
  a_a3 uuid := '6e8b0003-0000-4000-8000-000000000003';
  v_gen bigint;
  r jsonb;
BEGIN
  SELECT binding_generation INTO v_gen FROM public.social_accounts WHERE id = a_a1;

  -- two accounts in one policy are independent, including ban
  ASSERT public.youtube_comments_stage4_admits(a_a1, 'read')
     AND public.youtube_comments_stage4_admits(a_a1, 'write')
     AND NOT public.youtube_comments_stage4_admits(a_a1, 'ban'),
    'S11 a1: read+write on, ban off';
  ASSERT public.youtube_comments_stage4_admits(a_a3, 'ban'),
    'S11 a3: ban on — accounts in one policy are independent';

  -- a prerequisite failure reads as prerequisite_missing
  UPDATE public.app_settings
     SET value = jsonb_set(value, ARRAY['accounts', a_a1::text, 'read'], 'false'::jsonb)
   WHERE key = 'youtube_comments_stage4_rollout';
  r := public.youtube_comments_stage4_capability_status(a_a1);
  ASSERT NOT (r -> 'write' ->> 'allowed')::boolean
     AND r -> 'write' ->> 'reason' = 'prerequisite_missing',
    format('S11 write without read is prerequisite_missing: %s', r);
  UPDATE public.app_settings
     SET value = jsonb_set(value, ARRAY['accounts', a_a1::text, 'read'], 'true'::jsonb)
   WHERE key = 'youtube_comments_stage4_rollout';

  -- read on, write off: reads admit, every write claim is refused
  UPDATE public.app_settings
     SET value = jsonb_set(value, ARRAY['accounts', a_a1::text, 'write'], 'false'::jsonb)
   WHERE key = 'youtube_comments_stage4_rollout';
  ASSERT public.youtube_comments_stage4_admits(a_a1, 'read'),
    'S11 read still admits with write off';
  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha', v_gen,
    '00000000-0000-4000-8000-000000000901',
    'edit', '{"video_id":"vid-s4-11","comment_id":"cmt-s4-11"}'::jsonb,
    repeat('4', 64), '{}'::jsonb, 'write', 's11-off',
    pg_temp.s4_map(repeat('4', 64)));
  ASSERT r ->> 'reason' = 'capability_denied',
    format('S11 a write claim with the capability off is refused: %s', r);
  UPDATE public.app_settings
     SET value = jsonb_set(value, ARRAY['accounts', a_a1::text, 'write'], 'true'::jsonb)
   WHERE key = 'youtube_comments_stage4_rollout';

  -- a malformed policy denies everything with rollout_invalid
  UPDATE public.app_settings
     SET value = '{"version":1,"accounts":{"nope":true}}'::jsonb
   WHERE key = 'youtube_comments_stage4_rollout';
  r := public.youtube_comments_stage4_capability_status(a_a1);
  ASSERT r -> 'read' ->> 'reason' = 'rollout_invalid', format('S11 malformed policy: %s', r);

  -- an unknown version denies everything
  UPDATE public.app_settings
     SET value = jsonb_build_object('version', 2, 'accounts', jsonb_build_object(
       a_a1::text, jsonb_build_object('read', true, 'held', true, 'write', true, 'ban', false)))
   WHERE key = 'youtube_comments_stage4_rollout';
  r := public.youtube_comments_stage4_capability_status(a_a1);
  ASSERT r -> 'write' ->> 'reason' = 'rollout_invalid', 'S11 unknown version denies';

  -- a missing account entry is account_not_admitted
  UPDATE public.app_settings
     SET value = jsonb_build_object('version', 1, 'accounts', jsonb_build_object(
       a_a3::text, jsonb_build_object('read', true, 'held', true, 'write', true, 'ban', false)))
   WHERE key = 'youtube_comments_stage4_rollout';
  r := public.youtube_comments_stage4_capability_status(a_a1);
  ASSERT r -> 'read' ->> 'reason' = 'account_not_admitted', 'S11 a missing account is not admitted';

  -- with the key absent everything denies, and status still answers
  DELETE FROM public.app_settings WHERE key = 'youtube_comments_stage4_rollout';
  r := public.youtube_comments_stage4_capability_status(a_a1);
  ASSERT r -> 'read' ->> 'reason' = 'rollout_missing', 'S11 a missing key denies with rollout_missing';
  r := public.youtube_comment_op_status(u_a, a_a1, '00000000-0000-4000-8000-000000000801');
  ASSERT (r ->> 'ok')::boolean AND r ->> 'state' = 'confirmed',
    format('S11 status works with the rollout key absent: %s', r);

  -- restore the policy for the race part
  INSERT INTO public.app_settings (key, value, description) VALUES
    ('youtube_comments_stage4_rollout',
     jsonb_build_object(
       'version', 1,
       'accounts', jsonb_build_object(
         a_a1::text, jsonb_build_object('read', true, 'held', true, 'write', true, 'ban', false)
       )
     ),
     'Stage 4 suite rollout policy (race part)');
END
$s11$;

-- ---------------------------------------------------------------------------
-- S12. Status binding: the receipt dies with the binding, not the session.
-- ---------------------------------------------------------------------------
DO $s12$
DECLARE
  u_a  uuid := '6e8a0001-0000-4000-8000-000000000001';
  u_b  uuid := '6e8a0002-0000-4000-8000-000000000002';
  a_a1 uuid := '6e8b0001-0000-4000-8000-000000000001';
  v_gen bigint;
  r jsonb;
BEGIN
  SELECT binding_generation INTO v_gen FROM public.social_accounts WHERE id = a_a1;
  r := public.youtube_comment_op_status(u_a, a_a1, '00000000-0000-4000-8000-000000000801');
  ASSERT (r ->> 'ok')::boolean, 'S12 the receipt is readable under the live binding';

  -- a foreign owner reads nothing
  r := public.youtube_comment_op_status(u_b, a_a1, '00000000-0000-4000-8000-000000000801');
  ASSERT r ->> 'reason' = 'not_found', 'S12 a foreign owner reads no receipt';

  -- a rebind makes the same receipt unreachable for the same owner
  UPDATE public.social_accounts SET is_active = false WHERE id = a_a1;
  UPDATE public.social_accounts SET is_active = true WHERE id = a_a1;
  r := public.youtube_comment_op_status(u_a, a_a1, '00000000-0000-4000-8000-000000000801');
  ASSERT r ->> 'reason' = 'not_found',
    format('S12 after a rebind the receipt answers not_found for the same owner: %s', r);

  -- a hard delete leaves social_account_id NULL, which can never match
  r := public.youtube_comment_op_claim(
    u_a, a_a1, 'UC-s4-alpha',
    (SELECT binding_generation FROM public.social_accounts WHERE id = a_a1),
    '00000000-0000-4000-8000-000000000a01',
    'edit', '{"video_id":"vid-s4-12","comment_id":"cmt-s4-12"}'::jsonb,
    repeat('5', 64), '{}'::jsonb, 'write', 's12-delete',
    pg_temp.s4_map(repeat('5', 64)));
  ASSERT (r ->> 'ok')::boolean, 'S12 claim before the hard delete';
  DELETE FROM public.social_accounts WHERE id = a_a1;
  r := public.youtube_comment_op_status(u_a, a_a1, '00000000-0000-4000-8000-000000000a01');
  ASSERT r ->> 'reason' = 'not_found', 'S12 a hard-deleted account strands the receipt';
  ASSERT (SELECT social_account_id FROM public.youtube_comment_operations
           WHERE owner_id = u_a AND operation_id = '00000000-0000-4000-8000-000000000a01') IS NULL,
    'S12 the stranded receipt kept its evidence (SET NULL, not CASCADE)';
END
$s12$;

ROLLBACK;

-- ---------------------------------------------------------------------------
-- R blocks. Real two-session interleavings over committed fixtures.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email) VALUES
  ('6e9a0001-0000-4000-8000-000000000001', 's4-race-owner@example.invalid')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workspaces (id, owner_id, name, is_personal) VALUES
  ('6e9d0001-0000-4000-8000-000000000001', '6e9a0001-0000-4000-8000-000000000001', 'S4 Race', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.connector_connections (
  id, workspace_id, connector_type, toolkit, composio_auth_config_id, external_account_id, status
) VALUES (
  '6e8c0004-0000-4000-8000-000000000004',
  '6e9d0001-0000-4000-8000-000000000001',
  'youtube', 'youtube', 'ac-r4-race', 'ext-r4-race', 'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.social_accounts (
  id, user_id, platform, platform_user_id, platform_username,
  access_token, refresh_token, token_expires_at, is_active, auth_provider
) VALUES (
  '6e9b0001-0000-4000-8000-000000000001',
  '6e9a0001-0000-4000-8000-000000000001', 'youtube', 'UC-s4-race', 's4-race',
  'race-access-1', 'race-refresh-1', clock_timestamp() + interval '1 hour',
  true, 'native'
)
ON CONFLICT (id) DO UPDATE SET
  access_token = EXCLUDED.access_token,
  refresh_token = EXCLUDED.refresh_token,
  token_expires_at = EXCLUDED.token_expires_at,
  is_active = true,
  auth_provider = 'native',
  needs_reauth = false;

INSERT INTO public.app_settings (key, value, description) VALUES
  ('feature_youtube_comments', 'true'::jsonb, 'Stage 4 suite tile flag'),
  ('youtube_comments_stage4_rollout',
   jsonb_build_object('version', 1, 'accounts', jsonb_build_object(
     '6e9b0001-0000-4000-8000-000000000001'::text,
     jsonb_build_object('read', true, 'held', true, 'write', true, 'ban', false)
   )),
   'Stage 4 race rollout policy')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

SELECT extensions.dblink_connect(
  's4_a', format('dbname=%s user=%s application_name=s4_race_a', current_database(), current_user));
SELECT extensions.dblink_connect(
  's4_b', format('dbname=%s user=%s application_name=s4_race_b', current_database(), current_user));

-- R1. Two sessions claim the same (owner, operation_id): one token.
DO $r1$
DECLARE
  v_a text := '6e9a0001-0000-4000-8000-000000000001';
  v_acct text := '6e9b0001-0000-4000-8000-000000000001';
  v_claim text := format(
    'SELECT public.youtube_comment_op_claim(%L::uuid, %L::uuid, %L, (SELECT binding_generation FROM public.social_accounts WHERE id = %L::uuid), %L::uuid, %L, %L::jsonb, %L, %L::jsonb, %L, %L, %L::jsonb)::text',
    v_a, v_acct, 'UC-s4-race', v_acct,
    '00000000-0000-4000-8000-00000000b001',
    'edit', '{"' || 'video_id' || '":"' || 'vid-r1' || '","comment_id":"cmt-r1"}',
    repeat('r', 64), '{}', 'write', 'r1', pg_temp.s4_map(repeat('r', 64))::text);
  r_a text;
  r_b text;
  v_pid_b int;
BEGIN
  PERFORM extensions.dblink_exec('s4_a', 'BEGIN');
  SELECT res INTO r_a FROM extensions.dblink('s4_a', v_claim) AS t(res text);

  -- B's pid is read BEFORE the async send: a synchronous dblink() on a
  -- connection with a pending async query is the deadlock this suite once had.
  SELECT pid INTO v_pid_b FROM extensions.dblink('s4_b', 'SELECT pg_backend_pid()') AS t(pid int);

  -- B claims the same key and parks on the account row lock A holds.
  PERFORM extensions.dblink_send_query('s4_b', v_claim);
  -- Wait until B is actually blocked on A's lock (bounded; fails loudly).
  PERFORM extensions.dblink_exec('s4_a', format(
    'DO $$ BEGIN
       FOR i IN 1..100 LOOP
         EXIT WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = %s AND wait_event_type = ' || quote_literal('Lock') || ');
         PERFORM pg_sleep(0.05);
       END LOOP;
       IF NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = %s AND wait_event_type = ' || quote_literal('Lock') || ') THEN
         RAISE EXCEPTION ''R1 session B never parked on the account lock'';
       END IF;
     END $$;', v_pid_b, v_pid_b));

  PERFORM extensions.dblink_exec('s4_a', 'COMMIT');
  SELECT res INTO r_b FROM extensions.dblink_get_result('s4_b') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s4_b') AS t(res text);

  ASSERT (r_a::jsonb ->> 'ok')::boolean AND (r_a::jsonb ->> 'attempt_token') IS NOT NULL,
    format('R1 session A won the token: %s', r_a);
  ASSERT r_b::jsonb ->> 'reason' = 'already_recorded' AND (r_b::jsonb ->> 'attempt_token') IS NULL,
    format('R1 session B got the existing state and no token: %s', r_b);
END
$r1$;

-- R2. Two keys, the same logical digest, concurrently: one winner.
DO $r2$
DECLARE
  v_a text := '6e9a0001-0000-4000-8000-000000000001';
  v_acct text := '6e9b0001-0000-4000-8000-000000000001';
  v_dig text;
  v_claim_a text;
  v_claim_b text;
  r_a text;
  r_b text;
  v_pid_b int;
BEGIN
  SELECT encode(extensions.hmac(
       convert_to('logical','utf8') || '\x00'::bytea || convert_to('1','utf8') || '\x00'::bytea
       || convert_to('UC-s4-race','utf8') || '\x00'::bytea
       || convert_to('vid-r2','utf8') || '\x00'::bytea
       || convert_to('','utf8') || '\x00'::bytea
       || convert_to('Concurrent identical text','utf8'),
       (SELECT key FROM public.youtube_comment_digest_keys WHERE version = 1), 'sha256'), 'hex')
    INTO v_dig;

  v_claim_a := format(
    'SELECT public.youtube_comment_op_claim(%L::uuid, %L::uuid, %L, (SELECT binding_generation FROM public.social_accounts WHERE id = %L::uuid), %L::uuid, %L, %L::jsonb, %L, %L::jsonb, %L, %L, %L::jsonb)::text',
    v_a, v_acct, 'UC-s4-race', v_acct,
    '00000000-0000-4000-8000-00000000b101',
    'create_thread', '{"video_id":"vid-r2"}',
    repeat('x', 64), jsonb_build_object('1', v_dig)::text, 'write', 'r2a', pg_temp.s4_map(repeat('x', 64))::text);
  v_claim_b := format(
    'SELECT public.youtube_comment_op_claim(%L::uuid, %L::uuid, %L, (SELECT binding_generation FROM public.social_accounts WHERE id = %L::uuid), %L::uuid, %L, %L::jsonb, %L, %L::jsonb, %L, %L, %L::jsonb)::text',
    v_a, v_acct, 'UC-s4-race', v_acct,
    '00000000-0000-4000-8000-00000000b102',
    'create_thread', '{"video_id":"vid-r2"}',
    repeat('y', 64), jsonb_build_object('1', v_dig)::text, 'write', 'r2b', pg_temp.s4_map(repeat('y', 64))::text);

  PERFORM extensions.dblink_exec('s4_a', 'BEGIN');
  SELECT res INTO r_a FROM extensions.dblink('s4_a', v_claim_a) AS t(res text);

  -- B's pid BEFORE the async send (same deadlock lesson as R1).
  SELECT pid INTO v_pid_b FROM extensions.dblink('s4_b', 'SELECT pg_backend_pid()') AS t(pid int);
  PERFORM extensions.dblink_send_query('s4_b', v_claim_b);
  PERFORM extensions.dblink_exec('s4_a', format(
    'DO $$ BEGIN
       FOR i IN 1..100 LOOP
         EXIT WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = %s AND wait_event_type = ' || quote_literal('Lock') || ');
         PERFORM pg_sleep(0.05);
       END LOOP;
       IF NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = %s AND wait_event_type = ' || quote_literal('Lock') || ') THEN
         RAISE EXCEPTION ''R2 session B never parked on the account lock'';
       END IF;
     END $$;', v_pid_b, v_pid_b));

  PERFORM extensions.dblink_exec('s4_a', 'COMMIT');
  SELECT res INTO r_b FROM extensions.dblink_get_result('s4_b') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s4_b') AS t(res text);

  ASSERT (r_a::jsonb ->> 'ok')::boolean, format('R2 the first key won: %s', r_a);
  ASSERT r_b::jsonb ->> 'reason' = 'possible_duplicate',
    format('R2 the second key with the same logical digest was refused: %s', r_b);
END
$r2$;

-- R3. Session A verifies, session B rebinds, session A claims: refused.
DO $r3$
DECLARE
  v_a text := '6e9a0001-0000-4000-8000-000000000001';
  v_acct text := '6e9b0001-0000-4000-8000-000000000001';
  v_verified jsonb;
  r text;
BEGIN
  PERFORM extensions.dblink_exec('s4_a', 'BEGIN');
  -- A verifies exactly the way the handler does before a claim. A plain
  -- SELECT under READ COMMITTED holds no row lock.
  SELECT res INTO r FROM extensions.dblink('s4_a', format(
    'SELECT jsonb_build_object(''channel'', platform_user_id, ''generation'', binding_generation)::text FROM public.social_accounts WHERE id = %L::uuid AND user_id = %L::uuid AND platform = %L AND is_active AND auth_provider = %L',
    v_acct, v_a, 'youtube', 'native')) AS t(res text);
  v_verified := r::jsonb;

  -- B rebinds and commits while A still holds its read snapshot. The rebind
  -- runs on B, never on the main session: the main DO's own transaction would
  -- hold the row lock and deadlock against A's claim below.
  PERFORM extensions.dblink_exec('s4_b', format(
    'UPDATE public.social_accounts SET access_token = %L, refresh_token = %L WHERE id = %L::uuid',
    'race-access-2', 'race-refresh-2', v_acct));

  -- A claims with the values it verified: the row lock serialises against
  -- B's committed rebind, and the expected generation no longer matches.
  SELECT res INTO r FROM extensions.dblink('s4_a', format(
    'SELECT public.youtube_comment_op_claim(%L::uuid, %L::uuid, %L, %s, %L::uuid, %L, %L::jsonb, %L, %L::jsonb, %L, %L, %L::jsonb)::text',
    v_a, v_acct, v_verified ->> 'channel', v_verified ->> 'generation',
    '00000000-0000-4000-8000-00000000b201',
    'edit', '{"video_id":"vid-r3","comment_id":"cmt-r3"}',
    repeat('z', 64), '{}', 'write', 'r3', pg_temp.s4_map(repeat('z', 64))::text)) AS t(res text);
  PERFORM extensions.dblink_exec('s4_a', 'COMMIT');

  ASSERT r::jsonb ->> 'reason' = 'not_found',
    format('R3 a claim with pre-rebind expected values was refused: %s', r);
END
$r3$;

-- R4. A rebind between the claim and the mark: the mark refuses, the row closes.
DO $r4$
DECLARE
  v_a text := '6e9a0001-0000-4000-8000-000000000001';
  v_acct text := '6e9b0001-0000-4000-8000-000000000001';
  r jsonb;
  v_token text;
  v_gen text;
BEGIN
  SELECT binding_generation::text INTO v_gen FROM public.social_accounts WHERE id = v_acct::uuid;
  r := public.youtube_comment_op_claim(
    v_a::uuid, v_acct::uuid, 'UC-s4-race', v_gen::bigint,
    '00000000-0000-4000-8000-00000000b301',
    'edit', '{"video_id":"vid-r4","comment_id":"cmt-r4"}'::jsonb,
    repeat('w', 64), '{}'::jsonb, 'write', 'r4',
    pg_temp.s4_map(repeat('w', 64)));
  v_token := r ->> 'attempt_token';

  -- the rebind lands between the claim and the mark
  UPDATE public.social_accounts SET auth_provider = 'composio', connection_id = '6e8c0004-0000-4000-8000-000000000004'
   WHERE id = v_acct::uuid;

  r := public.youtube_comment_op_mark_dispatched(
    v_a::uuid, '00000000-0000-4000-8000-00000000b301', v_token::uuid,
    'UC-s4-race', v_gen::bigint);
  ASSERT NOT (r ->> 'ok')::boolean AND r ->> 'reason' = 'binding_changed',
    format('R4 the mark refused after the rebind: %s', r);
  ASSERT (SELECT state FROM public.youtube_comment_operations
           WHERE owner_id = v_a::uuid AND operation_id = '00000000-0000-4000-8000-00000000b301') = 'refused',
    'R4 the row closed as never sent';

  UPDATE public.social_accounts SET auth_provider = 'native', connection_id = NULL,
         access_token = 'race-access-3'
   WHERE id = v_acct::uuid;
END
$r4$;

-- R5. A rebind AFTER the mark: the row stays dispatched and settlement records.
DO $r5$
DECLARE
  v_a text := '6e9a0001-0000-4000-8000-000000000001';
  v_acct text := '6e9b0001-0000-4000-8000-000000000001';
  r jsonb;
  v_token text;
  v_gen text;
BEGIN
  SELECT binding_generation::text INTO v_gen FROM public.social_accounts WHERE id = v_acct::uuid;
  r := public.youtube_comment_op_claim(
    v_a::uuid, v_acct::uuid, 'UC-s4-race', v_gen::bigint,
    '00000000-0000-4000-8000-00000000b401',
    'edit', '{"video_id":"vid-r5","comment_id":"cmt-r5"}'::jsonb,
    repeat('v', 64), '{}'::jsonb, 'write', 'r5',
    pg_temp.s4_map(repeat('v', 64)));
  v_token := r ->> 'attempt_token';
  r := public.youtube_comment_op_mark_dispatched(
    v_a::uuid, '00000000-0000-4000-8000-00000000b401', v_token::uuid,
    'UC-s4-race', v_gen::bigint);
  ASSERT (r ->> 'ok')::boolean, 'R5 the mark committed';

  UPDATE public.social_accounts SET is_active = false WHERE id = v_acct::uuid;

  r := public.youtube_comment_op_settle(
    v_a::uuid, '00000000-0000-4000-8000-00000000b401', v_token::uuid,
    'confirmed', NULL, 'none', NULL, 'cmt-r5');
  ASSERT (r ->> 'ok')::boolean AND r ->> 'state' = 'confirmed',
    format('R5 settlement recorded the truth even after the disconnect: %s', r);

  UPDATE public.social_accounts SET is_active = true WHERE id = v_acct::uuid;
END
$r5$;

-- R6. The capability turned off at each of the three positions.
DO $r6$
DECLARE
  v_a text := '6e9a0001-0000-4000-8000-000000000001';
  v_acct text := '6e9b0001-0000-4000-8000-000000000001';
  v_policy jsonb;
  r jsonb;
  v_token text;
  v_gen text;
BEGIN
  SELECT value INTO v_policy FROM public.app_settings WHERE key = 'youtube_comments_stage4_rollout';
  SELECT binding_generation::text INTO v_gen FROM public.social_accounts WHERE id = v_acct::uuid;

  -- off BEFORE the claim
  UPDATE public.app_settings
     SET value = jsonb_set(value, ARRAY['accounts', v_acct, 'write'], 'false'::jsonb)
   WHERE key = 'youtube_comments_stage4_rollout';
  r := public.youtube_comment_op_claim(
    v_a::uuid, v_acct::uuid, 'UC-s4-race', v_gen::bigint,
    '00000000-0000-4000-8000-00000000b501',
    'edit', '{"video_id":"vid-r6","comment_id":"cmt-r6a"}'::jsonb,
    repeat('u', 64), '{}'::jsonb, 'write', 'r6a',
    pg_temp.s4_map(repeat('u', 64)));
  ASSERT r ->> 'reason' = 'capability_denied', format('R6 off before the claim refused it: %s', r);

  -- off BETWEEN the claim and the mark
  UPDATE public.app_settings SET value = v_policy
   WHERE key = 'youtube_comments_stage4_rollout';
  r := public.youtube_comment_op_claim(
    v_a::uuid, v_acct::uuid, 'UC-s4-race', v_gen::bigint,
    '00000000-0000-4000-8000-00000000b502',
    'edit', '{"video_id":"vid-r6","comment_id":"cmt-r6b"}'::jsonb,
    repeat('t', 64), '{}'::jsonb, 'write', 'r6b',
    pg_temp.s4_map(repeat('t', 64)));
  v_token := r ->> 'attempt_token';
  UPDATE public.app_settings
     SET value = jsonb_set(value, ARRAY['accounts', v_acct, 'write'], 'false'::jsonb)
   WHERE key = 'youtube_comments_stage4_rollout';
  r := public.youtube_comment_op_mark_dispatched(
    v_a::uuid, '00000000-0000-4000-8000-00000000b502', v_token::uuid,
    'UC-s4-race', v_gen::bigint);
  ASSERT NOT (r ->> 'ok')::boolean AND r ->> 'reason' = 'capability_denied',
    format('R6 off between claim and mark refused the mark: %s', r);
  ASSERT (SELECT state FROM public.youtube_comment_operations
           WHERE owner_id = v_a::uuid AND operation_id = '00000000-0000-4000-8000-00000000b502') = 'refused',
    'R6 the mark-off row closed as never sent';

  -- off AFTER the mark: settlement still records
  UPDATE public.app_settings SET value = v_policy
   WHERE key = 'youtube_comments_stage4_rollout';
  r := public.youtube_comment_op_claim(
    v_a::uuid, v_acct::uuid, 'UC-s4-race', v_gen::bigint,
    '00000000-0000-4000-8000-00000000b503',
    'edit', '{"video_id":"vid-r6","comment_id":"cmt-r6c"}'::jsonb,
    repeat('s', 64), '{}'::jsonb, 'write', 'r6c',
    pg_temp.s4_map(repeat('s', 64)));
  v_token := r ->> 'attempt_token';
  r := public.youtube_comment_op_mark_dispatched(
    v_a::uuid, '00000000-0000-4000-8000-00000000b503', v_token::uuid,
    'UC-s4-race', v_gen::bigint);
  ASSERT (r ->> 'ok')::boolean, 'R6 the mark committed before the capability change';
  UPDATE public.app_settings
     SET value = jsonb_set(value, ARRAY['accounts', v_acct, 'write'], 'false'::jsonb)
   WHERE key = 'youtube_comments_stage4_rollout';
  r := public.youtube_comment_op_settle(
    v_a::uuid, '00000000-0000-4000-8000-00000000b503', v_token::uuid,
    'confirmed', NULL, 'none', NULL, 'cmt-r6c');
  ASSERT (r ->> 'ok')::boolean,
    format('R6 one request already authorised settles whatever the policy says now: %s', r);

  -- Restore the admission for the blocks that follow.
  UPDATE public.app_settings SET value = v_policy
   WHERE key = 'youtube_comments_stage4_rollout';
END
$r6$;

-- R7. Lost acknowledgement: settlement commits, the caller's answer is gone.
DO $r7$
DECLARE
  v_a text := '6e9a0001-0000-4000-8000-000000000001';
  v_acct text := '6e9b0001-0000-4000-8000-000000000001';
  v_dig text;
  v_token text;
  r jsonb;
BEGIN
  SELECT encode(extensions.hmac(
       convert_to('logical','utf8') || '\x00'::bytea || convert_to('1','utf8') || '\x00'::bytea
       || convert_to('UC-s4-race','utf8') || '\x00'::bytea
       || convert_to('vid-r7','utf8') || '\x00'::bytea
       || convert_to('','utf8') || '\x00'::bytea
       || convert_to('Lost answer text','utf8'),
       (SELECT key FROM public.youtube_comment_digest_keys WHERE version = 1), 'sha256'), 'hex')
    INTO v_dig;

  -- Session B settles and the reply is discarded before the caller sees it.
  PERFORM extensions.dblink_exec('s4_b', 'BEGIN');
  SELECT res INTO r FROM extensions.dblink('s4_b', format(
    'SELECT public.youtube_comment_op_claim(%L::uuid, %L::uuid, %L, (SELECT binding_generation FROM public.social_accounts WHERE id = %L::uuid), %L::uuid, %L, %L::jsonb, %L, %L::jsonb, %L, %L, %L::jsonb)::text',
    v_a, v_acct, 'UC-s4-race', v_acct,
    '00000000-0000-4000-8000-00000000b601',
    'create_thread', '{"video_id":"vid-r7"}',
    repeat('l', 64), jsonb_build_object('1', v_dig)::text, 'write', 'r7', pg_temp.s4_map(repeat('l', 64))::text)) AS t(res text);
  v_token := (r::jsonb ->> 'attempt_token');
  PERFORM res2 FROM extensions.dblink('s4_b', format(
    'SELECT public.youtube_comment_op_mark_dispatched(%L::uuid, %L::uuid, %L::uuid, %L, (SELECT binding_generation FROM public.social_accounts WHERE id = %L::uuid))::text',
    v_a, '00000000-0000-4000-8000-00000000b601', v_token, 'UC-s4-race', v_acct)) AS t(res2 text);
  -- "Lose" the mark's answer on purpose: never call dblink_get_result for it.
  PERFORM res2 FROM extensions.dblink('s4_b', format(
    'SELECT public.youtube_comment_op_settle(%L::uuid, %L::uuid, %L::uuid, %L, NULL, %L, %L, %L)::text',
    v_a, '00000000-0000-4000-8000-00000000b601', v_token, 'confirmed', 'none', 'th-r7', 'cmt-r7')) AS t(res2 text);
  PERFORM extensions.dblink_exec('s4_b', 'COMMIT');

  -- The state read after commit is confirmed.
  r := public.youtube_comment_op_status(v_a::uuid, v_acct::uuid, '00000000-0000-4000-8000-00000000b601');
  ASSERT (r ->> 'ok')::boolean AND r ->> 'state' = 'confirmed' AND r ->> 'result_comment_id' = 'cmt-r7',
    format('R7 the settlement survived the lost answer: %s', r);

  -- The same key returns the confirmed state.
  r := public.youtube_comment_op_claim(
    v_a::uuid, v_acct::uuid, 'UC-s4-race',
    (SELECT binding_generation FROM public.social_accounts WHERE id = v_acct::uuid),
    '00000000-0000-4000-8000-00000000b601',
    'create_thread', '{"video_id":"vid-r7"}'::jsonb,
    repeat('l', 64), jsonb_build_object('1', v_dig), 'write', 'r7-replay',
    pg_temp.s4_map(repeat('l', 64)));
  ASSERT r ->> 'reason' = 'already_recorded' AND r ->> 'state' = 'confirmed',
    format('R7 the same key replays the confirmed state, it never re-sends: %s', r);

  -- A new key with the same text inside the window is recently_posted.
  r := public.youtube_comment_op_claim(
    v_a::uuid, v_acct::uuid, 'UC-s4-race',
    (SELECT binding_generation FROM public.social_accounts WHERE id = v_acct::uuid),
    '00000000-0000-4000-8000-00000000b602',
    'create_thread', '{"video_id":"vid-r7"}'::jsonb,
    repeat('m', 64), jsonb_build_object('1', v_dig), 'write', 'r7-newkey',
    pg_temp.s4_map(repeat('m', 64)));
  ASSERT r ->> 'reason' = 'recently_posted' AND r ->> 'result_comment_id' = 'cmt-r7',
    format('R7 a new key within the window is recently_posted with the comment id: %s', r);
END
$r7$;

-- R8. The ban capability is judged at the claim AND at the mark, from the
-- receipt's own ban flag, never from what the caller says it needs.
DO $r8$
DECLARE
  v_a text := '6e9a0001-0000-4000-8000-000000000001';
  v_acct text := '6e9b0001-0000-4000-8000-000000000001';
  v_policy jsonb;
  v_gen text;
  v_targets jsonb := '{"video_id":"vid-r8","comment_id":"cmt-r8","moderation_status":"rejected","ban_author":true,"author_channel_id":"UC-r8-viewer"}';
  r jsonb;
  v_token text;
BEGIN
  SELECT value INTO v_policy FROM public.app_settings WHERE key = 'youtube_comments_stage4_rollout';
  SELECT binding_generation::text INTO v_gen FROM public.social_accounts WHERE id = v_acct::uuid;

  -- ban OFF, write ON: a ban claim that LIES about its capability ('write') is
  -- still judged as a ban and refused.
  UPDATE public.app_settings
     SET value = jsonb_set(jsonb_set(value, ARRAY['accounts', v_acct, 'write'], 'true'::jsonb),
                           ARRAY['accounts', v_acct, 'ban'], 'false'::jsonb)
   WHERE key = 'youtube_comments_stage4_rollout';
  r := public.youtube_comment_op_claim(
    v_a::uuid, v_acct::uuid, 'UC-s4-race', v_gen::bigint,
    '00000000-0000-4000-8000-00000000b701',
    'moderate', v_targets, repeat('b', 64), '{}'::jsonb, 'write', 'r8a',
    pg_temp.s4_map(repeat('b', 64)));
  ASSERT r ->> 'reason' = 'capability_denied',
    format('R8 a ban claim is refused when only write is on, whatever p_capability says: %s', r);

  -- ban ON: the claim lands.
  UPDATE public.app_settings
     SET value = jsonb_set(value, ARRAY['accounts', v_acct, 'ban'], 'true'::jsonb)
   WHERE key = 'youtube_comments_stage4_rollout';
  r := public.youtube_comment_op_claim(
    v_a::uuid, v_acct::uuid, 'UC-s4-race', v_gen::bigint,
    '00000000-0000-4000-8000-00000000b702',
    'moderate', v_targets, repeat('c', 64), '{}'::jsonb, 'ban', 'r8b',
    pg_temp.s4_map(repeat('c', 64)));
  ASSERT (r ->> 'ok')::boolean, format('R8 a ban claim lands when ban is on: %s', r);
  v_token := r ->> 'attempt_token';

  -- ban turned OFF between the claim and the mark; write stays ON.
  UPDATE public.app_settings
     SET value = jsonb_set(value, ARRAY['accounts', v_acct, 'ban'], 'false'::jsonb)
   WHERE key = 'youtube_comments_stage4_rollout';
  r := public.youtube_comment_op_mark_dispatched(
    v_a::uuid, '00000000-0000-4000-8000-00000000b702', v_token::uuid,
    'UC-s4-race', v_gen::bigint);
  ASSERT NOT (r ->> 'ok')::boolean AND r ->> 'reason' = 'capability_denied',
    format('R8 the mark refuses a ban when ban was turned off though write is still on: %s', r);
  ASSERT (SELECT state FROM public.youtube_comment_operations
           WHERE owner_id = v_a::uuid AND operation_id = '00000000-0000-4000-8000-00000000b702') = 'refused'
     AND (SELECT dispatched_at FROM public.youtube_comment_operations
           WHERE owner_id = v_a::uuid AND operation_id = '00000000-0000-4000-8000-00000000b702') IS NULL,
    'R8 the receipt closed as never sent (no dispatched_at: zero provider writes are authorised)';

  UPDATE public.app_settings SET value = v_policy WHERE key = 'youtube_comments_stage4_rollout';
END
$r8$;

-- R9. A receipt is readable ONLY through the account it was written for. Two
-- accounts of one owner can sit on the same generation number (every new row
-- starts at 1); the number alone must never open another account's receipt,
-- before or after the first account is disconnected or deleted.
DO $r9$
DECLARE
  v_a text := '6e9a0001-0000-4000-8000-000000000001';
  x1 text := '6e9b0002-0000-4000-8000-000000000002';
  x2 text := '6e9b0003-0000-4000-8000-000000000003';
  v_policy jsonb;
  v_g1 bigint;
  v_g2 bigint;
  r jsonb;
  v_token text;
BEGIN
  SELECT value INTO v_policy FROM public.app_settings WHERE key = 'youtube_comments_stage4_rollout';

  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, platform_username,
    access_token, refresh_token, token_expires_at, is_active, auth_provider
  ) VALUES
    (x1::uuid, v_a::uuid, 'youtube', 'UC-s4-x1', 's4-x1', 'x1-access', 'x1-refresh',
     clock_timestamp() + interval '1 hour', true, 'native'),
    (x2::uuid, v_a::uuid, 'youtube', 'UC-s4-x2', 's4-x2', 'x2-access', 'x2-refresh',
     clock_timestamp() + interval '1 hour', true, 'native');
  SELECT binding_generation INTO v_g1 FROM public.social_accounts WHERE id = x1::uuid;
  SELECT binding_generation INTO v_g2 FROM public.social_accounts WHERE id = x2::uuid;
  ASSERT v_g1 = v_g2, format('R9 the two accounts share a generation number (%s vs %s)', v_g1, v_g2);

  UPDATE public.app_settings
     SET value = jsonb_set(value, ARRAY['accounts', x1],
                           '{"read":true,"held":true,"write":true,"ban":false}'::jsonb)
   WHERE key = 'youtube_comments_stage4_rollout';

  r := public.youtube_comment_op_claim(
    v_a::uuid, x1::uuid, 'UC-s4-x1', v_g1,
    '00000000-0000-4000-8000-00000000b801',
    'edit', '{"video_id":"vid-r9","comment_id":"cmt-r9"}'::jsonb,
    repeat('d', 64), '{}'::jsonb, 'write', 'r9',
    pg_temp.s4_map(repeat('d', 64)));
  v_token := r ->> 'attempt_token';
  r := public.youtube_comment_op_mark_dispatched(
    v_a::uuid, '00000000-0000-4000-8000-00000000b801', v_token::uuid, 'UC-s4-x1', v_g1);
  ASSERT (r ->> 'ok')::boolean, format('R9 the mark committed: %s', r);
  r := public.youtube_comment_op_settle(
    v_a::uuid, '00000000-0000-4000-8000-00000000b801', v_token::uuid,
    'confirmed', NULL, 'none', NULL, 'cmt-r9');
  ASSERT (r ->> 'ok')::boolean, 'R9 the receipt settled';

  r := public.youtube_comment_op_status(v_a::uuid, x1::uuid, '00000000-0000-4000-8000-00000000b801');
  ASSERT (r ->> 'ok')::boolean AND r ->> 'result_comment_id' = 'cmt-r9',
    format('R9 the owning account reads its receipt: %s', r);

  r := public.youtube_comment_op_status(v_a::uuid, x2::uuid, '00000000-0000-4000-8000-00000000b801');
  ASSERT NOT (r ->> 'ok')::boolean AND r ->> 'reason' = 'not_found'
     AND r ->> 'result_comment_id' IS NULL,
    format('R9 a sibling account on the same generation number does NOT read it: %s', r);

  -- disconnected: the receipt is gone for the original, and still not leaked.
  UPDATE public.social_accounts SET is_active = false WHERE id = x1::uuid;
  r := public.youtube_comment_op_status(v_a::uuid, x2::uuid, '00000000-0000-4000-8000-00000000b801');
  ASSERT r ->> 'reason' = 'not_found', format('R9 after the original is disconnected, the sibling still reads nothing: %s', r);

  -- deleted: social_account_id goes NULL; neither id reads the receipt.
  DELETE FROM public.social_accounts WHERE id = x1::uuid;
  r := public.youtube_comment_op_status(v_a::uuid, x2::uuid, '00000000-0000-4000-8000-00000000b801');
  ASSERT r ->> 'reason' = 'not_found', format('R9 after the original is deleted, the sibling still reads nothing: %s', r);
  r := public.youtube_comment_op_status(v_a::uuid, x1::uuid, '00000000-0000-4000-8000-00000000b801');
  ASSERT r ->> 'reason' = 'not_found', format('R9 the deleted account id reads nothing: %s', r);

  DELETE FROM public.social_accounts WHERE id = x2::uuid;
  UPDATE public.app_settings SET value = v_policy WHERE key = 'youtube_comments_stage4_rollout';
END
$r9$;

-- R10. Digest-key rotation cannot put two claims of one logical operation on
-- different locks, because two such claims cannot exist on different account
-- rows: social_accounts is unique on (user_id, platform, platform_user_id), and
-- every claim holds FOR UPDATE on its own owner-scoped account row. Both
-- claims therefore queue on the SAME row whichever key version each picked
-- (R1 and R2 above are that queue, with two real sessions and a barrier).
DO $r10$
BEGIN
  BEGIN
    INSERT INTO public.social_accounts (
      id, user_id, platform, platform_user_id, platform_username,
      access_token, refresh_token, token_expires_at, is_active, auth_provider
    ) VALUES (
      '6e9b0004-0000-4000-8000-000000000004', '6e9a0001-0000-4000-8000-000000000001',
      'youtube', 'UC-s4-race', 's4-race-twin', 't-access', 't-refresh',
      clock_timestamp() + interval '1 hour', true, 'native'
    );
    RAISE EXCEPTION 'R10 a second youtube row for the same owner and channel was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  ASSERT (SELECT count(*) FROM public.social_accounts
           WHERE user_id = '6e9a0001-0000-4000-8000-000000000001'::uuid
             AND platform = 'youtube' AND platform_user_id = 'UC-s4-race') = 1,
    'R10 exactly one account row exists per owner and channel';
END
$r10$;

-- R11. The trusted refresh role may update ONLY the credential and health
-- columns its two functions write, never an identity column.
DO $r11$
DECLARE
  c text;
BEGIN
  FOREACH c IN ARRAY ARRAY['access_token','refresh_token','token_expires_at','needs_reauth',
                           'failure_count','last_refresh_error','account_metadata','updated_at'] LOOP
    ASSERT has_column_privilege('youtube_stage4_refresh', 'public.social_accounts', c, 'UPDATE'),
      format('R11 the refresh role can update %s', c);
  END LOOP;
  FOREACH c IN ARRAY ARRAY['user_id','platform','platform_user_id','auth_provider','connection_id',
                           'is_active','binding_generation'] LOOP
    ASSERT NOT has_column_privilege('youtube_stage4_refresh', 'public.social_accounts', c, 'UPDATE'),
      format('R11 the refresh role can NOT update the identity column %s', c);
  END LOOP;
END
$r11$;
-- R12. A Stage 4 refresh stores the token and leaves account HEALTH alone. The
-- normal lease store resets needs_reauth, failure_count and last_refresh_error
-- on every success (right for the refresh job, wrong for a comment read); the
-- neutral store must not, and the default store must keep doing so.
DO $r12$
DECLARE
  v_acct uuid := '6e9b0001-0000-4000-8000-000000000001';
  v_lease jsonb;
  v_json jsonb;
  v_gen_before bigint;
  v_gen_after bigint;
  v_meta jsonb := '{"granted_scopes":["https://www.googleapis.com/auth/youtube.force-ssl"],"keep":"me"}';
  r record;
BEGIN
  UPDATE public.social_accounts
     SET account_metadata = v_meta, needs_reauth = false, failure_count = 0, last_refresh_error = NULL
   WHERE id = v_acct;
  SELECT binding_generation INTO v_gen_before FROM public.social_accounts WHERE id = v_acct;

  -- (a) failure_count > 0 with an error recorded.
  v_lease := public.acquire_youtube_refresh_lease(v_acct, 60);
  ASSERT (v_lease ->> 'ok')::boolean, format('R12 lease acquired: %s', v_lease);
  UPDATE public.social_accounts SET failure_count = 2, last_refresh_error = 'earlier transient failure' WHERE id = v_acct;
  v_json := public.store_youtube_refreshed_token_with_lease_neutral(
    v_acct, (v_lease ->> 'lease_token')::uuid, 'neutral-access-1', clock_timestamp() + interval '2 hours', 'neutral-refresh-1');
  ASSERT (v_json ->> 'ok')::boolean, format('R12 neutral store ok: %s', v_json);
  SELECT access_token, refresh_token, failure_count, last_refresh_error, needs_reauth, account_metadata, binding_generation
    INTO r FROM public.social_accounts WHERE id = v_acct;
  ASSERT r.access_token = 'neutral-access-1' AND r.refresh_token = 'neutral-refresh-1',
    'R12 the neutral store wrote the new tokens';
  ASSERT r.failure_count = 2 AND r.last_refresh_error = 'earlier transient failure' AND r.needs_reauth = false,
    format('R12 health untouched after a neutral store: %s / %s / %s', r.failure_count, r.last_refresh_error, r.needs_reauth);
  ASSERT r.account_metadata = v_meta, 'R12 granted scopes and metadata untouched';
  ASSERT r.binding_generation = v_gen_before, 'R12 a trusted neutral refresh keeps the binding generation (rotated token included)';
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_token_refresh_leases WHERE social_account_id = v_acct),
    'R12 the lease closed';

  -- (b) needs_reauth = true stays true.
  v_lease := public.acquire_youtube_refresh_lease(v_acct, 60);
  UPDATE public.social_accounts SET needs_reauth = true WHERE id = v_acct;
  v_json := public.store_youtube_refreshed_token_with_lease_neutral(
    v_acct, (v_lease ->> 'lease_token')::uuid, 'neutral-access-2', clock_timestamp() + interval '2 hours', NULL);
  ASSERT (v_json ->> 'ok')::boolean, format('R12 neutral store ok with needs_reauth: %s', v_json);
  SELECT access_token, refresh_token, failure_count, needs_reauth INTO r FROM public.social_accounts WHERE id = v_acct;
  ASSERT r.access_token = 'neutral-access-2' AND r.refresh_token = 'neutral-refresh-1',
    'R12 new access token written, omitted refresh token preserved';
  ASSERT r.needs_reauth = true AND r.failure_count = 2, 'R12 needs_reauth and failure_count untouched';

  -- (c) the default store keeps its behaviour for every existing caller.
  v_lease := public.acquire_youtube_refresh_lease(v_acct, 60);
  v_json := public.store_youtube_refreshed_token_with_lease(
    v_acct, (v_lease ->> 'lease_token')::uuid, 'default-access-3', clock_timestamp() + interval '2 hours', NULL, NULL);
  ASSERT (v_json ->> 'ok')::boolean, format('R12 default store ok: %s', v_json);
  SELECT failure_count, last_refresh_error, needs_reauth INTO r FROM public.social_accounts WHERE id = v_acct;
  ASSERT r.failure_count = 0 AND r.last_refresh_error IS NULL AND r.needs_reauth = false,
    'R12 the default store still resets health (unchanged for existing callers)';

  -- (d) a wrong or stale lease writes nothing.
  v_lease := public.acquire_youtube_refresh_lease(v_acct, 60);
  v_json := public.store_youtube_refreshed_token_with_lease_neutral(
    v_acct, gen_random_uuid(), 'must-not-land', clock_timestamp() + interval '2 hours', NULL);
  ASSERT NOT (v_json ->> 'ok')::boolean AND v_json ->> 'reason' = 'stale_lease', format('R12 stale lease refused: %s', v_json);
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = v_acct) = 'default-access-3', 'R12 nothing written';
  PERFORM public.release_youtube_refresh_lease(v_acct, (v_lease ->> 'lease_token')::uuid);

  ASSERT NOT has_function_privilege('authenticated', 'public.store_youtube_refreshed_token_with_lease_neutral(uuid,uuid,text,timestamptz,text)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.store_youtube_refreshed_token_with_lease_neutral(uuid,uuid,text,timestamptz,text)', 'EXECUTE')
     AND has_function_privilege('service_role', 'public.store_youtube_refreshed_token_with_lease_neutral(uuid,uuid,text,timestamptz,text)', 'EXECUTE'),
    'R12 only the service role may execute the neutral store';
END
$r12$;

-- R13. A digest key version cannot be deleted by a rotation between a claim's
-- pick of it and the insert of its receipt. Two real sessions: A claims under
-- version 2 and holds the transaction open; B tries to delete version 2 and
-- must wait, then be refused because the receipt now references it.
SELECT set_config('s4.r13', pg_temp.s4_next_version()::text, false);
INSERT INTO public.youtube_comment_digest_keys (version, key)
VALUES (current_setting('s4.r13')::int, sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'utf8')));

DO $r13$
DECLARE
  v_ver int := current_setting('s4.r13')::int;
  v_a text := '6e9a0001-0000-4000-8000-000000000001';
  v_acct text := '6e9b0001-0000-4000-8000-000000000001';
  v_claim text := format(
    'SELECT public.youtube_comment_op_claim(%L::uuid, %L::uuid, %L, (SELECT binding_generation FROM public.social_accounts WHERE id = %L::uuid), %L::uuid, %L, %L::jsonb, %L, %L::jsonb, %L, %L, %L::jsonb)::text',
    v_a, v_acct, 'UC-s4-race', v_acct,
    '00000000-0000-4000-8000-00000000c101',
    'create_thread', '{"video_id":"vid-r13"}', repeat('q', 64),
    jsonb_build_object('1', 'r13-logical-v1', v_ver::text, 'r13-logical-v2')::text, 'write', 'r13',
    jsonb_build_object('1', repeat('a', 64), v_ver::text, repeat('b', 64))::text);
  r_a text;
  v_pid_b int;
  v_blocked boolean;
  v_refused boolean := false;
BEGIN
  PERFORM extensions.dblink_exec('s4_a', 'BEGIN');
  SELECT res INTO r_a FROM extensions.dblink('s4_a', v_claim) AS t(res text);
  ASSERT (r_a::jsonb ->> 'ok')::boolean AND (r_a::jsonb ->> 'digest_key_version')::int = v_ver,
    format('R13 session A claimed under key version %s: %s', v_ver, r_a);

  SELECT pid INTO v_pid_b FROM extensions.dblink('s4_b', 'SELECT pg_backend_pid()') AS t(pid int);
  PERFORM extensions.dblink_send_query('s4_b', format('DELETE FROM public.youtube_comment_digest_keys WHERE version = %s', v_ver));
  -- B must PARK on A's lock on the key row (bounded wait; fails loudly).
  PERFORM extensions.dblink_exec('s4_a', format(
    'DO $$ BEGIN
       FOR i IN 1..100 LOOP
         EXIT WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = %s AND wait_event_type = ' || quote_literal('Lock') || ');
         PERFORM pg_sleep(0.05);
       END LOOP;
       IF NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = %s AND wait_event_type = ' || quote_literal('Lock') || ') THEN
         RAISE EXCEPTION ''R13 the delete of an in-use key version did not wait for the claim'';
       END IF;
     END $$;', v_pid_b, v_pid_b));

  PERFORM extensions.dblink_exec('s4_a', 'COMMIT');

  BEGIN
    PERFORM * FROM extensions.dblink_get_result('s4_b') AS t(res text);
  EXCEPTION WHEN OTHERS THEN
    v_refused := SQLERRM LIKE '%still referenced by a receipt%';
  END;
  ASSERT v_refused, 'R13 the delete was refused once the claim committed (the receipt references the version)';
  ASSERT EXISTS (SELECT 1 FROM public.youtube_comment_digest_keys WHERE version = v_ver), 'R13 the claimed version still exists';
  ASSERT (SELECT digest_key_version FROM public.youtube_comment_operations
           WHERE owner_id = v_a::uuid AND operation_id = '00000000-0000-4000-8000-00000000c101') = v_ver,
    'R13 the receipt references the surviving version';
END
$r13$;

-- R14. A retry of the same key and the same intent AFTER a rotation is answered
-- from the receipt; it is not a conflict. The comparison uses the digest under
-- the key version the receipt was signed with. A different intent still conflicts.
DO $r14$
DECLARE
  v_a uuid := '6e9a0001-0000-4000-8000-000000000001';
  v_acct uuid := '6e9b0001-0000-4000-8000-000000000001';
  v_gen bigint;
  v_op uuid := '00000000-0000-4000-8000-00000000c201';
  v_v1 text := repeat('1', 64);
  v_v2 text := repeat('2', 64);
  v_ver int := current_setting('s4.r13')::int;
  v_ver3 int := pg_temp.s4_next_version();
  r jsonb;
BEGIN
  SELECT binding_generation INTO v_gen FROM public.social_accounts WHERE id = v_acct;
  -- The R13 version is already active. The receipt is written under it.
  r := public.youtube_comment_op_claim(
    v_a, v_acct, 'UC-s4-race', v_gen, v_op,
    'edit', '{"video_id":"vid-r14","comment_id":"cmt-r14"}'::jsonb,
    v_v2, '{}'::jsonb, 'write', 'r14a',
    jsonb_build_object('1', v_v1, v_ver::text, v_v2));
  ASSERT (r ->> 'ok')::boolean, format('R14 first claim: %s', r);
  ASSERT (SELECT intent_key_version FROM public.youtube_comment_operations WHERE owner_id = v_a AND operation_id = v_op) = v_ver,
    'R14 the receipt records the key version its intent digest was signed with';

  -- Rotation: a newer version becomes active; the SAME key and intent are retried.
  INSERT INTO public.youtube_comment_digest_keys (version, key)
  VALUES (v_ver3, sha256(convert_to(gen_random_uuid()::text, 'utf8')));
  r := public.youtube_comment_op_claim(
    v_a, v_acct, 'UC-s4-race', v_gen, v_op,
    'edit', '{"video_id":"vid-r14","comment_id":"cmt-r14"}'::jsonb,
    repeat('3', 64), '{}'::jsonb, 'write', 'r14b',
    jsonb_build_object('1', v_v1, v_ver::text, v_v2, v_ver3::text, repeat('3', 64)));
  ASSERT r ->> 'reason' = 'already_recorded' AND (r ->> 'attempt_token') IS NULL,
    format('R14 the same key and intent after a rotation is answered from the receipt, with no token: %s', r);

  -- A different intent under the same key is still a conflict.
  r := public.youtube_comment_op_claim(
    v_a, v_acct, 'UC-s4-race', v_gen, v_op,
    'edit', '{"video_id":"vid-r14","comment_id":"cmt-r14"}'::jsonb,
    repeat('9', 64), '{}'::jsonb, 'write', 'r14c',
    jsonb_build_object('1', repeat('7', 64), v_ver::text, repeat('8', 64), v_ver3::text, repeat('9', 64)));
  ASSERT r ->> 'reason' = 'conflict', format('R14 a different intent is a conflict: %s', r);

  -- A caller that sends no digest for the receipt's version cannot verify it. That is the
  -- temporary refusal (the caller recomputes), never a pass and, since PR 2, never a conflict:
  -- a browser shows a conflict as a refusal and uses it to forget a live operation.
  r := public.youtube_comment_op_claim(
    v_a, v_acct, 'UC-s4-race', v_gen, v_op,
    'edit', '{"video_id":"vid-r14","comment_id":"cmt-r14"}'::jsonb,
    repeat('3', 64), '{}'::jsonb, 'write', 'r14d',
    jsonb_build_object(v_ver3::text, repeat('3', 64)));
  ASSERT r ->> 'reason' = 'upstream' AND (r ->> 'attempt_token') IS NULL,
    format('R14 an unverifiable version is the temporary refusal, with no token: %s', r);

  -- The R13 version is referenced by a receipt (its intent, and R13's logical digest) and cannot be removed.
  BEGIN
    DELETE FROM public.youtube_comment_digest_keys WHERE version = v_ver;
    RAISE EXCEPTION 'R14 a key version used by a receipt was deleted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%still referenced by a receipt%' THEN RAISE; END IF;
  END;

  -- clean up: receipts first, then the extra versions.
  DELETE FROM public.youtube_comment_operations
   WHERE owner_id = v_a AND operation_id IN ('00000000-0000-4000-8000-00000000c101', v_op);
  DELETE FROM public.youtube_comment_digest_keys WHERE version IN (v_ver3, v_ver);
  ASSERT (SELECT count(*) FROM public.youtube_comment_digest_keys) >= 1, 'R14 version 1 remains';
END
$r14$;

-- R15. A rotation between the caller computing its digests and the claim: the
-- caller's digests cover version 1 only, version 2 is active when the claim
-- runs. The claim must not store a version-1 digest labelled version 2; it is
-- refused as temporary, with no receipt and nothing dispatched.
DO $r15$
DECLARE
  v_a uuid := '6e9a0001-0000-4000-8000-000000000001';
  v_acct uuid := '6e9b0001-0000-4000-8000-000000000001';
  v_gen bigint;
  v_ver int := pg_temp.s4_next_version();
  v_old jsonb := jsonb_build_object('1', repeat('1', 64));
  v_both jsonb := jsonb_build_object('1', repeat('1', 64), v_ver::text, repeat('2', 64));
  v_op uuid;
  r jsonb;
  v_case record;
BEGIN
  SELECT binding_generation INTO v_gen FROM public.social_accounts WHERE id = v_acct;
  INSERT INTO public.youtube_comment_digest_keys (version, key)
  VALUES (v_ver, sha256(convert_to(gen_random_uuid()::text, 'utf8')));

  FOR v_case IN SELECT * FROM (VALUES
    ('edit', '{"video_id":"vid-r15","comment_id":"cmt-r15"}', '00000000-0000-4000-8000-00000000c301'),
    ('moderate', '{"video_id":"vid-r15","comment_id":"cmt-r15m","moderation_status":"published"}', '00000000-0000-4000-8000-00000000c302')
  ) AS c(action, targets, op) LOOP
    v_op := v_case.op::uuid;

    -- digests prepared under version 1 only, version 2 active: refused, temporary.
    r := public.youtube_comment_op_claim(
      v_a, v_acct, 'UC-s4-race', v_gen, v_op, v_case.action, v_case.targets::jsonb,
      repeat('1', 64), '{}'::jsonb, 'write', 'r15a', v_old);
    ASSERT NOT (r ->> 'ok')::boolean AND r ->> 'reason' = 'upstream' AND (r ->> 'attempt_token') IS NULL,
      format('R15 %s: a claim without a digest for the locked version is a temporary refusal: %s', v_case.action, r);
    ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_comment_operations WHERE owner_id = v_a AND operation_id = v_op),
      format('R15 %s: no receipt row was stored', v_case.action);
    ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_comment_operations WHERE owner_id = v_a AND dispatched_at IS NOT NULL AND operation_id = v_op),
      format('R15 %s: nothing was dispatched', v_case.action);

    -- digests for both versions: the VERSION-2 digest is stored, labelled 2.
    r := public.youtube_comment_op_claim(
      v_a, v_acct, 'UC-s4-race', v_gen, v_op, v_case.action, v_case.targets::jsonb,
      repeat('1', 64), '{}'::jsonb, 'write', 'r15b', v_both);
    ASSERT (r ->> 'ok')::boolean, format('R15 %s: the claim with both versions lands: %s', v_case.action, r);
    ASSERT (SELECT intent_digest || ':' || intent_key_version FROM public.youtube_comment_operations
             WHERE owner_id = v_a AND operation_id = v_op) = repeat('2', 64) || ':' || v_ver,
      format('R15 %s: the stored digest is the one for the key version it is labelled with', v_case.action);

    -- a retry of the same key and intent is answered from the receipt.
    r := public.youtube_comment_op_claim(
      v_a, v_acct, 'UC-s4-race', v_gen, v_op, v_case.action, v_case.targets::jsonb,
      repeat('2', 64), '{}'::jsonb, 'write', 'r15c', v_both);
    ASSERT r ->> 'reason' = 'already_recorded', format('R15 %s: the retry is already_recorded, not conflict: %s', v_case.action, r);
  END LOOP;

  DELETE FROM public.youtube_comment_operations
   WHERE owner_id = v_a AND operation_id IN ('00000000-0000-4000-8000-00000000c301', '00000000-0000-4000-8000-00000000c302');
  DELETE FROM public.youtube_comment_digest_keys WHERE version = v_ver;
END
$r15$;

-- R15b. The same rotation for create_thread and reply: digests computed under
-- version 1 only while version 2 is active are a TEMPORARY refusal, nothing is
-- stored, and a caller that sends no intent map is refused as malformed
-- (invalid_request), whatever else is missing.
SELECT set_config('s4.r15b', pg_temp.s4_next_version()::text, false);
INSERT INTO public.youtube_comment_digest_keys (version, key)
VALUES (current_setting('s4.r15b')::int, sha256(convert_to(gen_random_uuid()::text, 'utf8')));

DO $r15b$
DECLARE
  v_ver int := current_setting('s4.r15b')::int;
  v_a uuid := '6e9a0001-0000-4000-8000-000000000001';
  v_acct uuid := '6e9b0001-0000-4000-8000-000000000001';
  v_gen bigint;
  v_old jsonb := jsonb_build_object('1', repeat('1', 64));
  v_case record;
  r jsonb;
BEGIN
  SELECT binding_generation INTO v_gen FROM public.social_accounts WHERE id = v_acct;
  FOR v_case IN SELECT * FROM (VALUES
    ('create_thread', '{"video_id":"vid-r15b"}', '00000000-0000-4000-8000-00000000c311'),
    ('reply', '{"video_id":"vid-r15b","parent_comment_id":"cmt-r15b"}', '00000000-0000-4000-8000-00000000c312')
  ) AS c(action, targets, op) LOOP
    r := public.youtube_comment_op_claim(
      v_a, v_acct, 'UC-s4-race', v_gen, v_case.op::uuid, v_case.action, v_case.targets::jsonb,
      repeat('1', 64), jsonb_build_object('1', 'r15b-logical-v1'), 'write', 'r15b', v_old);
    ASSERT NOT (r ->> 'ok')::boolean AND r ->> 'reason' = 'upstream' AND (r ->> 'attempt_token') IS NULL,
      format('R15b %s: digests for an older key version are a temporary refusal: %s', v_case.action, r);
    ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_comment_operations WHERE owner_id = v_a AND operation_id = v_case.op::uuid),
      format('R15b %s: no receipt row was stored', v_case.action);

    r := public.youtube_comment_op_claim(
      v_a, v_acct, 'UC-s4-race', v_gen, v_case.op::uuid, v_case.action, v_case.targets::jsonb,
      repeat('1', 64), jsonb_build_object('1', 'r15b-logical-v1'), 'write', 'r15b', NULL);
    ASSERT NOT (r ->> 'ok')::boolean AND r ->> 'reason' = 'invalid_request',
      format('R15b %s: with no intent map the claim is malformed (invalid_request): %s', v_case.action, r);
  END LOOP;
  DELETE FROM public.youtube_comment_digest_keys WHERE version = v_ver;
END
$r15b$;

-- R16. The digest key guard: the only active key can be neither deleted nor
-- retired, key bytes never change under a version, and a rotation (insert a new
-- version, then retire the old one) still works. The new version carries no receipt,
-- so only the last-active rule can stop its removal.
DO $r16$
DECLARE
  v_refused text;
  v_ver int := pg_temp.s4_next_version();
BEGIN
  INSERT INTO public.youtube_comment_digest_keys (version, key)
  VALUES (v_ver, sha256(convert_to(gen_random_uuid()::text, 'utf8')));
  -- the rotation itself: version 1 retires while the new version is active.
  UPDATE public.youtube_comment_digest_keys SET retired_at = now() WHERE version = 1;

  BEGIN
    DELETE FROM public.youtube_comment_digest_keys WHERE version = v_ver;
    v_refused := NULL;
  EXCEPTION WHEN OTHERS THEN
    v_refused := SQLERRM;
  END;
  ASSERT v_refused LIKE '%last active digest key cannot be removed%',
    format('R16 the only active key cannot be deleted: %s', v_refused);

  BEGIN
    UPDATE public.youtube_comment_digest_keys SET retired_at = now() WHERE version = v_ver;
    v_refused := NULL;
  EXCEPTION WHEN OTHERS THEN
    v_refused := SQLERRM;
  END;
  ASSERT v_refused LIKE '%last active digest key cannot be retired%',
    format('R16 the only active key cannot be retired: %s', v_refused);

  BEGIN
    UPDATE public.youtube_comment_digest_keys SET key = sha256(convert_to('other', 'utf8')) WHERE version = v_ver;
    v_refused := NULL;
  EXCEPTION WHEN OTHERS THEN
    v_refused := SQLERRM;
  END;
  ASSERT v_refused LIKE '%key material of a version cannot be changed%',
    format('R16 the bytes of a version cannot be replaced: %s', v_refused);

  -- with another active key standing, the new version can go.
  UPDATE public.youtube_comment_digest_keys SET retired_at = NULL WHERE version = 1;
  DELETE FROM public.youtube_comment_digest_keys WHERE version = v_ver;
  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_comment_digest_keys WHERE version = v_ver),
    'R16 a key can be deleted while another active key remains';
  ASSERT (SELECT retired_at IS NULL FROM public.youtube_comment_digest_keys WHERE version = 1),
    'R16 version 1 is active again for the blocks that follow';
END
$r16$;

-- Session B's last result (R13's refused delete) was an error, which leaves the
-- connection unusable for another asynchronous query: start from a fresh one.
SELECT extensions.dblink_disconnect('s4_b');
SELECT extensions.dblink_connect(
  's4_b', format('dbname=%s user=%s application_name=s4_race_b', current_database(), current_user));

-- R17. The mark and a revocation are ordered. Session A marks (and holds its
-- transaction open); session B revokes the write capability and must PARK on
-- A's share lock on the settings row until A commits. Without the lock the
-- revocation commits at once, the mark commits afterwards, and the send
-- proceeds after the capability was revoked.
DO $r17$
DECLARE
  v_a text := '6e9a0001-0000-4000-8000-000000000001';
  v_acct text := '6e9b0001-0000-4000-8000-000000000001';
  v_op text := '00000000-0000-4000-8000-00000000c501';
  v_gen bigint;
  v_policy jsonb;
  r jsonb;
  r_a text;
  v_token text;
  v_pid_b int;
BEGIN
  SELECT value INTO v_policy FROM public.app_settings WHERE key = 'youtube_comments_stage4_rollout';
  SELECT binding_generation INTO v_gen FROM public.social_accounts WHERE id = v_acct::uuid;
  -- Committed (session B autocommits) so that session A can see the receipt.
  SELECT res::jsonb INTO r FROM extensions.dblink('s4_b', format(
    'SELECT public.youtube_comment_op_claim(%L::uuid, %L::uuid, %L, %s, %L::uuid, %L, %L::jsonb, %L, %L::jsonb, %L, %L, %L::jsonb)',
    v_a, v_acct, 'UC-s4-race', v_gen, v_op, 'edit', '{"video_id":"vid-r17","comment_id":"cmt-r17"}',
    repeat('v', 64), '{}', 'write', 'r17', pg_temp.s4_map(repeat('v', 64))::text)) AS t(res text);
  ASSERT (r ->> 'ok')::boolean, format('R17 claimed: %s', r);
  v_token := r ->> 'attempt_token';

  PERFORM extensions.dblink_exec('s4_a', 'BEGIN');
  SELECT res INTO r_a FROM extensions.dblink('s4_a', format(
    'SELECT public.youtube_comment_op_mark_dispatched(%L::uuid, %L::uuid, %L::uuid, %L, %s)',
    v_a, v_op, v_token, 'UC-s4-race', v_gen)) AS t(res text);
  ASSERT (r_a::jsonb ->> 'ok')::boolean, format('R17 session A marked: %s', r_a);

  SELECT pid INTO v_pid_b FROM extensions.dblink('s4_b', 'SELECT pg_backend_pid()') AS t(pid int);
  PERFORM extensions.dblink_send_query('s4_b', format(
    'UPDATE public.app_settings SET value = jsonb_set(value, %L::text[], %L::jsonb) WHERE key = %L',
    format('{accounts,%s,write}', v_acct), 'false', 'youtube_comments_stage4_rollout'));
  PERFORM extensions.dblink_exec('s4_a', format(
    'DO $$ BEGIN
       FOR i IN 1..100 LOOP
         EXIT WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = %s AND wait_event_type = ' || quote_literal('Lock') || ');
         PERFORM pg_sleep(0.05);
       END LOOP;
       IF NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = %s AND wait_event_type = ' || quote_literal('Lock') || ') THEN
         RAISE EXCEPTION ''R17 the revocation did not wait for the mark'';
       END IF;
     END $$;', v_pid_b, v_pid_b));
  ASSERT (SELECT value #>> ARRAY['accounts', v_acct, 'write'] FROM public.app_settings
           WHERE key = 'youtube_comments_stage4_rollout') = 'true',
    'R17 the revocation is not visible while the mark is open';

  PERFORM extensions.dblink_exec('s4_a', 'COMMIT');
  PERFORM * FROM extensions.dblink_get_result('s4_b') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s4_b') AS t(res text);

  ASSERT (SELECT state FROM public.youtube_comment_operations
           WHERE owner_id = v_a::uuid AND operation_id = v_op::uuid) = 'dispatched',
    'R17 the mark committed before the revocation';
  ASSERT (SELECT value #>> ARRAY['accounts', v_acct, 'write'] FROM public.app_settings
           WHERE key = 'youtube_comments_stage4_rollout') = 'false',
    'R17 the revocation applied once the mark committed';

  -- A revocation that committed BEFORE a mark is seen by that MARK (not only by
  -- the next claim): claim while writes are allowed, revoke, then mark with the
  -- claim's own token. The mark must refuse and close the operation as never sent.
  UPDATE public.app_settings SET value = v_policy WHERE key = 'youtube_comments_stage4_rollout';
  r := public.youtube_comment_op_claim(
    v_a::uuid, v_acct::uuid, 'UC-s4-race', v_gen, '00000000-0000-4000-8000-00000000c502'::uuid,
    'edit', '{"video_id":"vid-r17","comment_id":"cmt-r17b"}'::jsonb,
    repeat('w', 64), '{}'::jsonb, 'write', 'r17b',
    pg_temp.s4_map(repeat('w', 64)));
  ASSERT (r ->> 'ok')::boolean, format('R17 claimed while writes were allowed: %s', r);
  v_token := r ->> 'attempt_token';
  UPDATE public.app_settings
     SET value = jsonb_set(value, ARRAY['accounts', v_acct, 'write'], 'false'::jsonb)
   WHERE key = 'youtube_comments_stage4_rollout';
  r := public.youtube_comment_op_mark_dispatched(
    v_a::uuid, '00000000-0000-4000-8000-00000000c502'::uuid, v_token::uuid, 'UC-s4-race', v_gen);
  ASSERT NOT (r ->> 'ok')::boolean AND r ->> 'reason' = 'capability_denied' AND r ->> 'state' = 'refused',
    format('R17 a committed revocation stops the next MARK: %s', r);
  ASSERT (SELECT state FROM public.youtube_comment_operations
           WHERE owner_id = v_a::uuid AND operation_id = '00000000-0000-4000-8000-00000000c502'::uuid) = 'refused',
    'R17 the refused mark closed the operation as never sent';

  UPDATE public.app_settings SET value = v_policy WHERE key = 'youtube_comments_stage4_rollout';
END
$r17$;

-- R18. A status read that decides to convert a dispatched receipt to
-- indeterminate loses the race to a settlement: it must answer with the
-- settlement (confirmed, with its comment id), never with the stale guess.
DO $r18$
DECLARE
  v_a text := '6e9a0001-0000-4000-8000-000000000001';
  v_acct text := '6e9b0001-0000-4000-8000-000000000001';
  v_op text := '00000000-0000-4000-8000-00000000c601';
  v_gen bigint;
  r jsonb;
  r_a text;
  r_b text;
  v_token text;
  v_pid_b int;
BEGIN
  SELECT binding_generation INTO v_gen FROM public.social_accounts WHERE id = v_acct::uuid;
  SELECT res::jsonb INTO r FROM extensions.dblink('s4_b', format(
    'SELECT public.youtube_comment_op_claim(%L::uuid, %L::uuid, %L, %s, %L::uuid, %L, %L::jsonb, %L, %L::jsonb, %L, %L, %L::jsonb)',
    v_a, v_acct, 'UC-s4-race', v_gen, v_op, 'edit', '{"video_id":"vid-r18","comment_id":"cmt-r18"}',
    repeat('x', 64), '{}', 'write', 'r18', pg_temp.s4_map(repeat('x', 64))::text)) AS t(res text);
  ASSERT (r ->> 'ok')::boolean, format('R18 claimed: %s', r);
  v_token := r ->> 'attempt_token';
  SELECT res::jsonb INTO r FROM extensions.dblink('s4_b', format(
    'SELECT public.youtube_comment_op_mark_dispatched(%L::uuid, %L::uuid, %L::uuid, %L, %s)',
    v_a, v_op, v_token, 'UC-s4-race', v_gen)) AS t(res text);
  ASSERT (r ->> 'ok')::boolean, format('R18 marked: %s', r);
  PERFORM extensions.dblink_exec('s4_b', format(
    'UPDATE public.youtube_comment_operations SET dispatched_at = clock_timestamp() - interval ''100 seconds'' WHERE owner_id = %L::uuid AND operation_id = %L::uuid',
    v_a, v_op));

  PERFORM extensions.dblink_exec('s4_a', 'BEGIN');
  SELECT res INTO r_a FROM extensions.dblink('s4_a', format(
    'SELECT public.youtube_comment_op_settle(%L::uuid, %L::uuid, %L::uuid, %L, NULL, %L, NULL, %L)',
    v_a, v_op, v_token, 'confirmed', 'none', 'cmt-r18')) AS t(res text);
  ASSERT (r_a::jsonb ->> 'ok')::boolean, format('R18 session A settled (uncommitted): %s', r_a);

  SELECT pid INTO v_pid_b FROM extensions.dblink('s4_b', 'SELECT pg_backend_pid()') AS t(pid int);
  PERFORM extensions.dblink_send_query('s4_b', format(
    'SELECT public.youtube_comment_op_status(%L::uuid, %L::uuid, %L::uuid)', v_a, v_acct, v_op));
  PERFORM extensions.dblink_exec('s4_a', format(
    'DO $$ BEGIN
       FOR i IN 1..100 LOOP
         EXIT WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = %s AND wait_event_type = ' || quote_literal('Lock') || ');
         PERFORM pg_sleep(0.05);
       END LOOP;
       IF NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = %s AND wait_event_type = ' || quote_literal('Lock') || ') THEN
         RAISE EXCEPTION ''R18 the status conversion did not wait for the settlement'';
       END IF;
     END $$;', v_pid_b, v_pid_b));
  PERFORM extensions.dblink_exec('s4_a', 'COMMIT');

  SELECT res INTO r_b FROM extensions.dblink_get_result('s4_b') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s4_b') AS t(res text);
  ASSERT r_b::jsonb ->> 'state' = 'confirmed' AND r_b::jsonb ->> 'result_comment_id' = 'cmt-r18',
    format('R18 the status answers with the winning settlement: %s', r_b);
END
$r18$;

-- R19. The rollout policy shape is null-safe: a policy with valid accounts but
-- no version, a non-numeric version, or no accounts is invalid and admits nothing.
DO $r19$
DECLARE
  v_acct text := '6e9b0001-0000-4000-8000-000000000001';
  v_policy jsonb;
  v_variant jsonb;
  v_label text;
  st jsonb;
BEGIN
  SELECT value INTO v_policy FROM public.app_settings WHERE key = 'youtube_comments_stage4_rollout';
  FOR v_label, v_variant IN SELECT * FROM (VALUES
    ('no version', v_policy - 'version'),
    ('string version', jsonb_set(v_policy, '{version}', '"1"'::jsonb)),
    ('version 2', jsonb_set(v_policy, '{version}', '2'::jsonb)),
    ('no accounts', v_policy - 'accounts')
  ) AS t(label, variant) LOOP
    UPDATE public.app_settings SET value = v_variant WHERE key = 'youtube_comments_stage4_rollout';
    st := public.youtube_comments_stage4_rollout_state();
    ASSERT st ->> 'status' = 'rollout_invalid', format('R19 %s is rollout_invalid: %s', v_label, st);
    ASSERT NOT public.youtube_comments_stage4_admits(v_acct::uuid, 'write'),
      format('R19 %s admits nothing', v_label);
  END LOOP;
  UPDATE public.app_settings SET value = v_policy WHERE key = 'youtube_comments_stage4_rollout';
  st := public.youtube_comments_stage4_rollout_state();
  ASSERT st ->> 'status' = 'ok', format('R19 the valid policy is ok again: %s', st);
END
$r19$;

-- R20. The status read: an abandoned claim closes after 120 s, a fresh claim
-- stays claimed, an unsettled dispatch converts after 90 s with its reason,
-- and the edit target is reported apart from the result.
DO $r20$
DECLARE
  v_a text := '6e9a0001-0000-4000-8000-000000000001';
  v_acct text := '6e9b0001-0000-4000-8000-000000000001';
  v_gen bigint;
  r jsonb;
  st jsonb;
  v_token text;
BEGIN
  SELECT binding_generation INTO v_gen FROM public.social_accounts WHERE id = v_acct::uuid;

  r := public.youtube_comment_op_claim(
    v_a::uuid, v_acct::uuid, 'UC-s4-race', v_gen, '00000000-0000-4000-8000-00000000c701'::uuid,
    'edit', '{"video_id":"vid-r20","comment_id":"cmt-r20a"}'::jsonb,
    repeat('y', 64), '{}'::jsonb, 'write', 'r20a',
    pg_temp.s4_map(repeat('y', 64)));
  ASSERT (r ->> 'ok')::boolean, format('R20 claimed a: %s', r);
  v_token := r ->> 'attempt_token';
  st := public.youtube_comment_op_status(v_a::uuid, v_acct::uuid, '00000000-0000-4000-8000-00000000c701'::uuid);
  ASSERT st ->> 'state' = 'claimed' AND st ->> 'target_comment_id' = 'cmt-r20a',
    format('R20 a fresh claim stays claimed and names its target: %s', st);

  UPDATE public.youtube_comment_operations SET claimed_at = clock_timestamp() - interval '121 seconds'
   WHERE owner_id = v_a::uuid AND operation_id = '00000000-0000-4000-8000-00000000c701'::uuid;
  st := public.youtube_comment_op_status(v_a::uuid, v_acct::uuid, '00000000-0000-4000-8000-00000000c701'::uuid);
  ASSERT st ->> 'state' = 'refused' AND st ->> 'reason' = 'abandoned_before_dispatch',
    format('R20 an abandoned claim closes as refused: %s', st);
  -- With the claim's OWN token: a made-up token would be refused for being wrong
  -- and prove nothing about the closed state.
  r := public.youtube_comment_op_mark_dispatched(
    v_a::uuid, '00000000-0000-4000-8000-00000000c701'::uuid, v_token::uuid, 'UC-s4-race', v_gen);
  ASSERT NOT (r ->> 'ok')::boolean, format('R20 a closed claim can never be marked, even with its original token: %s', r);
  ASSERT (SELECT state FROM public.youtube_comment_operations
           WHERE owner_id = v_a::uuid AND operation_id = '00000000-0000-4000-8000-00000000c701'::uuid) = 'refused',
    'R20 the closed claim stayed refused after the mark attempt';

  r := public.youtube_comment_op_claim(
    v_a::uuid, v_acct::uuid, 'UC-s4-race', v_gen, '00000000-0000-4000-8000-00000000c702'::uuid,
    'edit', '{"video_id":"vid-r20","comment_id":"cmt-r20b"}'::jsonb,
    repeat('z', 64), '{}'::jsonb, 'write', 'r20b',
    pg_temp.s4_map(repeat('z', 64)));
  v_token := r ->> 'attempt_token';
  r := public.youtube_comment_op_mark_dispatched(
    v_a::uuid, '00000000-0000-4000-8000-00000000c702'::uuid, v_token::uuid, 'UC-s4-race', v_gen);
  ASSERT (r ->> 'ok')::boolean, format('R20 marked b: %s', r);
  UPDATE public.youtube_comment_operations SET dispatched_at = clock_timestamp() - interval '91 seconds'
   WHERE owner_id = v_a::uuid AND operation_id = '00000000-0000-4000-8000-00000000c702'::uuid;
  st := public.youtube_comment_op_status(v_a::uuid, v_acct::uuid, '00000000-0000-4000-8000-00000000c702'::uuid);
  ASSERT st ->> 'state' = 'indeterminate' AND st ->> 'reason' = 'no_settlement'
    AND st ->> 'result_comment_id' IS NULL AND st ->> 'target_comment_id' = 'cmt-r20b',
    format('R20 an unsettled dispatch converts with its reason and still names its target: %s', st);
END
$r20$;

-- R21. The logical fence across a key rotation that is ROLLED BACK. Request A
-- computes its digests under version 1 only and stalls. Version 2 is added and
-- request B (the same text and target) records its receipt under version 2.
-- The operator then makes version 1 active again and retires version 2. A's
-- digest set is complete for the ACTIVE key but misses a retained version, so
-- the duplicate check could never see B's receipt and both would be sent.
-- A must be refused (temporary) until its digests cover every retained
-- version, and then the fence must hold. Once with B unresolved, once with B
-- recently confirmed.
DO $r21$
DECLARE
  v_a uuid := '6e9a0001-0000-4000-8000-000000000001';
  v_acct uuid := '6e9b0001-0000-4000-8000-000000000001';
  v_gen bigint;
  v_case record;
  v_ver int := pg_temp.s4_next_version();
  r jsonb;
BEGIN
  SELECT binding_generation INTO v_gen FROM public.social_accounts WHERE id = v_acct;
  INSERT INTO public.youtube_comment_digest_keys (version, key)
  VALUES (v_ver, sha256(convert_to(gen_random_uuid()::text, 'utf8')));

  FOR v_case IN SELECT * FROM (VALUES
    ('unresolved', 'r21-u', '00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c802'),
    ('confirmed',  'r21-c', '00000000-0000-4000-8000-00000000c811', '00000000-0000-4000-8000-00000000c812')
  ) AS c(kind, tag, op_b, op_a) LOOP
    -- B, with both versions' digests, claims under the newest active version.
    r := public.youtube_comment_op_claim(
      v_a, v_acct, 'UC-s4-race', v_gen, v_case.op_b::uuid, 'create_thread', '{"video_id":"vid-r21"}'::jsonb,
      repeat('b', 64), jsonb_build_object('1', v_case.tag || '-v1', v_ver::text, v_case.tag || '-v2'), 'write', 'r21b', pg_temp.s4_map(repeat('b', 64)));
    ASSERT (r ->> 'ok')::boolean, format('R21 %s: B claimed: %s', v_case.kind, r);
    ASSERT (SELECT digest_key_version FROM public.youtube_comment_operations
             WHERE owner_id = v_a AND operation_id = v_case.op_b::uuid) = v_ver,
      format('R21 %s: B is recorded under the newest version', v_case.kind);
    IF v_case.kind = 'confirmed' THEN
      r := public.youtube_comment_op_mark_dispatched(v_a, v_case.op_b::uuid, (r ->> 'attempt_token')::uuid, 'UC-s4-race', v_gen);
      ASSERT (r ->> 'ok')::boolean, format('R21 confirmed: B marked: %s', r);
      r := public.youtube_comment_op_settle(
        v_a, v_case.op_b::uuid,
        (SELECT attempt_token FROM public.youtube_comment_operations WHERE owner_id = v_a AND operation_id = v_case.op_b::uuid),
        'confirmed', NULL, 'none', 'thr-r21', 'cmt-r21');
      ASSERT (r ->> 'ok')::boolean, format('R21 confirmed: B settled: %s', r);
    END IF;

    -- The rotation is rolled back: the newest version retires, version 1 is active again.
    UPDATE public.youtube_comment_digest_keys SET retired_at = now() WHERE version = v_ver;

    r := public.youtube_comment_op_claim(
      v_a, v_acct, 'UC-s4-race', v_gen, v_case.op_a::uuid, 'create_thread', '{"video_id":"vid-r21"}'::jsonb,
      repeat('a', 64), jsonb_build_object('1', v_case.tag || '-v1'), 'write', 'r21a', pg_temp.s4_map(repeat('a', 64)));
    ASSERT NOT (r ->> 'ok')::boolean AND r ->> 'reason' = 'upstream' AND (r ->> 'attempt_token') IS NULL,
      format('R21 %s: digests that miss a retained version are a temporary refusal: %s', v_case.kind, r);
    ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_comment_operations WHERE owner_id = v_a AND operation_id = v_case.op_a::uuid),
      format('R21 %s: nothing was stored for A', v_case.kind);

    -- Recomputed over every retained version, A meets B's receipt.
    r := public.youtube_comment_op_claim(
      v_a, v_acct, 'UC-s4-race', v_gen, v_case.op_a::uuid, 'create_thread', '{"video_id":"vid-r21"}'::jsonb,
      repeat('a', 64), jsonb_build_object('1', v_case.tag || '-v1', v_ver::text, v_case.tag || '-v2'), 'write', 'r21a', pg_temp.s4_map(repeat('a', 64)));
    ASSERT NOT (r ->> 'ok')::boolean
       AND r ->> 'reason' = CASE v_case.kind WHEN 'unresolved' THEN 'possible_duplicate' ELSE 'recently_posted' END,
      format('R21 %s: the fence holds across the rolled-back rotation: %s', v_case.kind, r);
    ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_comment_operations WHERE owner_id = v_a AND operation_id = v_case.op_a::uuid),
      format('R21 %s: still nothing stored or dispatched for A', v_case.kind);

    UPDATE public.youtube_comment_digest_keys SET retired_at = NULL WHERE version = v_ver;
  END LOOP;

  DELETE FROM public.youtube_comment_operations
   WHERE owner_id = v_a
     AND operation_id IN ('00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c811');
  DELETE FROM public.youtube_comment_digest_keys WHERE version = v_ver;
END
$r21$;

-- Fresh connections for the lock tests: the earlier blocks left session B and
-- A with results of their own.
SELECT extensions.dblink_disconnect('s4_a');
SELECT extensions.dblink_disconnect('s4_b');
SELECT extensions.dblink_connect(
  's4_a', format('dbname=%s user=%s application_name=s4_race_a', current_database(), current_user));
SELECT extensions.dblink_connect(
  's4_b', format('dbname=%s user=%s application_name=s4_race_b', current_database(), current_user));
SELECT extensions.dblink_connect(
  's4_c', format('dbname=%s user=%s application_name=s4_race_c', current_database(), current_user));

-- R17b. The settings lock only counts when BOTH rows are locked. Session B
-- holds the tile row; the rollout row is deleted (committed) and A's mark starts
-- its lock statement, which cannot see that row and parks on the tile row. While
-- A is parked the rollout row is re-added (committed) and B commits. Without the
-- count, A's evaluation would then read the NEW, unlocked row and allow the send;
-- with it, A saw only one row locked and closes the claim as never sent.
DO $r17b$
DECLARE
  v_a text := '6e9a0001-0000-4000-8000-000000000001';
  v_acct text := '6e9b0001-0000-4000-8000-000000000001';
  v_op text := '00000000-0000-4000-8000-00000000c504';
  v_gen bigint;
  v_policy jsonb;
  v_description text;
  r jsonb;
  r_a text;
  v_token text;
  v_pid_a int;
BEGIN
  SELECT value, description INTO v_policy, v_description
    FROM public.app_settings WHERE key = 'youtube_comments_stage4_rollout';
  SELECT binding_generation INTO v_gen FROM public.social_accounts WHERE id = v_acct::uuid;
  SELECT res::jsonb INTO r FROM extensions.dblink('s4_b', format(
    'SELECT public.youtube_comment_op_claim(%L::uuid, %L::uuid, %L, %s, %L::uuid, %L, %L::jsonb, %L, %L::jsonb, %L, %L, %L::jsonb)',
    v_a, v_acct, 'UC-s4-race', v_gen, v_op, 'edit', '{"video_id":"vid-r17b","comment_id":"cmt-r17b"}',
    repeat('p', 64), '{}', 'write', 'r17b', pg_temp.s4_map(repeat('p', 64))::text)) AS t(res text);
  ASSERT (r ->> 'ok')::boolean, format('R17b claimed: %s', r);
  v_token := r ->> 'attempt_token';

  PERFORM extensions.dblink_exec('s4_b', 'BEGIN');
  PERFORM extensions.dblink_exec('s4_b',
    'UPDATE public.app_settings SET value = value WHERE key = ' || quote_literal('feature_youtube_comments'));
  PERFORM extensions.dblink_exec('s4_c',
    'DELETE FROM public.app_settings WHERE key = ' || quote_literal('youtube_comments_stage4_rollout'));

  SELECT pid INTO v_pid_a FROM extensions.dblink('s4_a', 'SELECT pg_backend_pid()') AS t(pid int);
  PERFORM extensions.dblink_send_query('s4_a', format(
    'SELECT public.youtube_comment_op_mark_dispatched(%L::uuid, %L::uuid, %L::uuid, %L, %s)',
    v_a, v_op, v_token, 'UC-s4-race', v_gen));
  PERFORM extensions.dblink_exec('s4_c', format(
    'DO $$ BEGIN
       FOR i IN 1..100 LOOP
         EXIT WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = %s AND wait_event_type = ' || quote_literal('Lock') || ');
         PERFORM pg_sleep(0.05);
       END LOOP;
       IF NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = %s AND wait_event_type = ' || quote_literal('Lock') || ') THEN
         RAISE EXCEPTION ''R17b the mark did not park on the tile row'';
       END IF;
     END $$;', v_pid_a, v_pid_a));

  PERFORM extensions.dblink_exec('s4_c', format(
    'INSERT INTO public.app_settings(key, value, description) VALUES (%L, %L::jsonb, %L)',
    'youtube_comments_stage4_rollout', v_policy::text, v_description));
  PERFORM extensions.dblink_exec('s4_b', 'COMMIT');

  SELECT res INTO r_a FROM extensions.dblink_get_result('s4_a') AS t(res text);
  PERFORM * FROM extensions.dblink_get_result('s4_a') AS t(res text);
  ASSERT NOT (r_a::jsonb ->> 'ok')::boolean AND r_a::jsonb ->> 'reason' = 'capability_denied',
    format('R17b a mark that could not lock both settings rows refuses: %s', r_a);
  ASSERT (SELECT state FROM public.youtube_comment_operations
           WHERE owner_id = v_a::uuid AND operation_id = v_op::uuid) = 'refused'
     AND (SELECT dispatched_at FROM public.youtube_comment_operations
           WHERE owner_id = v_a::uuid AND operation_id = v_op::uuid) IS NULL,
    'R17b the claim is closed as never sent';
END
$r17b$;

-- R17c. The two settings rows are always locked in one key order. A
-- transaction that updates them in the OPPOSITE order can deadlock with a mark;
-- the database aborts one side. Whichever side loses, a mark that did not
-- complete sends nothing (its claim stays claimed), and a mark that completed
-- did so against a policy that still allowed it.
DO $r17c$
DECLARE
  v_a text := '6e9a0001-0000-4000-8000-000000000001';
  v_acct text := '6e9b0001-0000-4000-8000-000000000001';
  v_op text := '00000000-0000-4000-8000-00000000c505';
  v_gen bigint;
  r jsonb;
  r_a text;
  v_token text;
  v_pid_a int;
  v_b_aborted boolean := false;
  v_a_aborted boolean := false;
  v_state text;
BEGIN
  SELECT binding_generation INTO v_gen FROM public.social_accounts WHERE id = v_acct::uuid;
  SELECT res::jsonb INTO r FROM extensions.dblink('s4_c', format(
    'SELECT public.youtube_comment_op_claim(%L::uuid, %L::uuid, %L, %s, %L::uuid, %L, %L::jsonb, %L, %L::jsonb, %L, %L, %L::jsonb)',
    v_a, v_acct, 'UC-s4-race', v_gen, v_op, 'edit', '{"video_id":"vid-r17c","comment_id":"cmt-r17c"}',
    repeat('q', 64), '{}', 'write', 'r17c', pg_temp.s4_map(repeat('q', 64))::text)) AS t(res text);
  ASSERT (r ->> 'ok')::boolean, format('R17c claimed: %s', r);
  v_token := r ->> 'attempt_token';

  -- B holds the ROLLOUT row first (the key order a mark takes it second).
  PERFORM extensions.dblink_exec('s4_b', 'BEGIN');
  PERFORM extensions.dblink_exec('s4_b',
    'UPDATE public.app_settings SET value = value WHERE key = ' || quote_literal('youtube_comments_stage4_rollout'));

  SELECT pid INTO v_pid_a FROM extensions.dblink('s4_a', 'SELECT pg_backend_pid()') AS t(pid int);
  PERFORM extensions.dblink_send_query('s4_a', format(
    'SELECT public.youtube_comment_op_mark_dispatched(%L::uuid, %L::uuid, %L::uuid, %L, %s)',
    v_a, v_op, v_token, 'UC-s4-race', v_gen));
  PERFORM extensions.dblink_exec('s4_c', format(
    'DO $$ BEGIN
       FOR i IN 1..100 LOOP
         EXIT WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = %s AND wait_event_type = ' || quote_literal('Lock') || ');
         PERFORM pg_sleep(0.05);
       END LOOP;
     END $$;', v_pid_a));

  -- B now reaches for the TILE row, which the parked mark already holds: a deadlock.
  BEGIN
    PERFORM extensions.dblink_exec('s4_b',
      'UPDATE public.app_settings SET value = value WHERE key = ' || quote_literal('feature_youtube_comments'));
  EXCEPTION WHEN OTHERS THEN
    v_b_aborted := SQLERRM LIKE '%deadlock detected%';
    IF NOT v_b_aborted THEN RAISE; END IF;
  END;

  IF v_b_aborted THEN
    PERFORM extensions.dblink_exec('s4_b', 'ROLLBACK');
  ELSE
    PERFORM extensions.dblink_exec('s4_b', 'COMMIT');
  END IF;

  BEGIN
    SELECT res INTO r_a FROM extensions.dblink_get_result('s4_a') AS t(res text);
    PERFORM * FROM extensions.dblink_get_result('s4_a') AS t(res text);
  EXCEPTION WHEN OTHERS THEN
    v_a_aborted := SQLERRM LIKE '%deadlock detected%';
    IF NOT v_a_aborted THEN RAISE; END IF;
  END;

  SELECT state INTO v_state FROM public.youtube_comment_operations
   WHERE owner_id = v_a::uuid AND operation_id = v_op::uuid;
  ASSERT v_b_aborted OR v_a_aborted, 'R17c the opposite-order update deadlocked and the database aborted one side';
  IF v_a_aborted THEN
    ASSERT v_state = 'claimed', format('R17c an aborted mark sends nothing: the claim stays claimed (%s)', v_state);
  ELSE
    ASSERT (r_a::jsonb ->> 'ok')::boolean AND v_state = 'dispatched',
      format('R17c a mark that completed was authorised by a policy that still allowed it: %s / %s', r_a, v_state);
  END IF;
END
$r17c$;

SELECT extensions.dblink_disconnect('s4_c');
-- Back to fresh connections for whatever follows.
SELECT extensions.dblink_disconnect('s4_a');
SELECT extensions.dblink_disconnect('s4_b');
SELECT extensions.dblink_connect(
  's4_a', format('dbname=%s user=%s application_name=s4_race_a', current_database(), current_user));
SELECT extensions.dblink_connect(
  's4_b', format('dbname=%s user=%s application_name=s4_race_b', current_database(), current_user));

SELECT extensions.dblink_disconnect('s4_a');
SELECT extensions.dblink_disconnect('s4_b');

-- ---------------------------------------------------------------------------
-- S13 (committed part). Durability: nothing else touches these tables.
-- ---------------------------------------------------------------------------
DO $s13$
DECLARE
  v_offenders text[];
BEGIN
  -- no scheduled job references the tables (pg_cron may be absent on a
  -- stripped local server; CI and the documented run always have it)
  IF to_regclass('cron.job') IS NOT NULL THEN
    ASSERT NOT EXISTS (
      SELECT 1 FROM cron.job
       WHERE command ILIKE '%youtube_comment_operations%'
          OR command ILIKE '%youtube_comment_digest_keys%'
    ), 'S13 no cron job references the Stage 4 tables';
  END IF;

  -- no function body outside the Stage 4 set references the receipt table
  SELECT array_agg(p.oid::regprocedure::text) INTO v_offenders
    FROM pg_proc p
   WHERE p.prosrc ILIKE '%youtube_comment_operations%'
     AND p.pronamespace = 'public'::regnamespace
     AND p.proname NOT IN (
       'youtube_comment_op_claim', 'youtube_comment_op_mark_dispatched',
       'youtube_comment_op_settle', 'youtube_comment_op_status',
       'youtube_stage4_guard_digest_keys');
  ASSERT v_offenders IS NULL, format('S13 unexpected writers of the receipt table: %s', v_offenders);

  -- the only trigger on the digest keys is the guard
  ASSERT (SELECT array_agg(t.tgname::text ORDER BY t.tgname) FROM pg_trigger t
           WHERE t.tgrelid = 'public.youtube_comment_digest_keys'::regclass AND NOT t.tgisinternal)
      = ARRAY['trg_youtube_comment_digest_keys_guard'],
    'S13 the digest keys carry only the guard trigger';

  -- the receipt table carries no trigger at all
  ASSERT NOT EXISTS (SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid = 'public.youtube_comment_operations'::regclass AND NOT t.tgisinternal),
    'S13 the receipt table carries no trigger';
END
$s13$;

-- Cleanup of the committed race fixtures.
DELETE FROM public.youtube_comment_operations
 WHERE owner_id = '6e9a0001-0000-4000-8000-000000000001';
DELETE FROM public.social_accounts
 WHERE id = '6e9b0001-0000-4000-8000-000000000001';
DELETE FROM public.connector_connections
 WHERE id = '6e8c0004-0000-4000-8000-000000000004';
DELETE FROM public.workspaces
 WHERE id = '6e9d0001-0000-4000-8000-000000000001';
DELETE FROM public.app_settings
 WHERE key IN ('feature_youtube_comments', 'youtube_comments_stage4_rollout')
   AND description LIKE 'Stage 4 suite%';
DELETE FROM auth.users
 WHERE id = '6e9a0001-0000-4000-8000-000000000001';

\echo '=== youtube_comment_operations: ALL CHECKS PASSED ==='
