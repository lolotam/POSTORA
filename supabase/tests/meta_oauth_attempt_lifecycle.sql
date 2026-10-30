-- supabase/tests/meta_oauth_attempt_lifecycle.sql
-- Captured Meta OAuth attempts and transactional selection commits
-- (migration 20261027110000).
--
-- One transaction, synthetic fixtures, ROLLBACK. No provider calls and no
-- real tokens. Every token in this file is the literal string
-- 'synthetic-not-a-live-secret' or one of its labelled variants.
--
-- The denials are asserted as SQLSTATE 42501 (insufficient_privilege) or as
-- the stable MOA* codes, never as "zero rows returned". An RLS filter and a
-- revoked grant are different protections, and a query that returned no rows
-- would still have been a query the browser was allowed to make.
--
-- No assertion here is skipped, broadened or conditional. Every one of them
-- fails the suite.
--
-- The multi-session concurrency controls are NOT here. They live in
-- supabase/tests/meta_oauth_attempt_lifecycle_race_fixture.sql, which is a
-- manual two-session rehearsal and is deliberately not run by the ordinary
-- rollback suite.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- The rollout fixture.
--
-- R1 (20261030150000_instagram_collection_rollout_controls.sql) made the
-- rollout admission a default-off gate. This suite exercises the fenced
-- collection writes, not the rollout, so it installs an explicit synthetic
-- policy that admits every otherwise eligible target. The transaction rolls
-- back, so nothing survives the suite.
-- ---------------------------------------------------------------------------
INSERT INTO public.app_settings (key, value, description)
VALUES
  ('collection_instagram_insights_enabled', 'true'::jsonb,
   'Synthetic harness master switch.'),
  ('collection_instagram_rollout_policy',
   '{"version":1,"owners":{"mode":"all","account_ids":[]},"competitors":{"mode":"all","targets":[]}}'::jsonb,
   'Synthetic harness rollout policy: every otherwise eligible target.')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ---------------------------------------------------------------------------
-- Fixtures.
--
--   moa_owner  Alice. Owns one profile, one bound account, one sibling on
--              the same shared grant, one inactive account, and one account
--              that carries a username another identity must not adopt.
--   moa_other  Bob. Everything of his is foreign to Alice.
--
-- The shared grant moa_cred_1 already exists with two bound accounts, so
-- the "complete required shared membership" capture has something to
-- capture.
-- ---------------------------------------------------------------------------
DO $fixtures$
DECLARE
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  u_other uuid := '0ea00002-0000-4000-8000-000000000002';
  c_cred  uuid := '0ea90001-0000-4000-8000-000000000001';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (u_owner, 'moa-owner-' || u_owner::text || '@example.invalid'),
    (u_other, 'moa-other-' || u_other::text || '@example.invalid');

  INSERT INTO public.social_profiles (id, user_id, name)
  VALUES
    ('0ea10001-0000-4000-8000-000000000011', u_owner, 'MOA Owner Profile'),
    ('0ea10002-0000-4000-8000-000000000012', u_other, 'MOA Other Profile');

  -- The shared Facebook User credential. Two accounts are bound to it, so
  -- the grant has a real membership.
  INSERT INTO public.facebook_user_credentials (
    id, user_id, token, revision, lifecycle, provider_user_id,
    provenance_source, provenance_captured_at
  ) VALUES (
    c_cred, u_owner, 'synthetic-not-a-live-secret', 3, 'active',
    'moa-fb-user-1', 'oauth_exchange', '2026-10-27 08:00:00+00'::timestamptz
  );

  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, platform_username, access_token,
    is_active, social_profile_id, account_metadata, ig_auth_type
  ) VALUES
    -- bound, page-linked, on the shared grant
    ('0ea20001-0000-4000-8000-000000000021', u_owner, 'instagram',
     'moa-ig-a2', 'moa_a2', 'synthetic-not-a-live-secret', true,
     '0ea10001-0000-4000-8000-000000000011',
     '{"legacy":"kept"}'::jsonb, 'facebook_page'),
    -- the sibling on the same grant
    ('0ea20001-0000-4000-8000-000000000022', u_owner, 'instagram',
     'moa-ig-a3', 'moa_a3', 'synthetic-not-a-live-secret', true, NULL,
     NULL, 'facebook_page'),
    -- inactive, never bound, page-linked classification
    ('0ea20001-0000-4000-8000-000000000023', u_owner, 'instagram',
     'moa-ig-a1', 'moa_a1', 'synthetic-not-a-live-secret', false, NULL,
     NULL, 'facebook_page'),
    -- a username another identity must not adopt
    ('0ea20001-0000-4000-8000-000000000024', u_owner, 'instagram',
     'moa-ig-a4', 'moa_shared_handle', 'synthetic-not-a-live-secret', true,
     NULL, NULL, 'facebook_page'),
    -- a foreign owner's account
    ('0ea20002-0000-4000-8000-000000000025', u_other, 'instagram',
     'moa-ig-b1', 'moa_b1', 'synthetic-not-a-live-secret', true, NULL,
     NULL, 'facebook_page');

  INSERT INTO public.facebook_user_credential_bindings (
    social_account_id, user_id, platform, credential_id,
    verified_facebook_user_id, verified_facebook_page_id,
    verified_instagram_user_id, evidence_source, connection_version
  ) VALUES
    ('0ea20001-0000-4000-8000-000000000021', u_owner, 'instagram', c_cred,
     'moa-fb-user-1', 'moa-page-a2', 'moa-ig-a2', 'oauth_exchange', 5),
    ('0ea20001-0000-4000-8000-000000000022', u_owner, 'instagram', c_cred,
     'moa-fb-user-1', 'moa-page-a3', 'moa-ig-a3', 'oauth_exchange', 2);

  INSERT INTO public.facebook_user_credential_connection_fences (
    social_account_id, user_id, platform, connection_version
  ) VALUES
    ('0ea20001-0000-4000-8000-000000000021', u_owner, 'instagram', 5),
    ('0ea20001-0000-4000-8000-000000000022', u_owner, 'instagram', 2);

  INSERT INTO public.instagram_account_capabilities (
    social_account_id, user_id, platform, login_kind, permission_read_state,
    granted_scopes, scopes_read_at, credential_generation,
    credential_updated_at, generation_reason
  ) VALUES
    ('0ea20001-0000-4000-8000-000000000021', u_owner, 'instagram',
     'page_linked', 'ok', ARRAY['instagram_basic'],
     '2026-10-27 08:10:00+00'::timestamptz, 4,
     '2026-10-27 08:00:00+00'::timestamptz, 'credential_bound'),
    ('0ea20001-0000-4000-8000-000000000022', u_owner, 'instagram',
     'page_linked', 'unknown', ARRAY[]::TEXT[], NULL, 2,
     '2026-10-27 08:00:00+00'::timestamptz, 'credential_bound'),
    ('0ea20001-0000-4000-8000-000000000023', u_owner, 'instagram',
     'page_linked', 'unknown', ARRAY[]::TEXT[], NULL, 1,
     '2026-10-27 08:00:00+00'::timestamptz, 'credential_bound');

  INSERT INTO public.instagram_account_credentials (
    social_account_id, user_id, platform, credential_id
  ) VALUES
    ('0ea20001-0000-4000-8000-000000000021', u_owner, 'instagram', c_cred),
    ('0ea20001-0000-4000-8000-000000000022', u_owner, 'instagram', c_cred);

  -- A legacy pending stash row: no attempt reference at all. The legacy
  -- picker must keep working on it exactly as before.
  INSERT INTO public.oauth_pending_instagram_selections (
    id, user_id, social_profile_id, ig_candidates_json, long_lived_token,
    expires_in, created_at, expires_at
  ) VALUES (
    '0ea30001-0000-4000-8000-000000000031', u_owner,
    '0ea10001-0000-4000-8000-000000000011',
    '[{"ig_user_id":"moa-ig-legacy","ig_username":"moa_legacy","ig_profile_picture_url":null,"facebook_page_id":"moa-page-legacy","facebook_page_name":"MOA Legacy Page","page_access_token":"synthetic-not-a-live-secret","facebook_user_id":"moa-fb-user-legacy"}]'::jsonb,
    'synthetic-not-a-live-secret', 5184000,
    '2026-10-27 09:00:00+00'::timestamptz,
    '2026-10-27 09:15:00+00'::timestamptz
  );
END
$fixtures$;

-- The statement catalogue is read by the denial blocks below under a
-- restricted role, so it lives in a temp table.
CREATE TEMP TABLE moa_denied_statements (ord integer PRIMARY KEY, stmt text NOT NULL);
INSERT INTO moa_denied_statements (ord, stmt) VALUES
  (1,  'SELECT 1 FROM public.meta_oauth_attempts LIMIT 1'),
  (2,  'SELECT 1 FROM public.meta_oauth_attempt_receipts LIMIT 1'),
  (3,  'INSERT INTO public.meta_oauth_attempts (user_id, flow, intent, capture_version, captured_at, capture, nonce_digest, callback_deadline, picker_deadline) VALUES (''0ea00002-0000-4000-8000-000000000002'', ''instagram_direct'', ''connect_new'', 1, now(), ''{}''::jsonb, repeat(''a'',64), now(), now())'),
  (4,  'UPDATE public.meta_oauth_attempts SET capture = ''{}''::jsonb'),
  (5,  'DELETE FROM public.meta_oauth_attempts'),
  (6,  'INSERT INTO public.meta_oauth_attempt_receipts (attempt_id, user_id, selection_key, platform, platform_user_id, receipt) VALUES (gen_random_uuid(), ''0ea00002-0000-4000-8000-000000000002'', ''k'', ''instagram'', ''x'', ''{}''::jsonb)'),
  (7,  'UPDATE public.meta_oauth_attempt_receipts SET selection_key = ''z'''),
  (8,  'DELETE FROM public.meta_oauth_attempt_receipts'),
  (9,  'TRUNCATE public.meta_oauth_attempts'),
  (10, 'TRUNCATE public.meta_oauth_attempt_receipts'),
  (11, 'SELECT public.begin_meta_oauth_attempt(''0ea00001-0000-4000-8000-000000000001'', ''{}''::jsonb)'),
  (12, 'SELECT public.claim_meta_oauth_callback(''0ea00001-0000-4000-8000-000000000001'', ''{}''::jsonb)'),
  (13, 'SELECT public.complete_meta_oauth_callback(''0ea00001-0000-4000-8000-000000000001'', ''{}''::jsonb)'),
  (14, 'SELECT public.commit_meta_oauth_selection(''0ea00001-0000-4000-8000-000000000001'', ''{}''::jsonb)'),
  (15, 'SELECT public.read_meta_oauth_attempt(''0ea00001-0000-4000-8000-000000000001'', gen_random_uuid())'),
  (16, 'SELECT public.meta_oauth_attempt_digest(''x'')'),
  (17, 'SELECT public.meta_oauth_attempt_capture_account(''0ea00001-0000-4000-8000-000000000001'', gen_random_uuid())'),
  (18, 'SELECT public.meta_oauth_attempt_random_hex()'),
  (19, 'SELECT public.purge_expired_meta_oauth_pending(1)'),
  (20, 'SELECT public.meta_oauth_attempt_lock_owner(''0ea00001-0000-4000-8000-000000000001'')'),
  (21, 'SELECT public.meta_oauth_attempt_require_members(''0ea00001-0000-4000-8000-000000000001'', gen_random_uuid(), 1, ''x'', ''[]''::jsonb)'),
  (22, 'SELECT public.meta_oauth_attempt_invalidate_grant(''0ea00001-0000-4000-8000-000000000001'', gen_random_uuid(), ''[]''::jsonb, ARRAY[]::uuid[])'),
  (23, 'SELECT public.meta_oauth_attempt_lock_accounts(''0ea00001-0000-4000-8000-000000000001'', ARRAY[]::uuid[], ARRAY[]::uuid[])'),
  (24, 'SELECT public.meta_oauth_attempt_require_captured_account(''0ea00001-0000-4000-8000-000000000001'', ''{}''::jsonb)'),
  (25, 'SELECT public.meta_oauth_attempt_assert_live_expiries(''0ea00001-0000-4000-8000-000000000001'', NULL, NULL, NULL, NULL)');
GRANT SELECT ON moa_denied_statements TO authenticated, anon;

-- ---------------------------------------------------------------------------
-- S1. The catalog boundary: service-only tables, no policy, no browser
--     privilege, and the appended nullable attempt reference.
-- ---------------------------------------------------------------------------
DO $s1$
DECLARE
  t_name text;
  p_name text;
  shape text;
BEGIN
  FOREACH t_name IN ARRAY ARRAY[
    'meta_oauth_attempts',
    'meta_oauth_attempt_receipts'
  ] LOOP
    ASSERT (
      SELECT c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t_name
    ), format('S1 RLS is enabled on public.%s', t_name);

    ASSERT NOT EXISTS (
      SELECT 1
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t_name
    ), format('S1 no policy exists on public.%s', t_name);

    FOREACH p_name IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES',
      'TRIGGER', 'MAINTAIN'
    ] LOOP
      ASSERT NOT has_table_privilege('anon', format('public.%s', t_name), p_name),
        format('S1 anon holds no %s privilege on public.%s', p_name, t_name);
      ASSERT NOT has_table_privilege('authenticated', format('public.%s', t_name), p_name),
        format('S1 authenticated holds no %s privilege on public.%s', p_name, t_name);
      ASSERT NOT has_table_privilege('dashboard_user', format('public.%s', t_name), p_name),
        format('S1 PUBLIC grants no %s privilege on public.%s', p_name, t_name);
    END LOOP;

    FOREACH p_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      ASSERT has_table_privilege('service_role', format('public.%s', t_name), p_name),
        format('S1 service_role keeps %s on public.%s', p_name, t_name);
    END LOOP;
  END LOOP;

  -- The appended attempt reference is nullable, has no default, and is the
  -- LAST column of each pending table.
  FOREACH t_name IN ARRAY ARRAY[
    'oauth_pending_facebook_selections',
    'oauth_pending_instagram_selections'
  ] LOOP
    SELECT string_agg(
             column_name || ':' || data_type || ':' || is_nullable || ':' ||
             (column_default IS NOT NULL)::text,
             ',' ORDER BY ordinal_position)
      INTO shape
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = t_name;
    ASSERT shape LIKE '%meta_oauth_attempt_id:uuid:YES:false',
      format('S1 public.%s carries the nullable, default-less attempt reference (got %s)', t_name, shape);
    ASSERT shape LIKE '%meta_oauth_attempt_id:uuid:YES:false',
      format('S1 public.%s attempt reference is appended last (got %s)', t_name, shape);

    -- The attempt reference is an OWNER-MATCHING composite foreign key:
    -- (meta_oauth_attempt_id, user_id) -> meta_oauth_attempts (id, user_id).
    ASSERT EXISTS (
      SELECT 1
        FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
        JOIN pg_class fr ON fr.oid = c.confrelid
        JOIN pg_namespace fn ON fn.oid = fr.relnamespace
       WHERE n.nspname = 'public'
         AND r.relname = t_name
         AND c.contype = 'f'
         AND fn.nspname = 'public'
         AND fr.relname = 'meta_oauth_attempts'
         AND c.conkey = ARRAY[
           (SELECT attnum FROM pg_attribute a
             JOIN pg_class cc ON cc.oid = a.attrelid
             JOIN pg_namespace nn ON nn.oid = cc.relnamespace
            WHERE nn.nspname = 'public' AND cc.relname = t_name
              AND a.attname = 'meta_oauth_attempt_id'),
           (SELECT attnum FROM pg_attribute a
             JOIN pg_class cc ON cc.oid = a.attrelid
             JOIN pg_namespace nn ON nn.oid = cc.relnamespace
            WHERE nn.nspname = 'public' AND cc.relname = t_name
              AND a.attname = 'user_id')
         ]::smallint[]
         AND c.confkey = ARRAY[
           (SELECT attnum FROM pg_attribute a
             JOIN pg_class cc ON cc.oid = a.attrelid
             JOIN pg_namespace nn ON nn.oid = cc.relnamespace
            WHERE nn.nspname = 'public' AND cc.relname = 'meta_oauth_attempts'
              AND a.attname = 'id'),
           (SELECT attnum FROM pg_attribute a
             JOIN pg_class cc ON cc.oid = a.attrelid
             JOIN pg_namespace nn ON nn.oid = cc.relnamespace
            WHERE nn.nspname = 'public' AND cc.relname = 'meta_oauth_attempts'
              AND a.attname = 'user_id')
         ]::smallint[]
    ), format('S1 public.%s carries the owner-matching attempt foreign key', t_name);
  END LOOP;

  -- The attempt columns are exactly the whitelisted, nonsecret shape.
  SELECT string_agg(
           column_name || ':' || data_type || ':' || is_nullable,
           ',' ORDER BY ordinal_position)
    INTO shape
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'meta_oauth_attempts';
  ASSERT shape = 'id:uuid:NO,user_id:uuid:NO,flow:text:NO,intent:text:NO,target_social_account_id:uuid:YES,source_social_account_id:uuid:YES,intended_social_profile_id:uuid:YES,capture_version:integer:NO,captured_at:timestamp with time zone:NO,capture:jsonb:NO,nonce_digest:text:NO,status:text:NO,claim_token:text:YES,claimed_at:timestamp with time zone:YES,pending_selection_id:uuid:YES,authority_progression:jsonb:NO,callback_deadline:timestamp with time zone:NO,picker_deadline:timestamp with time zone:NO,created_at:timestamp with time zone:NO,updated_at:timestamp with time zone:NO,linked_target_social_account_id:uuid:YES',
    format('S1 the attempt table shape is the declared one (got %s)', shape);
END
$s1$;

-- ---------------------------------------------------------------------------
-- S2. begin_meta_oauth_attempt: the capture happens BEFORE authorization,
--     the nonce is returned once and stored only as a digest, and the
--     deadlines are server-controlled and bounded.
-- ---------------------------------------------------------------------------
DO $s2$
DECLARE
  shape text;
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_digest TEXT;
  v_row JSONB;
  v_status TEXT;
  v_capture_version INTEGER;
  v_capture JSONB;
  v_msg TEXT;
