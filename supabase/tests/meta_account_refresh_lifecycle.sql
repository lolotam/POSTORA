-- supabase/tests/meta_account_refresh_lifecycle.sql
-- Direct-Instagram and Meta refresh transactions (migration 20261027120000).
--
-- One transaction, synthetic fixtures, ROLLBACK. No provider calls, no real
-- tokens, no network. Proves the coherent capture, the direct writer, the
-- captured shared-grant rotation, and the exactly-preserved failure event.
--
-- The suite runs as the harness superuser, so every refusal here is a
-- refusal that survived the service role, not a browser denial.

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures.
--
--   owner A  0f100001-...  workspaces W1 (with a subscriber) and W2 (without)
--   A1 direct Instagram, no Facebook binding
--   A2 page-linked Instagram, bound to the shared grant C1, in W1
--   A3 page-linked Instagram, the sibling of A2 on C1, in W1
--   A4 Facebook page, the third member of C1, in W1
--   A5 direct Instagram with no workspace and no personal workspace
--   A6 direct Instagram in W2, a workspace with no subscriber
--   A7 direct Instagram in W1, used by the injected outbox failure
--   owner B  0f100002-...  its own direct Instagram account
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email)
VALUES
  ('0f100001-0000-4000-8000-000000000001', 'mar-a@example.invalid'),
  ('0f100002-0000-4000-8000-000000000002', 'mar-b@example.invalid');

INSERT INTO public.workspaces (id, name, owner_id, is_personal)
VALUES
  ('0f190001-0000-4000-8000-000000000001', 'mar-w1',
   '0f100001-0000-4000-8000-000000000001', false),
  ('0f190002-0000-4000-8000-000000000002', 'mar-w2',
   '0f100001-0000-4000-8000-000000000001', false);

INSERT INTO public.social_accounts
  (id, user_id, workspace_id, platform, platform_user_id, platform_username,
   access_token, refresh_token, token_expires_at, is_active, failure_count,
   needs_reauth, last_refresh_error, last_alert_sent_at)
VALUES
  ('0f1a0001-0000-4000-8000-000000000011', '0f100001-0000-4000-8000-000000000001',
   '0f190001-0000-4000-8000-000000000001', 'instagram', 'ig-direct-1', 'ig_direct_1',
   'direct-token-1', 'direct-refresh-1', '2027-01-01T00:00:00Z', true, 0, false, NULL, NULL),
  ('0f1a0002-0000-4000-8000-000000000012', '0f100001-0000-4000-8000-000000000001',
   '0f190001-0000-4000-8000-000000000001', 'instagram', 'ig-page-1', 'ig_page_1',
   'page-token-1', 'page-refresh-1', '2027-01-02T00:00:00Z', true, 0, false, NULL, NULL),
  ('0f1a0003-0000-4000-8000-000000000013', '0f100001-0000-4000-8000-000000000001',
   '0f190001-0000-4000-8000-000000000001', 'instagram', 'ig-page-2', 'ig_page_2',
   'page-token-2', NULL, '2027-01-03T00:00:00Z', true, 0, false, NULL, NULL),
  ('0f1a0004-0000-4000-8000-000000000014', '0f100001-0000-4000-8000-000000000001',
   '0f190001-0000-4000-8000-000000000001', 'facebook', 'fb-page-1', 'fb_page_1',
   'fb-page-token-1', NULL, NULL, true, 0, false, NULL, NULL),
  ('0f1a0005-0000-4000-8000-000000000015', '0f100001-0000-4000-8000-000000000001',
   NULL, 'instagram', 'ig-noworkspace-1', 'ig_noworkspace_1',
   'nows-token-1', NULL, '2027-01-04T00:00:00Z', true, 0, false, NULL, NULL),
  ('0f1a0006-0000-4000-8000-000000000016', '0f100001-0000-4000-8000-000000000001',
   '0f190002-0000-4000-8000-000000000002', 'instagram', 'ig-nosub-1', 'ig_nosub_1',
   'nosub-token-1', NULL, '2027-01-05T00:00:00Z', true, 0, false, NULL, NULL),
  ('0f1a0007-0000-4000-8000-000000000017', '0f100001-0000-4000-8000-000000000001',
   '0f190001-0000-4000-8000-000000000001', 'instagram', 'ig-injected-1', 'ig_injected_1',
   'injected-token-1', NULL, '2027-01-06T00:00:00Z', true, 0, false, NULL, NULL),
  ('0f2a0001-0000-4000-8000-000000000021', '0f100002-0000-4000-8000-000000000002',
   NULL, 'instagram', 'ig-direct-b', 'ig_direct_b',
   'direct-token-b', NULL, '2027-01-07T00:00:00Z', true, 0, false, NULL, NULL),
  ('0f1a0009-0000-4000-8000-000000000019', '0f100001-0000-4000-8000-000000000001',
   NULL, 'instagram', 'ig-aba-1', 'ig_aba_1',
   'aba-token-1', NULL, '2027-01-08T00:00:00Z', true, 0, false, NULL, NULL),
  ('0f1a0010-0000-4000-8000-000000000020', '0f100001-0000-4000-8000-000000000001',
   '0f190001-0000-4000-8000-000000000001', 'instagram', 'ig-stale-1', 'ig_stale_1',
   'stale-token-1', NULL, '2027-01-09T00:00:00Z', true, 0, false, NULL, NULL);

-- The shared Facebook User grant. One secret, three members.
INSERT INTO public.facebook_user_credentials (
  id, user_id, token, revision, lifecycle, token_expires_at, provider_user_id,
  provenance_source, provenance_captured_at
) VALUES (
  '0f1c0001-0000-4000-8000-000000000031', '0f100001-0000-4000-8000-000000000001',
  'user-token-1', 1, 'active', '2027-02-01T00:00:00Z', 'fb-user-1',
  'oauth_exchange', '2026-10-01T00:00:00Z'
);

INSERT INTO public.facebook_user_credential_bindings (
  social_account_id, user_id, platform, credential_id,
  verified_facebook_user_id, verified_facebook_page_id, verified_instagram_user_id,
  evidence_source, connection_version
) VALUES
  ('0f1a0002-0000-4000-8000-000000000012', '0f100001-0000-4000-8000-000000000001',
   'instagram', '0f1c0001-0000-4000-8000-000000000031',
   'fb-user-1', 'page-1', 'ig-page-1', 'oauth_exchange', 1),
  ('0f1a0003-0000-4000-8000-000000000013', '0f100001-0000-4000-8000-000000000001',
   'instagram', '0f1c0001-0000-4000-8000-000000000031',
   'fb-user-1', 'page-1', 'ig-page-2', 'oauth_exchange', 1),
  ('0f1a0004-0000-4000-8000-000000000014', '0f100001-0000-4000-8000-000000000001',
   'facebook', '0f1c0001-0000-4000-8000-000000000031',
   'fb-user-1', NULL, NULL, 'oauth_exchange', 1);

INSERT INTO public.facebook_user_credential_connection_fences (
  social_account_id, user_id, platform, connection_version
) VALUES
  ('0f1a0002-0000-4000-8000-000000000012', '0f100001-0000-4000-8000-000000000001',
   'instagram', 1),
  ('0f1a0003-0000-4000-8000-000000000013', '0f100001-0000-4000-8000-000000000001',
   'instagram', 1),
  ('0f1a0004-0000-4000-8000-000000000014', '0f100001-0000-4000-8000-000000000001',
   'facebook', 1);

INSERT INTO public.instagram_account_capabilities (
  social_account_id, user_id, platform, login_kind, permission_read_state,
  granted_scopes, scopes_read_at, credential_generation
) VALUES
  ('0f1a0001-0000-4000-8000-000000000011', '0f100001-0000-4000-8000-000000000001',
   'instagram', 'direct', 'unknown', ARRAY[]::TEXT[], NULL, 3),
  ('0f1a0002-0000-4000-8000-000000000012', '0f100001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_basic'], '2026-10-20T00:00:00Z', 2),
  ('0f1a0003-0000-4000-8000-000000000013', '0f100001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_basic'], '2026-10-20T00:00:00Z', 2),
  ('0f1a0005-0000-4000-8000-000000000015', '0f100001-0000-4000-8000-000000000001',
   'instagram', 'direct', 'unknown', ARRAY[]::TEXT[], NULL, 1),
  ('0f1a0006-0000-4000-8000-000000000016', '0f100001-0000-4000-8000-000000000001',
   'instagram', 'direct', 'unknown', ARRAY[]::TEXT[], NULL, 1),
  ('0f1a0007-0000-4000-8000-000000000017', '0f100001-0000-4000-8000-000000000001',
   'instagram', 'direct', 'unknown', ARRAY[]::TEXT[], NULL, 1),
  ('0f2a0001-0000-4000-8000-000000000021', '0f100002-0000-4000-8000-000000000002',
   'instagram', 'direct', 'unknown', ARRAY[]::TEXT[], NULL, 1),
  ('0f1a0009-0000-4000-8000-000000000019', '0f100001-0000-4000-8000-000000000001',
   'instagram', 'direct', 'unknown', ARRAY[]::TEXT[], NULL, 1),
  ('0f1a0010-0000-4000-8000-000000000020', '0f100001-0000-4000-8000-000000000001',
   'instagram', 'direct', 'unknown', ARRAY[]::TEXT[], NULL, 1);

-- The partner substrate. One workspace with one subscriber to the
-- reauthorization event, one workspace with none.
INSERT INTO public.partner_api_keys (
  workspace_id, social_account_id, key_hash, key_prefix, name, scopes
) VALUES (
  '0f190001-0000-4000-8000-000000000001',
  '0f1a0002-0000-4000-8000-000000000012',
  'mar-hash-a', 'pk_live_mara', 'mar-key-a', ARRAY['webhooks:manage']
);

INSERT INTO public.partner_webhooks (
  workspace_id, created_by_key_id, url, events, secret
) VALUES (
  '0f190001-0000-4000-8000-000000000001',
  (SELECT id FROM public.partner_api_keys WHERE key_hash = 'mar-hash-a'),
  'https://hooks.example.com/mar-1',
  ARRAY['account.reauthorization_required'],
  'mar-secret-1'
);

-- ---------------------------------------------------------------------------
-- S1. The boundary. Service-only relation, service-only RPCs, owner-only
--     helpers, and no secret column.
-- ---------------------------------------------------------------------------
DO $s1$
DECLARE
  p_name TEXT;
  f_sig regprocedure;
  v_helper RECORD;
BEGIN
  ASSERT (SELECT c.relrowsecurity
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public'
             AND c.relname = 'meta_account_refresh_captures'),
    'S1 RLS is enabled on the capture relation';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'meta_account_refresh_captures'
  ), 'S1 no browser policy exists on the capture relation';

  FOREACH p_name IN ARRAY ARRAY[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES',
    'TRIGGER', 'MAINTAIN'
  ] LOOP
    ASSERT NOT has_table_privilege('anon', 'public.meta_account_refresh_captures', p_name),
      format('S1 anon holds no %s privilege on the capture relation', p_name);
    ASSERT NOT has_table_privilege('authenticated', 'public.meta_account_refresh_captures', p_name),
      format('S1 authenticated holds no %s privilege on the capture relation', p_name);
  END LOOP;

  FOREACH p_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    ASSERT has_table_privilege('service_role', 'public.meta_account_refresh_captures', p_name),
      format('S1 service_role keeps %s on the capture relation', p_name);
  END LOOP;

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'meta_account_refresh_captures'
       AND column_name IN ('token', 'access_token', 'refresh_token', 'secret')
  ), 'S1 the capture relation holds no secret column';

  FOREACH f_sig IN ARRAY ARRAY[
    'public.begin_meta_account_refresh(uuid,jsonb)',
    'public.write_direct_instagram_account(uuid,jsonb)',
    'public.write_meta_account_refresh_success(uuid,jsonb)',
    'public.record_meta_refresh_failure(uuid,jsonb)'
  ]::regprocedure[] LOOP
    ASSERT has_function_privilege('service_role', f_sig, 'EXECUTE'),
      format('S1 service_role may execute %s', f_sig);
    ASSERT NOT has_function_privilege('anon', f_sig, 'EXECUTE'),
      format('S1 anon may not execute %s', f_sig);
    ASSERT NOT has_function_privilege('authenticated', f_sig, 'EXECUTE'),
      format('S1 authenticated may not execute %s', f_sig);
  END LOOP;

  FOR v_helper IN
    SELECT p.oid::regprocedure AS sig, p.prosecdef AS prosecdef
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE 'meta\_account\_refresh\_%'
       AND p.proname NOT IN (
         'begin_meta_account_refresh', 'write_direct_instagram_account',
         'write_meta_account_refresh_success', 'record_meta_refresh_failure'
       )
  LOOP
    ASSERT NOT v_helper.prosecdef,
      format('S1 %s is SECURITY INVOKER', v_helper.sig);
    ASSERT NOT has_function_privilege('anon', v_helper.sig, 'EXECUTE'),
      format('S1 anon may not execute %s', v_helper.sig);
    ASSERT NOT has_function_privilege('authenticated', v_helper.sig, 'EXECUTE'),
      format('S1 authenticated may not execute %s', v_helper.sig);
    ASSERT NOT has_function_privilege('service_role', v_helper.sig, 'EXECUTE'),
      format('S1 service_role may not execute %s directly', v_helper.sig);
  END LOOP;

  -- The direct tokens live in social_accounts and the User tokens live in
  -- facebook_user_credentials. Neither was moved.
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'social_accounts'
       AND column_name = 'access_token'
  ), 'S1 the operational token still lives in social_accounts';
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'facebook_user_credentials'
       AND column_name = 'token'
  ), 'S1 the Facebook User token still lives in facebook_user_credentials';