BEGIN
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked',
    'intent', 'connect_new'
  ));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_digest := v_result ->> 'nonce_digest';

  ASSERT v_attempt IS NOT NULL, 'S2 begin returns an attempt id';
  ASSERT char_length(v_nonce) = 64 AND v_nonce ~ '^[0-9a-f]{64}$',
    'S2 begin returns a 256 bit nonce exactly once';
  ASSERT v_digest = public.meta_oauth_attempt_digest(v_nonce),
    'S2 the returned digest is the digest of the returned nonce';
  ASSERT v_result -> 'state' ->> 'attempt_id' = v_attempt::TEXT,
    'S2 the state material carries the attempt id';
  ASSERT v_result -> 'state' ->> 'nonce' = v_nonce,
    'S2 the state material carries the nonce';
  ASSERT v_result -> 'state' ->> 'flow' = 'instagram_page_linked',
    'S2 the state material carries the flow';
  -- The signed state carries no token and no version.
  ASSERT v_result -> 'state' ? 'token' IS FALSE,
    'S2 the state material carries no token';
  ASSERT v_result -> 'state' ? 'capture' IS FALSE,
    'S2 the state material carries no authority version';

  -- The deadlines are bounded, server-controlled and in the right order.
  ASSERT (v_result ->> 'callback_deadline')::TIMESTAMPTZ
       > (v_result ->> 'captured_at')::TIMESTAMPTZ,
    'S2 the callback deadline is after the capture';
  ASSERT (v_result ->> 'callback_deadline')::TIMESTAMPTZ
       <= (v_result ->> 'captured_at')::TIMESTAMPTZ + interval '10 minutes 1 second',
    'S2 the callback deadline is bounded to ten minutes';
  ASSERT (v_result ->> 'picker_deadline')::TIMESTAMPTZ
       <= (v_result ->> 'captured_at')::TIMESTAMPTZ + interval '15 minutes 1 second',
    'S2 the picker deadline is bounded to fifteen minutes';

  -- A create-only attempt captures no account and no grant.
  v_capture := v_result -> 'capture';
  ASSERT NOT (v_capture ? 'target'),
    'S2 a connect_new attempt captures no target';
  ASSERT NOT (v_capture ? 'source'),
    'S2 a connect_new attempt captures no source';
  ASSERT NOT (v_capture ? 'grant'),
    'S2 a connect_new attempt captures no grant';
  ASSERT (v_capture ->> 'capture_version')::INTEGER = 1,
    'S2 the capture carries its version';

  -- The stored row holds the DIGEST, never the raw nonce, and no secret.
  SELECT a.nonce_digest, a.capture, a.status, a.capture_version
    INTO v_digest, v_capture, v_status, v_capture_version
    FROM public.meta_oauth_attempts AS a
   WHERE a.id = v_attempt;
  ASSERT v_digest <> v_nonce,
    'S2 the raw nonce is not stored in the attempt row';
  ASSERT v_capture::TEXT NOT LIKE '%' || v_nonce || '%',
    'S2 the raw nonce does not appear anywhere in the capture';
  ASSERT v_capture::TEXT NOT LIKE '%synthetic-not-a-live-secret%',
    'S2 the capture holds no token';
  ASSERT v_status = 'authorized',
    'S2 a fresh attempt is authorized';
  ASSERT v_capture_version = 1, 'S2 the capture records its version';

  -- The capture is immutable.
  BEGIN
    UPDATE public.meta_oauth_attempts
       SET capture = jsonb_build_object('capture_version', 1)
     WHERE id = v_attempt;
    RAISE EXCEPTION 'S2 failed: the capture was rewritten'
      USING ERRCODE = 'assert_failure';
  EXCEPTION
    WHEN SQLSTATE 'MOA04' THEN NULL;
  END;

  -- The progression is attempt-local: only the attempt itself may advance
  -- it.
  BEGIN
    UPDATE public.meta_oauth_attempts
       SET authority_progression = jsonb_build_object('credential_id', gen_random_uuid())
     WHERE id = v_attempt;
    RAISE EXCEPTION 'S2 failed: the authority progression was advanced from outside the attempt'
      USING ERRCODE = 'assert_failure';
  EXCEPTION
    WHEN SQLSTATE 'MOA04' THEN NULL;
  END;

  -- A reconnect attempt captures the target AND the complete shared grant.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked',
    'intent', 'reconnect',
    'target_social_account_id', '0ea20001-0000-4000-8000-000000000021'
  ));
  v_capture := v_result -> 'capture';
  ASSERT (v_capture -> 'target' ->> 'social_account_id')
       = '0ea20001-0000-4000-8000-000000000021',
    'S2 a reconnect attempt captures its explicit owned target';
  ASSERT (v_capture -> 'target' ->> 'binding_present')::BOOLEAN IS TRUE,
    'S2 the capture records the binding presence';
  ASSERT (v_capture -> 'target' ->> 'fence_state') = 'present',
    'S2 the capture records the surviving fence state';
  ASSERT (v_capture -> 'target' ->> 'fence_connection_version')::BIGINT = 5,
    'S2 the capture records the surviving fence high-water mark';
  ASSERT (v_capture -> 'target' ->> 'credential_revision')::BIGINT = 3,
    'S2 the capture records the credential revision';
  ASSERT (v_capture -> 'target' ->> 'capability_generation')::BIGINT = 4,
    'S2 the capture records the capability generation';
  ASSERT (v_capture -> 'target' ->> 'capability_login_kind') = 'page_linked',
    'S2 the capture records the capability classification';
  ASSERT (v_capture -> 'grant' ->> 'credential_id')
       = '0ea90001-0000-4000-8000-000000000001',
    'S2 the capture records the shared grant credential';
  ASSERT jsonb_array_length(v_capture -> 'grant' -> 'members') = 2,
    'S2 the capture records the COMPLETE shared grant membership';
  ASSERT (v_capture -> 'grant' ->> 'provider_user_id') = 'moa-fb-user-1',
    'S2 the capture records the grant identity';

  -- A never-created fence is an explicit sentinel, not a fence at zero.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked',
    'intent', 'reconnect',
    'target_social_account_id', '0ea20001-0000-4000-8000-000000000023'
  ));
  v_capture := v_result -> 'capture';
  ASSERT (v_capture -> 'target' ->> 'binding_present')::BOOLEAN IS FALSE,
    'S2 the capture records the absent binding';
  ASSERT (v_capture -> 'target' ->> 'fence_state') = 'never_created',
    'S2 a never-created fence is an explicit sentinel';
  ASSERT (v_capture -> 'target' ->> 'fence_connection_version')::BIGINT = 0,
    'S2 the never-created fence sentinel is zero';

  -- An unbound source has no grant to extend.
  BEGIN
    PERFORM public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
      'flow', 'instagram_page_linked',
      'intent', 'add_to_existing_grant',
      'source_social_account_id', '0ea20001-0000-4000-8000-000000000023'
    ));
    RAISE EXCEPTION 'S2 failed: an unbound source was accepted as a grant'
      USING ERRCODE = 'assert_failure';
  EXCEPTION
    WHEN SQLSTATE 'MOA02' THEN NULL;
  END;
END
$s2$;

-- ---------------------------------------------------------------------------
-- S3. claim_meta_oauth_callback: exactly one claim, the exact nonce, the
--     exact flow, and never a refreshed capture.
-- ---------------------------------------------------------------------------
DO $s3$
DECLARE
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_claim TEXT;
  v_capture_before JSONB;
  v_capture_after JSONB;
BEGIN
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_capture_before := v_result -> 'capture';

  -- A wrong nonce never reaches the claim.
  BEGIN
    PERFORM public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
      'attempt_id', v_attempt, 'nonce', repeat('b', 64),
      'flow', 'instagram_page_linked'));
    RAISE EXCEPTION 'S3 failed: a wrong nonce was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA03' THEN NULL;
  END;

  -- A wrong flow never reaches the claim.
  BEGIN
    PERFORM public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
      'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_direct'));
    RAISE EXCEPTION 'S3 failed: a wrong flow was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA03' THEN NULL;
  END;

  -- The correct claim.
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  v_claim := v_result ->> 'claim_token';
  ASSERT char_length(v_claim) = 64, 'S3 the claim hands out a claim token';
  ASSERT v_result -> 'capture' = v_capture_before,
    'S3 the claim never refreshes the original capture';

  -- A duplicate callback cannot reach a second exchange.
  BEGIN
    PERFORM public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
      'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
    RAISE EXCEPTION 'S3 failed: a duplicate callback was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA03' THEN NULL;
  END;

  -- A foreign owner cannot claim somebody else's attempt.
  BEGIN
    PERFORM public.claim_meta_oauth_callback('0ea00002-0000-4000-8000-000000000002',
      jsonb_build_object('attempt_id', v_attempt, 'nonce', v_nonce,
                         'flow', 'instagram_page_linked'));
    RAISE EXCEPTION 'S3 failed: a foreign owner claimed the attempt'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA02' THEN NULL;
  END;

  -- A malformed attempt id is a malformed payload.
  BEGIN
    PERFORM public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
      'attempt_id', 'not-a-uuid', 'nonce', v_nonce,
      'flow', 'instagram_page_linked'));
    RAISE EXCEPTION 'S3 failed: a malformed attempt id was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA01' THEN NULL;
  END;
END
$s3$;

-- ---------------------------------------------------------------------------
-- S4. complete_meta_oauth_callback: the exact claim, a whitelisted stash,
--     the stash persisted ONCE, and no secret in the attempt row.
-- ---------------------------------------------------------------------------
DO $s4$
DECLARE
  shape text;
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_claim TEXT;
  v_pending UUID;
  v_row JSONB;
  v_attempt_ref UUID;
  v_stash_token TEXT;
  v_stash JSONB;
BEGIN
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  v_claim := v_result ->> 'claim_token';

  v_stash := jsonb_build_object(
    'candidates', jsonb_build_array(jsonb_build_object(
      'ig_user_id', 'moa-ig-new-1',
      'ig_username', 'moa_new_one',
      'ig_profile_picture_url', 'https://example.invalid/moa1.png',
      'facebook_page_id', 'moa-page-new-1',
      'facebook_page_name', 'MOA New Page One',
      'page_access_token', 'synthetic-not-a-live-secret',
      'facebook_user_id', 'moa-fb-user-new'
    )),
    'user_token', 'synthetic-not-a-live-secret',
    'expires_in', 5184000
  );

  -- A wrong claim token never reaches the stash.
  BEGIN
    PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
      'attempt_id', v_attempt, 'claim_token', repeat('c', 64), 'stash', v_stash));
    RAISE EXCEPTION 'S4 failed: a wrong claim token was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA03' THEN NULL;
  END;

  -- An unknown stash key is refused.
  BEGIN
    PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
      'attempt_id', v_attempt, 'claim_token', v_claim,
      'stash', v_stash || jsonb_build_object('raw_provider_response', '{}'::jsonb)));
    RAISE EXCEPTION 'S4 failed: an unknown stash key was stored'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA01' THEN NULL;
  END;

  -- An unknown candidate field is refused.
  BEGIN
    PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
      'attempt_id', v_attempt, 'claim_token', v_claim,
      'stash', jsonb_build_object(
        'candidates', jsonb_build_array(jsonb_build_object(
          'ig_user_id', 'moa-ig-x', 'authorization_code', 'synthetic-not-a-live-secret')),
        'user_token', 'synthetic-not-a-live-secret')));
    RAISE EXCEPTION 'S4 failed: an unknown candidate field was stored'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA01' THEN NULL;
  END;

  -- A page-linked candidate without a page token is refused.
  BEGIN
    PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
      'attempt_id', v_attempt, 'claim_token', v_claim,
      'stash', jsonb_build_object(
        'candidates', jsonb_build_array(jsonb_build_object(
          'ig_user_id', 'moa-ig-x', 'facebook_page_id', 'moa-page-x',
          'facebook_user_id', 'moa-fb-x')),
        'user_token', 'synthetic-not-a-live-secret')));
    RAISE EXCEPTION 'S4 failed: a page-linked candidate without a page token was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA01' THEN NULL;
  END;

  -- The accepted completion.
  v_result := public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim, 'stash', v_stash));
  v_pending := (v_result ->> 'pending_selection_id')::UUID;
  ASSERT v_pending IS NOT NULL, 'S4 the completion returns the stash row';
  ASSERT (v_result -> 'candidates' -> 0 ->> 'selection_key')
       = 'instagram_page_linked:ig:moa-ig-new-1',
    'S4 the candidate carries its stable selection key';
  ASSERT (v_result -> 'candidates' -> 0 ->> 'page_access_token') IS NULL,
    'S4 the returned candidate list carries no page token';
  ASSERT v_result::TEXT NOT LIKE '%synthetic-not-a-live-secret%',
    'S4 the completion result carries no token';

  -- The stash really was written, and the attempt owns it.
  SELECT ps.meta_oauth_attempt_id, jsonb_array_length(ps.ig_candidates_json),
         ps.long_lived_token
    INTO v_attempt_ref, shape, v_stash_token
    FROM public.oauth_pending_instagram_selections AS ps
   WHERE ps.id = v_pending;
  ASSERT v_attempt_ref = v_attempt, 'S4 the stash row carries the attempt reference';
  ASSERT shape = '1', 'S4 the stash holds the candidate';
  ASSERT v_stash_token = 'synthetic-not-a-live-secret',
    'S4 the stash holds the grant token in the existing secret column';

  -- A replay cannot overwrite or replace the stash.
  BEGIN
    PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
      'attempt_id', v_attempt, 'claim_token', v_claim, 'stash', v_stash));
    RAISE EXCEPTION 'S4 failed: a replay replaced the stash'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA03' THEN NULL;
  END;

  SELECT count(*) INTO shape
    FROM public.oauth_pending_instagram_selections
   WHERE meta_oauth_attempt_id = v_attempt;
  ASSERT shape = '1', 'S4 the stash was persisted exactly once';
END
$s4$;

-- ---------------------------------------------------------------------------
-- S5. commit_meta_oauth_selection: the whole transition in one transaction,
--     no metadata copy, no secret in the receipt.
-- ---------------------------------------------------------------------------
DO $s5$
DECLARE
  shape text;
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_claim TEXT;
  v_pending UUID;
  v_receipt JSONB;
  v_account UUID;
  v_credential UUID;
  v_row RECORD;
BEGIN
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'connect_new',
    'intended_social_profile_id', '0ea10001-0000-4000-8000-000000000011'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  v_claim := v_result ->> 'claim_token';
  v_result := public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-commit-1',
        'ig_username', 'moa_commit_one',
        'ig_profile_picture_url', 'https://example.invalid/moa-commit-1.png',
        'facebook_page_id', 'moa-page-commit-1',
        'facebook_page_name', 'MOA Commit Page',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-commit',
        'page_token_expires_in', 7200
      )),
      'user_token', 'synthetic-not-a-live-secret',
      'expires_in', 5184000)));
  v_pending := (v_result ->> 'pending_selection_id')::UUID;

  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-commit-1'));

  ASSERT (v_receipt ->> 'operation') = 'created',
    'S5 the receipt records the operation';
  ASSERT (v_receipt ->> 'login_kind') = 'page_linked',
    'S5 the receipt records the classification';
  ASSERT v_receipt::TEXT NOT LIKE '%synthetic-not-a-live-secret%',
    'S5 the receipt carries no token';

  v_account := (v_receipt ->> 'social_account_id')::UUID;
  v_credential := (v_receipt ->> 'credential_id')::UUID;

  -- The account row.
  SELECT sa.platform, sa.platform_user_id, sa.platform_username, sa.avatar_url,
         sa.access_token, sa.is_active, sa.social_profile_id, sa.needs_reauth,
         sa.failure_count, sa.last_refresh_error, sa.ig_auth_type,
         sa.account_metadata, sa.token_expires_at, sa.connected_at
    INTO v_row
    FROM public.social_accounts AS sa
   WHERE sa.id = v_account AND sa.user_id = u_owner;
  ASSERT v_row.platform = 'instagram', 'S5 the account is an Instagram account';
  ASSERT v_row.platform_user_id = 'moa-ig-commit-1',
    'S5 the account carries the verified provider identity';
  ASSERT v_row.platform_username = 'moa_commit_one',
    'S5 the account carries the verified username';
  ASSERT v_row.avatar_url = 'https://example.invalid/moa-commit-1.png',
    'S5 the account carries the verified avatar';
  ASSERT v_row.access_token = 'synthetic-not-a-live-secret',
    'S5 the account carries the operational token';
  ASSERT v_row.is_active, 'S5 the account is active';
  ASSERT v_row.social_profile_id = '0ea10001-0000-4000-8000-000000000011',
    'S5 the account is assigned to the intended profile';
  ASSERT v_row.needs_reauth IS FALSE, 'S5 the health flag is cleared';
  ASSERT v_row.failure_count = 0, 'S5 the failure counter is cleared';
  ASSERT v_row.last_refresh_error IS NULL, 'S5 the last error is cleared';
  ASSERT v_row.ig_auth_type = 'facebook_page',
    'S5 the legacy display classification is written';
  ASSERT v_row.account_metadata IS NULL,
    'S5 the writer never writes account_metadata';
  -- The page token and the user token are anchored separately at the
  -- callback. The account must not inherit the 60-day user TTL.
  ASSERT v_row.token_expires_at IS NOT NULL, 'S5 the account carries the page-token expiry';
  ASSERT (
    SELECT c.token_expires_at
      FROM public.facebook_user_credentials AS c
     WHERE c.id = v_credential
  ) > v_row.token_expires_at,
    'S5 the user-token expiry is later than the page-token expiry';
  ASSERT v_row.connected_at IS NOT NULL, 'S5 the account carries a connection time';

  -- The shared credential and the binding.
  SELECT c.revision, c.provider_user_id, c.provenance_source, c.token
    INTO v_row
    FROM public.facebook_user_credentials AS c
   WHERE c.id = v_credential AND c.user_id = u_owner;
  ASSERT v_row.revision = 1, 'S5 the attempt created the grant at revision one';
  ASSERT v_row.provider_user_id = 'moa-fb-user-commit',
    'S5 the credential carries the verified grant identity';
  ASSERT v_row.provenance_source = 'oauth_exchange',
    'S5 the credential records the oauth provenance';

  SELECT b.verified_facebook_user_id, b.verified_facebook_page_id,
         b.verified_instagram_user_id, b.evidence_source, b.connection_version
    INTO v_row
    FROM public.facebook_user_credential_bindings AS b
   WHERE b.social_account_id = v_account AND b.user_id = u_owner;
  ASSERT v_row.verified_facebook_user_id = 'moa-fb-user-commit',
    'S5 the binding carries the verified facebook user id';
  ASSERT v_row.verified_facebook_page_id = 'moa-page-commit-1',
    'S5 the binding carries the verified page id';
  ASSERT v_row.verified_instagram_user_id = 'moa-ig-commit-1',
    'S5 the binding carries the verified instagram id';
  ASSERT v_row.evidence_source = 'oauth_exchange',
    'S5 the binding records the oauth evidence source';
  ASSERT v_row.connection_version = 1,
    'S5 the binding starts at connection version one';

  -- The capability record. The authoritative classification.
  SELECT c.login_kind, c.permission_read_state, c.credential_generation,
         c.granted_scopes, c.scopes_read_at
    INTO v_row
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_account AND c.user_id = u_owner;
  ASSERT v_row.login_kind = 'page_linked',
    'S5 the capability record carries the classification';
  ASSERT v_row.permission_read_state = 'unknown',
    'S5 the stale permission evidence is reset';
  ASSERT v_row.credential_generation = 1,
    'S5 the capability generation advanced exactly once';
  ASSERT v_row.granted_scopes = ARRAY[]::TEXT[],
    'S5 the stale scope set is cleared';
  ASSERT v_row.scopes_read_at IS NULL, 'S5 the stale scope read time is cleared';

  -- The protected linkage.
  ASSERT EXISTS (
    SELECT 1 FROM public.instagram_account_credentials
     WHERE social_account_id = v_account AND user_id = u_owner
       AND credential_id = v_credential
  ), 'S5 the protected credential linkage exists';

  -- The stash is finished and gone, and the attempt is completed.
  SELECT count(*) INTO shape FROM public.oauth_pending_instagram_selections
   WHERE meta_oauth_attempt_id = v_attempt;
  ASSERT shape = '0', 'S5 the finished stash was cleaned up';
  SELECT a.status INTO shape FROM public.meta_oauth_attempts a WHERE a.id = v_attempt;
  ASSERT shape = 'completed', 'S5 the attempt is completed';

  -- The attempt and the receipt hold no secret.
  SELECT a.capture::TEXT || a.authority_progression::TEXT INTO shape
    FROM public.meta_oauth_attempts a WHERE a.id = v_attempt;
  ASSERT shape NOT LIKE '%synthetic-not-a-live-secret%',
    'S5 the attempt row holds no token';
  SELECT r.receipt::TEXT INTO shape
    FROM public.meta_oauth_attempt_receipts r WHERE r.attempt_id = v_attempt;
  ASSERT shape NOT LIKE '%synthetic-not-a-live-secret%',
    'S5 the receipt row holds no token';