END
$s1$;

-- ---------------------------------------------------------------------------
-- S2. The coherent capture. The token material and the versioned authority
--     come out of one transaction, and the stored capture holds no secret.
-- ---------------------------------------------------------------------------
DO $s2$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1a0001-0000-4000-8000-000000000011';
  v_result JSONB;
  v_capture JSONB;
  v_token JSONB;
  v_stored JSONB;
  v_marker TIMESTAMPTZ;
  v_stored_marker TIMESTAMPTZ;
BEGIN
  v_result := public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account,
      'operation', 'direct_token'))));

  ASSERT v_result ->> 'capture_id' IS NOT NULL,
    'S2 the begin returned a capture id';
  ASSERT (v_result ->> 'capture_version')::integer = 1,
    'S2 the capture is versioned';
  ASSERT v_result ->> 'operation' = 'direct_token',
    'S2 the operation is explicit';
  ASSERT v_result ->> 'expires_at' > v_result ->> 'captured_at',
    'S2 the capture has a finite validity';

  -- The token material is returned on the service boundary.
  v_token := v_result -> 'tokens' -> 0;
  ASSERT v_token ->> 'token' = 'direct-token-1',
    'S2 the captured token is the live token';
  ASSERT v_token ->> 'refresh_token' = 'direct-refresh-1',
    'S2 the captured refresh token is the live refresh token';
  ASSERT v_token ->> 'scope' = 'account',
    'S2 the token material names its scope';

  -- The captured authority matches the live authority.
  v_capture := v_result -> 'capture';
  ASSERT v_capture ->> 'operation' = 'direct_token',
    'S2 the capture names its operation';
  ASSERT v_capture ->> 'user_id' = v_owner::text,
    'S2 the capture names its owner';
  ASSERT jsonb_array_length(v_capture -> 'targets') = 1,
    'S2 the capture holds exactly one target';
  ASSERT (v_capture -> 'targets' -> 0 ->> 'capability_generation')::bigint = 3,
    'S2 the capture holds the live capability generation';
  ASSERT (v_capture -> 'targets' -> 0 ->> 'binding_present')::boolean IS FALSE,
    'S2 the capture records the absent binding';
  ASSERT (v_capture -> 'targets' -> 0 ->> 'fence_state') = 'never_created',
    'S2 the capture records the absent connection fence';
  ASSERT (v_capture -> 'targets' -> 0 ->> 'platform_user_id') = 'ig-direct-1',
    'S2 the capture holds the stable provider identity';
  ASSERT (v_capture -> 'targets' -> 0 ->> 'capability_login_kind') = 'direct',
    'S2 the capture holds the trusted login kind';

  -- The stored capture holds no secret.
  SELECT c.capture INTO v_stored
    FROM public.meta_account_refresh_captures AS c
   WHERE c.id = (v_result ->> 'capture_id')::uuid
     AND c.user_id = v_owner;
  ASSERT FOUND, 'S2 the capture was stored';
  ASSERT v_stored ->> 'operation' = 'direct_token',
    'S2 the stored capture names its operation';
  ASSERT v_stored::TEXT NOT LIKE '%direct-token-1%',
    'S2 the stored capture holds no access token';
  ASSERT v_stored::TEXT NOT LIKE '%direct-refresh-1%',
    'S2 the stored capture holds no refresh token';
  ASSERT v_stored::TEXT NOT LIKE '%user-token-1%',
    'S2 the stored capture holds no User token';

  -- The attempt marker belongs to this transaction and to this capture.
  SELECT sa.last_refresh_attempt_at INTO v_stored_marker
    FROM public.social_accounts AS sa
   WHERE sa.id = v_account;
  ASSERT v_stored_marker IS NOT NULL,
    'S2 the attempt marker was recorded';
  ASSERT (v_capture -> 'targets' -> 0 ->> 'last_refresh_attempt_at')
         = v_result ->> 'attempt_marker',
    'S2 the returned marker is the captured marker';
  ASSERT v_stored_marker = (v_result ->> 'attempt_marker')::TIMESTAMPTZ,
    'S2 the stored marker is the returned marker';
END
$s2$;

-- ---------------------------------------------------------------------------
-- S3. The direct writer. The token stays in social_accounts, the field
--     whitelist is exact, an omitted field is preserved, and the fence
--     advances.
-- ---------------------------------------------------------------------------
DO $s3$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1a0001-0000-4000-8000-000000000011';
  v_capture UUID;
  v_result JSONB;
  v_token TEXT;
  v_refresh TEXT;
  v_expiry TIMESTAMPTZ;
  v_generation BIGINT;
  v_status TEXT;
BEGIN
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  v_result := public.write_direct_instagram_account(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'operation', 'direct_token',
    'fields', jsonb_build_object('access_token', 'direct-token-2')));

  ASSERT (v_result ->> 'applied')::boolean IS TRUE,
    'S3 the direct write applied';
  ASSERT (v_result ->> 'credential_generation')::bigint = 4,
    'S3 the writer returned the advanced generation';
  ASSERT (v_result -> 'account' ->> 'credential_generation')::bigint = 4,
    'S3 the writer returned the authoritative generation';
  ASSERT (v_result -> 'account' ->> 'needs_reauth')::boolean IS FALSE,
    'S3 the writer reports the live reauthorization state';
  ASSERT v_result -> 'account' ->> 'access_token' IS NULL,
    'S3 the writer never returns the token';

  SELECT sa.access_token, sa.refresh_token, sa.token_expires_at,
         c.credential_generation, cap.status
    INTO v_token, v_refresh, v_expiry, v_generation, v_status
    FROM public.social_accounts AS sa
    JOIN public.instagram_account_capabilities AS c
      ON c.social_account_id = sa.id
    JOIN public.meta_account_refresh_captures AS cap
      ON cap.id = v_capture
   WHERE sa.id = v_account;

  ASSERT v_token = 'direct-token-2',
    'S3 the new token is stored in social_accounts';
  ASSERT v_refresh = 'direct-refresh-1',
    'S3 an omitted refresh token is preserved, not nulled';
  ASSERT v_expiry = '2027-01-01T00:00:00Z'::TIMESTAMPTZ,
    'S3 an omitted expiry is preserved, not cleared';
  ASSERT v_generation = 4,
    'S3 the account fence advanced';
  ASSERT v_status = 'completed',
    'S3 the capture was closed';

  -- An explicit null clears. An explicit null is not an omission.
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  PERFORM public.write_direct_instagram_account(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'operation', 'direct_token',
    'fields', jsonb_build_object(
      'access_token', 'direct-token-3',
      'refresh_token', NULL,
      'token_expires_at', NULL)));

  SELECT sa.refresh_token, sa.token_expires_at INTO v_refresh, v_expiry
    FROM public.social_accounts AS sa WHERE sa.id = v_account;
  ASSERT v_refresh IS NULL,
    'S3 an explicit null refresh token clears it';
  ASSERT v_expiry IS NULL,
    'S3 an explicit null expiry clears it';

  -- The OAuth-only fields are refused before any lock is taken.
  FOR v_token IN
    SELECT unnest(ARRAY[
      'needs_reauth', 'is_active', 'social_profile_id', 'account_metadata',
      'platform_user_id', 'platform_username', 'user_id', 'failure_count',
      'last_refresh_error', 'last_refresh_attempt_at'
    ])
  LOOP
    BEGIN
      PERFORM public.write_direct_instagram_account(v_owner, jsonb_build_object(
        'capture_id', v_capture,
        'operation', 'direct_token',
        'fields', jsonb_build_object(
          'access_token', 'direct-token-4',
          v_token, 'x')));
      RAISE EXCEPTION 'S3 failed: the OAuth-only field % was accepted', v_token
        USING ERRCODE = 'assert_failure';
    EXCEPTION WHEN SQLSTATE 'MAR01' THEN
      NULL;
    END;
  END LOOP;

  -- An unknown field is refused too.
  BEGIN
    PERFORM public.write_direct_instagram_account(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'direct_token',
      'fields', jsonb_build_object(
        'access_token', 'direct-token-4',
        'unexpected_field', 'x')));
    RAISE EXCEPTION 'S3 failed: an unknown field was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN
    NULL;
  END;
END
$s3$;

-- ---------------------------------------------------------------------------
-- S4. The refusals. Ownership, identity, platform, subject, capability,
--     binding, eligibility and operation are all checked in SQL.
-- ---------------------------------------------------------------------------
DO $s4$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_other CONSTANT uuid := '0f100002-0000-4000-8000-000000000002';
  v_direct CONSTANT uuid := '0f1a0001-0000-4000-8000-000000000011';
  v_page CONSTANT uuid := '0f1a0002-0000-4000-8000-000000000012';
  v_fb CONSTANT uuid := '0f1a0004-0000-4000-8000-000000000014';
  v_capture UUID;
  v_foreign UUID;
  v_msg TEXT;