END
$s5$;

-- ---------------------------------------------------------------------------
-- S6. The receipt replay: identical retry, same receipt, ZERO mutations.
--     A conflicting retry refuses.
-- ---------------------------------------------------------------------------
DO $s6$
DECLARE
  shape text;
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_claim TEXT;
  v_first JSONB;
  v_second JSONB;
  v_account UUID;
  v_before RECORD;
  v_after RECORD;
  v_msg TEXT;
BEGIN
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  v_claim := v_result ->> 'claim_token';
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-replay-1',
        'ig_username', 'moa_replay_one',
        'facebook_page_id', 'moa-page-replay-1',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-replay'
      )),
      'user_token', 'synthetic-not-a-live-secret')));

  v_first := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-replay-1'));
  v_account := (v_first ->> 'social_account_id')::UUID;

  SELECT sa.updated_at AS account_updated_at, c.revision AS credential_revision,
         c.updated_at AS credential_updated_at,
         f.connection_version AS connection_version,
         cap.credential_generation AS capability_generation
    INTO v_before
    FROM public.social_accounts sa
    JOIN public.facebook_user_credential_bindings b
      ON b.social_account_id = sa.id
    JOIN public.facebook_user_credentials c ON c.id = b.credential_id
    JOIN public.facebook_user_credential_connection_fences f
      ON f.social_account_id = sa.id
    JOIN public.instagram_account_capabilities cap
      ON cap.social_account_id = sa.id
   WHERE sa.id = v_account;

  -- The identical retry.
  v_second := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-replay-1'));
  ASSERT v_second = v_first,
    'S6 an identical retry returns the SAME nonsecret receipt';

  SELECT sa.updated_at AS account_updated_at, c.revision AS credential_revision,
         c.updated_at AS credential_updated_at,
         f.connection_version AS connection_version,
         cap.credential_generation AS capability_generation
    INTO v_after
    FROM public.social_accounts sa
    JOIN public.facebook_user_credential_bindings b
      ON b.social_account_id = sa.id
    JOIN public.facebook_user_credentials c ON c.id = b.credential_id
    JOIN public.facebook_user_credential_connection_fences f
      ON f.social_account_id = sa.id
    JOIN public.instagram_account_capabilities cap
      ON cap.social_account_id = sa.id
   WHERE sa.id = v_account;

  ASSERT v_after.account_updated_at = v_before.account_updated_at,
    'S6 the identical retry did not touch the account row';
  ASSERT v_after.credential_revision = v_before.credential_revision,
    'S6 the identical retry did not advance the credential revision';
  ASSERT v_after.credential_updated_at = v_before.credential_updated_at,
    'S6 the identical retry did not touch the credential row';
  ASSERT v_after.connection_version = v_before.connection_version,
    'S6 the identical retry did not advance the connection fence';
  ASSERT v_after.capability_generation = v_before.capability_generation,
    'S6 the identical retry did not advance the capability generation';

  SELECT count(*) INTO shape
    FROM public.meta_oauth_attempt_receipts WHERE attempt_id = v_attempt;
  ASSERT shape = '1', 'S6 the identical retry wrote no second receipt';

  -- A conflicting retry: the committed identity no longer matches the
  -- account.
  UPDATE public.social_accounts
     SET platform_user_id = 'moa-ig-replay-1-moved'
   WHERE id = v_account;
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-replay-1'));
    RAISE EXCEPTION 'S6 failed: a conflicting retry was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA06' THEN NULL;
  END;
END
$s6$;

-- ---------------------------------------------------------------------------
-- S7. Multiple Instagram selections from one stash: the first selection
--     creates the grant, the second reuses it through the attempt's OWN
--     progression. The stash survives until the last selection.
-- ---------------------------------------------------------------------------
DO $s7$
DECLARE
  shape text;
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_claim TEXT;
  v_pending UUID;
  v_r1 JSONB;
  v_r2 JSONB;
  v_cred1 UUID;
  v_cred2 UUID;
  v_stash_rows INTEGER;
  v_stash_candidates INTEGER;
BEGIN
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  v_claim := v_result ->> 'claim_token';
  v_result := public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(
        jsonb_build_object(
          'ig_user_id', 'moa-ig-multi-1', 'ig_username', 'moa_multi_one',
          'facebook_page_id', 'moa-page-multi-1',
          'page_access_token', 'synthetic-not-a-live-secret',
          'facebook_user_id', 'moa-fb-user-multi'),
        jsonb_build_object(
          'ig_user_id', 'moa-ig-multi-2', 'ig_username', 'moa_multi_two',
          'facebook_page_id', 'moa-page-multi-2',
          'page_access_token', 'synthetic-not-a-live-secret',
          'facebook_user_id', 'moa-fb-user-multi')
      ),
      'user_token', 'synthetic-not-a-live-secret')));
  v_pending := (v_result ->> 'pending_selection_id')::UUID;

  v_r1 := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-multi-1'));
  v_cred1 := (v_r1 ->> 'credential_id')::UUID;

  -- The stash survives: the picker may select a second account.
  SELECT count(*), max(jsonb_array_length(ps.ig_candidates_json))
    INTO v_stash_rows, v_stash_candidates
    FROM public.oauth_pending_instagram_selections ps
   WHERE ps.id = v_pending;
  ASSERT v_stash_rows = 1, 'S7 the stash survives the first selection';
  ASSERT v_stash_candidates = 1,
    'S7 the consumed candidate is removed from the stash';

  v_r2 := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-multi-2'));
  v_cred2 := (v_r2 ->> 'credential_id')::UUID;

  ASSERT v_cred2 = v_cred1,
    'S7 the second selection reuses the credential the FIRST selection returned';
  SELECT count(*) INTO shape FROM public.facebook_user_credentials
   WHERE user_id = u_owner AND provider_user_id = 'moa-fb-user-multi';
  ASSERT shape = '1', 'S7 the attempt created exactly one grant';

  -- Both accounts are bound to it.
  SELECT count(*) INTO shape
    FROM public.facebook_user_credential_bindings
   WHERE user_id = u_owner AND credential_id = v_cred1
     AND social_account_id IN (
       (v_r1 ->> 'social_account_id')::UUID,
       (v_r2 ->> 'social_account_id')::UUID);
  ASSERT shape = '2', 'S7 both accounts are bound to the shared grant';

  -- The stash is finished now.
  SELECT count(*) INTO shape FROM public.oauth_pending_instagram_selections
   WHERE meta_oauth_attempt_id = v_attempt;
  ASSERT shape = '0', 'S7 the stash is cleaned up after the last selection';

  -- The progression is attempt-local: another attempt must NOT be able to
  -- reuse this attempt's credential.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  v_claim := v_result ->> 'claim_token';
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-multi-3', 'ig_username', 'moa_multi_three',
        'facebook_page_id', 'moa-page-multi-3',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-multi')),
      'user_token', 'synthetic-not-a-live-secret')));
  v_r1 := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-multi-3'));
  ASSERT (v_r1 ->> 'credential_id')::UUID <> v_cred1,
    'S7 a different attempt creates its own grant and never adopts another one';
END
$s7$;

-- ---------------------------------------------------------------------------
-- S8. The absence fence. A bind -> detach by another attempt advances the
--     surviving fence, and the older absence capture is refused. This is
--     the defect the preflight probes reproduced.
-- ---------------------------------------------------------------------------
DO $s8$
DECLARE
  shape text;
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_claim TEXT;
  v_credential UUID;
  v_conn BIGINT;
  v_msg TEXT;
BEGIN
  -- The capture happens while the account has NO binding and NO fence.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'reconnect',
    'target_social_account_id', '0ea20001-0000-4000-8000-000000000023'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  v_claim := v_result ->> 'claim_token';
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-a1', 'ig_username', 'moa_a1',
        'facebook_page_id', 'moa-page-a1',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-2')),
      'user_token', 'synthetic-not-a-live-secret')));

  -- Another attempt binds and then detaches the SAME account.
  PERFORM public.bind_facebook_user_credential(u_owner, jsonb_build_object(
    'expected_absent', true,
    'token', 'synthetic-not-a-live-secret',
    'provenance_source', 'oauth_exchange',
    'provenance_captured_at', '2026-10-27T09:30:00.000Z',
    'social_account_id', '0ea20001-0000-4000-8000-000000000023',
    'expected_capability_generation', 1,
    'verified_provider_identity', jsonb_build_object(
      'facebook_user_id', 'moa-fb-user-2',
      'facebook_page_id', 'moa-page-a1',
      'instagram_user_id', 'moa-ig-a1')
  ));
  SELECT b.credential_id, b.connection_version INTO v_credential, v_conn
    FROM public.facebook_user_credential_bindings b
   WHERE b.social_account_id = '0ea20001-0000-4000-8000-000000000023';
  PERFORM public.unbind_facebook_user_credential(u_owner, jsonb_build_object(
    'social_account_id', '0ea20001-0000-4000-8000-000000000023',
    'credential_id', v_credential,
    'expected_revision', 1,
    'expected_connection_version', v_conn,
    'expected_capability_generation', 2
  ));

  -- The surviving fence advanced; the binding is gone again.
  SELECT count(*) INTO shape FROM public.facebook_user_credential_bindings
   WHERE social_account_id = '0ea20001-0000-4000-8000-000000000023';
  ASSERT shape = '0', 'S8 the intervening detach removed the binding again';
  SELECT f.connection_version INTO v_conn
    FROM public.facebook_user_credential_connection_fences f
   WHERE f.social_account_id = '0ea20001-0000-4000-8000-000000000023';
  ASSERT v_conn = 2,
    'S8 the surviving fence kept its high-water mark through the detach';

  -- The OLD absence capture is now refused. This is the ABA.
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-a1'));
    RAISE EXCEPTION 'S8 failed: the old absent capture was accepted after a bind -> detach'
      USING ERRCODE = 'assert_failure';
  EXCEPTION
    WHEN SQLSTATE 'MOA07' THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      ASSERT v_msg LIKE '%fence%',
        format('S8 the refusal names the fence (got %s)', v_msg);
  END;

  -- The refusal left zero account, credential, fence and receipt changes.
  SELECT count(*) INTO shape FROM public.meta_oauth_attempt_receipts
   WHERE attempt_id = v_attempt;
  ASSERT shape = '0', 'S8 the refused selection wrote no receipt';
  SELECT count(*) INTO shape FROM public.facebook_user_credentials
   WHERE user_id = u_owner AND provider_user_id = 'moa-fb-user-2';
  ASSERT shape = '0', 'S8 the refused selection created no credential';
  SELECT f.connection_version INTO v_conn
    FROM public.facebook_user_credential_connection_fences f
   WHERE f.social_account_id = '0ea20001-0000-4000-8000-000000000023';
  ASSERT v_conn = 2, 'S8 the refused selection did not advance the fence';
END
$s8$;

-- ---------------------------------------------------------------------------
-- S9. The shared grant scope. Adding a new Instagram account to an
--     existing grant requires an explicit owned source, validates the grant
--     identity, and reuses the captured grant.
-- ---------------------------------------------------------------------------
DO $s9$
DECLARE
  shape text;
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_claim TEXT;
  v_receipt JSONB;
  v_msg TEXT;
BEGIN
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'add_to_existing_grant',
    'source_social_account_id', '0ea20001-0000-4000-8000-000000000021'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  ASSERT (v_result -> 'capture' -> 'grant' ->> 'credential_id')
       = '0ea90001-0000-4000-8000-000000000001',
    'S9 the capture names the shared grant of the owned source';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  v_claim := v_result ->> 'claim_token';

  -- A grant identity that does not match the captured grant is refused.
  BEGIN
    PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
      'attempt_id', v_attempt, 'claim_token', v_claim,
      'stash', jsonb_build_object(
        'candidates', jsonb_build_array(jsonb_build_object(
          'ig_user_id', 'moa-ig-grant-1', 'ig_username', 'moa_grant_one',
          'facebook_page_id', 'moa-page-grant-1',
          'page_access_token', 'synthetic-not-a-live-secret',
          'facebook_user_id', 'moa-fb-user-WRONG')),
        'user_token', 'synthetic-not-a-live-secret')));
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-grant-1'));
    RAISE EXCEPTION 'S9 failed: a grant identity mismatch was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;

  -- The accepted grant extension.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'add_to_existing_grant',
    'source_social_account_id', '0ea20001-0000-4000-8000-000000000021'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  v_claim := v_result ->> 'claim_token';
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-grant-2', 'ig_username', 'moa_grant_two',
        'facebook_page_id', 'moa-page-grant-2',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-1')),
      'user_token', 'synthetic-not-a-live-secret')));

  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-grant-2'));

  ASSERT (v_receipt ->> 'credential_id')::UUID
       = '0ea90001-0000-4000-8000-000000000001',
    'S9 the new account reuses the CAPTURED shared grant';
  ASSERT (v_receipt ->> 'credential_revision')::BIGINT = 4,
    'S9 the shared grant revision advanced exactly once';

  -- The siblings are untouched.
  SELECT count(*) INTO shape FROM public.facebook_user_credential_bindings
   WHERE credential_id = '0ea90001-0000-4000-8000-000000000001'
     AND social_account_id IN (
       '0ea20001-0000-4000-8000-000000000021',
       '0ea20001-0000-4000-8000-000000000022');
  ASSERT shape = '2', 'S9 the sibling bindings survive the grant extension';
  SELECT count(*) INTO shape FROM public.facebook_user_credentials
   WHERE user_id = u_owner AND provider_user_id = 'moa-fb-user-1';
  ASSERT shape = '1', 'S9 no second grant row was created for the same grant';
END
$s9$;

-- ---------------------------------------------------------------------------
-- S10. Create-only handling. An existing natural key is a typed conflict,
--      never an adoption, and a username never identifies an identity.
-- ---------------------------------------------------------------------------
DO $s10$
DECLARE
  shape text;
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_claim TEXT;
  v_before RECORD;
  v_after RECORD;
BEGIN
  -- The same provider identity under a different username.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  v_claim := v_result ->> 'claim_token';
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-a4', 'ig_username', 'moa_different_handle',
        'facebook_page_id', 'moa-page-a4',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-4')),
      'user_token', 'synthetic-not-a-live-secret')));

  SELECT sa.platform_username, sa.access_token INTO v_before
    FROM public.social_accounts sa
   WHERE sa.id = '0ea20001-0000-4000-8000-000000000024';

  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-a4'));
    RAISE EXCEPTION 'S10 failed: an existing natural key was adopted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA05' THEN NULL;
  END;

  SELECT sa.platform_username, sa.access_token INTO v_after
    FROM public.social_accounts sa
   WHERE sa.id = '0ea20001-0000-4000-8000-000000000024';
  ASSERT v_after.platform_username = v_before.platform_username,
    'S10 the conflicting commit did not rename the existing account';
  ASSERT v_after.access_token = v_before.access_token,
    'S10 the conflicting commit did not replace the existing token';
  SELECT count(*) INTO shape FROM public.meta_oauth_attempt_receipts
   WHERE attempt_id = v_attempt;
  ASSERT shape = '0', 'S10 the conflicting commit wrote no receipt';

  -- The same USERNAME under a different provider identity creates a NEW
  -- account and never touches the other one.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  v_claim := v_result ->> 'claim_token';
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-a5', 'ig_username', 'moa_shared_handle',
        'facebook_page_id', 'moa-page-a5',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-5')),
      'user_token', 'synthetic-not-a-live-secret')));

  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-a5'));

  SELECT sa.platform_username INTO v_after
    FROM public.social_accounts sa
   WHERE sa.id = '0ea20001-0000-4000-8000-000000000024';
  ASSERT v_after.platform_username = v_before.platform_username,
    'S10 the other identity kept its username';
  SELECT count(*) INTO shape FROM public.social_accounts
   WHERE user_id = u_owner AND platform = 'instagram' AND platform_user_id = 'moa-ig-a5';
  ASSERT shape = '1', 'S10 the new identity created its own account';
END
$s10$;

-- ---------------------------------------------------------------------------
-- S11. Direct login: no Facebook grant, and a login-kind conversion that
--      detaches only the target's old binding.
-- ---------------------------------------------------------------------------
DO $s11$
DECLARE
  shape text;
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_claim TEXT;
  v_receipt JSONB;
  v_before RECORD;