BEGIN
  -- The other owner's capture is structurally refused, even for the owner.
  SELECT (public.begin_meta_account_refresh(v_other, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', '0f2a0001-0000-4000-8000-000000000021',
      'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_foreign;

  BEGIN
    PERFORM public.write_direct_instagram_account(v_owner, jsonb_build_object(
      'capture_id', v_foreign,
      'operation', 'direct_token',
      'fields', jsonb_build_object('access_token', 'x')));
    RAISE EXCEPTION 'S4 failed: a foreign capture was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR02' THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%owner%',
      format('S4 the refusal names the owner (got %s)', v_msg);
  END;

  -- An unknown capture id.
  BEGIN
    PERFORM public.write_direct_instagram_account(v_owner, jsonb_build_object(
      'capture_id', '0f9c9999-0000-4000-8000-000000000099',
      'operation', 'direct_token',
      'fields', jsonb_build_object('access_token', 'x')));
    RAISE EXCEPTION 'S4 failed: an unknown capture was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR02' THEN
    NULL;
  END;

  -- A malformed payload.
  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, '"not-an-object"'::JSONB);
    RAISE EXCEPTION 'S4 failed: a malformed payload was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', v_direct, 'operation', 'direct_token')),
      'unexpected', TRUE));
    RAISE EXCEPTION 'S4 failed: an unknown payload key was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', 'not-a-uuid', 'operation', 'direct_token'))));
    RAISE EXCEPTION 'S4 failed: a malformed uuid was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', v_direct, 'operation', 'unknown_operation'))));
    RAISE EXCEPTION 'S4 failed: an unknown operation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN
    NULL;
  END;

  -- One capture may not mix operations.
  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(
        jsonb_build_object('social_account_id', v_direct, 'operation', 'direct_token'),
        jsonb_build_object('social_account_id', v_page, 'operation', 'page_token'))));
    RAISE EXCEPTION 'S4 failed: mixed operations were accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN
    NULL;
  END;

  -- A duplicate account.
  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(
        jsonb_build_object('social_account_id', v_direct, 'operation', 'direct_token'),
        jsonb_build_object('social_account_id', v_direct, 'operation', 'direct_token'))));
    RAISE EXCEPTION 'S4 failed: a duplicate account was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN
    NULL;
  END;

  -- An account of another owner.
  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', '0f2a0001-0000-4000-8000-000000000021',
        'operation', 'direct_token'))));
    RAISE EXCEPTION 'S4 failed: a foreign account was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR02' THEN
    NULL;
  END;

  -- Facebook Page operational refresh is supported (S16). A Facebook Page
  -- is still not a direct Instagram account.
  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', v_fb, 'operation', 'direct_token'))));
    RAISE EXCEPTION 'S4 failed: a facebook account was accepted for a direct refresh'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR03' THEN
    NULL;
  END;

  -- A page-linked account is not a direct account.
  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', v_page, 'operation', 'direct_token'))));
    RAISE EXCEPTION 'S4 failed: a page-linked account was accepted for a direct refresh'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR03' THEN
    NULL;
  END;

  -- A direct account is not a page-linked account.
  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', v_direct, 'operation', 'page_token'))));
    RAISE EXCEPTION 'S4 failed: a direct account was accepted for a page refresh'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR03' THEN
    NULL;
  END;

  -- An unbound account cannot carry a shared User grant.
  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', v_direct, 'operation', 'facebook_user_token'))));
    RAISE EXCEPTION 'S4 failed: an unbound account was accepted for a grant refresh'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR03' THEN
    NULL;
  END;

  -- An inactive account is not refreshed, and it is never reactivated.
  UPDATE public.social_accounts SET is_active = false
   WHERE id = '0f1a0006-0000-4000-8000-000000000016';
  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', '0f1a0006-0000-4000-8000-000000000016',
        'operation', 'direct_token'))));
    RAISE EXCEPTION 'S4 failed: an inactive account was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR03' THEN
    NULL;
  END;
  UPDATE public.social_accounts SET is_active = true
   WHERE id = '0f1a0006-0000-4000-8000-000000000016';

  -- An account without a capability record.
  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, access_token, is_active
  ) VALUES (
    '0f1a0008-0000-4000-8000-000000000018', v_owner, 'instagram',
    'ig-nocap-1', 'nocap-token-1', true
  );
  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', '0f1a0008-0000-4000-8000-000000000018',
        'operation', 'direct_token'))));
    RAISE EXCEPTION 'S4 failed: an account without a capability was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR03' THEN
    NULL;
  END;

  -- A direct account that carries a Facebook grant is refused.
  INSERT INTO public.facebook_user_credentials (
    id, user_id, token, revision, lifecycle, provider_user_id,
    provenance_source, provenance_captured_at
  ) VALUES (
    '0f1c0002-0000-4000-8000-000000000032', v_owner, 'user-token-x', 1,
    'active', 'fb-user-x', 'oauth_exchange', '2026-10-01T00:00:00Z'
  );
  INSERT INTO public.facebook_user_credential_bindings (
    social_account_id, user_id, platform, credential_id,
    verified_facebook_user_id, verified_facebook_page_id, verified_instagram_user_id,
    evidence_source, connection_version
  ) VALUES (
    '0f1a0007-0000-4000-8000-000000000017', v_owner, 'instagram',
    '0f1c0002-0000-4000-8000-000000000032',
    'fb-user-x', 'page-x', 'ig-injected-1', 'oauth_exchange', 1
  );
  INSERT INTO public.facebook_user_credential_connection_fences (
    social_account_id, user_id, platform, connection_version
  ) VALUES (
    '0f1a0007-0000-4000-8000-000000000017', v_owner, 'instagram', 1
  );
  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', '0f1a0007-0000-4000-8000-000000000017',
        'operation', 'direct_token'))));
    RAISE EXCEPTION 'S4 failed: a direct account with a grant was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR03' THEN
    NULL;
  END;

  -- The grant is removed again, so the later cases start from a direct
  -- account with no binding.
  DELETE FROM public.facebook_user_credential_bindings
   WHERE social_account_id = '0f1a0007-0000-4000-8000-000000000017';

  -- The operation of the writer must match the capture.
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_page, 'operation', 'page_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  BEGIN
    PERFORM public.write_direct_instagram_account(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_token',
      'fields', jsonb_build_object('access_token', 'x')));
    RAISE EXCEPTION 'S4 failed: the direct writer accepted a page capture'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR06' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'direct_token',
      'fields', jsonb_build_object('access_token', 'x')));
    RAISE EXCEPTION 'S4 failed: the bound writer accepted a direct capture'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR06' THEN
    NULL;
  END;

  -- The failing account must be one of the captured accounts.
  BEGIN
    PERFORM public.record_meta_refresh_failure(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'social_account_id', v_direct,
      'error_category', 'provider_transient'));
    RAISE EXCEPTION 'S4 failed: an uncaptured account was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR02' THEN
    NULL;
  END;

  -- The error category list is closed.
  BEGIN
    PERFORM public.record_meta_refresh_failure(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'social_account_id', v_page,
      'error_category', 'provider said something with a token in it'));
    RAISE EXCEPTION 'S4 failed: an unknown error category was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN
    NULL;
  END;
END
$s4$;

-- ---------------------------------------------------------------------------
-- S5. The captured absence. A binding that appears, and a bind -> detach
--     cycle that leaves a surviving high-water mark, both refuse.
-- ---------------------------------------------------------------------------
DO $s5$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1a0005-0000-4000-8000-000000000015';
  v_aba CONSTANT uuid := '0f1a0009-0000-4000-8000-000000000019';
  v_capture UUID;
BEGIN
  -- A binding that appears after the capture.
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  INSERT INTO public.facebook_user_credential_bindings (
    social_account_id, user_id, platform, credential_id,
    verified_facebook_user_id, verified_facebook_page_id, verified_instagram_user_id,
    evidence_source, connection_version
  ) VALUES (
    v_account, v_owner, 'instagram', '0f1c0001-0000-4000-8000-000000000031',
    'fb-user-1', 'page-1', 'ig-noworkspace-1', 'oauth_exchange', 1
  );
  INSERT INTO public.facebook_user_credential_connection_fences (
    social_account_id, user_id, platform, connection_version
  ) VALUES (
    v_account, v_owner, 'instagram', 1
  );

  BEGIN
    PERFORM public.write_direct_instagram_account(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'direct_token',
      'fields', jsonb_build_object('access_token', 'nows-token-2')));
    RAISE EXCEPTION 'S5 failed: a capture was accepted after a binding appeared'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN
    NULL;
  END;

  -- The bind -> detach cycle leaves a surviving high-water mark. The
  -- captured absence is not the current absence.
  DELETE FROM public.facebook_user_credential_bindings
   WHERE social_account_id = v_account;

  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_aba, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  INSERT INTO public.facebook_user_credential_bindings (
    social_account_id, user_id, platform, credential_id,
    verified_facebook_user_id, verified_facebook_page_id, verified_instagram_user_id,
    evidence_source, connection_version
  ) VALUES (
    v_aba, v_owner, 'instagram', '0f1c0001-0000-4000-8000-000000000031',
    'fb-user-1', 'page-1', 'ig-aba-1', 'oauth_exchange', 1
  );
  INSERT INTO public.facebook_user_credential_connection_fences (
    social_account_id, user_id, platform, connection_version
  ) VALUES (
    v_aba, v_owner, 'instagram', 1
  );
  DELETE FROM public.facebook_user_credential_bindings
   WHERE social_account_id = v_aba;

  BEGIN
    PERFORM public.write_direct_instagram_account(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'direct_token',
      'fields', jsonb_build_object('access_token', 'aba-token')));
    RAISE EXCEPTION 'S5 failed: the connection ABA was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN
    NULL;
  END;

  ASSERT (SELECT f.connection_version
            FROM public.facebook_user_credential_connection_fences AS f
           WHERE f.social_account_id = v_aba) = 2,
    'S5 the surviving fence kept its high-water mark through the detach';

  ASSERT (SELECT access_token FROM public.social_accounts
           WHERE id = v_aba) = 'aba-token-1',
    'S5 the refused write did not touch the token';
END
$s5$;

-- ---------------------------------------------------------------------------
-- S6. The stale result. A generation that moved, a conversion, and a
--     reconnect all refuse, and a refused result changes nothing.
-- ---------------------------------------------------------------------------
DO $s6$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1a0002-0000-4000-8000-000000000012';
  v_capture UUID;
  v_before JSONB;
  v_after JSONB;
BEGIN
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'page_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  -- The credential was replaced while the provider call was in flight.
  UPDATE public.instagram_account_capabilities
     SET credential_generation = credential_generation + 1
   WHERE social_account_id = v_account;

  SELECT jsonb_build_object(
           'token', sa.access_token,
           'refresh', sa.refresh_token,
           'expiry', sa.token_expires_at,
           'failures', sa.failure_count,
           'reauth', sa.needs_reauth,
           'error', sa.last_refresh_error,
           'alert', sa.last_alert_sent_at,
           'generation', c.credential_generation,
           'status', cap.status)
    INTO v_before
    FROM public.social_accounts AS sa
    JOIN public.instagram_account_capabilities AS c
      ON c.social_account_id = sa.id
    JOIN public.meta_account_refresh_captures AS cap
      ON cap.id = v_capture
   WHERE sa.id = v_account;

  BEGIN
    PERFORM public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_token',
      'fields', jsonb_build_object('access_token', 'page-token-late')));
    RAISE EXCEPTION 'S6 failed: a stale result was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN
    NULL;
  END;

  SELECT jsonb_build_object(
           'token', sa.access_token,
           'refresh', sa.refresh_token,
           'expiry', sa.token_expires_at,
           'failures', sa.failure_count,
           'reauth', sa.needs_reauth,
           'error', sa.last_refresh_error,
           'alert', sa.last_alert_sent_at,
           'generation', c.credential_generation,
           'status', cap.status)
    INTO v_after
    FROM public.social_accounts AS sa
    JOIN public.instagram_account_capabilities AS c
      ON c.social_account_id = sa.id
    JOIN public.meta_account_refresh_captures AS cap
      ON cap.id = v_capture
   WHERE sa.id = v_account;

  ASSERT v_after = v_before,
    'S6 the refused result changed nothing at all';

  -- A direct account that was converted to a page-linked one.
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', '0f1a0001-0000-4000-8000-000000000011',
      'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  UPDATE public.instagram_account_capabilities
     SET login_kind = 'page_linked'
   WHERE social_account_id = '0f1a0001-0000-4000-8000-000000000011';

  BEGIN
    PERFORM public.write_direct_instagram_account(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'direct_token',
      'fields', jsonb_build_object('access_token', 'converted-token')));
    RAISE EXCEPTION 'S6 failed: a conversion was accepted by an old capture'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN
    NULL;
  END;

  UPDATE public.instagram_account_capabilities
     SET login_kind = 'direct'
   WHERE social_account_id = '0f1a0001-0000-4000-8000-000000000011';
END
$s6$;

-- ---------------------------------------------------------------------------
-- S7. The retry and duplicate semantics. The newest attempt wins; an older
--     open capture is closed and can no longer be committed.
-- ---------------------------------------------------------------------------
DO $s7$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1a0001-0000-4000-8000-000000000011';
  v_first UUID;
  v_second UUID;
  v_status TEXT;
BEGIN
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_first;

  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_second;

  ASSERT v_first <> v_second,
    'S7 the two attempts are two captures';
  ASSERT (SELECT status FROM public.meta_account_refresh_captures
           WHERE id = v_first) = 'superseded',
    'S7 the older attempt was superseded';
  ASSERT (SELECT status FROM public.meta_account_refresh_captures
           WHERE id = v_second) = 'open',
    'S7 the newer attempt is open';

  BEGIN
    PERFORM public.write_direct_instagram_account(v_owner, jsonb_build_object(
      'capture_id', v_first,
      'operation', 'direct_token',
      'fields', jsonb_build_object('access_token', 'superseded-token')));
    RAISE EXCEPTION 'S7 failed: a superseded capture was committed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN
    NULL;
  END;

  PERFORM public.write_direct_instagram_account(v_owner, jsonb_build_object(
    'capture_id', v_second,
    'operation', 'direct_token',
    'fields', jsonb_build_object('access_token', 'current-token')));

  ASSERT (SELECT access_token FROM public.social_accounts
           WHERE id = v_account) = 'current-token',
    'S7 the newest attempt committed';

  -- A duplicate of a closed capture is refused.
  BEGIN
    PERFORM public.write_direct_instagram_account(v_owner, jsonb_build_object(
      'capture_id', v_second,
      'operation', 'direct_token',
      'fields', jsonb_build_object('access_token', 'duplicate-token')));
    RAISE EXCEPTION 'S7 failed: a duplicate commit was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN
    NULL;
  END;

  -- An expired capture is refused.
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_first;

  UPDATE public.meta_account_refresh_captures
     SET captured_at = clock_timestamp() - INTERVAL '1 hour',
         expires_at = clock_timestamp() - INTERVAL '1 minute'
   WHERE id = v_first;

  BEGIN
    PERFORM public.write_direct_instagram_account(v_owner, jsonb_build_object(
      'capture_id', v_first,
      'operation', 'direct_token',
      'fields', jsonb_build_object('access_token', 'expired-token')));
    RAISE EXCEPTION 'S7 failed: an expired capture was committed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN
    NULL;
  END;

  -- A token that already expired is refused after the waits.
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_first;

  BEGIN
    PERFORM public.write_direct_instagram_account(v_owner, jsonb_build_object(
      'capture_id', v_first,
      'operation', 'direct_token',
      'fields', jsonb_build_object(
        'access_token', 'expired-token',
        'token_expires_at', '2020-01-01T00:00:00Z')));
    RAISE EXCEPTION 'S7 failed: an already expired token was committed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR07' THEN
    NULL;
  END;