BEGIN
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_direct', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_direct'));
  v_claim := v_result ->> 'claim_token';

  -- A direct candidate must never carry a facebook grant or a page token.
  BEGIN
    PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
      'attempt_id', v_attempt, 'claim_token', v_claim,
      'stash', jsonb_build_object(
        'candidates', jsonb_build_array(jsonb_build_object(
          'ig_user_id', 'moa-ig-direct-x', 'facebook_page_id', 'moa-page-x',
          'page_access_token', 'synthetic-not-a-live-secret')),
        'user_token', 'synthetic-not-a-live-secret')));
    RAISE EXCEPTION 'S11 failed: a direct candidate carried a facebook grant'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA02' THEN NULL;
  END;

  -- The accepted direct connect.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_direct', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_direct'));
  v_claim := v_result ->> 'claim_token';
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-direct-1', 'ig_username', 'moa_direct_one',
        'ig_profile_picture_url', 'https://example.invalid/moa-direct-1.png')),
      'user_token', 'synthetic-not-a-live-secret')));

  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_direct:ig:moa-ig-direct-1'));

  ASSERT (v_receipt ->> 'login_kind') = 'direct',
    'S11 the direct receipt records the direct classification';
  ASSERT (v_receipt ->> 'credential_id') IS NULL,
    'S11 a direct connect creates no Facebook User credential';
  SELECT count(*) INTO shape FROM public.facebook_user_credentials
   WHERE user_id = u_owner AND provider_user_id = 'moa-fb-user-direct';
  ASSERT shape = '0', 'S11 a direct connect creates no grant at all';
  SELECT count(*) INTO shape FROM public.facebook_user_credential_bindings
   WHERE social_account_id = (v_receipt ->> 'social_account_id')::UUID;
  ASSERT shape = '0', 'S11 a direct account carries no facebook binding';
  SELECT sa.access_token, sa.ig_auth_type INTO v_before
    FROM public.social_accounts sa
   WHERE sa.id = (v_receipt ->> 'social_account_id')::UUID;
  ASSERT v_before.access_token = 'synthetic-not-a-live-secret',
    'S11 the direct account carries its own token';
  ASSERT v_before.ig_auth_type = 'business_login',
    'S11 the legacy display classification records the direct login';
  SELECT c.login_kind, c.permission_read_state INTO v_before
    FROM public.instagram_account_capabilities c
   WHERE c.social_account_id = (v_receipt ->> 'social_account_id')::UUID;
  ASSERT v_before.login_kind = 'direct',
    'S11 the capability record carries the direct classification';

  -- A CONVERSION from page-linked to direct on an owned account. Only the
  -- target's old binding is detached; the sibling survives.
  SELECT sa.platform_user_id INTO v_before
    FROM public.social_accounts sa
   WHERE sa.id = '0ea20001-0000-4000-8000-000000000021';
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_direct', 'intent', 'reconnect',
    'target_social_account_id', '0ea20001-0000-4000-8000-000000000021'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_direct'));
  v_claim := v_result ->> 'claim_token';
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', v_before.platform_user_id, 'ig_username', 'moa_a2')),
      'user_token', 'synthetic-not-a-live-secret')));
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_direct:ig:' || v_before.platform_user_id));

  ASSERT (v_receipt ->> 'operation') = 'reconnected',
    'S11 the conversion is an explicit reconnect operation';
  SELECT count(*) INTO shape FROM public.facebook_user_credential_bindings
   WHERE social_account_id = '0ea20001-0000-4000-8000-000000000021';
  ASSERT shape = '0', 'S11 the conversion detached the target binding';
  SELECT count(*) INTO shape FROM public.facebook_user_credential_bindings
   WHERE social_account_id = '0ea20001-0000-4000-8000-000000000022';
  ASSERT shape = '1', 'S11 the conversion preserved the sibling binding';
  SELECT c.login_kind, c.permission_read_state, c.granted_scopes INTO v_before
    FROM public.instagram_account_capabilities c
   WHERE c.social_account_id = '0ea20001-0000-4000-8000-000000000021';
  ASSERT v_before.login_kind = 'direct',
    'S11 the conversion wrote the new classification';
  ASSERT v_before.permission_read_state = 'unknown',
    'S11 the conversion reset the stale permission evidence';
  ASSERT v_before.granted_scopes = ARRAY[]::TEXT[],
    'S11 the conversion cleared the stale scope set';
END
$s11$;

-- ---------------------------------------------------------------------------
-- S12. Reconnection and reactivation of a captured owned target.
-- ---------------------------------------------------------------------------
DO $s12$
DECLARE
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_claim TEXT;
  v_receipt JSONB;
  v_before RECORD;
  v_after RECORD;
BEGIN
  SELECT sa.is_active, sa.connected_at, sa.account_metadata INTO v_before
    FROM public.social_accounts sa
   WHERE sa.id = '0ea20001-0000-4000-8000-000000000023';

  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'reconnect',
    'target_social_account_id', '0ea20001-0000-4000-8000-000000000023',
    'intended_social_profile_id', '0ea10001-0000-4000-8000-000000000011'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  v_claim := v_result ->> 'claim_token';
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-a1', 'ig_username', 'moa_a1',
        'facebook_page_id', 'moa-page-a1',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-a1')),
      'user_token', 'synthetic-not-a-live-secret')));

  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-a1'));

  ASSERT (v_receipt ->> 'operation') = 'reactivated',
    'S12 an inactive captured target is reactivated';
  SELECT sa.is_active, sa.connected_at, sa.account_metadata,
         sa.social_profile_id, sa.platform_user_id, sa.user_id, sa.platform
    INTO v_after
    FROM public.social_accounts sa
   WHERE sa.id = '0ea20001-0000-4000-8000-000000000023';
  ASSERT v_after.is_active, 'S12 the reactivated account is active';
  ASSERT v_after.connected_at = v_before.connected_at,
    'S12 the reactivation preserved the original connection time';
  ASSERT v_after.account_metadata IS NOT DISTINCT FROM v_before.account_metadata,
    'S12 the reactivation never touched account_metadata';
  ASSERT v_after.social_profile_id = '0ea10001-0000-4000-8000-000000000011',
    'S12 the reactivation assigned the intended profile';
  ASSERT v_after.platform_user_id = 'moa-ig-a1',
    'S12 the reactivation preserved the stable provider identity';
  ASSERT v_after.user_id = u_owner AND v_after.platform = 'instagram',
    'S12 the reactivation preserved the owner and the platform';

  -- A verified identity that does not match the captured target refuses.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'reconnect',
    'target_social_account_id', '0ea20001-0000-4000-8000-000000000023'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  v_claim := v_result ->> 'claim_token';
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-somebody-else',
        'facebook_page_id', 'moa-page-a1',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-a1')),
      'user_token', 'synthetic-not-a-live-secret')));
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-somebody-else'));
    RAISE EXCEPTION 'S12 failed: a mismatched provider identity was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
END
$s12$;

-- ---------------------------------------------------------------------------
-- S13. Ownership is structural. A foreign owner's account, profile or
--      attempt is unreachable, and a pending row cannot be attached to
--      somebody else's attempt.
-- ---------------------------------------------------------------------------
DO $s13$
DECLARE
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  u_other uuid := '0ea00002-0000-4000-8000-000000000002';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_msg TEXT;
  v_refused BOOLEAN;
BEGIN
  -- A foreign reconnect target.
  BEGIN
    PERFORM public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
      'flow', 'instagram_page_linked', 'intent', 'reconnect',
      'target_social_account_id', '0ea20002-0000-4000-8000-000000000025'));
    RAISE EXCEPTION 'S13 failed: a foreign target was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA02' THEN NULL;
  END;

  -- A foreign grant source.
  BEGIN
    PERFORM public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
      'flow', 'instagram_page_linked', 'intent', 'add_to_existing_grant',
      'source_social_account_id', '0ea20002-0000-4000-8000-000000000025'));
    RAISE EXCEPTION 'S13 failed: a foreign source was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA02' THEN NULL;
  END;

  -- A foreign profile.
  BEGIN
    PERFORM public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
      'flow', 'instagram_page_linked', 'intent', 'connect_new',
      'intended_social_profile_id', '0ea10002-0000-4000-8000-000000000012'));
    RAISE EXCEPTION 'S13 failed: a foreign profile was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA02' THEN NULL;
  END;

  -- A foreign attempt is unreachable.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_other, jsonb_build_object(
      'attempt_id', v_attempt, 'selection_key', 'instagram_page_linked:ig:x'));
    RAISE EXCEPTION 'S13 failed: a foreign owner reached a foreign attempt'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA02' THEN NULL;
  END;

  -- The pending row cannot be attached to somebody else's attempt. The
  -- owner-matching composite reference refuses it structurally; the guard
  -- trigger refuses it one step earlier. Either refusal is a refusal, and
  -- the row must not exist afterwards.
  v_refused := false;
  BEGIN
    INSERT INTO public.oauth_pending_instagram_selections (
      id, user_id, ig_candidates_json, long_lived_token, expires_in,
      created_at, expires_at, meta_oauth_attempt_id
    ) VALUES (
      '0ea30001-0000-4000-8000-000000000032', u_other, '[]'::jsonb,
      'synthetic-not-a-live-secret', 5184000, now(), now(), v_attempt);
  EXCEPTION
    WHEN foreign_key_violation THEN v_refused := true;
    WHEN SQLSTATE 'MOA04' THEN v_refused := true;
  END;
  ASSERT v_refused,
    'S13 a pending row was attached to a foreign attempt';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.oauth_pending_instagram_selections
     WHERE id = '0ea30001-0000-4000-8000-000000000032'
  ), 'S13 the refused pending row does not exist';
END
$s13$;

-- ---------------------------------------------------------------------------
-- S14. The typed refusals: unsupported flows, malformed payloads, unknown
--      selection keys and an expired deadline.
-- ---------------------------------------------------------------------------
DO $s14$
DECLARE
  shape text;
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_claim TEXT;
  v_pending UUID;
  v_expired UUID;
  v_now TIMESTAMPTZ;
  v_msg TEXT;
BEGIN
  -- An unsupported flow is refused by name.
  BEGIN
    PERFORM public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
      'flow', 'facebook_page_linked', 'intent', 'connect_new'));
    RAISE EXCEPTION 'S14 failed: an unsupported flow was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION
    WHEN SQLSTATE 'MOA02' THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      ASSERT v_msg LIKE '%instagram_page_linked%',
        format('S14 the refusal names the supported flows (got %s)', v_msg);
  END;

  -- An unknown payload key is refused.
  BEGIN
    PERFORM public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
      'flow', 'instagram_direct', 'intent', 'connect_new',
      'browser_supplied_version', 4));
    RAISE EXCEPTION 'S14 failed: a browser-supplied version was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA01' THEN NULL;
  END;

  -- A reconnect without a target is refused.
  BEGIN
    PERFORM public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
      'flow', 'instagram_direct', 'intent', 'reconnect'));
    RAISE EXCEPTION 'S14 failed: a reconnect without a target was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA01' THEN NULL;
  END;

  -- A connect_new that names a target is refused.
  BEGIN
    PERFORM public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
      'flow', 'instagram_direct', 'intent', 'connect_new',
      'target_social_account_id', '0ea20001-0000-4000-8000-000000000021'));
    RAISE EXCEPTION 'S14 failed: a connect_new with a target was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA01' THEN NULL;
  END;

  -- An unknown selection key is refused.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_direct', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_direct'));
  v_claim := v_result ->> 'claim_token';
  v_result := public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-unknown-key')),
      'user_token', 'synthetic-not-a-live-secret')));
  v_pending := (v_result ->> 'pending_selection_id')::UUID;
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt, 'selection_key', 'instagram_direct:ig:not-there'));
    RAISE EXCEPTION 'S14 failed: an unknown selection key was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA03' THEN NULL;
  END;

  -- An EXPIRED attempt refuses the selection and changes nothing.
  v_now := clock_timestamp();
  INSERT INTO public.meta_oauth_attempts (
    id, user_id, flow, intent, capture_version, captured_at, capture,
    nonce_digest, status, callback_deadline, picker_deadline,
    pending_selection_id, created_at, updated_at
  ) VALUES (
    '0ea40001-0000-4000-8000-000000000041', u_owner, 'instagram_direct',
    'connect_new', 1, v_now - interval '30 minutes',
    jsonb_build_object('capture_version', 1, 'captured_at', '2026-10-27T09:00:00.000000Z'),
    repeat('d', 64), 'selection_ready',
    v_now - interval '20 minutes', v_now - interval '10 minutes',
    '0ea30001-0000-4000-8000-000000000041', v_now, v_now
  );
  -- The stash row of that attempt is written with the attempt capability,
  -- exactly as the completion RPC writes it.
  PERFORM set_config('postora.meta_oauth_attempt',
                     '0ea40001-0000-4000-8000-000000000041', true);
  INSERT INTO public.oauth_pending_instagram_selections (
    id, user_id, ig_candidates_json, long_lived_token, expires_in,
    created_at, expires_at, meta_oauth_attempt_id
  ) VALUES (
    '0ea30001-0000-4000-8000-000000000041', u_owner,
    '[{"ig_user_id":"moa-ig-expired"}]'::jsonb,
    'synthetic-not-a-live-secret', 5184000,
    v_now - interval '30 minutes', v_now - interval '20 minutes',
    '0ea40001-0000-4000-8000-000000000041');
  PERFORM set_config('postora.meta_oauth_attempt', '', true);

  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', '0ea40001-0000-4000-8000-000000000041',
      'selection_key', 'instagram_direct:ig:moa-ig-expired'));
    RAISE EXCEPTION 'S14 failed: an expired attempt committed a selection'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA08' THEN NULL;
  END;

  SELECT count(*) INTO shape FROM public.social_accounts
   WHERE user_id = u_owner AND platform_user_id = 'moa-ig-expired';
  ASSERT shape = '0', 'S14 the expired attempt created no account';
  SELECT count(*) INTO shape FROM public.meta_oauth_attempt_receipts
   WHERE attempt_id = '0ea40001-0000-4000-8000-000000000041';
  ASSERT shape = '0', 'S14 the expired attempt wrote no receipt';
END
$s14$;

-- ---------------------------------------------------------------------------
-- S15. The legacy pending picker still works, and the legacy writer can
--      never consume an attempt's stash.
-- ---------------------------------------------------------------------------
DO $s15$
DECLARE
  shape text;
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_legacy uuid := '0ea30001-0000-4000-8000-000000000031';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_claim TEXT;
  v_pending UUID;
  v_msg TEXT;
  v_legacy_row RECORD;
BEGIN
  -- The legacy row has no attempt reference.
  SELECT ps.meta_oauth_attempt_id INTO v_pending
    FROM public.oauth_pending_instagram_selections ps
   WHERE ps.id = v_legacy;
  ASSERT v_pending IS NULL, 'S15 the legacy stash row has no attempt reference';

  -- The legacy read shape still resolves.
  SELECT ps.id, ps.user_id, ps.social_profile_id, ps.ig_candidates_json,
         ps.expires_in, ps.expires_at, ps.long_lived_token
    INTO v_legacy_row
    FROM public.oauth_pending_instagram_selections ps
   WHERE ps.id = v_legacy AND ps.user_id = u_owner;
  ASSERT v_legacy_row.id = v_legacy, 'S15 the legacy picker read still resolves';
  ASSERT v_legacy_row.user_id = u_owner,
    'S15 the legacy picker read still resolves the owner';
  ASSERT v_legacy_row.ig_candidates_json IS NOT NULL,
    'S15 the legacy picker read still resolves the candidates';
  ASSERT v_legacy_row.long_lived_token = 'synthetic-not-a-live-secret',
    'S15 the legacy picker read still resolves the token column';
  ASSERT v_legacy_row.expires_in = 5184000,
    'S15 the legacy picker read still resolves the lifetime';

  -- The legacy insert still works.
  INSERT INTO public.oauth_pending_instagram_selections (
    id, user_id, ig_candidates_json, long_lived_token, expires_in,
    created_at, expires_at
  ) VALUES (
    '0ea30001-0000-4000-8000-000000000033', u_owner, '[]'::jsonb,
    'synthetic-not-a-live-secret', 5184000, now(), now());
  ASSERT EXISTS (
    SELECT 1 FROM public.oauth_pending_instagram_selections
     WHERE id = '0ea30001-0000-4000-8000-000000000033'
  ), 'S15 the legacy insert still works';

  -- The legacy delete still works.
  DELETE FROM public.oauth_pending_instagram_selections
   WHERE id = '0ea30001-0000-4000-8000-000000000033';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.oauth_pending_instagram_selections
     WHERE id = '0ea30001-0000-4000-8000-000000000033'
  ), 'S15 the legacy delete still works';

  -- The Facebook stash keeps its legacy shape and legacy writer too.
  INSERT INTO public.oauth_pending_facebook_selections (
    id, user_id, target_platform, provider_token, pages_json, ig_standalone_json,
    created_at, expires_at
  ) VALUES (
    '0ea30001-0000-4000-8000-000000000034', u_owner, 'facebook',
    'synthetic-not-a-live-secret', '[]'::jsonb, '[]'::jsonb, now(), now());
  DELETE FROM public.oauth_pending_facebook_selections
   WHERE id = '0ea30001-0000-4000-8000-000000000034';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.oauth_pending_facebook_selections
     WHERE id = '0ea30001-0000-4000-8000-000000000034'
  ), 'S15 the legacy Facebook stash delete still works';

  -- An attempt's stash cannot be consumed by the legacy writer.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_direct', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_direct'));
  v_claim := v_result ->> 'claim_token';
  v_result := public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-guarded')),
      'user_token', 'synthetic-not-a-live-secret')));
  v_pending := (v_result ->> 'pending_selection_id')::UUID;

  BEGIN
    DELETE FROM public.oauth_pending_instagram_selections
     WHERE id = v_pending AND user_id = u_owner;
    RAISE EXCEPTION 'S15 failed: the legacy writer consumed an attempt stash'
      USING ERRCODE = 'assert_failure';
  EXCEPTION
    WHEN SQLSTATE 'MOA04' THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      ASSERT v_msg ILIKE '%oauth attempt%',
        format('S15 the refusal names the attempt (got %s)', v_msg);
  END;

  BEGIN
    INSERT INTO public.oauth_pending_instagram_selections (
      id, user_id, ig_candidates_json, long_lived_token, expires_in,
      created_at, expires_at, meta_oauth_attempt_id
    ) VALUES (
      '0ea30001-0000-4000-8000-000000000035', u_owner, '[]'::jsonb,
      'synthetic-not-a-live-secret', 5184000, now(), now(), v_attempt);
    RAISE EXCEPTION 'S15 failed: a foreign writer created an attempt stash'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA04' THEN NULL;
  END;

  ASSERT EXISTS (
    SELECT 1 FROM public.oauth_pending_instagram_selections WHERE id = v_pending
  ), 'S15 the attempt stash survived the refused legacy writes';
END
$s15$;

-- ---------------------------------------------------------------------------
-- S16. The nonsecret picker reader.
-- ---------------------------------------------------------------------------
DO $s16$
DECLARE
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_claim TEXT;
  v_pending UUID;
BEGIN
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'connect_new',
    'intended_social_profile_id', '0ea10001-0000-4000-8000-000000000011'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  v_claim := v_result ->> 'claim_token';
  v_result := public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(
        jsonb_build_object('ig_user_id', 'moa-ig-read-1', 'ig_username', 'moa_read_one',
                           'facebook_page_id', 'moa-page-read-1',
                           'page_access_token', 'synthetic-not-a-live-secret',
                           'facebook_user_id', 'moa-fb-user-read'),
        jsonb_build_object('ig_user_id', 'moa-ig-read-2', 'ig_username', 'moa_read_two',
                           'facebook_page_id', 'moa-page-read-2',
                           'page_access_token', 'synthetic-not-a-live-secret',
                           'facebook_user_id', 'moa-fb-user-read')
      ),
      'user_token', 'synthetic-not-a-live-secret')));
  v_pending := (v_result ->> 'pending_selection_id')::UUID;

  v_result := public.read_meta_oauth_attempt(u_owner, v_pending);
  ASSERT (v_result ->> 'attempt_id') = v_attempt::TEXT,
    'S16 the reader returns the attempt';
  ASSERT (v_result ->> 'social_profile_id')
       = '0ea10001-0000-4000-8000-000000000011',
    'S16 the reader returns the intended profile';
  ASSERT jsonb_array_length(v_result -> 'candidates') = 2,
    'S16 the reader returns every candidate';
  ASSERT (v_result -> 'candidates' -> 0 ->> 'selection_key')
       = 'instagram_page_linked:ig:moa-ig-read-1',
    'S16 the reader returns the stable selection key';
  ASSERT v_result::TEXT NOT LIKE '%synthetic-not-a-live-secret%',
    'S16 the reader returns no token';
  ASSERT jsonb_array_length(v_result -> 'committed_selection_keys') = 0,
    'S16 a fresh attempt has no committed selection';

  -- Commit one, and the reader reports it.
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-read-1'));
  v_result := public.read_meta_oauth_attempt(u_owner, v_pending);
  ASSERT jsonb_array_length(v_result -> 'committed_selection_keys') = 1,
    'S16 the reader reports the committed selection';
  ASSERT jsonb_array_length(v_result -> 'candidates') = 1,
    'S16 the reader reports the remaining candidate';

  -- A foreign owner cannot read it.
  BEGIN
    PERFORM public.read_meta_oauth_attempt(
      '0ea00002-0000-4000-8000-000000000002', v_pending);
    RAISE EXCEPTION 'S16 failed: a foreign owner read the picker'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA02' THEN NULL;
  END;

  -- A legacy stash row is not an attempt.
  BEGIN
    PERFORM public.read_meta_oauth_attempt(
      u_owner, '0ea30001-0000-4000-8000-000000000031');
    RAISE EXCEPTION 'S16 failed: a legacy stash row was read as an attempt'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MOA04' THEN NULL;
  END;