END
$s7$;

-- ---------------------------------------------------------------------------
-- S8. The captured failure. A fresh false -> true transition produces
--     exactly one event, and the health, the alert marker and the fence
--     advance in the same transaction.
-- ---------------------------------------------------------------------------
DO $s8$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1a0002-0000-4000-8000-000000000012';
  v_capture UUID;
  v_result JSONB;
  v_generation BIGINT;
  v_outbox INTEGER;
  v_reauth BOOLEAN;
  v_failures INTEGER;
  v_error TEXT;
  v_alert BOOLEAN;
  v_before_generation BIGINT;
BEGIN
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'page_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  SELECT c.credential_generation INTO v_generation
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_account;
  v_before_generation := v_generation;

  v_result := public.record_meta_refresh_failure(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'social_account_id', v_account,
    'error_category', 'provider_auth_revoked'));

  ASSERT (v_result ->> 'transitioned')::boolean IS TRUE,
    'S8 the false -> true transition happened';
  ASSERT (v_result ->> 'enqueued')::integer = 1,
    'S8 exactly one delivery was enqueued';
  ASSERT (v_result ->> 'account_found')::boolean IS TRUE,
    'S8 the account was found';
  ASSERT (v_result ->> 'failure_count')::integer = 1,
    'S8 the failure count advanced';
  ASSERT (v_result ->> 'escalated')::boolean IS TRUE,
    'S8 a permanent failure latches';
  ASSERT (v_result ->> 'error_category') = 'provider_auth_revoked',
    'S8 the stable category is the stored error';

  SELECT count(*) INTO v_outbox
    FROM public.partner_webhook_deliveries AS d
   WHERE d.event_type = 'account.reauthorization_required'
     AND d.payload ->> 'account_id' = 'acc_' || v_account::text;
  ASSERT v_outbox = 1,
    'S8 the event reached the outbox exactly once';

  SELECT sa.needs_reauth, sa.failure_count, sa.last_refresh_error,
         (sa.last_alert_sent_at IS NOT NULL), c.credential_generation
    INTO v_reauth, v_failures, v_error, v_alert, v_generation
    FROM public.social_accounts AS sa
    JOIN public.instagram_account_capabilities AS c
      ON c.social_account_id = sa.id
   WHERE sa.id = v_account;

  ASSERT v_reauth IS TRUE,
    'S8 the account needs a reauthorization';
  ASSERT v_failures = 1,
    'S8 the failure count was stored';
  ASSERT v_error = 'provider_auth_revoked',
    'S8 the stored error is the stable category, not a provider message';
  ASSERT v_alert IS TRUE,
    'S8 the alert marker was written';
  ASSERT v_generation = v_before_generation + 1,
    'S8 the fence advanced by exactly one in the same transaction';
  ASSERT (SELECT status FROM public.meta_account_refresh_captures
           WHERE id = v_capture) = 'failed',
    'S8 the capture was closed as failed';
END
$s8$;

-- ---------------------------------------------------------------------------
-- S9. A repeated fresh failure on an already flagged account is not a new
--     transition.
-- ---------------------------------------------------------------------------
DO $s9$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1a0002-0000-4000-8000-000000000012';
  v_capture UUID;
  v_result JSONB;
  v_outbox INTEGER;
  v_failures INTEGER;
  v_reauth BOOLEAN;
BEGIN
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'page_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  v_result := public.record_meta_refresh_failure(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'social_account_id', v_account,
    'error_category', 'provider_error'));

  ASSERT (v_result ->> 'transitioned')::boolean IS FALSE,
    'S9 an already flagged account is not a new transition';
  ASSERT (v_result ->> 'enqueued')::integer = 0,
    'S9 an already flagged account enqueues nothing';
  ASSERT (v_result ->> 'failure_count')::integer = 2,
    'S9 the failure count still advanced';

  SELECT count(*) INTO v_outbox
    FROM public.partner_webhook_deliveries AS d
   WHERE d.event_type = 'account.reauthorization_required'
     AND d.payload ->> 'account_id' = 'acc_' || v_account::text;
  ASSERT v_outbox = 1,
    'S9 no second event was produced';

  -- A transient failure is not evidence against the grant. The count is held
  -- and the account is never latched.
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', '0f1a0009-0000-4000-8000-000000000019',
      'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  v_result := public.record_meta_refresh_failure(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'social_account_id', '0f1a0009-0000-4000-8000-000000000019',
    'error_category', 'provider_transient'));

  ASSERT (v_result ->> 'escalated')::boolean IS FALSE,
    'S9 a transient failure does not latch';
  ASSERT (v_result ->> 'failure_count')::integer = 0,
    'S9 a transient failure holds the count';
  ASSERT (v_result ->> 'alert_marker_written')::boolean IS FALSE,
    'S9 a transient failure writes no alert marker';

  SELECT sa.needs_reauth, sa.failure_count INTO v_reauth, v_failures
    FROM public.social_accounts AS sa
   WHERE sa.id = '0f1a0009-0000-4000-8000-000000000019';
  ASSERT v_reauth IS FALSE,
    'S9 the transient account was not latched';
  ASSERT v_failures = 0,
    'S9 the transient account did not count';
END
$s9$;

-- ---------------------------------------------------------------------------
-- S10. A stale failure produces neither a health change, nor a fence
--      advance, nor an event, nor an alert marker.
-- ---------------------------------------------------------------------------
DO $s10$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1a0010-0000-4000-8000-000000000020';
  v_capture UUID;
  v_before JSONB;
  v_after JSONB;
  v_outbox_before INTEGER;
  v_outbox_after INTEGER;
BEGIN
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  -- The health moved under the capture.
  UPDATE public.social_accounts
     SET failure_count = 7, needs_reauth = TRUE
   WHERE id = v_account;

  SELECT count(*) INTO v_outbox_before
    FROM public.partner_webhook_deliveries;

  SELECT jsonb_build_object(
           'token', sa.access_token,
           'failures', sa.failure_count,
           'reauth', sa.needs_reauth,
           'error', sa.last_refresh_error,
           'alert', sa.last_alert_sent_at,
           'generation', c.credential_generation)
    INTO v_before
    FROM public.social_accounts AS sa
    JOIN public.instagram_account_capabilities AS c
      ON c.social_account_id = sa.id
   WHERE sa.id = v_account;

  BEGIN
    PERFORM public.record_meta_refresh_failure(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'social_account_id', v_account,
      'error_category', 'provider_auth_revoked'));
    RAISE EXCEPTION 'S10 failed: a stale failure was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN
    NULL;
  END;

  SELECT jsonb_build_object(
           'token', sa.access_token,
           'failures', sa.failure_count,
           'reauth', sa.needs_reauth,
           'error', sa.last_refresh_error,
           'alert', sa.last_alert_sent_at,
           'generation', c.credential_generation)
    INTO v_after
    FROM public.social_accounts AS sa
    JOIN public.instagram_account_capabilities AS c
      ON c.social_account_id = sa.id
   WHERE sa.id = v_account;

  SELECT count(*) INTO v_outbox_after
    FROM public.partner_webhook_deliveries;

  ASSERT v_after = v_before,
    'S10 the stale failure changed no health and no fence';
  ASSERT v_outbox_after = v_outbox_before,
    'S10 the stale failure produced no event';
END
$s10$;

-- ---------------------------------------------------------------------------
-- S11. The legitimate no-workspace and no-subscriber semantics are kept.
-- ---------------------------------------------------------------------------
DO $s11$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_noworkspace CONSTANT uuid := '0f1a0005-0000-4000-8000-000000000015';
  v_nosub CONSTANT uuid := '0f1a0006-0000-4000-8000-000000000016';
  v_capture UUID;
  v_result JSONB;
  v_outbox INTEGER;
BEGIN
  -- No workspace at all: the account is found and latched, and nothing is
  -- enqueued. The failure does not claim a delivery it cannot make.
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_noworkspace, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  v_result := public.record_meta_refresh_failure(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'social_account_id', v_noworkspace,
    'error_category', 'provider_auth_revoked'));

  ASSERT (v_result ->> 'account_found')::boolean IS TRUE,
    'S11 the account without a workspace was found';
  ASSERT (v_result ->> 'transitioned')::boolean IS FALSE,
    'S11 an account without a workspace reports no transition';
  ASSERT (v_result ->> 'enqueued')::integer = 0,
    'S11 an account without a workspace enqueues nothing';
  ASSERT (SELECT needs_reauth FROM public.social_accounts
           WHERE id = v_noworkspace) IS TRUE,
    'S11 the account without a workspace is still latched';

  -- A workspace with no subscriber: the transition happened, and the
  -- enqueue count is honestly zero.
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_nosub, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  v_result := public.record_meta_refresh_failure(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'social_account_id', v_nosub,
    'error_category', 'provider_auth_revoked'));

  ASSERT (v_result ->> 'transitioned')::boolean IS TRUE,
    'S11 the account in a workspace without a subscriber still transitions';
  ASSERT (v_result ->> 'enqueued')::integer = 0,
    'S11 a workspace without a subscriber enqueues nothing';
  ASSERT (v_result ->> 'account_found')::boolean IS TRUE,
    'S11 the account in a workspace without a subscriber was found';

  SELECT count(*) INTO v_outbox
    FROM public.partner_webhook_deliveries AS d
   WHERE d.payload ->> 'account_id' = 'acc_' || v_nosub::text;
  ASSERT v_outbox = 0,
    'S11 no delivery row was invented for the unsubscribed workspace';
END
$s11$;

-- ---------------------------------------------------------------------------
-- S12. An injected downstream outbox failure rolls the health, the fence
--      and the capture back, in their entirety.
-- ---------------------------------------------------------------------------
DO $s12$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1a0007-0000-4000-8000-000000000017';
  v_capture UUID;
  v_before JSONB;
  v_after JSONB;
  v_msg TEXT;
BEGIN
  CREATE OR REPLACE FUNCTION public.mar_injected_outbox_failure()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $mar_injected$
  BEGIN
    RAISE EXCEPTION 'injected downstream outbox failure'
      USING ERRCODE = 'P0001';
  END;
  $mar_injected$;

  CREATE TRIGGER mar_injected_outbox_failure
    BEFORE INSERT ON public.partner_webhook_deliveries
    FOR EACH ROW EXECUTE FUNCTION public.mar_injected_outbox_failure();

  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  SELECT jsonb_build_object(
           'failures', sa.failure_count,
           'reauth', sa.needs_reauth,
           'error', sa.last_refresh_error,
           'alert', sa.last_alert_sent_at,
           'generation', c.credential_generation,
           'status', cap.status)
    INTO v_before
    FROM public.social_accounts AS sa
    JOIN public.instagram_account_capabilities AS c
      ON c.social_account_id = sa.id
    JOIN public.meta_account_refresh_captures AS cap
      ON cap.id = v_capture
   WHERE sa.id = v_account;

  BEGIN
    PERFORM public.record_meta_refresh_failure(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'social_account_id', v_account,
      'error_category', 'provider_auth_revoked'));
    RAISE EXCEPTION 'S12 failed: the injected outbox failure was swallowed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%injected downstream outbox failure%',
      format('S12 the downstream failure reached the caller (got %s)', v_msg);
  END;

  SELECT jsonb_build_object(
           'failures', sa.failure_count,
           'reauth', sa.needs_reauth,
           'error', sa.last_refresh_error,
           'alert', sa.last_alert_sent_at,
           'generation', c.credential_generation,
           'status', cap.status)
    INTO v_after
    FROM public.social_accounts AS sa
    JOIN public.instagram_account_capabilities AS c
      ON c.social_account_id = sa.id
    JOIN public.meta_account_refresh_captures AS cap
      ON cap.id = v_capture
   WHERE sa.id = v_account;

  ASSERT v_after = v_before,
    'S12 the downstream failure rolled the health, the fence and the capture back';

  DROP TRIGGER mar_injected_outbox_failure ON public.partner_webhook_deliveries;
  DROP FUNCTION public.mar_injected_outbox_failure();