END
$s16$;

-- ---------------------------------------------------------------------------
-- S17. A failed insert rolls the WHOLE selection back: no account, no
--      credential, no binding, no capability, no receipt.
-- ---------------------------------------------------------------------------
DO $s17$
DECLARE
  shape text;
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_claim TEXT;
  v_failed BOOLEAN := false;
  v_msg TEXT;
BEGIN
  CREATE FUNCTION public.moa_injected_failure() RETURNS TRIGGER
    LANGUAGE plpgsql AS $fn$
  BEGIN
    RAISE EXCEPTION 'injected downstream failure in the receipt writer'
      USING ERRCODE = 'MOA09';
  END;
  $fn$;
  CREATE TRIGGER moa_injected_failure
    BEFORE INSERT ON public.meta_oauth_attempt_receipts
    FOR EACH ROW EXECUTE FUNCTION public.moa_injected_failure();

  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  v_claim := v_result ->> 'claim_token';
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-rollback-1', 'ig_username', 'moa_rollback_one',
        'facebook_page_id', 'moa-page-rollback-1',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-rollback')),
      'user_token', 'synthetic-not-a-live-secret')));

  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-rollback-1'));
  EXCEPTION
    WHEN OTHERS THEN
      v_failed := true;
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
  END;

  ASSERT v_failed, 'S17 the injected failure aborted the selection';
  ASSERT v_msg LIKE '%injected downstream failure%',
    format('S17 the injected failure is the reported error (got %s)', v_msg);

  SELECT count(*) INTO shape FROM public.social_accounts
   WHERE user_id = u_owner AND platform_user_id = 'moa-ig-rollback-1';
  ASSERT shape = '0', 'S17 the failed selection created no account';
  SELECT count(*) INTO shape FROM public.facebook_user_credentials
   WHERE user_id = u_owner AND provider_user_id = 'moa-fb-user-rollback';
  ASSERT shape = '0', 'S17 the failed selection created no credential';
  SELECT count(*) INTO shape FROM public.meta_oauth_attempt_receipts
   WHERE attempt_id = v_attempt;
  ASSERT shape = '0', 'S17 the failed selection wrote no receipt';
  SELECT count(*) INTO shape FROM public.instagram_account_capabilities
   WHERE user_id = u_owner AND social_account_id IN (
     SELECT id FROM public.social_accounts
      WHERE user_id = u_owner AND platform_user_id = 'moa-ig-rollback-1');
  ASSERT shape = '0', 'S17 the failed selection created no capability record';
  -- The stash is untouched, so the selection can be retried.
  ASSERT EXISTS (
    SELECT 1 FROM public.oauth_pending_instagram_selections
     WHERE meta_oauth_attempt_id = v_attempt
  ), 'S17 the failed selection left the stash intact';

  DROP TRIGGER moa_injected_failure ON public.meta_oauth_attempt_receipts;
  DROP FUNCTION public.moa_injected_failure();
END
$s17$;

-- ---------------------------------------------------------------------------
-- S18. The browser roles are refused, including the OWNER holding a
--      matching JWT, and including the service-only RPCs.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '0ea00001-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $s18$
DECLARE
  stmt text;
  ord integer;
BEGIN
  FOR ord, stmt IN SELECT d.ord, d.stmt FROM moa_denied_statements d ORDER BY d.ord LOOP
    BEGIN
      EXECUTE stmt;
      RAISE EXCEPTION
        'S18 failed: the owning browser role was allowed to run statement %: %',
        ord, stmt
        USING ERRCODE = 'assert_failure';
    EXCEPTION
      WHEN SQLSTATE '42501' THEN NULL;
    END;
  END LOOP;
END
$s18$;

RESET ROLE;

SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.role', 'anon', true);

DO $s18b$
DECLARE
  stmt text;
  ord integer;
BEGIN
  FOR ord, stmt IN SELECT d.ord, d.stmt FROM moa_denied_statements d ORDER BY d.ord LOOP
    BEGIN
      EXECUTE stmt;
      RAISE EXCEPTION
        'S18b failed: the anonymous role was allowed to run statement %: %',
        ord, stmt
        USING ERRCODE = 'assert_failure';
    EXCEPTION
      WHEN SQLSTATE '42501' THEN NULL;
    END;
  END LOOP;
END
$s18b$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S19. The service role reaches the new relations, and the service path
--      the lifecycle depends on still works.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $s19$
DECLARE
  shape text;
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
BEGIN
  SELECT count(*) INTO shape FROM public.meta_oauth_attempts;
  ASSERT shape::BIGINT >= 0, 'S19 the service role reads the attempt table';
  SELECT count(*) INTO shape FROM public.meta_oauth_attempt_receipts;
  ASSERT shape::BIGINT >= 0, 'S19 the service role reads the receipt table';

  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_direct', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  ASSERT v_attempt IS NOT NULL,
    'S19 the service role can start an attempt';
END
$s19$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S20. Shared-grant invalidation, replay guard, expiry truth, page flows
--      and rebind. Existing sections above are unchanged.
-- ---------------------------------------------------------------------------
DO $s20$
DECLARE
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_claim TEXT;
  v_receipt JSONB;
  v_sibling UUID;
  v_sibling_gen BIGINT;
  v_sibling_token TEXT;
  v_revision BIGINT;
  v_accounts INTEGER;
  v_job UUID := '0ea70001-0000-4000-8000-000000000071';
  v_lease UUID := '0ea70002-0000-4000-8000-000000000072';
  v_msg TEXT;
  v_expired UUID := '0ea71001-0000-4000-8000-000000000081';
  v_fresh UUID := '0ea71002-0000-4000-8000-000000000082';
  v_legacy_old UUID := '0ea71003-0000-4000-8000-000000000083';
  v_legacy_new UUID := '0ea71004-0000-4000-8000-000000000084';
  v_protected_pending UUID := '0ea71005-0000-4000-8000-000000000085';
  v_fresh_pending UUID := '0ea71006-0000-4000-8000-000000000086';
  v_purge JSONB;
BEGIN
  SELECT count(*) INTO v_accounts FROM public.social_accounts WHERE user_id = u_owner;

  -- Sibling generation drift between capture and commit refuses, and writes nothing.
  -- 021 was converted to direct by S11, so the account that is still on the
  -- shared grant is 022. The other remaining member is the one that drifts.
  SELECT b.social_account_id INTO v_sibling
    FROM public.facebook_user_credential_bindings AS b
   WHERE b.credential_id = '0ea90001-0000-4000-8000-000000000001'
     AND b.social_account_id <> '0ea20001-0000-4000-8000-000000000022'
   ORDER BY b.social_account_id
   LIMIT 1;
  ASSERT v_sibling IS NOT NULL, 'S20 the shared grant still has a sibling of 022';
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'reconnect',
    'target_social_account_id', '0ea20001-0000-4000-8000-000000000022'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  v_claim := v_result ->> 'claim_token';
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-a3', 'ig_username', 'moa_a3',
        'facebook_page_id', 'moa-page-a3',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-1',
        'page_token_expires_in', 3600)),
      'user_token', 'synthetic-not-a-live-secret',
      'expires_in', 7200)));
  UPDATE public.instagram_account_capabilities
     SET credential_generation = credential_generation + 1
   WHERE social_account_id = v_sibling;
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-a3'));
    RAISE EXCEPTION 'S20 failed: a sibling generation change was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.meta_oauth_attempt_receipts WHERE attempt_id = v_attempt
  ), 'S20 a stale sibling writes no receipt';

  -- Put the sibling generation back so the following rotation is the change under test.
  UPDATE public.instagram_account_capabilities
     SET credential_generation = credential_generation - 1
   WHERE social_account_id = v_sibling;

  UPDATE public.instagram_account_capabilities
     SET permission_read_state = 'ok',
         granted_scopes = ARRAY['instagram_basic','instagram_manage_insights'],
         scopes_read_at = clock_timestamp()
   WHERE social_account_id = v_sibling;
  SELECT c.credential_generation, sa.access_token
    INTO v_sibling_gen, v_sibling_token
    FROM public.instagram_account_capabilities AS c
    JOIN public.social_accounts AS sa ON sa.id = c.social_account_id
   WHERE c.social_account_id = v_sibling;

  INSERT INTO public.instagram_collection_jobs (
    id, user_id, target_kind, target_id, social_account_id, captured_on,
    job_generation, status, due_at, lease_token, lease_expires_at, attempts,
    context_viewer_social_account_id, context_credential_generation, context_login_kind
  ) VALUES (
    v_job, u_owner, 'owner',
    v_sibling, v_sibling,
    (now() AT TIME ZONE 'Asia/Kuwait')::date,
    1, 'leased', now(), v_lease, clock_timestamp() + interval '10 minutes', 1,
    v_sibling, v_sibling_gen, 'page_linked'
  );

  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'reconnect',
    'target_social_account_id', '0ea20001-0000-4000-8000-000000000022'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_result ->> 'claim_token',
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(
        jsonb_build_object(
          'ig_user_id', 'moa-ig-a3', 'ig_username', 'moa_a3',
          'facebook_page_id', 'moa-page-a3',
          'page_access_token', 'synthetic-not-a-live-secret',
          'facebook_user_id', 'moa-fb-user-1',
          'page_token_expires_in', 3600),
        jsonb_build_object(
          'ig_user_id', 'moa-ig-a3-spare', 'ig_username', 'moa_a3_spare',
          'facebook_page_id', 'moa-page-a3-spare',
          'page_access_token', 'synthetic-not-a-live-secret',
          'facebook_user_id', 'moa-fb-user-1',
          'page_token_expires_in', 3600)),
      'user_token', 'synthetic-not-a-live-secret',
      'user_token_expires_in', 86400)));
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-a3'));
  ASSERT (v_receipt ->> 'operation') IN ('reconnected', 'reactivated'),
    'S20 the shared rotation commits';
  ASSERT (
    SELECT c.credential_generation
      FROM public.instagram_account_capabilities AS c
     WHERE c.social_account_id = v_sibling
  ) = v_sibling_gen + 1, 'S20 the sibling capability generation advances';
  ASSERT (
    SELECT sa.access_token FROM public.social_accounts AS sa
     WHERE sa.id = v_sibling
  ) = v_sibling_token, 'S20 the sibling operational token is preserved';
  ASSERT (
    SELECT jsonb_array_length(a.authority_progression -> 'accounts')
      FROM public.meta_oauth_attempts AS a WHERE a.id = v_attempt
  ) >= 2, 'S20 the progression lists the whole grant';

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  BEGIN
    PERFORM public.complete_instagram_collection_job(
      v_job, v_lease, 1, 'unavailable', 'provider_unavailable');
    RAISE EXCEPTION 'S20 failed: a stale collection job completed';
  EXCEPTION WHEN SQLSTATE '40001' THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
      RAISE;
    END IF;
  END;
  ASSERT (
    SELECT status FROM public.instagram_collection_jobs WHERE id = v_job
  ) = 'leased', 'S20 the refused job writes nothing';
  BEGIN
    PERFORM public.persist_instagram_collection_snapshot(
      v_job, v_lease, 1, '{"kind":"owner_media","items":[{}]}'::jsonb);
    RAISE EXCEPTION 'S20 failed: a stale collection snapshot was written';
  EXCEPTION WHEN SQLSTATE '40001' THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
      RAISE;
    END IF;
  END;
  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      v_job, v_lease, 1, '{"kind":"inventory","pages":77}'::jsonb);
    RAISE EXCEPTION 'S20 failed: a stale collection progress was recorded';
  EXCEPTION WHEN SQLSTATE '40001' THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
      RAISE;
    END IF;
  END;
  ASSERT (
    SELECT j.status FROM public.instagram_collection_jobs AS j WHERE j.id = v_job
  ) = 'leased', 'S20 a stale snapshot and progress leave the job leased';
  ASSERT (
    SELECT j.last_success_at IS NULL
      FROM public.instagram_collection_jobs AS j WHERE j.id = v_job
  ), 'S20 a stale completion does not advance last_success_at';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.ig_media_insight_snapshots AS s
     WHERE s.social_account_id = v_sibling
  ), 'S20 a stale snapshot writes no insight row';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.instagram_collection_job_checkpoints AS c
     WHERE c.job_id = v_job AND c.inventory_pages_fetched <> 0
  ), 'S20 a stale progress writes no inventory pages';

  -- Replay must not leave the mutation guard set.
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-a3'));
  ASSERT current_setting('postora.meta_oauth_attempt', true) IS DISTINCT FROM v_attempt::TEXT,
    'S20 replay does not leave the attempt guard set';
  BEGIN
    UPDATE public.oauth_pending_instagram_selections
       SET ig_candidates_json = ig_candidates_json
     WHERE meta_oauth_attempt_id = v_attempt;
    IF FOUND THEN
      RAISE EXCEPTION 'S20 failed: a raw stash update succeeded after replay';
    END IF;
  EXCEPTION WHEN SQLSTATE 'MOA04' THEN NULL;
  END;

  -- A token that is already expired at selection is not stored.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_direct', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_direct'));
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_result ->> 'claim_token',
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-already-expired', 'ig_username', 'moa_expired')),
      'user_token', 'synthetic-not-a-live-secret',
      'direct_token_expires_at', to_char(clock_timestamp() - interval '1 minute',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))));
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_direct:ig:moa-ig-already-expired'));
    RAISE EXCEPTION 'S20 failed: an already-expired token was stored';
  EXCEPTION WHEN SQLSTATE 'MOA08' THEN NULL;
  END;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.social_accounts
     WHERE user_id = u_owner AND platform_user_id = 'moa-ig-already-expired'
  ), 'S20 an expired token creates no account';

  -- Facebook Page only, then page plus Instagram under one grant.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'facebook_page', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'facebook_page'));
  v_result := public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_result ->> 'claim_token',
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(
        jsonb_build_object(
          'candidate_kind', 'page_only',
          'facebook_page_id', 'moa-fbpage-only',
          'facebook_page_name', 'MOA Page Only',
          'page_access_token', 'synthetic-page-only-secret',
          'facebook_user_id', 'moa-fb-user-page',
          'page_token_expires_in', 1800),
        jsonb_build_object(
          'candidate_kind', 'page_plus_ig',
          'facebook_page_id', 'moa-fbpage-plus',
          'facebook_page_name', 'MOA Page Plus',
          'ig_user_id', 'moa-ig-from-page',
          'ig_username', 'moa_from_page',
          'page_access_token', 'synthetic-page-plus-secret',
          'facebook_user_id', 'moa-fb-user-page',
          'page_token_expires_in', 1800)
      ),
      'user_token', 'synthetic-user-page-secret',
      'user_token_expires_in', 90000)));
  ASSERT (v_result -> 'candidates' -> 0 ->> 'page_access_token') IS NULL,
    'S20 the page picker projection carries no page token';
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'facebook_page:page:moa-fbpage-only'));
  ASSERT (v_receipt ->> 'platform') = 'facebook', 'S20 a page-only selection commits the Page account';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.instagram_account_capabilities
     WHERE social_account_id = (v_receipt ->> 'social_account_id')::UUID
  ), 'S20 a Facebook Page account has no Instagram capability row';
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'facebook_page:page:moa-fbpage-plus:ig:moa-ig-from-page'));
  ASSERT (v_receipt ->> 'companion_social_account_id') IS NOT NULL,
    'S20 page-plus-ig commits both accounts in one receipt';
  ASSERT (
    SELECT count(*) FROM public.facebook_user_credentials
     WHERE user_id = u_owner AND provider_user_id = 'moa-fb-user-page'
  ) = 1, 'S20 both page selections share one user grant';

  -- Same-subject rebind is refused. A different subject detaches only the target.
  SELECT revision INTO v_revision
    FROM public.facebook_user_credentials
   WHERE id = '0ea90001-0000-4000-8000-000000000001';
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'rebind',
    'target_social_account_id', '0ea20001-0000-4000-8000-000000000022'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_result ->> 'claim_token',
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-a3', 'ig_username', 'moa_a3',
        'facebook_page_id', 'moa-page-a3',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-1')),
      'user_token', 'synthetic-not-a-live-secret')));
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-a3'));
    RAISE EXCEPTION 'S20 failed: a same-subject rebind was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA01' THEN NULL;
  END;

  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'rebind',
    'target_social_account_id', '0ea20001-0000-4000-8000-000000000022'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_result ->> 'claim_token',
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-a3', 'ig_username', 'moa_a3',
        'facebook_page_id', 'moa-page-a3-rebind',
        'page_access_token', 'synthetic-rebind-secret',
        'facebook_user_id', 'moa-fb-user-REBIND')),
      'user_token', 'synthetic-rebind-user-secret',
      'user_token_expires_in', 4000)));
  SELECT c.credential_generation INTO v_sibling_gen
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = '0ea20001-0000-4000-8000-000000000021';
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-a3'));
  ASSERT (v_receipt ->> 'credential_id')::UUID
      <> '0ea90001-0000-4000-8000-000000000001',
    'S20 rebind creates a new credential';
  ASSERT (
    SELECT revision FROM public.facebook_user_credentials
     WHERE id = '0ea90001-0000-4000-8000-000000000001'
  ) = v_revision, 'S20 rebind does not rotate the old credential';
  ASSERT (
    SELECT c.credential_generation
      FROM public.instagram_account_capabilities AS c
     WHERE c.social_account_id = '0ea20001-0000-4000-8000-000000000021'
  ) = v_sibling_gen, 'S20 rebind does not bump an unselected sibling';
  ASSERT (
    SELECT b.credential_id FROM public.facebook_user_credential_bindings AS b
     WHERE b.social_account_id = '0ea20001-0000-4000-8000-000000000022'
  ) = (v_receipt ->> 'credential_id')::UUID,
    'S20 the rebound account is on the new grant';

  -- Expired read hides candidates. Purge removes expired protected and legacy
  -- rows and leaves an unexpired protected row and the accounts alone.
  INSERT INTO public.meta_oauth_attempts (
    id, user_id, flow, intent, capture_version, captured_at, capture,
    nonce_digest, status, callback_deadline, picker_deadline
  ) VALUES (
    v_expired, u_owner, 'instagram_direct', 'connect_new', 1, clock_timestamp(),
    '{"capture_version":1}'::jsonb, repeat('a', 64), 'selection_ready',
    clock_timestamp() - interval '2 minutes',
    clock_timestamp() - interval '1 minute'
  );
  PERFORM set_config('postora.meta_oauth_attempt', v_expired::TEXT, true);
  INSERT INTO public.oauth_pending_instagram_selections (
    id, user_id, ig_candidates_json, long_lived_token, expires_in,
    created_at, expires_at, meta_oauth_attempt_id
  ) VALUES (
    v_protected_pending, u_owner, '[{"ig_user_id":"moa-ig-purge"}]'::jsonb,
    'synthetic-purge-secret', 0, clock_timestamp(),
    clock_timestamp() - interval '1 minute', v_expired
  );
  UPDATE public.meta_oauth_attempts
     SET pending_selection_id = v_protected_pending
   WHERE id = v_expired;
  PERFORM set_config('postora.meta_oauth_attempt', '', true);

  v_result := public.read_meta_oauth_attempt(u_owner, v_protected_pending);
  ASSERT (v_result ->> 'expired')::BOOLEAN, 'S20 an expired stash reads as expired';
  ASSERT v_result -> 'candidates' = '[]'::JSONB, 'S20 an expired read returns no candidates';
  ASSERT v_result::TEXT NOT LIKE '%synthetic-purge-secret%',
    'S20 an expired read returns no token';

  INSERT INTO public.meta_oauth_attempts (
    id, user_id, flow, intent, capture_version, captured_at, capture,
    nonce_digest, status, callback_deadline, picker_deadline
  ) VALUES (
    v_fresh, u_owner, 'instagram_direct', 'connect_new', 1, clock_timestamp(),
    '{"capture_version":1}'::jsonb, repeat('b', 64), 'selection_ready',
    clock_timestamp() + interval '5 minutes',
    clock_timestamp() + interval '10 minutes'
  );
  PERFORM set_config('postora.meta_oauth_attempt', v_fresh::TEXT, true);
  INSERT INTO public.oauth_pending_instagram_selections (
    id, user_id, ig_candidates_json, long_lived_token, expires_in,
    created_at, expires_at, meta_oauth_attempt_id
  ) VALUES (
    v_fresh_pending, u_owner, '[{"ig_user_id":"moa-ig-fresh"}]'::jsonb,
    'synthetic-fresh-secret', 0, clock_timestamp(),
    clock_timestamp() + interval '10 minutes', v_fresh
  );
  UPDATE public.meta_oauth_attempts
     SET pending_selection_id = v_fresh_pending
   WHERE id = v_fresh;
  PERFORM set_config('postora.meta_oauth_attempt', '', true);

  INSERT INTO public.oauth_pending_instagram_selections (
    id, user_id, ig_candidates_json, long_lived_token, expires_in, created_at, expires_at
  ) VALUES
    (v_legacy_old, u_owner, '[]'::jsonb, 'synthetic-legacy-old', 0,
     clock_timestamp(), clock_timestamp() - interval '1 minute'),
    (v_legacy_new, u_owner, '[]'::jsonb, 'synthetic-legacy-new', 0,
     clock_timestamp(), clock_timestamp() + interval '10 minutes');

  BEGIN
    DELETE FROM public.oauth_pending_instagram_selections
     WHERE id IN (v_protected_pending, v_legacy_old);
    RAISE EXCEPTION 'S20 failed: a mixed expired delete bypassed the guard';
  EXCEPTION WHEN SQLSTATE 'MOA04' THEN NULL;
  END;
  ASSERT EXISTS (
    SELECT 1 FROM public.oauth_pending_instagram_selections WHERE id = v_legacy_old
  ), 'S20 the refused mixed delete keeps the legacy row';

  v_purge := public.purge_expired_meta_oauth_pending(50);
  ASSERT (v_purge ->> 'protected_rows_removed')::INTEGER >= 1,
    'S20 purge removes the expired protected stash';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.oauth_pending_instagram_selections WHERE id = v_protected_pending
  ), 'S20 the expired protected secret is gone';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.oauth_pending_instagram_selections WHERE id = v_legacy_old
  ), 'S20 purge removes the expired legacy stash';
  ASSERT EXISTS (
    SELECT 1 FROM public.oauth_pending_instagram_selections WHERE id = v_fresh_pending
  ), 'S20 purge keeps an unexpired protected stash';
  ASSERT EXISTS (
    SELECT 1 FROM public.oauth_pending_instagram_selections WHERE id = v_legacy_new
  ), 'S20 purge keeps an unexpired legacy stash';
  ASSERT (
    SELECT status FROM public.meta_oauth_attempts WHERE id = v_expired
  ) = 'expired', 'S20 purge marks the attempt expired and retains it';
  ASSERT (
    SELECT count(*) FROM public.social_accounts WHERE user_id = u_owner
  ) >= v_accounts, 'S20 purge does not remove accounts';
END
$s20$;

-- ---------------------------------------------------------------------------
-- S21. Fence ABA, membership added between two selections, a wrong subject,
--      and a direct progression generation. Page-plus second-half rollback
--      is the concurrent natural-key control, because a single session
--      cannot insert the colliding identity after this function's pre-check.
-- ---------------------------------------------------------------------------
DO $s21$
DECLARE
  u_owner uuid := '0ea00001-0000-4000-8000-000000000001';
  v_result JSONB;
  v_attempt UUID;
  v_nonce TEXT;
  v_claim TEXT;
  v_receipt JSONB;
  v_credential UUID;
  v_accounts INTEGER;
BEGIN
  -- Connection ABA: the fence high-water moves while the binding version
  -- captured at begin stays put. The commit must refuse and write nothing.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'reconnect',
    'target_social_account_id', '0ea20001-0000-4000-8000-000000000022'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  v_claim := v_result ->> 'claim_token';
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_claim,
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-a3', 'ig_username', 'moa_a3',
        'facebook_page_id', 'moa-page-a3',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-REBIND',
        'page_token_expires_in', 3600)),
      'user_token', 'synthetic-not-a-live-secret',
      'user_token_expires_in', 86400)));
  UPDATE public.facebook_user_credential_connection_fences
     SET connection_version = connection_version + 1
   WHERE social_account_id = '0ea20001-0000-4000-8000-000000000022';
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-a3'));
    RAISE EXCEPTION 'S21 failed: a connection fence ABA was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.meta_oauth_attempt_receipts WHERE attempt_id = v_attempt
  ), 'S21 a fence ABA writes no receipt';
  UPDATE public.facebook_user_credential_connection_fences
     SET connection_version = connection_version - 1
   WHERE social_account_id = '0ea20001-0000-4000-8000-000000000022';

  -- A member added after this attempt's own commit is not adopted.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_nonce := v_result ->> 'nonce';
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_nonce, 'flow', 'instagram_page_linked'));
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_result ->> 'claim_token',
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(
        jsonb_build_object(
          'ig_user_id', 'moa-ig-s21a', 'ig_username', 'moa_s21a',
          'facebook_page_id', 'moa-page-s21a',
          'page_access_token', 'synthetic-not-a-live-secret',
          'facebook_user_id', 'moa-fb-user-s21',
          'page_token_expires_in', 3600),
        jsonb_build_object(
          'ig_user_id', 'moa-ig-s21b', 'ig_username', 'moa_s21b',
          'facebook_page_id', 'moa-page-s21b',
          'page_access_token', 'synthetic-not-a-live-secret',
          'facebook_user_id', 'moa-fb-user-s21',
          'page_token_expires_in', 3600)),
      'user_token', 'synthetic-not-a-live-secret',
      'user_token_expires_in', 86400)));
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-s21a'));
  v_credential := (v_receipt ->> 'credential_id')::UUID;
  SELECT count(*) INTO v_accounts FROM public.social_accounts WHERE user_id = u_owner;
  BEGIN
    INSERT INTO public.social_accounts (
      id, user_id, platform, platform_user_id, platform_username, access_token,
      is_active, ig_auth_type
    ) VALUES (
      '0ea21021-0000-4000-8000-000000000021', u_owner, 'instagram',
      'moa-ig-s21-extra', 'moa_s21_extra', 'synthetic-not-a-live-secret',
      true, 'facebook_page');
    INSERT INTO public.instagram_account_capabilities (
      social_account_id, user_id, platform, login_kind, permission_read_state,
      granted_scopes, credential_generation, credential_updated_at, generation_reason
    ) VALUES (
      '0ea21021-0000-4000-8000-000000000021', u_owner, 'instagram', 'page_linked',
      'unknown', ARRAY[]::TEXT[], 1, clock_timestamp(), 'credential_bound');
    INSERT INTO public.facebook_user_credential_bindings (
      social_account_id, user_id, platform, credential_id,
      verified_facebook_user_id, verified_facebook_page_id,
      verified_instagram_user_id, evidence_source, connection_version
    ) VALUES (
      '0ea21021-0000-4000-8000-000000000021', u_owner, 'instagram', v_credential,
      'moa-fb-user-s21', 'moa-page-s21-extra', 'moa-ig-s21-extra',
      'oauth_exchange', 1);
    INSERT INTO public.facebook_user_credential_connection_fences (
      social_account_id, user_id, platform, connection_version
    ) VALUES (
      '0ea21021-0000-4000-8000-000000000021', u_owner, 'instagram', 1);
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-s21b'));
    RAISE EXCEPTION 'S21 failed: a member added between selections was adopted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.social_accounts WHERE id = '0ea21021-0000-4000-8000-000000000021'
  ), 'S21 the refused membership change rolls back the added account';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.meta_oauth_attempt_receipts
     WHERE attempt_id = v_attempt AND selection_key = 'instagram_page_linked:ig:moa-ig-s21b'
  ), 'S21 the second selection writes no receipt';
  ASSERT (
    SELECT count(*) FROM public.social_accounts WHERE user_id = u_owner
  ) = v_accounts, 'S21 the refused second selection creates no account';

  -- Wrong subject on reconnect stays a stale refusal. Rebind is the only
  -- path that may move the target onto a different grant.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'reconnect',
    'target_social_account_id', '0ea20001-0000-4000-8000-000000000022'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_result ->> 'nonce',
    'flow', 'instagram_page_linked'));
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_result ->> 'claim_token',
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-a3', 'ig_username', 'moa_a3',
        'facebook_page_id', 'moa-page-a3',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-WRONG',
        'page_token_expires_in', 3600)),
      'user_token', 'synthetic-not-a-live-secret',
      'user_token_expires_in', 86400)));
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-a3'));
    RAISE EXCEPTION 'S21 failed: a wrong-subject reconnect was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;

  -- Direct progression: the second selection refuses a generation change
  -- on the account this attempt already committed.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_direct', 'intent', 'connect_new'));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_result ->> 'nonce', 'flow', 'instagram_direct'));
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_result ->> 'claim_token',
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(
        jsonb_build_object('ig_user_id', 'moa-ig-dir-1', 'ig_username', 'moa_dir_1'),
        jsonb_build_object('ig_user_id', 'moa-ig-dir-2', 'ig_username', 'moa_dir_2')),
      'user_token', 'synthetic-direct-secret',
      'direct_token_expires_in', 3600)));
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_direct:ig:moa-ig-dir-1'));
  ASSERT (v_receipt ->> 'credential_id') IS NULL,
    'S21 a direct selection does not create a facebook user grant';
  UPDATE public.instagram_account_capabilities
     SET credential_generation = credential_generation + 1
   WHERE social_account_id = (v_receipt ->> 'social_account_id')::UUID;
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_direct:ig:moa-ig-dir-2'));
    RAISE EXCEPTION 'S21 failed: a direct progression generation change was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.social_accounts
     WHERE user_id = u_owner AND platform_user_id = 'moa-ig-dir-2'
  ), 'S21 a stale direct progression creates no second account';
END
$s21$;

-- ---------------------------------------------------------------------------
-- S22. The linked account is checked even when capture saw it unbound.
--      Paired replay checks both provider identities. A page-linked
--      Instagram extension may name an explicit Facebook source.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.moa_s22_page_pair(
  p_owner UUID, p_target UUID, p_linked UUID, p_ig TEXT
) RETURNS JSONB
LANGUAGE plpgsql
AS $moa_s22_page_pair$
DECLARE
  v_result JSONB;
  v_attempt UUID;
BEGIN
  v_result := public.begin_meta_oauth_attempt(p_owner, jsonb_build_object(
    'flow', 'facebook_page', 'intent', 'reconnect',
    'target_social_account_id', p_target,
    'linked_target_social_account_id', p_linked));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_result := public.claim_meta_oauth_callback(p_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_result ->> 'nonce', 'flow', 'facebook_page'));
  PERFORM public.complete_meta_oauth_callback(p_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_result ->> 'claim_token',
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'candidate_kind', 'page_plus_ig',
        'facebook_page_id', 'moa-fbpage-s22',
        'facebook_page_name', 'MOA S22 Page',
        'ig_user_id', p_ig,
        'ig_username', 'moa_s22',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-s22',
        'page_token_expires_in', 7200)),
      'user_token', 'synthetic-not-a-live-secret',
      'user_token_expires_in', 90000)));
  RETURN jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'facebook_page:page:moa-fbpage-s22:ig:' || p_ig);
END
$moa_s22_page_pair$;

DO $s22$
DECLARE
  u_owner UUID := '0ea00001-0000-4000-8000-000000000001';
  u_other UUID := '0ea00002-0000-4000-8000-000000000002';
  v_page UUID := '0ea20001-0000-4000-8000-000000000026';
  v_ig UUID := '0ea20001-0000-4000-8000-000000000027';
  v_bound UUID := '0ea20001-0000-4000-8000-000000000028';
  v_fb_source UUID := '0ea20001-0000-4000-8000-000000000029';
  v_unbound_fb UUID := '0ea20001-0000-4000-8000-00000000002b';
  v_foreign_fb UUID := '0ea20002-0000-4000-8000-00000000002c';
  v_cred UUID := '0ea90001-0000-4000-8000-000000000026';
  v_other_cred UUID := '0ea90001-0000-4000-8000-000000000027';
  v_stage JSONB;
  v_attempt UUID;
  v_key TEXT;
  v_result JSONB;
  v_receipt JSONB;
  v_version BIGINT;
  v_revision BIGINT;