END
$s12$;

-- ---------------------------------------------------------------------------
-- S13. The captured shared-grant rotation. Every captured member of the
--      grant is fenced, and the sibling operational tokens are untouched.
-- ---------------------------------------------------------------------------
DO $s13$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_target CONSTANT uuid := '0f1a0002-0000-4000-8000-000000000012';
  v_sibling CONSTANT uuid := '0f1a0003-0000-4000-8000-000000000013';
  v_fb CONSTANT uuid := '0f1a0004-0000-4000-8000-000000000014';
  v_capture UUID;
  v_result JSONB;
  v_members INTEGER;
  v_revision BIGINT;
  v_token TEXT;
  v_gen_target BIGINT;
  v_gen_sibling BIGINT;
  v_fence_fb BIGINT;
  v_token_sibling TEXT;
  v_provenance TEXT;
  v_gen_before BIGINT;
  v_gen_sibling_before BIGINT;
  v_fence_fb_before BIGINT;
BEGIN
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_target, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  SELECT jsonb_array_length(
           (SELECT c.capture -> 'members' FROM public.meta_account_refresh_captures AS c
             WHERE c.id = v_capture))
    INTO v_members;
  ASSERT v_members = 3,
    'S13 the capture holds the complete membership of the grant';

  SELECT c.revision, c.token INTO v_revision, v_token
    FROM public.facebook_user_credentials AS c
   WHERE c.id = '0f1c0001-0000-4000-8000-000000000031';

  SELECT c.credential_generation INTO v_gen_target
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_target;
  SELECT c.credential_generation INTO v_gen_sibling
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_sibling;
  SELECT f.connection_version INTO v_fence_fb
    FROM public.facebook_user_credential_connection_fences AS f
   WHERE f.social_account_id = v_fb;
  v_gen_before := v_gen_target;
  v_gen_sibling_before := v_gen_sibling;
  v_fence_fb_before := v_fence_fb;

  v_result := public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'operation', 'facebook_user_token',
    'fields', jsonb_build_object(
      'token', 'user-token-2',
      'token_expires_at', '2027-03-01T00:00:00Z')));

  ASSERT (v_result ->> 'applied')::boolean IS TRUE,
    'S13 the shared rotation applied';
  ASSERT jsonb_array_length(v_result -> 'accounts') = 3,
    'S13 the writer reported every captured member';

  SELECT c.revision, c.token, c.provenance_source INTO v_revision, v_token, v_provenance
    FROM public.facebook_user_credentials AS c
   WHERE c.id = '0f1c0001-0000-4000-8000-000000000031';
  ASSERT v_revision = 2,
    'S13 the shared secret rotated exactly once';
  ASSERT v_token = 'user-token-2',
    'S13 the new shared secret is stored in facebook_user_credentials';
  ASSERT v_provenance = 'token_refresh',
    'S13 the rotated secret records its refresh provenance';

  SELECT c.credential_generation INTO v_gen_target
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_target;
  SELECT c.credential_generation INTO v_gen_sibling
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_sibling;
  SELECT f.connection_version INTO v_fence_fb
    FROM public.facebook_user_credential_connection_fences AS f
   WHERE f.social_account_id = v_fb;
  SELECT sa.access_token INTO v_token_sibling
    FROM public.social_accounts AS sa WHERE sa.id = v_sibling;

  ASSERT v_gen_target = v_gen_before + 1,
    'S13 the target member was fenced';
  ASSERT v_gen_sibling = v_gen_sibling_before + 1,
    'S13 the sibling member was fenced by the shared rotation';
  ASSERT v_fence_fb = v_fence_fb_before + 1,
    'S13 the facebook member connection fence was advanced';
  ASSERT v_token_sibling = 'page-token-2',
    'S13 the sibling operational token was not rewritten';

  -- The rotation is refused when the captured revision moved.
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_target, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  UPDATE public.facebook_user_credentials
     SET revision = revision + 1
   WHERE id = '0f1c0001-0000-4000-8000-000000000031';

  BEGIN
    PERFORM public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'facebook_user_token',
      'fields', jsonb_build_object('token', 'user-token-3')));
    RAISE EXCEPTION 'S13 failed: a rotation against a moved revision was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN
    NULL;
  END;

  SELECT c.token INTO v_token
    FROM public.facebook_user_credentials AS c
   WHERE c.id = '0f1c0001-0000-4000-8000-000000000031';
  ASSERT v_token = 'user-token-2',
    'S13 the refused rotation did not rotate the shared secret';
END
$s13$;

-- ---------------------------------------------------------------------------
-- S14. An account-only page change does not rotate the shared User secret
--      and does not touch the sibling.
-- ---------------------------------------------------------------------------
DO $s14$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_target CONSTANT uuid := '0f1a0002-0000-4000-8000-000000000012';
  v_sibling CONSTANT uuid := '0f1a0003-0000-4000-8000-000000000013';
  v_capture UUID;
  v_revision BIGINT;
  v_token TEXT;
  v_gen_sibling BIGINT;
  v_fence_sibling BIGINT;
BEGIN
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_target, 'operation', 'page_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  PERFORM public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'operation', 'page_token',
    'fields', jsonb_build_object('access_token', 'page-token-1b')));

  SELECT c.revision, c.token INTO v_revision, v_token
    FROM public.facebook_user_credentials AS c
   WHERE c.id = '0f1c0001-0000-4000-8000-000000000031';
  SELECT c.credential_generation INTO v_gen_sibling
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_sibling;
  SELECT f.connection_version INTO v_fence_sibling
    FROM public.facebook_user_credential_connection_fences AS f
   WHERE f.social_account_id = v_sibling;

  ASSERT v_revision = 3,
    'S14 an account-only change did not rotate the shared User secret';
  ASSERT v_token = 'user-token-2',
    'S14 the shared User secret is unchanged';
  ASSERT v_gen_sibling = 3,
    'S14 an account-only change did not fence the sibling';
  ASSERT v_fence_sibling = 1,
    'S14 an account-only change did not advance the sibling fence';
  ASSERT (SELECT access_token FROM public.social_accounts
           WHERE id = v_target) = 'page-token-1b',
    'S14 the page operational token was written';
  ASSERT (SELECT refresh_token FROM public.social_accounts
           WHERE id = v_target) = 'page-refresh-1',
    'S14 the omitted page refresh token was preserved';
END
$s14$;

-- ---------------------------------------------------------------------------
-- S15. An old job result cannot persist after a refresh, and the shared
--      rotation invalidates every old member job.
-- ---------------------------------------------------------------------------
DO $s15$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_target CONSTANT uuid := '0f1a0003-0000-4000-8000-000000000013';
  v_capture UUID;
  v_claim JSONB;
  v_job UUID;
  v_token UUID;
  v_gen BIGINT;
  v_msg TEXT;
  v_written INTEGER;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  PERFORM public.enqueue_instagram_collection_jobs_service(v_owner, jsonb_build_array(
    jsonb_build_object(
      'target_kind', 'owner',
      'target_id', v_target,
      'mode', 'normal')));

  SELECT c INTO v_claim
    FROM public.claim_instagram_collection_jobs('owner', 25) AS c
   WHERE c ->> 'job_id' = (SELECT id::TEXT FROM public.instagram_collection_jobs
                             WHERE social_account_id = v_target
                               AND target_kind = 'owner');

  ASSERT FOUND,
    'S15 the owner job was claimed';
  v_job := (v_claim ->> 'job_id')::uuid;
  v_token := (v_claim ->> 'claim_token')::uuid;
  v_gen := (v_claim ->> 'job_generation')::bigint;

  -- The positive control: the old claim still works before the refresh.
  v_written := (public.persist_instagram_collection_snapshot(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'owner_media',
      'items', jsonb_build_array(jsonb_build_object(
        'ig_media_id', 'ig-media-before',
        'media_product_type', 'REELS',
        'media_type', 'VIDEO',
        'published_at', '2026-10-20T10:00:00Z',
        'status', 'ok',
        'metrics', jsonb_build_object(
          'views', 10, 'reach', NULL, 'likes', 0,
          'total_interactions', 1)))))
    ->> 'written')::integer;
  ASSERT v_written = 1,
    'S15 the old claim worked before the refresh';

  -- The refresh advances the fence of the account the job is bound to.
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_target, 'operation', 'page_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  PERFORM public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'operation', 'page_token',
    'fields', jsonb_build_object('access_token', 'page-token-2b')));

  -- The old claim can no longer persist a result.
  BEGIN
    PERFORM public.persist_instagram_collection_snapshot(
      v_job, v_token, v_gen,
      jsonb_build_object(
        'kind', 'owner_media',
        'items', jsonb_build_array(jsonb_build_object(
          'ig_media_id', 'ig-media-after',
          'media_product_type', 'REELS',
          'media_type', 'VIDEO',
          'published_at', '2026-10-21T10:00:00Z',
          'status', 'ok',
          'metrics', jsonb_build_object(
            'views', 20, 'reach', NULL, 'likes', 0,
            'total_interactions', 2)))));
    RAISE EXCEPTION 'S15 failed: an old job result persisted after the refresh'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%',
      format('S15 the old claim was refused for the changed credential (got %s)', v_msg);
  END;

  ASSERT (SELECT count(*) FROM public.ig_media_insight_snapshots
           WHERE ig_media_id = 'ig-media-after') = 0,
    'S15 no snapshot row was written by the stale claim';
END
$s15$;

-- ---------------------------------------------------------------------------
-- S16. Operation-specific material and a Facebook Page operational refresh.
--      The Page token stays on social_accounts. The User secret does not
--      move. A stale connection fence refuses with the Page token unchanged.
--      needs_reauth is not cleared.
-- ---------------------------------------------------------------------------
DO $s16$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_page CONSTANT uuid := '0f1a0004-0000-4000-8000-000000000014';
  v_ig CONSTANT uuid := '0f1a0002-0000-4000-8000-000000000012';
  v_sibling CONSTANT uuid := '0f1a0003-0000-4000-8000-000000000013';
  v_cred CONSTANT uuid := '0f1c0001-0000-4000-8000-000000000031';
  v_result JSONB;
  v_token JSONB;
  v_capture UUID;
  v_user_token TEXT;
  v_user_rev BIGINT;
  v_ig_token TEXT;
  v_sibling_token TEXT;
  v_page_token TEXT;
  v_fence BIGINT;
  v_fence_after BIGINT;
BEGIN
  SELECT c.token, c.revision INTO v_user_token, v_user_rev
    FROM public.facebook_user_credentials AS c WHERE c.id = v_cred;
  SELECT access_token INTO v_ig_token FROM public.social_accounts WHERE id = v_ig;
  SELECT access_token INTO v_sibling_token FROM public.social_accounts WHERE id = v_sibling;
  SELECT access_token INTO v_page_token FROM public.social_accounts WHERE id = v_page;
  SELECT connection_version INTO v_fence
    FROM public.facebook_user_credential_connection_fences
   WHERE social_account_id = v_page;

  UPDATE public.social_accounts
     SET failure_count = 2, last_refresh_error = 'fb-old', needs_reauth = true
   WHERE id = v_page;

  v_result := public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_page, 'operation', 'page_token'))));
  v_token := v_result -> 'tokens' -> 0;
  ASSERT v_token ->> 'scope' = 'account',
    'S16 a Facebook Page begin returns account scope';
  ASSERT v_token ->> 'token' = v_page_token,
    'S16 a Facebook Page begin returns the Page operational token';
  ASSERT v_token ->> 'token' IS DISTINCT FROM v_user_token,
    'S16 a Facebook Page begin does not return the User token';
  ASSERT v_token ->> 'credential_id' IS NULL,
    'S16 the Page token envelope does not name the User credential';
  ASSERT v_token ->> 'social_account_id' = v_page::text,
    'S16 the Page token envelope names the Page account';
  ASSERT (SELECT count(*) FROM jsonb_object_keys(v_token)) = 7,
    'S16 the token envelope keeps its seven fields';

  v_capture := (v_result ->> 'capture_id')::uuid;
  v_result := public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'operation', 'page_token',
    'fields', jsonb_build_object(
      'access_token', 'fb-page-token-2',
      'token_expires_at', '2027-06-01T00:00:00Z')));

  ASSERT (v_result ->> 'credential_generation') IS NULL,
    'S16 a Facebook Page refresh does not invent an Instagram generation';
  ASSERT (v_result -> 'accounts' -> 0 ->> 'needs_reauth')::boolean IS TRUE,
    'S16 success does not clear needs_reauth';
  ASSERT (v_result -> 'accounts' -> 0 ->> 'failure_count')::integer = 0,
    'S16 success clears the Page failure count';

  SELECT connection_version INTO v_fence_after
    FROM public.facebook_user_credential_connection_fences
   WHERE social_account_id = v_page;
  ASSERT v_fence_after = v_fence + 1,
    'S16 the Facebook Page connection fence advanced';
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = v_page) = 'fb-page-token-2',
    'S16 the Page operational token was written on the account';
  ASSERT (SELECT failure_count FROM public.social_accounts WHERE id = v_page) = 0,
    'S16 the Page failure count was stored as cleared';
  ASSERT (SELECT last_refresh_error FROM public.social_accounts WHERE id = v_page) IS NULL,
    'S16 the Page error was cleared';
  ASSERT (SELECT needs_reauth FROM public.social_accounts WHERE id = v_page) IS TRUE,
    'S16 needs_reauth stayed set';
  ASSERT (SELECT token FROM public.facebook_user_credentials WHERE id = v_cred) = v_user_token,
    'S16 the User token was not rotated';
  ASSERT (SELECT revision FROM public.facebook_user_credentials WHERE id = v_cred) = v_user_rev,
    'S16 the User revision was not rotated';
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = v_ig) = v_ig_token,
    'S16 the Instagram Page token was not rewritten';
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = v_sibling) = v_sibling_token,
    'S16 the sibling token was not rewritten';

  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_page, 'operation', 'page_token'))))
    ->> 'capture_id')::uuid INTO v_capture;
  UPDATE public.facebook_user_credential_connection_fences
     SET connection_version = connection_version + 1
   WHERE social_account_id = v_page;
  BEGIN
    PERFORM public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_token',
      'fields', jsonb_build_object('access_token', 'fb-page-token-3')));
    RAISE EXCEPTION 'S16 failed: a stale Facebook Page fence was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN
    NULL;
  END;
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = v_page) = 'fb-page-token-2',
    'S16 the stale fence wrote no Page token';
  ASSERT (SELECT revision FROM public.facebook_user_credentials WHERE id = v_cred) = v_user_rev,
    'S16 the stale fence did not rotate the User grant';
  ASSERT (SELECT f.connection_version
            FROM public.facebook_user_credential_connection_fences AS f
           WHERE f.social_account_id = v_page)
         = (SELECT b.connection_version
              FROM public.facebook_user_credential_bindings AS b
             WHERE b.social_account_id = v_page) + 1,
    'S16 the administrative fence drift survived the refused write';
  -- The drift is the refusal. Put the fence back beside its binding so a
  -- later shared rotation still has one coherent connection version.
  UPDATE public.facebook_user_credential_connection_fences AS f
     SET connection_version = b.connection_version
    FROM public.facebook_user_credential_bindings AS b
   WHERE f.social_account_id = v_page
     AND b.social_account_id = f.social_account_id
     AND b.user_id = f.user_id;
END
$s16$;

-- ---------------------------------------------------------------------------
-- S17. A bound Instagram Page begin returns that Page token, not the User
--      credential. A direct begin still returns the direct token.
-- ---------------------------------------------------------------------------
DO $s17$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_page CONSTANT uuid := '0f1a0002-0000-4000-8000-000000000012';
  v_direct CONSTANT uuid := '0f1a0005-0000-4000-8000-000000000015';
  v_cred CONSTANT uuid := '0f1c0001-0000-4000-8000-000000000031';
  v_result JSONB;
  v_live TEXT;
  v_user TEXT;
  v_rev BIGINT;
BEGIN
  SELECT access_token INTO v_live FROM public.social_accounts WHERE id = v_page;
  SELECT token, revision INTO v_user, v_rev
    FROM public.facebook_user_credentials WHERE id = v_cred;

  v_result := public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_page, 'operation', 'page_token'))));
  ASSERT v_result -> 'tokens' -> 0 ->> 'scope' = 'account',
    'S17 the Instagram Page token scope is account';
  ASSERT v_result -> 'tokens' -> 0 ->> 'token' = v_live,
    'S17 the Instagram Page begin returns the Page operational token';
  ASSERT v_result -> 'tokens' -> 0 ->> 'token' IS DISTINCT FROM v_user,
    'S17 the Instagram Page begin does not substitute the User token';
  ASSERT (SELECT token FROM public.facebook_user_credentials WHERE id = v_cred) = v_user,
    'S17 begin did not rotate the User token';
  ASSERT (SELECT revision FROM public.facebook_user_credentials WHERE id = v_cred) = v_rev,
    'S17 begin did not rotate the User revision';

  SELECT access_token INTO v_live FROM public.social_accounts WHERE id = v_direct;
  v_result := public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_direct, 'operation', 'direct_token'))));
  ASSERT v_result -> 'tokens' -> 0 ->> 'scope' = 'account',
    'S17 the direct token scope is account';
  ASSERT v_result -> 'tokens' -> 0 ->> 'token' = v_live,
    'S17 the direct begin returns the direct operational token';

  v_result := public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_page, 'operation', 'facebook_user_token'))));
  ASSERT v_result -> 'tokens' -> 0 ->> 'scope' = 'credential',
    'S17 a User rotation returns credential scope';
  ASSERT v_result -> 'tokens' -> 0 ->> 'token' = v_user,
    'S17 a User rotation returns the User token';
  ASSERT v_result -> 'tokens' -> 0 ->> 'social_account_id' IS NULL,
    'S17 the User token envelope is not an account token';
  ASSERT jsonb_array_length(v_result -> 'tokens') = 1,
    'S17 the User token is returned once';
END
$s17$;

-- ---------------------------------------------------------------------------
-- S18. Present, typed inputs. A missing operation cannot rotate another
--      authority. A direct or Page capture of two accounts is refused at
--      begin and leaves no open capture. Refusals do not mutate state.
--      Malformed begins are compared with the snapshot taken before them.
--      Writer refusals are compared with the snapshot taken after the one
--      legitimate begin, including every column of the authority tables.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.mar_refresh_authority_snapshot(p_owner UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $snap$
  SELECT jsonb_build_object(
    'accounts', COALESCE((
      SELECT jsonb_agg(to_jsonb(sa) ORDER BY sa.id)
        FROM public.social_accounts AS sa WHERE sa.user_id = p_owner), '[]'::JSONB),
    'credentials', COALESCE((
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id)
        FROM public.facebook_user_credentials AS c WHERE c.user_id = p_owner), '[]'::JSONB),
    'bindings', COALESCE((
      SELECT jsonb_agg(to_jsonb(b) ORDER BY b.social_account_id)
        FROM public.facebook_user_credential_bindings AS b WHERE b.user_id = p_owner), '[]'::JSONB),
    'fences', COALESCE((
      SELECT jsonb_agg(to_jsonb(f) ORDER BY f.social_account_id)
        FROM public.facebook_user_credential_connection_fences AS f WHERE f.user_id = p_owner), '[]'::JSONB),
    'capabilities', COALESCE((
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.social_account_id)
        FROM public.instagram_account_capabilities AS c WHERE c.user_id = p_owner), '[]'::JSONB),
    'captures', COALESCE((
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at, c.id)
        FROM public.meta_account_refresh_captures AS c WHERE c.user_id = p_owner), '[]'::JSONB),
    'outbox', COALESCE((
      SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id)
        FROM public.partner_webhook_deliveries AS d
        JOIN public.workspaces AS w ON w.id = d.workspace_id
       WHERE w.owner_id = p_owner), '[]'::JSONB)
  );
$snap$;

DO $s18$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_page CONSTANT uuid := '0f1a0002-0000-4000-8000-000000000012';
  v_direct CONSTANT uuid := '0f1a0001-0000-4000-8000-000000000011';
  v_other CONSTANT uuid := '0f1a0005-0000-4000-8000-000000000015';
  v_cred CONSTANT uuid := '0f1c0001-0000-4000-8000-000000000031';
  v_capture UUID;
  v_before JSONB;
  v_baseline JSONB;
  v_after_write JSONB;
  v_sqlstate TEXT;
  v_rev BIGINT;
BEGIN
  v_before := pg_temp.mar_refresh_authority_snapshot(v_owner);
  SELECT revision INTO v_rev FROM public.facebook_user_credentials WHERE id = v_cred;

  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, '{}'::jsonb);
    RAISE EXCEPTION 'S18 failed: an empty begin was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;
  ASSERT pg_temp.mar_refresh_authority_snapshot(v_owner) = v_before,
    'S18 an empty begin changed authority';

  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object('accounts', NULL));
    RAISE EXCEPTION 'S18 failed: a null account list was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;
  ASSERT pg_temp.mar_refresh_authority_snapshot(v_owner) = v_before,
    'S18 a null account list changed authority';

  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(1)));
    RAISE EXCEPTION 'S18 failed: a non-object account entry was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;
  ASSERT pg_temp.mar_refresh_authority_snapshot(v_owner) = v_before,
    'S18 a non-object account entry changed authority';

  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', v_direct))));
    RAISE EXCEPTION 'S18 failed: a missing operation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;
  ASSERT pg_temp.mar_refresh_authority_snapshot(v_owner) = v_before,
    'S18 a missing operation changed authority';

  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', v_direct, 'operation', NULL))));
    RAISE EXCEPTION 'S18 failed: a null operation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;
  ASSERT pg_temp.mar_refresh_authority_snapshot(v_owner) = v_before,
    'S18 a null operation changed authority';

  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(
        jsonb_build_object('social_account_id', v_direct, 'operation', 'direct_token'),
        jsonb_build_object('social_account_id', v_other, 'operation', 'direct_token'))));
    RAISE EXCEPTION 'S18 failed: a two-account direct capture was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;
  ASSERT pg_temp.mar_refresh_authority_snapshot(v_owner) = v_before,
    'S18 a two-account direct capture changed authority';

  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(
        jsonb_build_object('social_account_id', v_page, 'operation', 'page_token'),
        jsonb_build_object('social_account_id', '0f1a0003-0000-4000-8000-000000000013',
                           'operation', 'page_token'))));
    RAISE EXCEPTION 'S18 failed: a two-account page capture was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;
  ASSERT pg_temp.mar_refresh_authority_snapshot(v_owner) = v_before,
    'S18 a two-account page capture changed authority';

  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_page, 'operation', 'page_token'))))
    ->> 'capture_id')::uuid INTO v_capture;
  v_baseline := pg_temp.mar_refresh_authority_snapshot(v_owner);
  ASSERT v_baseline <> v_before,
    'S18 the legitimate begin recorded a capture';
  ASSERT (SELECT status FROM public.meta_account_refresh_captures WHERE id = v_capture) = 'open',
    'S18 the legitimate begin left its capture open';

  BEGIN
    PERFORM public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'fields', jsonb_build_object('token', 'synthetic-cross-authority')));
    RAISE EXCEPTION 'S18 failed: a success without an operation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;
  ASSERT pg_temp.mar_refresh_authority_snapshot(v_owner) = v_baseline,
    'S18 a success without an operation changed authority';

  BEGIN
    PERFORM public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', NULL,
      'fields', jsonb_build_object('token', 'synthetic-cross-authority')));
    RAISE EXCEPTION 'S18 failed: a null success operation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;
  ASSERT pg_temp.mar_refresh_authority_snapshot(v_owner) = v_baseline,
    'S18 a null success operation changed authority';

  BEGIN
    PERFORM public.write_direct_instagram_account(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'fields', jsonb_build_object('access_token', 'synthetic-direct')));
    RAISE EXCEPTION 'S18 failed: a direct write without an operation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;
  ASSERT pg_temp.mar_refresh_authority_snapshot(v_owner) = v_baseline,
    'S18 a direct write without an operation changed authority';

  BEGIN
    PERFORM public.record_meta_refresh_failure(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'error_category', 'provider_error'));
    RAISE EXCEPTION 'S18 failed: a failure without an account was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;
  ASSERT pg_temp.mar_refresh_authority_snapshot(v_owner) = v_baseline,
    'S18 a failure without an account changed authority';

  BEGIN
    PERFORM public.record_meta_refresh_failure(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'social_account_id', v_page,
      'error_category', NULL));
    RAISE EXCEPTION 'S18 failed: a null failure category was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;
  ASSERT pg_temp.mar_refresh_authority_snapshot(v_owner) = v_baseline,
    'S18 a null failure category changed authority';

  ASSERT (SELECT count(*) FROM public.meta_account_refresh_captures
           WHERE user_id = v_owner AND status = 'open'
             AND operation IN ('direct_token', 'page_token')
             AND jsonb_array_length(capture -> 'targets') > 1) = 0,
    'S18 no multi-account direct or page capture was stored';

  -- The explicit matching page write still succeeds and does not rotate User.
  PERFORM public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'operation', 'page_token',
    'fields', jsonb_build_object('access_token', 'page-token-s18')));
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = v_page) = 'page-token-s18',
    'S18 the explicit page write stored the Page token';
  ASSERT (SELECT revision FROM public.facebook_user_credentials WHERE id = v_cred) = v_rev,
    'S18 the explicit page write did not rotate the User revision';
  ASSERT (SELECT status FROM public.meta_account_refresh_captures WHERE id = v_capture) = 'completed',
    'S18 the explicit page write closed its own capture';

  v_after_write := pg_temp.mar_refresh_authority_snapshot(v_owner);

  -- A wrong-type capture id is malformed, not an internal cast error.
  BEGIN
    PERFORM public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
      'capture_id', 12,
      'operation', 'page_token',
      'fields', jsonb_build_object('access_token', 'x')));
    RAISE EXCEPTION 'S18 failed: a numeric capture id was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION
    WHEN SQLSTATE 'MAR01' THEN NULL;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE;
      RAISE EXCEPTION 'S18 a numeric capture id raised %', v_sqlstate;
  END;
  ASSERT pg_temp.mar_refresh_authority_snapshot(v_owner) = v_after_write,
    'S18 a numeric capture id changed authority';