BEGIN
  INSERT INTO public.facebook_user_credentials (
    id, user_id, token, revision, lifecycle, provider_user_id,
    provenance_source, provenance_captured_at
  ) VALUES (
    v_cred, u_owner, 'synthetic-s22-user', 2, 'active', 'moa-fb-user-s22',
    'oauth_exchange', '2026-10-27 09:00:00+00'::timestamptz
  );
  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, platform_username, access_token,
    is_active, ig_auth_type
  ) VALUES
    (v_page, u_owner, 'facebook', 'moa-fbpage-s22', 'moa_s22_page',
     'synthetic-page-s22', true, 'facebook_page'),
    (v_ig, u_owner, 'instagram', 'moa-ig-s22-free', 'moa_s22_free',
     'synthetic-free-s22', false, 'facebook_page'),
    (v_bound, u_owner, 'instagram', 'moa-ig-s22-bound', 'moa_s22_bound',
     'synthetic-bound-s22', true, 'facebook_page'),
    (v_fb_source, u_owner, 'facebook', 'moa-fb-user-s22', 'moa_s22_fb_source',
     'synthetic-fb-source-s22', true, 'facebook_page'),
    (v_unbound_fb, u_owner, 'facebook', 'moa-fb-unbound-s22', 'moa_s22_unbound_fb',
     'synthetic-fb-unbound-s22', true, 'facebook_page'),
    (v_foreign_fb, u_other, 'facebook', 'moa-fb-foreign-s22', 'moa_s22_foreign',
     'synthetic-fb-foreign-s22', true, 'facebook_page');
  INSERT INTO public.facebook_user_credential_bindings (
    social_account_id, user_id, platform, credential_id,
    verified_facebook_user_id, verified_facebook_page_id,
    verified_instagram_user_id, evidence_source, connection_version
  ) VALUES
    (v_page, u_owner, 'facebook', v_cred, 'moa-fb-user-s22', NULL, NULL,
     'oauth_exchange', 1),
    (v_bound, u_owner, 'instagram', v_cred, 'moa-fb-user-s22', 'moa-page-s22-bound',
     'moa-ig-s22-bound', 'oauth_exchange', 3),
    (v_fb_source, u_owner, 'facebook', v_cred, 'moa-fb-user-s22', NULL, NULL,
     'oauth_exchange', 1);
  INSERT INTO public.facebook_user_credential_connection_fences (
    social_account_id, user_id, platform, connection_version
  ) VALUES
    (v_page, u_owner, 'facebook', 1),
    (v_bound, u_owner, 'instagram', 3),
    (v_fb_source, u_owner, 'facebook', 1);
  INSERT INTO public.instagram_account_capabilities (
    social_account_id, user_id, platform, login_kind, permission_read_state,
    granted_scopes, credential_generation, credential_updated_at, generation_reason
  ) VALUES
    (v_ig, u_owner, 'instagram', 'page_linked', 'unknown', ARRAY[]::TEXT[], 1,
     '2026-10-27 09:00:00+00'::timestamptz, 'credential_bound'),
    (v_bound, u_owner, 'instagram', 'page_linked', 'unknown', ARRAY[]::TEXT[], 1,
     '2026-10-27 09:00:00+00'::timestamptz, 'credential_bound');
  INSERT INTO public.instagram_account_credentials (
    social_account_id, user_id, platform, credential_id
  ) VALUES
    (v_bound, u_owner, 'instagram', v_cred);

  v_revision := (
    SELECT revision FROM public.facebook_user_credentials WHERE id = v_cred
  );

  -- Companion generation changed after capture. It is not a grant member.
  UPDATE public.instagram_account_capabilities
     SET credential_generation = 2
   WHERE social_account_id = v_ig;
  v_stage := pg_temp.moa_s22_page_pair(u_owner, v_page, v_ig, 'moa-ig-s22-free');
  -- The update above is the live state begin captured. Move it again
  -- after capture so the commit is the thing that must refuse.
  UPDATE public.instagram_account_capabilities
     SET credential_generation = 3
   WHERE social_account_id = v_ig;
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', (v_stage ->> 'attempt_id')::UUID,
      'selection_key', v_stage ->> 'selection_key'));
    RAISE EXCEPTION 'S22 failed: a companion generation change was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  ASSERT (
    SELECT credential_generation FROM public.instagram_account_capabilities
     WHERE social_account_id = v_ig
  ) = 3, 'S22 a refused companion generation change is not rewritten';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.meta_oauth_attempt_receipts
     WHERE attempt_id = (v_stage ->> 'attempt_id')::UUID
  ), 'S22 a refused companion generation change writes no receipt';
  ASSERT (
    SELECT access_token FROM public.social_accounts WHERE id = v_ig
  ) = 'synthetic-free-s22', 'S22 a refused companion generation change keeps the companion token';
  ASSERT (
    SELECT access_token FROM public.social_accounts WHERE id = v_page
  ) = 'synthetic-page-s22', 'S22 a refused companion generation change keeps the page token';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.facebook_user_credential_bindings WHERE social_account_id = v_ig
  ), 'S22 a refused companion generation change creates no binding';
  UPDATE public.instagram_account_capabilities
     SET credential_generation = 1
   WHERE social_account_id = v_ig;

  -- Bind, then detach, after an absence capture. The fence survives.
  v_stage := pg_temp.moa_s22_page_pair(u_owner, v_page, v_ig, 'moa-ig-s22-free');
  INSERT INTO public.facebook_user_credentials (
    id, user_id, token, revision, lifecycle, provider_user_id,
    provenance_source, provenance_captured_at
  ) VALUES (
    v_other_cred, u_owner, 'synthetic-s22-other', 1, 'active', 'moa-fb-user-s22-other',
    'oauth_exchange', clock_timestamp()
  );
  v_version := public.facebook_user_credential_allocate_connection_version(
    v_ig, u_owner, 'instagram');
  INSERT INTO public.facebook_user_credential_bindings (
    social_account_id, user_id, platform, credential_id,
    verified_facebook_user_id, verified_facebook_page_id,
    verified_instagram_user_id, evidence_source, connection_version
  ) VALUES (
    v_ig, u_owner, 'instagram', v_other_cred, 'moa-fb-user-s22-other',
    'moa-page-other', 'moa-ig-s22-free', 'oauth_exchange', v_version);
  DELETE FROM public.facebook_user_credential_bindings
   WHERE social_account_id = v_ig;
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', (v_stage ->> 'attempt_id')::UUID,
      'selection_key', v_stage ->> 'selection_key'));
    RAISE EXCEPTION 'S22 failed: a companion bind then detach was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.meta_oauth_attempt_receipts
     WHERE attempt_id = (v_stage ->> 'attempt_id')::UUID
  ), 'S22 a companion fence ABA writes no receipt';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.facebook_user_credential_bindings WHERE social_account_id = v_ig
  ), 'S22 a companion fence ABA does not adopt a binding';
  ASSERT (
    SELECT access_token FROM public.social_accounts WHERE id = v_page
  ) = 'synthetic-page-s22', 'S22 a companion fence ABA keeps the page token';
  ASSERT EXISTS (
    SELECT 1 FROM public.facebook_user_credential_connection_fences
     WHERE social_account_id = v_ig AND connection_version > 0
  ), 'S22 the intervening companion fence still exists';

  -- Bind the unbound companion to a different owned grant after capture.
  v_stage := pg_temp.moa_s22_page_pair(u_owner, v_page, v_ig, 'moa-ig-s22-free');
  INSERT INTO public.facebook_user_credentials (
    id, user_id, token, revision, lifecycle, provider_user_id,
    provenance_source, provenance_captured_at
  ) VALUES (
    v_other_cred, u_owner, 'synthetic-s22-other', 1, 'active', 'moa-fb-user-s22-other',
    'oauth_exchange', clock_timestamp()
  );
  v_version := public.facebook_user_credential_allocate_connection_version(
    v_ig, u_owner, 'instagram');
  INSERT INTO public.facebook_user_credential_bindings (
    social_account_id, user_id, platform, credential_id,
    verified_facebook_user_id, verified_facebook_page_id,
    verified_instagram_user_id, evidence_source, connection_version
  ) VALUES (
    v_ig, u_owner, 'instagram', v_other_cred, 'moa-fb-user-s22-other',
    'moa-page-other', 'moa-ig-s22-free', 'oauth_exchange', v_version);
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', (v_stage ->> 'attempt_id')::UUID,
      'selection_key', v_stage ->> 'selection_key'));
    RAISE EXCEPTION 'S22 failed: a companion bind to a different grant was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  ASSERT (
    SELECT credential_id FROM public.facebook_user_credential_bindings
     WHERE social_account_id = v_ig
  ) = v_other_cred, 'S22 the intervening companion binding stays on its own grant';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.meta_oauth_attempt_receipts
     WHERE attempt_id = (v_stage ->> 'attempt_id')::UUID
  ), 'S22 a different-grant companion bind writes no receipt';
  ASSERT (
    SELECT revision FROM public.facebook_user_credentials WHERE id = v_cred
  ) = v_revision, 'S22 a different-grant companion bind does not rotate the page grant';
  DELETE FROM public.facebook_user_credential_bindings WHERE social_account_id = v_ig;

  -- Already on the page grant: a connection-version change is a refusal.
  v_stage := pg_temp.moa_s22_page_pair(u_owner, v_page, v_bound, 'moa-ig-s22-bound');
  UPDATE public.facebook_user_credential_bindings
     SET connection_version = connection_version + 1
   WHERE social_account_id = v_bound;
  UPDATE public.facebook_user_credential_connection_fences
     SET connection_version = connection_version + 1
   WHERE social_account_id = v_bound;
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', (v_stage ->> 'attempt_id')::UUID,
      'selection_key', v_stage ->> 'selection_key'));
    RAISE EXCEPTION 'S22 failed: a same-grant companion version change was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  ASSERT (
    SELECT access_token FROM public.social_accounts WHERE id = v_bound
  ) = 'synthetic-bound-s22', 'S22 a same-grant companion change keeps the companion token';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.meta_oauth_attempt_receipts
     WHERE attempt_id = (v_stage ->> 'attempt_id')::UUID
  ), 'S22 a same-grant companion change writes no receipt';
  UPDATE public.facebook_user_credential_bindings
     SET connection_version = 3 WHERE social_account_id = v_bound;
  UPDATE public.facebook_user_credential_connection_fences
     SET connection_version = 3 WHERE social_account_id = v_bound;

  -- Unchanged unbound companion. The commit itself may bind it.
  v_stage := pg_temp.moa_s22_page_pair(u_owner, v_page, v_ig, 'moa-ig-s22-free');
  v_attempt := (v_stage ->> 'attempt_id')::UUID;
  v_key := v_stage ->> 'selection_key';
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'selection_key', v_key));
  ASSERT (v_receipt ->> 'companion_social_account_id')::UUID = v_ig,
    'S22 an unchanged unbound companion is the receipt companion';
  ASSERT (
    SELECT credential_id FROM public.facebook_user_credential_bindings
     WHERE social_account_id = v_ig
  ) = v_cred, 'S22 an unchanged unbound companion joins the captured page grant';

  v_result := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'selection_key', v_key));
  ASSERT v_result = v_receipt, 'S22 an unchanged pair replays the same receipt';
  ASSERT current_setting('postora.meta_oauth_attempt', true) IS DISTINCT FROM v_attempt::TEXT,
    'S22 paired replay does not leave the attempt guard set';

  BEGIN
    UPDATE public.social_accounts
       SET platform_user_id = 'moa-ig-s22-CHANGED'
     WHERE id = v_ig;
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt, 'selection_key', v_key));
    RAISE EXCEPTION 'S22 failed: a changed companion identity was replayed';
  EXCEPTION WHEN SQLSTATE 'MOA06' THEN NULL;
  END;
  ASSERT (
    SELECT platform_user_id FROM public.social_accounts WHERE id = v_ig
  ) = 'moa-ig-s22-free', 'S22 the companion identity check does not itself write';

  BEGIN
    UPDATE public.social_accounts
       SET platform_user_id = 'moa-fbpage-s22-CHANGED'
     WHERE id = v_page;
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt, 'selection_key', v_key));
    RAISE EXCEPTION 'S22 failed: a changed primary identity was replayed';
  EXCEPTION WHEN SQLSTATE 'MOA06' THEN NULL;
  END;

  DELETE FROM public.social_accounts WHERE id = v_ig;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.meta_oauth_attempt_receipts WHERE attempt_id = v_attempt
  ), 'S22 deleting the companion cascades the receipt';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.meta_oauth_attempts WHERE id = v_attempt
  ), 'S22 deleting the companion cascades the attempt that referenced it';
  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, platform_username, access_token,
    is_active, ig_auth_type
  ) VALUES (
    '0ea20001-0000-4000-8000-00000000002d', u_owner, 'instagram',
    'moa-ig-s22-free', 'moa_s22_recreated', 'synthetic-recreated-s22',
    true, 'facebook_page');
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt, 'selection_key', v_key));
    RAISE EXCEPTION 'S22 failed: a recreated companion resurrected the receipt';
  EXCEPTION WHEN SQLSTATE 'MOA02' THEN NULL;
  END;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.meta_oauth_attempt_receipts
     WHERE attempt_id = v_attempt AND selection_key = v_key
  ), 'S22 recreation does not restore the cascaded receipt';

  -- Explicit Facebook source for a new page-linked Instagram account.
  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'add_to_existing_grant',
    'source_social_account_id', v_fb_source));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_result ->> 'nonce',
    'flow', 'instagram_page_linked'));
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_result ->> 'claim_token',
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-from-fb-source',
        'ig_username', 'moa_from_fb',
        'facebook_page_id', 'moa-page-from-fb',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-s22',
        'page_token_expires_in', 3600)),
      'user_token', 'synthetic-not-a-live-secret',
      'user_token_expires_in', 90000)));
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-from-fb-source'));
  ASSERT (v_receipt ->> 'credential_id')::UUID = v_cred,
    'S22 a Facebook source extends its own grant';
  ASSERT (
    SELECT b.credential_id
      FROM public.facebook_user_credential_bindings AS b
      JOIN public.social_accounts AS sa ON sa.id = b.social_account_id
     WHERE sa.platform_user_id = 'moa-ig-from-fb-source'
  ) = v_cred, 'S22 the new Instagram account is bound to the Facebook source grant';

  BEGIN
    PERFORM public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
      'flow', 'instagram_direct', 'intent', 'add_to_existing_grant',
      'source_social_account_id', v_fb_source));
    RAISE EXCEPTION 'S22 failed: direct Instagram accepted a Facebook source';
  EXCEPTION WHEN SQLSTATE 'MOA02' THEN NULL;
  END;

  BEGIN
    PERFORM public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
      'flow', 'instagram_page_linked', 'intent', 'add_to_existing_grant',
      'source_social_account_id', v_unbound_fb));
    RAISE EXCEPTION 'S22 failed: an unbound Facebook source was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA02' THEN NULL;
  END;

  BEGIN
    PERFORM public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
      'flow', 'instagram_page_linked', 'intent', 'add_to_existing_grant',
      'source_social_account_id', v_foreign_fb));
    RAISE EXCEPTION 'S22 failed: another user Facebook source was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA02' THEN NULL;
  END;

  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'add_to_existing_grant',
    'source_social_account_id', v_fb_source));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_result ->> 'nonce',
    'flow', 'instagram_page_linked'));
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_result ->> 'claim_token',
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-wrong-subject',
        'ig_username', 'moa_wrong_subject',
        'facebook_page_id', 'moa-page-wrong-subject',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-WRONG',
        'page_token_expires_in', 3600)),
      'user_token', 'synthetic-not-a-live-secret',
      'user_token_expires_in', 90000)));
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-wrong-subject'));
    RAISE EXCEPTION 'S22 failed: a wrong-subject Facebook source extension was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.social_accounts
     WHERE platform_user_id = 'moa-ig-wrong-subject'
  ), 'S22 a wrong-subject Facebook source creates no Instagram account';

  v_result := public.begin_meta_oauth_attempt(u_owner, jsonb_build_object(
    'flow', 'instagram_page_linked', 'intent', 'add_to_existing_grant',
    'source_social_account_id', v_bound));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_result := public.claim_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_result ->> 'nonce',
    'flow', 'instagram_page_linked'));
  PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_result ->> 'claim_token',
    'stash', jsonb_build_object(
      'candidates', jsonb_build_array(jsonb_build_object(
        'ig_user_id', 'moa-ig-from-ig-source',
        'ig_username', 'moa_from_ig',
        'facebook_page_id', 'moa-page-from-ig',
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', 'moa-fb-user-s22',
        'page_token_expires_in', 3600)),
      'user_token', 'synthetic-not-a-live-secret',
      'user_token_expires_in', 90000)));
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-from-ig-source'));
  ASSERT (v_receipt ->> 'credential_id')::UUID = v_cred,
    'S22 an ordinary Instagram source still extends its grant';
END
$s22$;

-- ---------------------------------------------------------------------------
-- S23. A later selection of the same existing-grant attempt uses the
--      progression that attempt committed. The original source capture
--      stays immutable and still supplies the source identity.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.moa_s23_open(
  p_owner UUID, p_flow TEXT, p_source UUID, p_stash JSONB
) RETURNS UUID
LANGUAGE plpgsql
AS $moa_s23_open$
DECLARE
  v_result JSONB;
  v_attempt UUID;
BEGIN
  v_result := public.begin_meta_oauth_attempt(p_owner, jsonb_build_object(
    'flow', p_flow, 'intent', 'add_to_existing_grant',
    'source_social_account_id', p_source));
  v_attempt := (v_result ->> 'attempt_id')::UUID;
  v_result := public.claim_meta_oauth_callback(p_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_result ->> 'nonce', 'flow', p_flow));
  PERFORM public.complete_meta_oauth_callback(p_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_result ->> 'claim_token',
    'stash', p_stash));
  RETURN v_attempt;
END
$moa_s23_open$;