END
$s18$;

-- ---------------------------------------------------------------------------
-- S19. Shared success validates each explicit target and resets only that
--      target's failure evidence. Identity, health and expiry drift refuse.
--      needs_reauth stays. A sibling's health stays.
-- ---------------------------------------------------------------------------
DO $s19$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_target CONSTANT uuid := '0f1a0002-0000-4000-8000-000000000012';
  v_sibling CONSTANT uuid := '0f1a0003-0000-4000-8000-000000000013';
  v_cred CONSTANT uuid := '0f1c0001-0000-4000-8000-000000000031';
  v_capture UUID;
  v_rev BIGINT;
  v_token TEXT;
  v_sibling_token TEXT;
  v_identity TEXT;
BEGIN
  UPDATE public.social_accounts
     SET failure_count = 2, last_refresh_error = 'old_error', needs_reauth = true
   WHERE id = v_target;
  UPDATE public.social_accounts
     SET failure_count = 4, last_refresh_error = 'sibling_error', needs_reauth = true
   WHERE id = v_sibling;
  SELECT token, revision INTO v_token, v_rev
    FROM public.facebook_user_credentials WHERE id = v_cred;
  SELECT access_token INTO v_sibling_token FROM public.social_accounts WHERE id = v_sibling;

  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_target, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid INTO v_capture;
  PERFORM public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'operation', 'facebook_user_token',
    'fields', jsonb_build_object('token', 'user-token-s19')));

  ASSERT (SELECT token FROM public.facebook_user_credentials WHERE id = v_cred) = 'user-token-s19',
    'S19 the explicit User rotation stored the new User token';
  ASSERT (SELECT revision FROM public.facebook_user_credentials WHERE id = v_cred) = v_rev + 1,
    'S19 the User revision advanced once';
  ASSERT (SELECT failure_count FROM public.social_accounts WHERE id = v_target) = 0,
    'S19 the explicit target failure count was reset';
  ASSERT (SELECT last_refresh_error FROM public.social_accounts WHERE id = v_target) IS NULL,
    'S19 the explicit target error was cleared';
  ASSERT (SELECT needs_reauth FROM public.social_accounts WHERE id = v_target) IS TRUE,
    'S19 the explicit target needs_reauth was not cleared';
  ASSERT (SELECT failure_count FROM public.social_accounts WHERE id = v_sibling) = 4,
    'S19 the sibling failure count was left untouched';
  ASSERT (SELECT last_refresh_error FROM public.social_accounts WHERE id = v_sibling) = 'sibling_error',
    'S19 the sibling error was left untouched';
  ASSERT (SELECT needs_reauth FROM public.social_accounts WHERE id = v_sibling) IS TRUE,
    'S19 the sibling needs_reauth was left untouched';
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = v_sibling) = v_sibling_token,
    'S19 the sibling operational token was not rewritten';

  SELECT platform_user_id INTO v_identity FROM public.social_accounts WHERE id = v_target;
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_target, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid INTO v_capture;
  UPDATE public.social_accounts SET platform_user_id = 'ig-page-drift'
   WHERE id = v_target;
  BEGIN
    PERFORM public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'facebook_user_token',
      'fields', jsonb_build_object('token', 'user-token-drift')));
    RAISE EXCEPTION 'S19 failed: target identity drift was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;
  UPDATE public.social_accounts SET platform_user_id = v_identity WHERE id = v_target;
  ASSERT (SELECT token FROM public.facebook_user_credentials WHERE id = v_cred) = 'user-token-s19',
    'S19 identity drift did not rotate the User token';

  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_target, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid INTO v_capture;
  UPDATE public.social_accounts SET failure_count = failure_count + 1 WHERE id = v_target;
  BEGIN
    PERFORM public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'facebook_user_token',
      'fields', jsonb_build_object('token', 'user-token-health')));
    RAISE EXCEPTION 'S19 failed: target health drift was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;
  ASSERT (SELECT token FROM public.facebook_user_credentials WHERE id = v_cred) = 'user-token-s19',
    'S19 health drift did not rotate the User token';

  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_target, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid INTO v_capture;
  UPDATE public.social_accounts
     SET token_expires_at = '2028-01-01T00:00:00Z'
   WHERE id = v_target;
  BEGIN
    PERFORM public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'facebook_user_token',
      'fields', jsonb_build_object('token', 'user-token-expiry')));
    RAISE EXCEPTION 'S19 failed: target expiry drift was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;
  ASSERT (SELECT revision FROM public.facebook_user_credentials WHERE id = v_cred) = v_rev + 1,
    'S19 expiry drift did not advance the User revision';
END
$s19$;

-- ---------------------------------------------------------------------------
-- S20. Canonical failure classes. Malformed responses and generic permission
--      errors count and do not latch. Revoked, expired, invalid-grant and
--      no-refresh-material latch immediately. The third counted failure
--      latches and emits one transition. Success resets the counter without
--      clearing needs_reauth. An omitted expiry is preserved even when the
--      stored expiry is already past.
-- ---------------------------------------------------------------------------
DO $s20$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1a0007-0000-4000-8000-000000000017';
  v_direct CONSTANT uuid := '0f1a0005-0000-4000-8000-000000000015';
  v_capture UUID;
  v_outbox INTEGER;
  v_past TIMESTAMPTZ := '2020-01-01T00:00:00Z';
  v_result JSONB;
BEGIN
  UPDATE public.social_accounts
     SET failure_count = 0, needs_reauth = false, last_refresh_error = NULL,
         last_alert_sent_at = NULL, alerts_snoozed = false
   WHERE id = v_account;
  SELECT count(*) INTO v_outbox
    FROM public.partner_webhook_deliveries
   WHERE event_type = 'account.reauthorization_required'
     AND payload ->> 'account_id' = 'acc_' || v_account::text;

  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;
  v_result := public.record_meta_refresh_failure(v_owner, jsonb_build_object(
    'capture_id', v_capture, 'social_account_id', v_account,
    'error_category', 'provider_response_invalid'));
  ASSERT (v_result ->> 'escalated')::boolean IS FALSE,
    'S20 a malformed response does not latch';
  ASSERT (v_result ->> 'failure_count')::integer = 1,
    'S20 a malformed response counts';
  ASSERT (SELECT needs_reauth FROM public.social_accounts WHERE id = v_account) IS FALSE,
    'S20 a malformed response left needs_reauth false';
  ASSERT (SELECT last_refresh_error FROM public.social_accounts WHERE id = v_account)
         = 'provider_response_invalid',
    'S20 the stored error is the category, not provider text';

  UPDATE public.social_accounts
     SET failure_count = 0, needs_reauth = false, last_refresh_error = NULL
   WHERE id = v_account;
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;
  v_result := public.record_meta_refresh_failure(v_owner, jsonb_build_object(
    'capture_id', v_capture, 'social_account_id', v_account,
    'error_category', 'provider_permission_denied'));
  ASSERT (v_result ->> 'escalated')::boolean IS FALSE,
    'S20 a generic permission error does not latch';
  ASSERT (SELECT failure_count FROM public.social_accounts WHERE id = v_account) = 1,
    'S20 a generic permission error counts';
  ASSERT (SELECT needs_reauth FROM public.social_accounts WHERE id = v_account) IS FALSE,
    'S20 a generic permission error left needs_reauth false';

  UPDATE public.social_accounts
     SET failure_count = 0, needs_reauth = false, last_refresh_error = NULL,
         alerts_snoozed = true
   WHERE id = v_account;
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;
  v_result := public.record_meta_refresh_failure(v_owner, jsonb_build_object(
    'capture_id', v_capture, 'social_account_id', v_account,
    'error_category', 'provider_auth_revoked'));
  ASSERT (v_result ->> 'escalated')::boolean IS TRUE,
    'S20 a revoked grant latches immediately';
  ASSERT (v_result ->> 'enqueued')::integer = 1,
    'S20 a revoked grant emits the false to true event';
  ASSERT (v_result ->> 'alert_marker_written')::boolean IS FALSE,
    'S20 a snoozed account does not take an alert marker';
  ASSERT (SELECT last_alert_sent_at FROM public.social_accounts WHERE id = v_account) IS NULL,
    'S20 the snooze preserved the empty alert marker';
  ASSERT (SELECT needs_reauth FROM public.social_accounts WHERE id = v_account) IS TRUE,
    'S20 the revoked grant set needs_reauth';

  UPDATE public.social_accounts
     SET failure_count = 0, needs_reauth = false, last_refresh_error = NULL,
         alerts_snoozed = false, last_alert_sent_at = clock_timestamp()
   WHERE id = v_account;
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;
  v_result := public.record_meta_refresh_failure(v_owner, jsonb_build_object(
    'capture_id', v_capture, 'social_account_id', v_account,
    'error_category', 'local_no_refresh_material'));
  ASSERT (v_result ->> 'escalated')::boolean IS TRUE,
    'S20 no refresh material latches immediately';
  ASSERT (v_result ->> 'enqueued')::integer = 1,
    'S20 no refresh material emits the false to true event';
  ASSERT (v_result ->> 'alert_marker_written')::boolean IS FALSE,
    'S20 the alert cooldown did not rewrite the marker';

  UPDATE public.social_accounts
     SET failure_count = 0, needs_reauth = false, last_refresh_error = NULL,
         last_alert_sent_at = NULL
   WHERE id = v_account;
  SELECT count(*) INTO v_outbox
    FROM public.partner_webhook_deliveries
   WHERE event_type = 'account.reauthorization_required'
     AND payload ->> 'account_id' = 'acc_' || v_account::text;
  -- Two separate captures. A query loop would open the second before the
  -- first failure closed the first, and begin would supersede it.
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;
  PERFORM public.record_meta_refresh_failure(v_owner, jsonb_build_object(
    'capture_id', v_capture, 'social_account_id', v_account,
    'error_category', 'provider_error'));
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;
  PERFORM public.record_meta_refresh_failure(v_owner, jsonb_build_object(
    'capture_id', v_capture, 'social_account_id', v_account,
    'error_category', 'provider_error'));
  ASSERT (SELECT needs_reauth FROM public.social_accounts WHERE id = v_account) IS FALSE,
    'S20 two counted errors do not latch';
  ASSERT (SELECT failure_count FROM public.social_accounts WHERE id = v_account) = 2,
    'S20 two counted errors are stored';
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;
  v_result := public.record_meta_refresh_failure(v_owner, jsonb_build_object(
    'capture_id', v_capture, 'social_account_id', v_account,
    'error_category', 'provider_error'));
  ASSERT (v_result ->> 'escalated')::boolean IS TRUE,
    'S20 the third counted error latches';
  ASSERT (v_result ->> 'transitioned')::boolean IS TRUE,
    'S20 the third counted error is the false to true transition';
  ASSERT (v_result ->> 'enqueued')::integer = 1,
    'S20 the transition enqueued one delivery';
  ASSERT (SELECT count(*) FROM public.partner_webhook_deliveries
           WHERE event_type = 'account.reauthorization_required'
             AND payload ->> 'account_id' = 'acc_' || v_account::text)
         = v_outbox + 1,
    'S20 exactly one new reauthorization event was stored';

  -- Success clears the counter and leaves the latch for OAuth.
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;
  PERFORM public.write_direct_instagram_account(v_owner, jsonb_build_object(
    'capture_id', v_capture, 'operation', 'direct_token',
    'fields', jsonb_build_object('access_token', 'injected-token-s20')));
  ASSERT (SELECT failure_count FROM public.social_accounts WHERE id = v_account) = 0,
    'S20 success reset the failure count';
  ASSERT (SELECT last_refresh_error FROM public.social_accounts WHERE id = v_account) IS NULL,
    'S20 success cleared the error';
  ASSERT (SELECT needs_reauth FROM public.social_accounts WHERE id = v_account) IS TRUE,
    'S20 success did not clear needs_reauth';

  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;
  PERFORM public.record_meta_refresh_failure(v_owner, jsonb_build_object(
    'capture_id', v_capture, 'social_account_id', v_account,
    'error_category', 'provider_error'));
  ASSERT (SELECT failure_count FROM public.social_accounts WHERE id = v_account) = 1,
    'S20 the failure after success starts again at one';
  ASSERT (SELECT count(*) FROM public.partner_webhook_deliveries
           WHERE event_type = 'account.reauthorization_required'
             AND payload ->> 'account_id' = 'acc_' || v_account::text)
         = v_outbox + 1,
    'S20 a failure on an already flagged account emits no second event';

  -- An omitted expiry is not refused because the stored expiry is past.
  UPDATE public.social_accounts
     SET token_expires_at = v_past, access_token = 'past-direct-token'
   WHERE id = v_direct;
  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_direct, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid INTO v_capture;
  PERFORM public.write_direct_instagram_account(v_owner, jsonb_build_object(
    'capture_id', v_capture, 'operation', 'direct_token',
    'fields', jsonb_build_object('access_token', 'past-direct-token-2')));
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = v_direct) = 'past-direct-token-2',
    'S20 an omitted expiry still stored the new token';
  ASSERT (SELECT token_expires_at FROM public.social_accounts WHERE id = v_direct) = v_past,
    'S20 an omitted expiry preserved the past stored expiry';