CREATE FUNCTION pg_temp.moa_s23_ig_stash(p_subject TEXT, p_a TEXT, p_b TEXT)
RETURNS JSONB
LANGUAGE sql
AS $moa_s23_ig_stash$
  SELECT jsonb_build_object(
    'candidates', jsonb_build_array(
      jsonb_build_object(
        'ig_user_id', p_a, 'ig_username', p_a,
        'facebook_page_id', 'page-' || p_a,
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', p_subject, 'page_token_expires_in', 7200),
      jsonb_build_object(
        'ig_user_id', p_b, 'ig_username', p_b,
        'facebook_page_id', 'page-' || p_b,
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', p_subject, 'page_token_expires_in', 7200)),
    'user_token', 'synthetic-not-a-live-secret',
    'user_token_expires_in', 90000);
$moa_s23_ig_stash$;

CREATE FUNCTION pg_temp.moa_s23_page_stash(p_subject TEXT, p_a TEXT, p_b TEXT)
RETURNS JSONB
LANGUAGE sql
AS $moa_s23_page_stash$
  SELECT jsonb_build_object(
    'candidates', jsonb_build_array(
      jsonb_build_object(
        'candidate_kind', 'page_only',
        'facebook_page_id', p_a, 'facebook_page_name', p_a,
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', p_subject, 'page_token_expires_in', 7200),
      jsonb_build_object(
        'candidate_kind', 'page_only',
        'facebook_page_id', p_b, 'facebook_page_name', p_b,
        'page_access_token', 'synthetic-not-a-live-secret',
        'facebook_user_id', p_subject, 'page_token_expires_in', 7200)),
    'user_token', 'synthetic-not-a-live-secret',
    'user_token_expires_in', 90000);
$moa_s23_page_stash$;

DO $s23$
DECLARE
  u_owner UUID := '0ea00001-0000-4000-8000-000000000001';
  v_cred UUID := '0ea90001-0000-4000-8000-000000000031';
  v_ig_source UUID := '0ea20001-0000-4000-8000-000000000031';
  v_sibling UUID := '0ea20001-0000-4000-8000-000000000032';
  v_fb_source UUID := '0ea20001-0000-4000-8000-000000000033';
  v_page_ig_source UUID := '0ea20001-0000-4000-8000-000000000034';
  v_page_fb_source UUID := '0ea20001-0000-4000-8000-000000000035';
  v_neg_source UUID := '0ea20001-0000-4000-8000-000000000036';
  v_neg_sibling UUID := '0ea20001-0000-4000-8000-000000000037';
  v_neg_cred UUID := '0ea90001-0000-4000-8000-000000000032';
  v_other_cred UUID := '0ea90001-0000-4000-8000-000000000033';
  v_other_holder UUID := '0ea20001-0000-4000-8000-000000000038';
  v_extra UUID := '0ea20001-0000-4000-8000-000000000039';
  v_attempt UUID;
  v_receipt JSONB;
  v_replay JSONB;
  v_revision BIGINT;
  v_generation BIGINT;
  v_before JSONB;
  v_after JSONB;
  v_accounts INTEGER;
BEGIN
  INSERT INTO public.facebook_user_credentials (
    id, user_id, token, revision, lifecycle, provider_user_id,
    provenance_source, provenance_captured_at
  ) VALUES
    (v_cred, u_owner, 'synthetic-s23-user', 3, 'active', 'moa-fb-user-s23',
     'oauth_exchange', '2026-10-27 09:00:00+00'),
    (v_neg_cred, u_owner, 'synthetic-s23-neg', 3, 'active', 'moa-fb-user-s23n',
     'oauth_exchange', '2026-10-27 09:00:00+00'),
    (v_other_cred, u_owner, 'synthetic-s23-other', 1, 'active', 'moa-fb-user-s23o',
     'oauth_exchange', '2026-10-27 09:00:00+00');
  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, platform_username, access_token,
    is_active, ig_auth_type
  ) VALUES
    (v_ig_source, u_owner, 'instagram', 'moa-ig-s23-src', 'moa_s23_src',
     'synthetic-s23-src', true, 'facebook_page'),
    (v_sibling, u_owner, 'instagram', 'moa-ig-s23-sib', 'moa_s23_sib',
     'synthetic-s23-sib', true, 'facebook_page'),
    (v_fb_source, u_owner, 'facebook', 'moa-fb-user-s23', 'moa_s23_fb',
     'synthetic-s23-fb', true, 'facebook_page'),
    (v_page_ig_source, u_owner, 'instagram', 'moa-ig-s23-page-src', 'moa_s23_pis',
     'synthetic-s23-pis', true, 'facebook_page'),
    (v_page_fb_source, u_owner, 'facebook', 'moa-fb-user-s23p', 'moa_s23_pfb',
     'synthetic-s23-pfb', true, 'facebook_page'),
    (v_neg_source, u_owner, 'instagram', 'moa-ig-s23-neg', 'moa_s23_neg',
     'synthetic-s23-neg', true, 'facebook_page'),
    (v_neg_sibling, u_owner, 'instagram', 'moa-ig-s23-neg-sib', 'moa_s23_ns',
     'synthetic-s23-ns', true, 'facebook_page'),
    (v_other_holder, u_owner, 'instagram', 'moa-ig-s23-holder', 'moa_s23_hold',
     'synthetic-s23-hold', true, 'facebook_page'),
    (v_extra, u_owner, 'instagram', 'moa-ig-s23-extra', 'moa_s23_extra',
     'synthetic-s23-extra', false, 'facebook_page');
  INSERT INTO public.facebook_user_credential_bindings (
    social_account_id, user_id, platform, credential_id,
    verified_facebook_user_id, verified_facebook_page_id,
    verified_instagram_user_id, evidence_source, connection_version
  ) VALUES
    (v_ig_source, u_owner, 'instagram', v_cred, 'moa-fb-user-s23',
     'moa-page-s23-src', 'moa-ig-s23-src', 'oauth_exchange', 4),
    (v_sibling, u_owner, 'instagram', v_cred, 'moa-fb-user-s23',
     'moa-page-s23-sib', 'moa-ig-s23-sib', 'oauth_exchange', 2),
    (v_fb_source, u_owner, 'facebook', v_cred, 'moa-fb-user-s23',
     NULL, NULL, 'oauth_exchange', 1),
    (v_page_ig_source, u_owner, 'instagram', v_cred, 'moa-fb-user-s23',
     'moa-page-s23-pis', 'moa-ig-s23-page-src', 'oauth_exchange', 4),
    (v_page_fb_source, u_owner, 'facebook', v_cred, 'moa-fb-user-s23',
     NULL, NULL, 'oauth_exchange', 1),
    (v_neg_source, u_owner, 'instagram', v_neg_cred, 'moa-fb-user-s23n',
     'moa-page-s23-neg', 'moa-ig-s23-neg', 'oauth_exchange', 4),
    (v_neg_sibling, u_owner, 'instagram', v_neg_cred, 'moa-fb-user-s23n',
     'moa-page-s23-ns', 'moa-ig-s23-neg-sib', 'oauth_exchange', 2),
    (v_other_holder, u_owner, 'instagram', v_other_cred, 'moa-fb-user-s23o',
     'moa-page-s23-hold', 'moa-ig-s23-holder', 'oauth_exchange', 1);
  INSERT INTO public.facebook_user_credential_connection_fences (
    social_account_id, user_id, platform, connection_version
  ) VALUES
    (v_ig_source, u_owner, 'instagram', 4),
    (v_sibling, u_owner, 'instagram', 2),
    (v_fb_source, u_owner, 'facebook', 1),
    (v_page_ig_source, u_owner, 'instagram', 4),
    (v_page_fb_source, u_owner, 'facebook', 1),
    (v_neg_source, u_owner, 'instagram', 4),
    (v_neg_sibling, u_owner, 'instagram', 2),
    (v_other_holder, u_owner, 'instagram', 1);
  INSERT INTO public.instagram_account_capabilities (
    social_account_id, user_id, platform, login_kind, permission_read_state,
    granted_scopes, credential_generation, credential_updated_at, generation_reason
  ) VALUES
    (v_ig_source, u_owner, 'instagram', 'page_linked', 'unknown', ARRAY[]::TEXT[], 2,
     '2026-10-27 09:00:00+00', 'credential_bound'),
    (v_sibling, u_owner, 'instagram', 'page_linked', 'unknown', ARRAY[]::TEXT[], 1,
     '2026-10-27 09:00:00+00', 'credential_bound'),
    (v_page_ig_source, u_owner, 'instagram', 'page_linked', 'unknown', ARRAY[]::TEXT[], 2,
     '2026-10-27 09:00:00+00', 'credential_bound'),
    (v_neg_source, u_owner, 'instagram', 'page_linked', 'unknown', ARRAY[]::TEXT[], 2,
     '2026-10-27 09:00:00+00', 'credential_bound'),
    (v_neg_sibling, u_owner, 'instagram', 'page_linked', 'unknown', ARRAY[]::TEXT[], 1,
     '2026-10-27 09:00:00+00', 'credential_bound'),
    (v_other_holder, u_owner, 'instagram', 'page_linked', 'unknown', ARRAY[]::TEXT[], 1,
     '2026-10-27 09:00:00+00', 'credential_bound'),
    (v_extra, u_owner, 'instagram', 'page_linked', 'unknown', ARRAY[]::TEXT[], 1,
     '2026-10-27 09:00:00+00', 'credential_bound');

  -- Two Instagram selections from an Instagram source. The second reuses
  -- the progression and does not rotate the grant again.
  v_attempt := pg_temp.moa_s23_open(
    u_owner, 'instagram_page_linked', v_ig_source,
    pg_temp.moa_s23_ig_stash('moa-fb-user-s23', 'moa-ig-s23-a', 'moa-ig-s23-b'));
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-s23-a'));
  v_revision := (SELECT revision FROM public.facebook_user_credentials WHERE id = v_cred);
  v_generation := (
    SELECT credential_generation FROM public.instagram_account_capabilities
     WHERE social_account_id = v_ig_source);
  ASSERT v_revision = 4, 'S23 the first selection rotates the shared grant once';
  ASSERT v_generation = 3, 'S23 the first selection advances the source generation';
  v_replay := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-s23-a'));
  ASSERT v_replay = v_receipt, 'S23 the first receipt replays without a new write';
  ASSERT (
    SELECT revision FROM public.facebook_user_credentials WHERE id = v_cred
  ) = v_revision, 'S23 replaying the first receipt does not rotate the grant';
  ASSERT (
    SELECT count(*) FROM public.meta_oauth_attempt_receipts WHERE attempt_id = v_attempt
  ) = 1, 'S23 replay does not insert a second receipt';
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-s23-b'));
  ASSERT (
    SELECT count(*) FROM public.meta_oauth_attempt_receipts WHERE attempt_id = v_attempt
  ) = 2, 'S23 both Instagram selections have receipts';
  ASSERT (
    SELECT count(DISTINCT b.credential_id)
      FROM public.facebook_user_credential_bindings AS b
      JOIN public.social_accounts AS sa ON sa.id = b.social_account_id
     WHERE sa.platform_user_id IN ('moa-ig-s23-a', 'moa-ig-s23-b', 'moa-ig-s23-src')
  ) = 1, 'S23 both new accounts and the source share one grant';
  ASSERT (
    SELECT revision FROM public.facebook_user_credentials WHERE id = v_cred
  ) = v_revision, 'S23 the second selection does not rotate the grant again';
  ASSERT (
    SELECT credential_generation FROM public.instagram_account_capabilities
     WHERE social_account_id = v_ig_source
  ) = v_generation, 'S23 the second selection does not advance the source again';
  ASSERT (
    SELECT capture -> 'source' ->> 'credential_revision'
      FROM public.meta_oauth_attempts WHERE id = v_attempt
  ) = '3', 'S23 the original source capture stays at the pre-commit revision';

  -- Two Instagram selections from an explicit Facebook source. No Page row.
  v_attempt := pg_temp.moa_s23_open(
    u_owner, 'instagram_page_linked', v_fb_source,
    pg_temp.moa_s23_ig_stash('moa-fb-user-s23', 'moa-ig-s23-fb-a', 'moa-ig-s23-fb-b'));
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-s23-fb-a'));
  v_revision := (SELECT revision FROM public.facebook_user_credentials WHERE id = v_cred);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-s23-fb-b'));
  ASSERT (
    SELECT count(*) FROM public.meta_oauth_attempt_receipts WHERE attempt_id = v_attempt
  ) = 2, 'S23 a Facebook source extends twice';
  ASSERT (
    SELECT revision FROM public.facebook_user_credentials WHERE id = v_cred
  ) = v_revision, 'S23 the Facebook-source second selection does not rotate again';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.social_accounts
     WHERE platform = 'facebook'
       AND platform_user_id IN ('page-moa-ig-s23-fb-a', 'page-moa-ig-s23-fb-b')
  ), 'S23 an Instagram extension does not upsert a Page candidate';

  -- Two Page candidates from a Facebook source, then from an Instagram source.
  v_attempt := pg_temp.moa_s23_open(
    u_owner, 'facebook_page', v_page_fb_source,
    pg_temp.moa_s23_page_stash('moa-fb-user-s23', 'moa-page-s23-a', 'moa-page-s23-b'));
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'facebook_page:page:moa-page-s23-a'));
  v_revision := (SELECT revision FROM public.facebook_user_credentials WHERE id = v_cred);
  v_replay := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'facebook_page:page:moa-page-s23-a'));
  ASSERT (
    SELECT count(*) FROM public.meta_oauth_attempt_receipts WHERE attempt_id = v_attempt
  ) = 1, 'S23 replaying the first Page receipt writes nothing';
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'facebook_page:page:moa-page-s23-b'));
  ASSERT (
    SELECT count(*) FROM public.social_accounts
     WHERE platform = 'facebook'
       AND platform_user_id IN ('moa-page-s23-a', 'moa-page-s23-b')
  ) = 2, 'S23 both Page candidates are committed';
  ASSERT (
    SELECT revision FROM public.facebook_user_credentials WHERE id = v_cred
  ) = v_revision, 'S23 the second Page selection does not rotate the grant';

  v_attempt := pg_temp.moa_s23_open(
    u_owner, 'facebook_page', v_page_ig_source,
    pg_temp.moa_s23_page_stash('moa-fb-user-s23', 'moa-page-s23-c', 'moa-page-s23-d'));
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'facebook_page:page:moa-page-s23-c'));
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'facebook_page:page:moa-page-s23-d'));
  ASSERT (
    SELECT count(*) FROM public.meta_oauth_attempt_receipts WHERE attempt_id = v_attempt
  ) = 2, 'S23 an Instagram source can extend two Page candidates';

  -- Outside changes after the first selection. Each uses a fresh pair on
  -- the negative grant, whose first commit is allowed to rotate it.
  v_attempt := pg_temp.moa_s23_open(
    u_owner, 'instagram_page_linked', v_neg_source,
    pg_temp.moa_s23_ig_stash('moa-fb-user-s23n', 'moa-ig-s23-n1', 'moa-ig-s23-n2'));
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-s23-n1'));
  PERFORM public.bump_instagram_credential_generation(
    v_neg_source, u_owner, 'credential_replaced',
    (SELECT credential_generation
       FROM public.instagram_account_capabilities
      WHERE social_account_id = v_neg_source));
  v_before := jsonb_build_object(
    'receipts', (SELECT count(*) FROM public.meta_oauth_attempt_receipts WHERE attempt_id = v_attempt),
    'second', (SELECT count(*) FROM public.social_accounts WHERE platform_user_id = 'moa-ig-s23-n2'),
    'revision', (SELECT revision FROM public.facebook_user_credentials WHERE id = v_neg_cred),
    'generation', (SELECT credential_generation FROM public.instagram_account_capabilities WHERE social_account_id = v_neg_source),
    'progression', (SELECT authority_progression FROM public.meta_oauth_attempts WHERE id = v_attempt),
    'stash', (SELECT ig_candidates_json FROM public.oauth_pending_instagram_selections WHERE meta_oauth_attempt_id = v_attempt));
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-s23-n2'));
    RAISE EXCEPTION 'S23 failed: a source generation bump was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  v_after := jsonb_build_object(
    'receipts', (SELECT count(*) FROM public.meta_oauth_attempt_receipts WHERE attempt_id = v_attempt),
    'second', (SELECT count(*) FROM public.social_accounts WHERE platform_user_id = 'moa-ig-s23-n2'),
    'revision', (SELECT revision FROM public.facebook_user_credentials WHERE id = v_neg_cred),
    'generation', (SELECT credential_generation FROM public.instagram_account_capabilities WHERE social_account_id = v_neg_source),
    'progression', (SELECT authority_progression FROM public.meta_oauth_attempts WHERE id = v_attempt),
    'stash', (SELECT ig_candidates_json FROM public.oauth_pending_instagram_selections WHERE meta_oauth_attempt_id = v_attempt));
  ASSERT v_after = v_before, 'S23 a refused source generation change leaves the attempt untouched';

  v_attempt := pg_temp.moa_s23_open(
    u_owner, 'instagram_page_linked', v_neg_source,
    pg_temp.moa_s23_ig_stash('moa-fb-user-s23n', 'moa-ig-s23-n3', 'moa-ig-s23-n4'));
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-s23-n3'));
  PERFORM public.bump_instagram_credential_generation(
    v_neg_sibling, u_owner, 'credential_replaced',
    (SELECT credential_generation
       FROM public.instagram_account_capabilities
      WHERE social_account_id = v_neg_sibling));
  v_accounts := (SELECT count(*) FROM public.social_accounts WHERE user_id = u_owner);
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-s23-n4'));
    RAISE EXCEPTION 'S23 failed: a sibling generation bump was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.social_accounts WHERE platform_user_id = 'moa-ig-s23-n4'
  ), 'S23 a refused sibling change creates no account';
  ASSERT (
    SELECT count(*) FROM public.social_accounts WHERE user_id = u_owner
  ) = v_accounts, 'S23 a refused sibling change creates no account at all';

  v_attempt := pg_temp.moa_s23_open(
    u_owner, 'instagram_page_linked', v_neg_source,
    pg_temp.moa_s23_ig_stash('moa-fb-user-s23n', 'moa-ig-s23-n5', 'moa-ig-s23-n6'));
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-s23-n5'));
  UPDATE public.facebook_user_credential_connection_fences
     SET connection_version = connection_version + 1
   WHERE social_account_id = v_neg_source;
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-s23-n6'));
    RAISE EXCEPTION 'S23 failed: a source fence ABA was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.social_accounts WHERE platform_user_id = 'moa-ig-s23-n6'
  ), 'S23 a source fence ABA creates no account';
  ASSERT (
    SELECT count(*) FROM public.meta_oauth_attempt_receipts WHERE attempt_id = v_attempt
  ) = 1, 'S23 a source fence ABA writes no second receipt';
  -- The refusal kept the advanced fence. Put it back beside the binding so
  -- the next attempt captures one consistent version, not a leftover ABA.
  UPDATE public.facebook_user_credential_connection_fences AS f
     SET connection_version = b.connection_version
    FROM public.facebook_user_credential_bindings AS b
   WHERE f.social_account_id = v_neg_source
     AND b.social_account_id = f.social_account_id;

  v_attempt := pg_temp.moa_s23_open(
    u_owner, 'instagram_page_linked', v_neg_source,
    pg_temp.moa_s23_ig_stash('moa-fb-user-s23n', 'moa-ig-s23-n7', 'moa-ig-s23-n8'));
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-s23-n7'));
  v_generation := public.facebook_user_credential_allocate_connection_version(
    v_extra, u_owner, 'instagram');
  INSERT INTO public.facebook_user_credential_bindings (
    social_account_id, user_id, platform, credential_id,
    verified_facebook_user_id, verified_facebook_page_id,
    verified_instagram_user_id, evidence_source, connection_version
  ) VALUES (
    v_extra, u_owner, 'instagram', v_neg_cred, 'moa-fb-user-s23n',
    'moa-page-s23-extra', 'moa-ig-s23-extra', 'oauth_exchange', v_generation);
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-s23-n8'));
    RAISE EXCEPTION 'S23 failed: an added grant member was adopted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.social_accounts WHERE platform_user_id = 'moa-ig-s23-n8'
  ), 'S23 an added member creates no selected account';

  v_attempt := pg_temp.moa_s23_open(
    u_owner, 'instagram_page_linked', v_neg_source,
    pg_temp.moa_s23_ig_stash('moa-fb-user-s23n', 'moa-ig-s23-n9', 'moa-ig-s23-n10'));
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-s23-n9'));
  UPDATE public.facebook_user_credentials
     SET revision = revision + 1
   WHERE id = v_neg_cred;
  v_before := jsonb_build_object(
    'receipts', (SELECT count(*) FROM public.meta_oauth_attempt_receipts WHERE attempt_id = v_attempt),
    'revision', (SELECT revision FROM public.facebook_user_credentials WHERE id = v_neg_cred),
    'progression', (SELECT authority_progression FROM public.meta_oauth_attempts WHERE id = v_attempt));
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-s23-n10'));
    RAISE EXCEPTION 'S23 failed: a shared secret rotation was adopted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  ASSERT v_before = jsonb_build_object(
    'receipts', (SELECT count(*) FROM public.meta_oauth_attempt_receipts WHERE attempt_id = v_attempt),
    'revision', (SELECT revision FROM public.facebook_user_credentials WHERE id = v_neg_cred),
    'progression', (SELECT authority_progression FROM public.meta_oauth_attempts WHERE id = v_attempt)
  ), 'S23 a refused secret rotation leaves the receipt and progression';

  v_attempt := pg_temp.moa_s23_open(
    u_owner, 'instagram_page_linked', v_neg_source,
    pg_temp.moa_s23_ig_stash('moa-fb-user-s23n', 'moa-ig-s23-n11', 'moa-ig-s23-n12'));
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-s23-n11'));
  DELETE FROM public.facebook_user_credential_bindings
   WHERE social_account_id = v_neg_source;
  v_generation := public.facebook_user_credential_allocate_connection_version(
    v_neg_source, u_owner, 'instagram');
  INSERT INTO public.facebook_user_credential_bindings (
    social_account_id, user_id, platform, credential_id,
    verified_facebook_user_id, verified_facebook_page_id,
    verified_instagram_user_id, evidence_source, connection_version
  ) VALUES (
    v_neg_source, u_owner, 'instagram', v_other_cred, 'moa-fb-user-s23o',
    'moa-page-s23-moved', 'moa-ig-s23-neg', 'oauth_exchange', v_generation);
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-s23-n12'));
    RAISE EXCEPTION 'S23 failed: a detached and rebound source was adopted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  ASSERT (
    SELECT credential_id FROM public.facebook_user_credential_bindings
     WHERE social_account_id = v_neg_source
  ) = v_other_cred, 'S23 the refused selection does not move the rebound source back';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.social_accounts WHERE platform_user_id = 'moa-ig-s23-n12'
  ), 'S23 a rebound source creates no selected account';

  UPDATE public.social_accounts
     SET platform_user_id = 'moa-ig-s23-neg'
   WHERE id = v_neg_source;
  DELETE FROM public.facebook_user_credential_bindings WHERE social_account_id = v_neg_source;
  v_generation := public.facebook_user_credential_allocate_connection_version(
    v_neg_source, u_owner, 'instagram');
  INSERT INTO public.facebook_user_credential_bindings (
    social_account_id, user_id, platform, credential_id,
    verified_facebook_user_id, verified_facebook_page_id,
    verified_instagram_user_id, evidence_source, connection_version
  ) VALUES (
    v_neg_source, u_owner, 'instagram', v_neg_cred, 'moa-fb-user-s23n',
    'moa-page-s23-back', 'moa-ig-s23-neg', 'oauth_exchange', v_generation);
  v_attempt := pg_temp.moa_s23_open(
    u_owner, 'instagram_page_linked', v_neg_source,
    pg_temp.moa_s23_ig_stash('moa-fb-user-s23n', 'moa-ig-s23-n13', 'moa-ig-s23-n14'));
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', 'instagram_page_linked:ig:moa-ig-s23-n13'));
  UPDATE public.social_accounts
     SET platform_user_id = 'moa-ig-s23-neg-changed'
   WHERE id = v_neg_source;
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_attempt,
      'selection_key', 'instagram_page_linked:ig:moa-ig-s23-n14'));
    RAISE EXCEPTION 'S23 failed: a changed source identity was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  ASSERT (
    SELECT platform_user_id FROM public.social_accounts WHERE id = v_neg_source
  ) = 'moa-ig-s23-neg-changed', 'S23 the identity refusal does not rewrite the source';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.social_accounts WHERE platform_user_id = 'moa-ig-s23-n14'
  ), 'S23 a changed source identity creates no selected account';
END
$s23$;

ROLLBACK;

\echo '=== meta_oauth_attempt_lifecycle: ALL CHECKS PASSED ==='