END
$s20$;

-- ---------------------------------------------------------------------------
-- S21. An account-only failure does not require an unrelated sibling
--      generation to stay unchanged, and it does not mutate that sibling.
-- ---------------------------------------------------------------------------
DO $s21$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_target CONSTANT uuid := '0f1a0002-0000-4000-8000-000000000012';
  v_sibling CONSTANT uuid := '0f1a0003-0000-4000-8000-000000000013';
  v_capture UUID;
  v_sibling_gen BIGINT;
  v_sibling_fail INTEGER;
  v_result JSONB;
BEGIN
  SELECT credential_generation INTO v_sibling_gen
    FROM public.instagram_account_capabilities WHERE social_account_id = v_sibling;
  SELECT failure_count INTO v_sibling_fail
    FROM public.social_accounts WHERE id = v_sibling;

  SELECT (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_target, 'operation', 'page_token'))))
    ->> 'capture_id')::uuid INTO v_capture;

  -- The sibling moves after the capture exists. An account-only failure of
  -- the target does not require that sibling generation to stay put, and it
  -- does not rewrite the sibling.
  UPDATE public.instagram_account_capabilities
     SET credential_generation = credential_generation + 1
   WHERE social_account_id = v_sibling;

  v_result := public.record_meta_refresh_failure(v_owner, jsonb_build_object(
    'capture_id', v_capture, 'social_account_id', v_target,
    'error_category', 'provider_rate_limited'));
  ASSERT (v_result ->> 'applied')::boolean IS TRUE,
    'S21 an account-only failure is accepted after a sibling generation change';
  ASSERT (v_result ->> 'failure_count')::integer
         = (SELECT (capture -> 'targets' -> 0 ->> 'failure_count')::integer + 0
              FROM public.meta_account_refresh_captures WHERE id = v_capture),
    'S21 a rate limit does not have to match a counted increment';
  ASSERT (SELECT credential_generation FROM public.instagram_account_capabilities
           WHERE social_account_id = v_sibling) = v_sibling_gen + 1,
    'S21 the sibling generation was not rewritten by the account-only failure';
  ASSERT (SELECT failure_count FROM public.social_accounts WHERE id = v_sibling) = v_sibling_fail,
    'S21 the sibling failure count was not rewritten';
END
$s21$;

-- ---------------------------------------------------------------------------
-- S24. A test administrator can insert a capture row. Browsers cannot.
--      A valid direct-account document spliced onto a valid shared-grant
--      document must not rotate that grant.
-- ---------------------------------------------------------------------------
DO $s24$
DECLARE
  v_owner CONSTANT uuid := '0f100001-0000-4000-8000-000000000001';
  v_direct CONSTANT uuid := '0f1a0001-0000-4000-8000-000000000011';
  v_cred CONSTANT uuid := '0f1c0001-0000-4000-8000-000000000031';
  v_capture UUID;
  v_rev BIGINT;
  v_token TEXT;
  v_direct_token TEXT;
  v_direct_fail INTEGER;
  v_doc JSONB;
BEGIN
  SELECT token, revision INTO v_token, v_rev
    FROM public.facebook_user_credentials WHERE id = v_cred;
  SELECT access_token, failure_count INTO v_direct_token, v_direct_fail
    FROM public.social_accounts WHERE id = v_direct;

  v_doc := jsonb_build_object(
    'capture_version', 1,
    'captured_at', clock_timestamp(),
    'expires_at', clock_timestamp() + INTERVAL '30 minutes',
    'user_id', v_owner,
    'operation', 'facebook_user_token',
    'targets', jsonb_build_array(
      public.meta_account_refresh_capture_account(v_owner, v_direct)),
    'credential', (
      SELECT jsonb_build_object(
               'credential_id', c.id,
               'revision', c.revision,
               'provider_user_id', c.provider_user_id,
               'token_expires_at', c.token_expires_at)
        FROM public.facebook_user_credentials AS c
       WHERE c.id = v_cred),
    'members', public.meta_account_refresh_capture_members(v_owner, v_cred));

  ASSERT NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_doc -> 'members') AS e(value)
     WHERE (e.value ->> 'social_account_id')::uuid = v_direct
  ), 'S24 the forged target is outside the captured member set';

  INSERT INTO public.meta_account_refresh_captures (
    user_id, capture_version, operation, status, captured_at, expires_at, capture
  ) VALUES (
    v_owner, 1, 'facebook_user_token', 'open',
    clock_timestamp(), clock_timestamp() + INTERVAL '30 minutes', v_doc
  ) RETURNING id INTO v_capture;

  BEGIN
    PERFORM public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'facebook_user_token',
      'fields', jsonb_build_object('token', 'forged-grant-rotation')));
    RAISE EXCEPTION 'S24 a spliced target rotated the grant'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  ASSERT (SELECT revision FROM public.facebook_user_credentials WHERE id = v_cred) = v_rev,
    'S24 the captured grant revision was not rotated';
  ASSERT (SELECT token FROM public.facebook_user_credentials WHERE id = v_cred) = v_token,
    'S24 the captured grant token was not rotated';
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = v_direct) = v_direct_token,
    'S24 the spliced account token was not rewritten';
  ASSERT (SELECT failure_count FROM public.social_accounts WHERE id = v_direct) = v_direct_fail,
    'S24 the spliced account health was not rewritten';
  ASSERT (SELECT status FROM public.meta_account_refresh_captures WHERE id = v_capture) = 'open',
    'S24 the forged capture stayed open';
END
$s24$;

-- ---------------------------------------------------------------------------
-- S22. Capture acquisition is NOWAIT, and cancellation is not remapped.
--      These predicates read the function body. A second session is what
--      shows a real NOWAIT refusal and a real cancellation; this file does
--      not open one.
-- ---------------------------------------------------------------------------
DO $s22$
DECLARE
  v_load TEXT;
  v_begin TEXT;
BEGIN
  v_load := pg_get_functiondef(
    'public.meta_account_refresh_load_capture(uuid,uuid,text)'::regprocedure);
  v_begin := pg_get_functiondef(
    'public.begin_meta_account_refresh(uuid,jsonb)'::regprocedure);
  ASSERT v_load LIKE '%FOR UPDATE NOWAIT%',
    'S22 capture load takes the row NOWAIT';
  ASSERT position('WHEN query_canceled' IN v_load) = 0,
    'S22 capture load does not map query_canceled';
  ASSERT position('57014' IN v_load) = 0,
    'S22 capture load does not map statement cancellation by SQLSTATE';
  ASSERT position('WHEN query_canceled' IN v_begin) = 0,
    'S22 begin does not map query_canceled to contention';
  ASSERT position('57014' IN v_begin) = 0,
    'S22 begin does not map statement cancellation by SQLSTATE';
  ASSERT position('postora.meta_refresh_discovery_barrier' IN v_begin) = 0,
    'S22 begin has no production discovery barrier';
  ASSERT position('pg_advisory_xact_lock' IN v_begin) = 0,
    'S22 begin takes no blocking advisory lock';
  ASSERT position('meta_account_refresh_require_discovered_grant' IN v_begin) > 0,
    'S22 begin rechecks the discovered grant under its locks';
END
$s22$;

-- ---------------------------------------------------------------------------
-- S23. Actual anon and authenticated execution is denied. Privilege
--      predicates are not this proof.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE anon;

DO $s23a$
BEGIN
  BEGIN
    PERFORM public.begin_meta_account_refresh(
      '0f100001-0000-4000-8000-000000000001',
      jsonb_build_object('accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', '0f1a0001-0000-4000-8000-000000000011',
        'operation', 'direct_token'))));
    RAISE EXCEPTION 'S23 anon executed begin' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.write_direct_instagram_account(
      '0f100001-0000-4000-8000-000000000001', '{}'::jsonb);
    RAISE EXCEPTION 'S23 anon executed the direct writer' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.write_meta_account_refresh_success(
      '0f100001-0000-4000-8000-000000000001', '{}'::jsonb);
    RAISE EXCEPTION 'S23 anon executed the success writer' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.record_meta_refresh_failure(
      '0f100001-0000-4000-8000-000000000001', '{}'::jsonb);
    RAISE EXCEPTION 'S23 anon executed the failure writer' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$s23a$;

RESET ROLE;
SET LOCAL ROLE authenticated;

DO $s23b$
BEGIN
  BEGIN
    PERFORM public.begin_meta_account_refresh(
      '0f100001-0000-4000-8000-000000000001',
      jsonb_build_object('accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', '0f1a0001-0000-4000-8000-000000000011',
        'operation', 'direct_token'))));
    RAISE EXCEPTION 'S23 authenticated executed begin' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.write_direct_instagram_account(
      '0f100001-0000-4000-8000-000000000001', '{}'::jsonb);
    RAISE EXCEPTION 'S23 authenticated executed the direct writer'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.write_meta_account_refresh_success(
      '0f100001-0000-4000-8000-000000000001', '{}'::jsonb);
    RAISE EXCEPTION 'S23 authenticated executed the success writer'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.record_meta_refresh_failure(
      '0f100001-0000-4000-8000-000000000001', '{}'::jsonb);
    RAISE EXCEPTION 'S23 authenticated executed the failure writer'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$s23b$;

RESET ROLE;

ROLLBACK;

\echo 'meta_account_refresh_lifecycle: ALL CHECKS PASSED'
