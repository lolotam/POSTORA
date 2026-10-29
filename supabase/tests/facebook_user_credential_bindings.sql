-- supabase/tests/facebook_user_credential_bindings.sql
-- Credential-store correction (migration 20261026140000).
--
-- One transaction, synthetic fixtures, ROLLBACK. No provider calls and no
-- real tokens. Proves the Facebook User secret has one authority, bindings
-- are owner-scoped, and the Task 3a read wrapper still resolves it.

BEGIN;

DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  u_b uuid := 'f11b0002-0000-4000-8000-000000000002';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (u_a, 'fuc-a-' || u_a::text || '@example.invalid'),
    (u_b, 'fuc-b-' || u_b::text || '@example.invalid');

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username,
     access_token, ig_auth_type, account_metadata)
  VALUES
    ('f11c0001-0000-4000-8000-000000000011', u_a, 'facebook', 'page-a', 'page_a',
     'page-token-a', NULL, '{"facebook_page_id":"should-not-bind"}'::jsonb),
    ('f11c0006-0000-4000-8000-000000000016', u_a, 'facebook', 'page-a2', 'page_a2',
     'page-token-a2', NULL, '{}'::jsonb),
    ('f11c0005-0000-4000-8000-000000000015', u_b, 'facebook', 'page-b', 'page_b',
     'page-token-b', NULL, '{}'::jsonb),
    ('f11c0002-0000-4000-8000-000000000012', u_a, 'instagram', 'ig-page', 'ig_page',
     'ig-page-token', 'facebook_page', '{"facebook_page_id":"meta-page"}'::jsonb),
    ('f11c0004-0000-4000-8000-000000000014', u_a, 'instagram', 'ig-page-2', 'ig_page_2',
     'ig-page-token-2', 'facebook_page', NULL),
    ('f11c0003-0000-4000-8000-000000000013', u_a, 'instagram', 'ig-direct', 'ig_direct',
     'ig-direct-token', 'business_login', '{"facebook_page_id":"forged-page"}'::jsonb);
END $$;

-- ---------------------------------------------------------------------------
-- S1. Grant surface. No browser policy, no client privilege, no token column
-- on the old linkage.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f TEXT;
BEGIN
  ASSERT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'public.facebook_user_credentials'::regclass),
    'S1 RLS is enabled on facebook_user_credentials';
  ASSERT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'public.facebook_user_credential_bindings'::regclass),
    'S1 RLS is enabled on facebook_user_credential_bindings';
  ASSERT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'public.facebook_user_credential_connection_fences'::regclass),
    'S1 RLS is enabled on connection fences';
  ASSERT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'public.instagram_account_credentials'::regclass),
    'S1 the compatibility linkage still has RLS';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN (
         'facebook_user_credentials',
         'facebook_user_credential_bindings',
         'facebook_user_credential_connection_fences',
         'instagram_account_credentials'
       )
  ), 'S1 no policy exists on the credential relations';

  ASSERT NOT has_table_privilege('anon', 'public.facebook_user_credentials',
                                 'SELECT, INSERT, UPDATE, DELETE'),
    'S1 anon holds no privilege on facebook_user_credentials';
  ASSERT NOT has_table_privilege('authenticated', 'public.facebook_user_credentials',
                                 'SELECT, INSERT, UPDATE, DELETE'),
    'S1 authenticated holds no privilege on facebook_user_credentials';
  ASSERT NOT has_table_privilege('anon', 'public.facebook_user_credential_bindings',
                                 'SELECT, INSERT, UPDATE, DELETE'),
    'S1 anon holds no privilege on bindings';
  ASSERT NOT has_table_privilege('authenticated', 'public.facebook_user_credential_bindings',
                                 'SELECT, INSERT, UPDATE, DELETE'),
    'S1 authenticated holds no privilege on bindings';
  ASSERT NOT has_table_privilege('anon', 'public.facebook_user_credential_connection_fences',
                                 'SELECT, INSERT, UPDATE, DELETE'),
    'S1 anon holds no privilege on connection fences';
  ASSERT NOT has_table_privilege('authenticated', 'public.facebook_user_credential_connection_fences',
                                 'SELECT, INSERT, UPDATE, DELETE'),
    'S1 authenticated holds no privilege on connection fences';
  ASSERT has_table_privilege('service_role', 'public.facebook_user_credential_connection_fences', 'SELECT'),
    'S1 service_role can SELECT connection fences';
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'social_accounts'
       AND column_name = 'connection_version'
  ), 'S1 connection version is not a social_accounts column';
  ASSERT NOT has_function_privilege(
    'anon',
    'public.facebook_user_credential_commit_connection_version(uuid,uuid,bigint)',
    'EXECUTE'),
    'S1 anon cannot advance a connection version directly';
  ASSERT NOT has_function_privilege(
    'service_role',
    'public.facebook_user_credential_commit_connection_version(uuid,uuid,bigint)',
    'EXECUTE'),
    'S1 service_role cannot advance a connection version directly';
  ASSERT has_table_privilege('service_role', 'public.facebook_user_credentials', 'SELECT'),
    'S1 service_role can SELECT credentials';
  ASSERT has_table_privilege('service_role', 'public.facebook_user_credentials', 'INSERT'),
    'S1 service_role can INSERT credentials';
  ASSERT has_table_privilege('service_role', 'public.facebook_user_credentials', 'UPDATE'),
    'S1 service_role can UPDATE credentials';
  ASSERT has_table_privilege('service_role', 'public.facebook_user_credentials', 'DELETE'),
    'S1 service_role can DELETE credentials';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'instagram_account_credentials'
       AND column_name IN ('token', 'token_expires_at', 'credential_kind')
  ), 'S1 the compatibility linkage has no secret columns';
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'instagram_account_credentials'
       AND column_name = 'credential_id'
  ), 'S1 the compatibility linkage points at a credential id';

  FOREACH f IN ARRAY ARRAY[
    'public.bind_facebook_user_credential(uuid,jsonb)',
    'public.write_facebook_user_credential(uuid,jsonb)',
    'public.unbind_facebook_user_credential(uuid,jsonb)',
    'public.revoke_facebook_user_credential(uuid,jsonb)',
    'public.describe_facebook_user_credential(uuid,uuid)',
    'public.read_facebook_user_credential(uuid,uuid)',
    'public.read_facebook_user_account_credential(uuid,uuid)'
  ] LOOP
    ASSERT NOT has_function_privilege('anon', f, 'EXECUTE'),
      format('S1 anon cannot execute %s', f);
    ASSERT NOT has_function_privilege('authenticated', f, 'EXECUTE'),
      format('S1 authenticated cannot execute %s', f);
    ASSERT has_function_privilege('service_role', f, 'EXECUTE'),
      format('S1 service_role can execute %s', f);
  END LOOP;

  ASSERT NOT has_function_privilege(
    'service_role',
    'public.facebook_user_credential_lock_scope(uuid[],uuid[])',
    'EXECUTE'),
    'S1 service_role cannot call the lock helper directly';
  ASSERT NOT has_function_privilege(
    'anon',
    'public.facebook_user_credential_binding_deleted()',
    'EXECUTE'),
    'S1 anon cannot execute the purge trigger function';
END $$;

-- ---------------------------------------------------------------------------
-- S2. A credential cannot commit without a binding.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
BEGIN
  BEGIN
    INSERT INTO public.facebook_user_credentials (
      user_id, token, provenance_source
    ) VALUES (
      u_a, 'orphan-secret-value', 'compatibility_task3a'
    );
    SET CONSTRAINTS facebook_user_credentials_binding_required IMMEDIATE;
    RAISE EXCEPTION 'S2 failed: an unbound secret was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC03' THEN
    NULL;
  END;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.facebook_user_credentials
     WHERE token = 'orphan-secret-value'
  ), 'S2 the refused unbound secret is not stored';
END $$;

SET LOCAL ROLE service_role;

-- ---------------------------------------------------------------------------
-- S3. Facebook-only connection. No Instagram capability is required.
-- Metadata is not consulted. The status document has no token.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  fb uuid := 'f11c0001-0000-4000-8000-000000000011';
  v jsonb;
  v_read jsonb;
  v_id uuid;
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.instagram_account_capabilities
     WHERE social_account_id = fb
  ), 'S3 a Facebook account has no Instagram capability';

  v := public.bind_facebook_user_credential(u_a, jsonb_build_object(
    'expected_absent', true,
    'token', 'synthetic-user-token-a',
    'token_expires_at', '2027-01-01T00:00:00Z',
    'provenance_source', 'oauth_exchange',
    'provenance_captured_at', '2026-10-26T12:00:00Z',
    'social_account_id', fb,
    'verified_provider_identity', jsonb_build_object('facebook_user_id', 'fb-user-a'),
    'account', jsonb_build_object(
      'access_token', 'page-token-a-replaced',
      'needs_reauth', false,
      'failure_count', 0,
      'last_refresh_error', null,
      'last_refresh_attempt_at', '2026-10-26T12:00:00+0000'
    )
  ));
  ASSERT v->>'operation' = 'created', 'S3 create reports created';
  ASSERT v->>'deleted' = 'false', 'S3 create keeps the secret';
  ASSERT v->>'revision' = '1', 'S3 a new secret starts at revision 1';
  ASSERT v->>'binding_count' = '1', 'S3 one Facebook binding';
  ASSERT v->>'provider_user_id' = 'fb-user-a', 'S3 the provider user id is stored';
  ASSERT position('synthetic-user-token-a' IN v::text) = 0,
    'S3 the status document does not contain the user token';
  ASSERT position('page-token-a-replaced' IN v::text) = 0,
    'S3 the status document does not contain the page token';
  ASSERT NOT (v ? 'token'), 'S3 the status document has no token key';
  v_id := (v->>'credential_id')::uuid;

  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = fb)
           = 'page-token-a-replaced',
    'S3 the page token and the user credential commit together';
  ASSERT (SELECT needs_reauth FROM public.social_accounts WHERE id = fb) = false,
    'S3 needs_reauth is written in the same call';

  v_read := public.read_facebook_user_account_credential(u_a, fb);
  ASSERT v_read->>'found' = 'true', 'S3 the account read finds the secret';
  ASSERT v_read->>'token' = 'synthetic-user-token-a', 'S3 the account read returns the token';
  ASSERT v_read->>'capability_generation' IS NULL,
    'S3 a Facebook binding has no capability generation';
  ASSERT (SELECT count(*) FROM public.facebook_user_credentials WHERE id = v_id) = 1,
    'S3 one credential row holds the secret';
END $$;

-- ---------------------------------------------------------------------------
-- S4. Page-linked Instagram binds with explicit evidence. Browser metadata
-- is not the authority: an empty metadata document still binds, and a
-- contradictory one does not change the stored evidence.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  fb uuid := 'f11c0001-0000-4000-8000-000000000011';
  ig uuid := 'f11c0002-0000-4000-8000-000000000012';
  ig2 uuid := 'f11c0004-0000-4000-8000-000000000014';
  v jsonb;
  v_id uuid;
  v_gen bigint;
BEGIN
  PERFORM public.write_instagram_account_capability(
    ig, u_a, '{"login_kind":"page_linked"}'::jsonb);
  PERFORM public.write_instagram_account_capability(
    ig2, u_a, '{"login_kind":"page_linked"}'::jsonb);

  v_id := (
    SELECT b.credential_id
      FROM public.facebook_user_credential_bindings AS b
     WHERE b.social_account_id = fb
  );

  v := public.bind_facebook_user_credential(u_a, jsonb_build_object(
    'credential_id', v_id,
    'expected_revision', 1,
    'social_account_id', ig,
    'expected_capability_generation', 0,
    'provenance_source', 'oauth_exchange',
    'verified_provider_identity', jsonb_build_object(
      'facebook_user_id', 'fb-user-a',
      'facebook_page_id', 'verified-page',
      'instagram_user_id', 'verified-ig'
    )
  ));
  ASSERT v->>'binding_count' = '2', 'S4 one secret is shared by Facebook and Instagram';
  ASSERT v->>'revision' = '1', 'S4 attaching an account does not rotate the secret';
  ASSERT (SELECT count(*) FROM public.facebook_user_credentials) = 1,
    'S4 the shared grant did not copy the secret';
  ASSERT (SELECT b.verified_facebook_page_id
            FROM public.facebook_user_credential_bindings AS b
           WHERE b.social_account_id = ig) = 'verified-page',
    'S4 stored evidence comes from the payload, not account_metadata';
  v_gen := (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint;
  ASSERT v_gen = 1, 'S4 binding an Instagram account fences its capability';

  -- Second page-linked account, metadata null, same provider user.
  v := public.bind_facebook_user_credential(u_a, jsonb_build_object(
    'credential_id', v_id,
    'expected_revision', 1,
    'social_account_id', ig2,
    'expected_capability_generation', 0,
    'provenance_source', 'oauth_exchange',
    'verified_provider_identity', jsonb_build_object(
      'facebook_user_id', 'fb-user-a',
      'facebook_page_id', 'verified-page-2',
      'instagram_user_id', 'verified-ig-2'
    )
  ));
  ASSERT v->>'binding_count' = '3', 'S4 a third account shares the same secret';
  ASSERT (SELECT token FROM public.facebook_user_credentials WHERE id = v_id)
           = 'synthetic-user-token-a',
    'S4 both Instagram accounts resolve one token';
END $$;

-- ---------------------------------------------------------------------------
-- S5. Direct Instagram is refused even when metadata claims a page id.
-- The compatibility writer refuses it too. The account token stays where
-- it was. No second credential is created.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  igd uuid := 'f11c0003-0000-4000-8000-000000000013';
  v_id uuid;
  v_err text;
  v_before bigint;
BEGIN
  PERFORM public.write_instagram_account_capability(
    igd, u_a, '{"login_kind":"direct"}'::jsonb);
  v_before := (public.read_instagram_account_capability(igd, u_a)->>'credential_generation')::bigint;
  v_id := (
    SELECT b.credential_id FROM public.facebook_user_credential_bindings AS b
     WHERE b.social_account_id = 'f11c0001-0000-4000-8000-000000000011'
  );
  BEGIN
    PERFORM public.bind_facebook_user_credential(u_a, jsonb_build_object(
      'credential_id', v_id,
      'expected_revision', 1,
      'social_account_id', igd,
      'expected_capability_generation', 0,
      'provenance_source', 'oauth_exchange',
      'verified_provider_identity', jsonb_build_object(
        'facebook_user_id', 'fb-user-a',
        'facebook_page_id', 'forged-page',
        'instagram_user_id', 'ig-direct'
      )
    ));
    RAISE EXCEPTION 'S5 failed: direct Instagram was bound'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC02' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err = 'direct Instagram login cannot bind a Facebook user credential',
    'S5 direct Instagram is refused';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.facebook_user_credential_bindings
     WHERE social_account_id = igd
  ), 'S5 the refused bind writes nothing';

  BEGIN
    PERFORM public.replace_instagram_account_credential(igd, u_a, jsonb_build_object(
      'credential_kind', 'facebook_user',
      'token', 'compatibility-direct-token',
      'token_expires_at', '2027-06-01T00:00:00+00:00',
      'expected_credential_generation', v_before
    ));
    RAISE EXCEPTION 'S5 failed: the compatibility writer accepted direct login'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC02' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err = 'direct Instagram login cannot bind a Facebook user credential',
    'S5 the compatibility writer refuses direct login';
  ASSERT (public.read_instagram_account_credential(igd, u_a)->>'found') = 'false',
    'S5 direct login stores no Facebook user credential';
  ASSERT (public.read_instagram_account_capability(igd, u_a)->>'credential_generation')::bigint
           = v_before,
    'S5 the refused compatibility writer leaves the generation untouched';
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = igd) = 'ig-direct-token',
    'S5 the direct account token stays on the account';
  ASSERT (SELECT count(*) FROM public.facebook_user_credentials) = 1,
    'S5 no second credential is created for direct login';
END $$;

-- ---------------------------------------------------------------------------
-- S6. Same owner and provider user id do not merge unrelated grants.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  fb2 uuid := 'f11c0006-0000-4000-8000-000000000016';
  v jsonb;
BEGIN
  v := public.bind_facebook_user_credential(u_a, jsonb_build_object(
    'expected_absent', true,
    'token', 'synthetic-user-token-other',
    'provenance_source', 'oauth_exchange',
    'provenance_captured_at', '2026-10-26T12:30:00+0000',
    'social_account_id', fb2,
    'verified_provider_identity', jsonb_build_object('facebook_user_id', 'fb-user-a')
  ));
  ASSERT v->>'binding_count' = '1', 'S6 the second grant is not merged into the first';
  ASSERT (SELECT count(*) FROM public.facebook_user_credentials
           WHERE provider_user_id = 'fb-user-a') = 2,
    'S6 owner plus provider user id is not a unique secret';
END $$;

-- ---------------------------------------------------------------------------
-- S7. Secret replacement fences every dependent Instagram generation.
-- A stale revision writes nothing, including the page token. Rollback
-- restores both.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  fb uuid := 'f11c0001-0000-4000-8000-000000000011';
  ig uuid := 'f11c0002-0000-4000-8000-000000000012';
  ig2 uuid := 'f11c0004-0000-4000-8000-000000000014';
  v_id uuid;
  v jsonb;
  v_gen1 bigint;
  v_gen2 bigint;
  v_err text;
BEGIN
  v_id := (
    SELECT credential_id FROM public.facebook_user_credential_bindings
     WHERE social_account_id = fb
  );
  v_gen1 := (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint;
  v_gen2 := (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint;

  v := public.write_facebook_user_credential(u_a, jsonb_build_object(
    'credential_id', v_id,
    'expected_revision', 1,
    'token', 'synthetic-user-token-a2',
    'provenance_source', 'token_refresh',
    'provenance_captured_at', '2026-10-26T13:00:00Z',
    'accounts', jsonb_build_array(
      jsonb_build_object(
        'social_account_id', ig,
        'expected_capability_generation', v_gen1,
        'access_token', 'ig-page-token-refreshed',
        'needs_reauth', false
      ),
      jsonb_build_object(
        'social_account_id', ig2,
        'expected_capability_generation', v_gen2
      ),
      jsonb_build_object('social_account_id', fb)
    )
  ));
  ASSERT v->>'operation' = 'secret_replaced', 'S7 replacement is reported';
  ASSERT v->>'revision' = '2', 'S7 revision increments once';
  ASSERT position('synthetic-user-token-a2' IN v::text) = 0,
    'S7 the replacement result does not contain the token';
  ASSERT (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint
           = v_gen1 + 1,
    'S7 the listed Instagram capability is fenced';
  ASSERT (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint
           = v_gen2 + 1,
    'S7 the other Instagram capability is fenced too';
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = ig)
           = 'ig-page-token-refreshed',
    'S7 the page token updates in the same call';
  ASSERT (public.read_facebook_user_account_credential(u_a, ig2)->>'token')
           = 'synthetic-user-token-a2',
    'S7 both accounts read the replaced secret';

  BEGIN
    PERFORM public.write_facebook_user_credential(u_a, jsonb_build_object(
      'credential_id', v_id,
      'expected_revision', 1,
      'token', 'synthetic-stale-token',
      'provenance_source', 'token_refresh',
      'provenance_captured_at', '2026-10-26T13:05:00Z',
      'accounts', jsonb_build_array(
        jsonb_build_object(
          'social_account_id', ig,
          'expected_capability_generation', v_gen1,
          'access_token', 'ig-page-token-stale'
        ),
        jsonb_build_object(
          'social_account_id', ig2,
          'expected_capability_generation', v_gen2
        ),
        jsonb_build_object('social_account_id', fb)
      )
    ));
    RAISE EXCEPTION 'S7 failed: a stale revision was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC01' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err = 'stale credential revision', 'S7 stale revision is refused';
  ASSERT (public.read_facebook_user_credential(u_a, v_id)->>'token')
           = 'synthetic-user-token-a2',
    'S7 a stale revision does not change the secret';
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = ig)
           = 'ig-page-token-refreshed',
    'S7 a stale revision does not change the page token';
  ASSERT (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint
           = v_gen1 + 1,
    'S7 a stale revision does not bump the generation again';
END $$;

SAVEPOINT fuc_atomic;

DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  ig uuid := 'f11c0002-0000-4000-8000-000000000012';
  v_id uuid;
  v_gen bigint;
  v_gen2 bigint;
BEGIN
  v_id := (
    SELECT credential_id FROM public.facebook_user_credential_bindings
     WHERE social_account_id = 'f11c0001-0000-4000-8000-000000000011'
  );
  v_gen := (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint;
  v_gen2 := (public.read_instagram_account_capability(
    'f11c0004-0000-4000-8000-000000000014', u_a)->>'credential_generation')::bigint;
  PERFORM public.write_facebook_user_credential(u_a, jsonb_build_object(
    'credential_id', v_id,
    'expected_revision', 2,
    'token', 'synthetic-rolled-back-token',
    'provenance_source', 'token_refresh',
    'provenance_captured_at', '2026-10-26T13:10:00Z',
    'accounts', jsonb_build_array(
      jsonb_build_object(
        'social_account_id', ig,
        'expected_capability_generation', v_gen,
        'access_token', 'ig-page-token-rolled-back'
      ),
      jsonb_build_object(
        'social_account_id', 'f11c0004-0000-4000-8000-000000000014',
        'expected_capability_generation', v_gen2
      ),
      jsonb_build_object('social_account_id', 'f11c0001-0000-4000-8000-000000000011')
    )
  ));
END $$;

ROLLBACK TO SAVEPOINT fuc_atomic;

DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  ig uuid := 'f11c0002-0000-4000-8000-000000000012';
  v_id uuid;
BEGIN
  v_id := (
    SELECT credential_id FROM public.facebook_user_credential_bindings
     WHERE social_account_id = 'f11c0001-0000-4000-8000-000000000011'
  );
  ASSERT (public.read_facebook_user_credential(u_a, v_id)->>'token')
           = 'synthetic-user-token-a2',
    'S7 rollback restores the user token';
  ASSERT (public.read_facebook_user_credential(u_a, v_id)->>'revision') = '2',
    'S7 rollback restores the revision';
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = ig)
           = 'ig-page-token-refreshed',
    'S7 rollback restores the page token';
END $$;

-- ---------------------------------------------------------------------------
-- S7b. Shared secret replacement and grant revocation require the dependent
-- set captured before the provider call. Reconnect or attach makes the old
-- payload fail, and no token, status, generation, or binding changes.
-- ---------------------------------------------------------------------------
SAVEPOINT fuc_shared_fence;

DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  fb uuid := 'f11c0001-0000-4000-8000-000000000011';
  ig uuid := 'f11c0002-0000-4000-8000-000000000012';
  ig2 uuid := 'f11c0004-0000-4000-8000-000000000014';
  v_id uuid;
  v_rev bigint;
  v_ig bigint;
  v_ig2 bigint;
  v_before jsonb;
  v_mid jsonb;
  v_err text;
BEGIN
  v_id := (
    SELECT credential_id FROM public.facebook_user_credential_bindings
     WHERE social_account_id = fb
  );
  v_rev := (public.read_facebook_user_credential(u_a, v_id)->>'revision')::bigint;
  v_ig := (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint;
  v_ig2 := (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint;
  SELECT jsonb_build_object(
    'user_md5', md5(c.token),
    'revision', c.revision,
    'expires', c.token_expires_at,
    'bindings', (
      SELECT COALESCE(jsonb_agg(b.social_account_id ORDER BY b.social_account_id), '[]'::jsonb)
        FROM public.facebook_user_credential_bindings AS b
       WHERE b.credential_id = c.id
    ),
    'ig_gen', (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint,
    'ig2_gen', (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint,
    'ig_access_md5', md5(igsa.access_token),
    'ig2_access_md5', md5(ig2sa.access_token),
    'fb_access_md5', md5(fbsa.access_token),
    'ig_reauth', igsa.needs_reauth,
    'ig2_reauth', ig2sa.needs_reauth,
    'fb_reauth', fbsa.needs_reauth,
    'ig_failures', igsa.failure_count,
    'ig2_failures', ig2sa.failure_count,
    'fb_failures', fbsa.failure_count
  ) INTO v_before
  FROM public.facebook_user_credentials AS c
  JOIN public.social_accounts AS igsa ON igsa.id = ig
  JOIN public.social_accounts AS ig2sa ON ig2sa.id = ig2
  JOIN public.social_accounts AS fbsa ON fbsa.id = fb
  WHERE c.id = v_id;

  BEGIN
    PERFORM public.write_facebook_user_credential(u_a, jsonb_build_object(
      'credential_id', v_id,
      'expected_revision', v_rev,
      'token', 'synthetic-omitted-dependent',
      'provenance_source', 'token_refresh',
      'provenance_captured_at', '2026-10-26T13:20:00Z',
      'accounts', jsonb_build_array(
        jsonb_build_object(
          'social_account_id', ig,
          'expected_capability_generation', v_ig
        ),
        jsonb_build_object('social_account_id', fb)
      )
    ));
    RAISE EXCEPTION 'S7b failed: an omitted Instagram dependent was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC01' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err = 'credential binding set does not match the captured dependent accounts',
    'S7b an omitted Instagram account is refused';
  ASSERT position('synthetic' IN v_err) = 0, 'S7b the refusal does not contain a token';

  BEGIN
    PERFORM public.write_facebook_user_credential(u_a, jsonb_build_object(
      'credential_id', v_id,
      'expected_revision', v_rev,
      'token', 'synthetic-stale-sibling',
      'provenance_source', 'token_refresh',
      'provenance_captured_at', '2026-10-26T13:21:00Z',
      'accounts', jsonb_build_array(
        jsonb_build_object(
          'social_account_id', ig2,
          'expected_capability_generation', v_ig2 - 1
        ),
        jsonb_build_object(
          'social_account_id', ig,
          'expected_capability_generation', v_ig
        ),
        jsonb_build_object('social_account_id', fb)
      )
    ));
    RAISE EXCEPTION 'S7b failed: a stale sibling generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC01' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err = 'stale capability generation',
    'S7b a stale sibling generation is refused';

  SELECT jsonb_build_object(
    'user_md5', md5(c.token),
    'revision', c.revision,
    'expires', c.token_expires_at,
    'bindings', (
      SELECT COALESCE(jsonb_agg(b.social_account_id ORDER BY b.social_account_id), '[]'::jsonb)
        FROM public.facebook_user_credential_bindings AS b
       WHERE b.credential_id = c.id
    ),
    'ig_gen', (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint,
    'ig2_gen', (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint,
    'ig_access_md5', md5(igsa.access_token),
    'ig2_access_md5', md5(ig2sa.access_token),
    'fb_access_md5', md5(fbsa.access_token),
    'ig_reauth', igsa.needs_reauth,
    'ig2_reauth', ig2sa.needs_reauth,
    'fb_reauth', fbsa.needs_reauth,
    'ig_failures', igsa.failure_count,
    'ig2_failures', ig2sa.failure_count,
    'fb_failures', fbsa.failure_count
  ) INTO v_mid
  FROM public.facebook_user_credentials AS c
  JOIN public.social_accounts AS igsa ON igsa.id = ig
  JOIN public.social_accounts AS ig2sa ON ig2sa.id = ig2
  JOIN public.social_accounts AS fbsa ON fbsa.id = fb
  WHERE c.id = v_id;
  ASSERT v_mid = v_before, 'S7b refused refreshes leave the grant unchanged';

  PERFORM public.record_instagram_account_reconnect(ig, u_a, jsonb_build_object(
    'login_kind', 'page_linked',
    'reason', 'user_reconnect',
    'expected_credential_generation', v_ig
  ));
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.facebook_user_credential_bindings
     WHERE social_account_id = ig
  ), 'S7b reconnect removes that account binding';
  ASSERT (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint
           = v_ig + 1,
    'S7b reconnect advances only that generation';

  SELECT jsonb_build_object(
    'user_md5', md5(c.token),
    'revision', c.revision,
    'expires', c.token_expires_at,
    'bindings', (
      SELECT COALESCE(jsonb_agg(b.social_account_id ORDER BY b.social_account_id), '[]'::jsonb)
        FROM public.facebook_user_credential_bindings AS b
       WHERE b.credential_id = c.id
    ),
    'ig_gen', (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint,
    'ig2_gen', (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint,
    'ig_access_md5', md5(igsa.access_token),
    'ig2_access_md5', md5(ig2sa.access_token),
    'fb_access_md5', md5(fbsa.access_token),
    'ig_reauth', igsa.needs_reauth,
    'ig2_reauth', ig2sa.needs_reauth,
    'fb_reauth', fbsa.needs_reauth,
    'ig_failures', igsa.failure_count,
    'ig2_failures', ig2sa.failure_count,
    'fb_failures', fbsa.failure_count
  ) INTO v_mid
  FROM public.facebook_user_credentials AS c
  JOIN public.social_accounts AS igsa ON igsa.id = ig
  JOIN public.social_accounts AS ig2sa ON ig2sa.id = ig2
  JOIN public.social_accounts AS fbsa ON fbsa.id = fb
  WHERE c.id = v_id;

  BEGIN
    PERFORM public.write_facebook_user_credential(u_a, jsonb_build_object(
      'credential_id', v_id,
      'expected_revision', v_rev,
      'token', 'synthetic-stale-after-reconnect',
      'provenance_source', 'token_refresh',
      'provenance_captured_at', '2026-10-26T13:22:00Z',
      'accounts', jsonb_build_array(
        jsonb_build_object(
          'social_account_id', ig,
          'expected_capability_generation', v_ig
        ),
        jsonb_build_object(
          'social_account_id', ig2,
          'expected_capability_generation', v_ig2
        ),
        jsonb_build_object('social_account_id', fb)
      )
    ));
    RAISE EXCEPTION 'S7b failed: a pre-reconnect refresh was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC01' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.revoke_facebook_user_credential(u_a, jsonb_build_object(
      'credential_id', v_id,
      'expected_revision', v_rev,
      'reason', 'provider_revoked',
      'accounts', jsonb_build_array(
        jsonb_build_object(
          'social_account_id', ig,
          'expected_capability_generation', v_ig
        ),
        jsonb_build_object(
          'social_account_id', ig2,
          'expected_capability_generation', v_ig2
        ),
        jsonb_build_object('social_account_id', fb)
      )
    ));
    RAISE EXCEPTION 'S7b failed: a pre-reconnect revoke was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC01' THEN
    NULL;
  END;

  SELECT jsonb_build_object(
    'user_md5', md5(c.token),
    'revision', c.revision,
    'expires', c.token_expires_at,
    'bindings', (
      SELECT COALESCE(jsonb_agg(b.social_account_id ORDER BY b.social_account_id), '[]'::jsonb)
        FROM public.facebook_user_credential_bindings AS b
       WHERE b.credential_id = c.id
    ),
    'ig_gen', (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint,
    'ig2_gen', (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint,
    'ig_access_md5', md5(igsa.access_token),
    'ig2_access_md5', md5(ig2sa.access_token),
    'fb_access_md5', md5(fbsa.access_token),
    'ig_reauth', igsa.needs_reauth,
    'ig2_reauth', ig2sa.needs_reauth,
    'fb_reauth', fbsa.needs_reauth,
    'ig_failures', igsa.failure_count,
    'ig2_failures', ig2sa.failure_count,
    'fb_failures', fbsa.failure_count
  ) INTO v_before
  FROM public.facebook_user_credentials AS c
  JOIN public.social_accounts AS igsa ON igsa.id = ig
  JOIN public.social_accounts AS ig2sa ON ig2sa.id = ig2
  JOIN public.social_accounts AS fbsa ON fbsa.id = fb
  WHERE c.id = v_id;
  ASSERT v_before = v_mid, 'S7b a stale shared refresh or revoke writes nothing after reconnect';
END $$;

ROLLBACK TO SAVEPOINT fuc_shared_fence;

SAVEPOINT fuc_attach_fence;

DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  fb uuid := 'f11c0001-0000-4000-8000-000000000011';
  ig uuid := 'f11c0002-0000-4000-8000-000000000012';
  ig2 uuid := 'f11c0004-0000-4000-8000-000000000014';
  igd uuid := 'f11c0003-0000-4000-8000-000000000013';
  v_id uuid;
  v_rev bigint;
  v_ig bigint;
  v_ig2 bigint;
  v_attached bigint;
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_id := (
    SELECT credential_id FROM public.facebook_user_credential_bindings
     WHERE social_account_id = fb
  );
  v_rev := (public.read_facebook_user_credential(u_a, v_id)->>'revision')::bigint;
  v_ig := (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint;
  v_ig2 := (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint;

  PERFORM public.record_instagram_account_reconnect(igd, u_a, jsonb_build_object(
    'login_kind', 'page_linked',
    'reason', 'attach_prepare',
    'expected_credential_generation',
      (public.read_instagram_account_capability(igd, u_a)->>'credential_generation')::int
  ));
  PERFORM public.bind_facebook_user_credential(u_a, jsonb_build_object(
    'credential_id', v_id,
    'expected_revision', v_rev,
    'social_account_id', igd,
    'expected_capability_generation',
      (public.read_instagram_account_capability(igd, u_a)->>'credential_generation')::int,
    'provenance_source', 'oauth_exchange',
    'verified_provider_identity', jsonb_build_object(
      'facebook_user_id', 'fb-user-a',
      'facebook_page_id', 'verified-page-direct',
      'instagram_user_id', 'verified-ig-direct'
    )
  ));
  v_attached := (public.read_instagram_account_capability(igd, u_a)->>'credential_generation')::bigint;

  SELECT jsonb_build_object(
    'user_md5', md5(c.token),
    'revision', c.revision,
    'bindings', (
      SELECT COALESCE(jsonb_agg(b.social_account_id ORDER BY b.social_account_id), '[]'::jsonb)
        FROM public.facebook_user_credential_bindings AS b
       WHERE b.credential_id = c.id
    ),
    'ig_gen', (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint,
    'ig2_gen', (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint,
    'igd_gen', (public.read_instagram_account_capability(igd, u_a)->>'credential_generation')::bigint,
    'ig_access_md5', md5(igsa.access_token),
    'fb_access_md5', md5(fbsa.access_token),
    'fb_reauth', fbsa.needs_reauth
  ) INTO v_before
  FROM public.facebook_user_credentials AS c
  JOIN public.social_accounts AS igsa ON igsa.id = ig
  JOIN public.social_accounts AS fbsa ON fbsa.id = fb
  WHERE c.id = v_id;

  BEGIN
    PERFORM public.write_facebook_user_credential(u_a, jsonb_build_object(
      'credential_id', v_id,
      'expected_revision', v_rev,
      'token', 'synthetic-stale-after-attach',
      'provenance_source', 'token_refresh',
      'provenance_captured_at', '2026-10-26T13:23:00Z',
      'accounts', jsonb_build_array(
        jsonb_build_object(
          'social_account_id', ig,
          'expected_capability_generation', v_ig
        ),
        jsonb_build_object(
          'social_account_id', ig2,
          'expected_capability_generation', v_ig2
        ),
        jsonb_build_object('social_account_id', fb)
      )
    ));
    RAISE EXCEPTION 'S7b failed: a pre-attach refresh was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC01' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.revoke_facebook_user_credential(u_a, jsonb_build_object(
      'credential_id', v_id,
      'expected_revision', v_rev,
      'reason', 'provider_revoked',
      'accounts', jsonb_build_array(
        jsonb_build_object(
          'social_account_id', ig,
          'expected_capability_generation', v_ig
        ),
        jsonb_build_object(
          'social_account_id', ig2,
          'expected_capability_generation', v_ig2
        ),
        jsonb_build_object('social_account_id', fb)
      )
    ));
    RAISE EXCEPTION 'S7b failed: a pre-attach revoke was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC01' THEN
    NULL;
  END;

  SELECT jsonb_build_object(
    'user_md5', md5(c.token),
    'revision', c.revision,
    'bindings', (
      SELECT COALESCE(jsonb_agg(b.social_account_id ORDER BY b.social_account_id), '[]'::jsonb)
        FROM public.facebook_user_credential_bindings AS b
       WHERE b.credential_id = c.id
    ),
    'ig_gen', (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint,
    'ig2_gen', (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint,
    'igd_gen', (public.read_instagram_account_capability(igd, u_a)->>'credential_generation')::bigint,
    'ig_access_md5', md5(igsa.access_token),
    'fb_access_md5', md5(fbsa.access_token),
    'fb_reauth', fbsa.needs_reauth
  ) INTO v_after
  FROM public.facebook_user_credentials AS c
  JOIN public.social_accounts AS igsa ON igsa.id = ig
  JOIN public.social_accounts AS fbsa ON fbsa.id = fb
  WHERE c.id = v_id;
  ASSERT v_after = v_before, 'S7b a stale shared refresh or revoke writes nothing after attach';
  ASSERT (v_after->>'igd_gen')::bigint = v_attached,
    'S7b the newly attached generation stays at the post-attach version';
END $$;

ROLLBACK TO SAVEPOINT fuc_attach_fence;

-- ---------------------------------------------------------------------------
-- S8. Disconnect removes one binding. The other account keeps the secret.
-- The last binding deletes it. Stored permission reads stay until reconnect.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  fb uuid := 'f11c0001-0000-4000-8000-000000000011';
  ig uuid := 'f11c0002-0000-4000-8000-000000000012';
  ig2 uuid := 'f11c0004-0000-4000-8000-000000000014';
  v_id uuid;
  v jsonb;
  v_before jsonb;
  v_gen bigint;
  v_sibling bigint;
  v_conn bigint;
  v_cred uuid;
BEGIN
  v_id := (
    SELECT credential_id FROM public.facebook_user_credential_bindings
     WHERE social_account_id = fb
  );
  v_gen := (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint;
  v_sibling := (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint;
  PERFORM public.write_instagram_account_capability(ig2, u_a, jsonb_build_object(
    'permission_read_state', 'ok',
    'expected_credential_generation', v_gen,
    'granted_scopes', jsonb_build_array('instagram_manage_insights'),
    'scopes_read_at', '2099-01-01T00:00:00Z'
  ));
  v_before := public.read_instagram_account_capability(ig2, u_a);

  v_cred := (public.read_facebook_user_account_credential(u_a, ig2)->>'credential_id')::uuid;
  v_conn := (public.read_facebook_user_account_credential(u_a, ig2)->>'connection_version')::bigint;
  v := public.unbind_facebook_user_credential(u_a, jsonb_build_object(
    'social_account_id', ig2,
    'credential_id', v_cred,
    'expected_revision', 2,
    'expected_connection_version', v_conn,
    'expected_capability_generation', v_gen
  ));
  ASSERT v->>'deleted' = 'false', 'S8 disconnect keeps the shared secret';
  ASSERT v->>'binding_count' = '2', 'S8 the Facebook and other Instagram bindings remain';
  ASSERT (public.read_facebook_user_account_credential(u_a, ig)->>'token')
           = 'synthetic-user-token-a2',
    'S8 the remaining Instagram account still reads the secret';
  ASSERT (public.read_facebook_user_account_credential(u_a, ig2)->>'found') = 'false',
    'S8 the disconnected account no longer resolves a secret';
  ASSERT (public.read_facebook_user_account_credential(u_a, ig2)->>'token') IS NULL,
    'S8 a missing binding is null, not an empty token';
  v := public.read_instagram_account_capability(ig2, u_a);
  ASSERT (v->>'credential_generation')::bigint = v_gen + 1,
    'S8 disconnect fences only that capability';
  ASSERT v->>'permission_read_state' = 'ok',
    'S8 disconnect does not clear the stored permission read';
  ASSERT v->'granted_scopes' = v_before->'granted_scopes',
    'S8 disconnect keeps the stored scopes';
  ASSERT (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint
           = v_sibling,
    'S8 disconnect does not fence the other Instagram account';

  -- Last two bindings: remove Instagram, then Facebook, and the secret goes.
  v_gen := (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint;
  v_cred := (public.read_facebook_user_account_credential(u_a, ig)->>'credential_id')::uuid;
  v_conn := (public.read_facebook_user_account_credential(u_a, ig)->>'connection_version')::bigint;
  PERFORM public.unbind_facebook_user_credential(u_a, jsonb_build_object(
    'social_account_id', ig,
    'credential_id', v_cred,
    'expected_revision', 2,
    'expected_connection_version', v_conn,
    'expected_capability_generation', v_gen
  ));
  v_cred := (public.read_facebook_user_account_credential(u_a, fb)->>'credential_id')::uuid;
  v_conn := (public.read_facebook_user_account_credential(u_a, fb)->>'connection_version')::bigint;
  v := public.unbind_facebook_user_credential(u_a, jsonb_build_object(
    'social_account_id', fb,
    'credential_id', v_cred,
    'expected_revision', 2,
    'expected_connection_version', v_conn
  ));
  ASSERT v->>'deleted' = 'true', 'S8 the last binding deletes the secret';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.facebook_user_credentials WHERE id = v_id
  ), 'S8 no credential row remains';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.facebook_user_credential_bindings WHERE credential_id = v_id
  ), 'S8 no binding remains';
END $$;

-- ---------------------------------------------------------------------------
-- S9. Grant revocation fences every dependent and deletes the secret.
-- A stored successful read remains. Account reassignment is refused.
-- Deleting one account of a shared grant does not delete the other secret use.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  u_b uuid := 'f11b0002-0000-4000-8000-000000000002';
  fb uuid := 'f11c0001-0000-4000-8000-000000000011';
  ig uuid := 'f11c0002-0000-4000-8000-000000000012';
  ig2 uuid := 'f11c0004-0000-4000-8000-000000000014';
  v jsonb;
  v_id uuid;
  v_gen bigint;
  v_gen2 bigint;
  v_scopes jsonb;
BEGIN
  v := public.bind_facebook_user_credential(u_a, jsonb_build_object(
    'expected_absent', true,
    'token', 'synthetic-revoke-token',
    'token_expires_at', '2027-02-01T00:00:00Z',
    'provenance_source', 'oauth_exchange',
    'provenance_captured_at', '2026-10-26T14:00:00Z',
    'social_account_id', fb,
    'verified_provider_identity', jsonb_build_object('facebook_user_id', 'fb-user-revoke')
  ));
  v_id := (v->>'credential_id')::uuid;
  v_gen := (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint;
  PERFORM public.bind_facebook_user_credential(u_a, jsonb_build_object(
    'credential_id', v_id,
    'expected_revision', 1,
    'social_account_id', ig,
    'expected_capability_generation', v_gen,
    'provenance_source', 'oauth_exchange',
    'verified_provider_identity', jsonb_build_object(
      'facebook_user_id', 'fb-user-revoke',
      'facebook_page_id', 'page-revoke',
      'instagram_user_id', 'ig-revoke'
    )
  ));
  v_gen := (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint;
  PERFORM public.bind_facebook_user_credential(u_a, jsonb_build_object(
    'credential_id', v_id,
    'expected_revision', 1,
    'social_account_id', ig2,
    'expected_capability_generation', v_gen,
    'provenance_source', 'oauth_exchange',
    'verified_provider_identity', jsonb_build_object(
      'facebook_user_id', 'fb-user-revoke',
      'facebook_page_id', 'page-revoke-2',
      'instagram_user_id', 'ig-revoke-2'
    )
  ));

  v_gen := (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint;
  PERFORM public.write_instagram_account_capability(ig, u_a, jsonb_build_object(
    'permission_read_state', 'ok',
    'expected_credential_generation', v_gen,
    'granted_scopes', jsonb_build_array('pages_show_list'),
    'scopes_read_at', '2099-02-01T00:00:00Z'
  ));
  v_scopes := public.read_instagram_account_capability(ig, u_a)->'granted_scopes';
  v_gen := (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint;
  v_gen2 := (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint;

  BEGIN
    UPDATE public.social_accounts SET user_id = u_b WHERE id = fb;
    RAISE EXCEPTION 'S9 failed: the account owner was reassigned'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
  ASSERT (SELECT user_id FROM public.social_accounts WHERE id = fb) = u_a,
    'S9 the account owner is unchanged';

  v := public.revoke_facebook_user_credential(u_a, jsonb_build_object(
    'credential_id', v_id,
    'expected_revision', 1,
    'reason', 'provider_revoked',
    'accounts', jsonb_build_array(
      jsonb_build_object(
        'social_account_id', fb,
        'needs_reauth', true,
        'expected_connection_version',
          (public.read_facebook_user_account_credential(u_a, fb)->>'connection_version')::int
      ),
      jsonb_build_object(
        'social_account_id', ig,
        'expected_capability_generation', v_gen
      ),
      jsonb_build_object(
        'social_account_id', ig2,
        'expected_capability_generation', v_gen2
      )
    )
  ));
  ASSERT v->>'deleted' = 'true', 'S9 revocation deletes the secret';
  ASSERT position('synthetic-revoke-token' IN v::text) = 0,
    'S9 the revocation result does not contain the token';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.facebook_user_credentials WHERE id = v_id
  ), 'S9 the credential row is gone';
  ASSERT (SELECT needs_reauth FROM public.social_accounts WHERE id = fb),
    'S9 account health is updated in the revocation transaction';
  ASSERT (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint
           = v_gen + 1,
    'S9 revocation fences the Instagram capability';
  ASSERT public.read_instagram_account_capability(ig, u_a)->'granted_scopes' = v_scopes,
    'S9 revocation does not clear the stored permission read';
  ASSERT (public.read_facebook_user_account_credential(u_a, ig2)->>'found') = 'false',
    'S9 every binding is removed';
END $$;

-- ---------------------------------------------------------------------------
-- S10. Deleting one account of a shared grant keeps the other binding
-- and deletes the secret only when it was the last one.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  fb uuid := 'f11c0006-0000-4000-8000-000000000016';
  ig uuid := 'f11c0002-0000-4000-8000-000000000012';
  v_id uuid;
  v_gen bigint;
BEGIN
  v_id := (
    SELECT credential_id FROM public.facebook_user_credential_bindings
     WHERE social_account_id = fb
  );
  v_gen := (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint;
  PERFORM public.bind_facebook_user_credential(u_a, jsonb_build_object(
    'credential_id', v_id,
    'expected_revision', 1,
    'social_account_id', ig,
    'expected_capability_generation', v_gen,
    'provenance_source', 'oauth_exchange',
    'verified_provider_identity', jsonb_build_object(
      'facebook_user_id', 'fb-user-a',
      'facebook_page_id', 'page-keep',
      'instagram_user_id', 'ig-keep'
    )
  ));

  DELETE FROM public.social_accounts WHERE id = ig;
  ASSERT EXISTS (
    SELECT 1 FROM public.facebook_user_credentials WHERE id = v_id
  ), 'S10 deleting one account keeps the shared secret';
  ASSERT (public.read_facebook_user_account_credential(u_a, fb)->>'token')
           = 'synthetic-user-token-other',
    'S10 the remaining account still reads the secret';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.instagram_account_credentials WHERE social_account_id = ig
  ), 'S10 the compatibility linkage is removed with the account';

  DELETE FROM public.social_accounts WHERE id = fb;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.facebook_user_credentials WHERE id = v_id
  ), 'S10 deleting the last account deletes the secret';
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S11. Cross-owner links fail under service_role. anon cannot read.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  u_b uuid := 'f11b0002-0000-4000-8000-000000000002';
  fb_b uuid := 'f11c0005-0000-4000-8000-000000000015';
  v jsonb;
  v_id uuid;
  v_err text;
BEGIN
  v := public.bind_facebook_user_credential(u_a, jsonb_build_object(
    'expected_absent', true,
    'token', 'synthetic-owner-token',
    'provenance_source', 'oauth_exchange',
    'provenance_captured_at', '2026-10-26T15:00:00Z',
    'social_account_id', 'f11c0001-0000-4000-8000-000000000011',
    'verified_provider_identity', jsonb_build_object('facebook_user_id', 'fb-user-owner')
  ));
  v_id := (v->>'credential_id')::uuid;

  BEGIN
    PERFORM public.read_facebook_user_credential(u_b, v_id);
    RAISE EXCEPTION 'S11 failed: a cross-owner read was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'facebook user credential is not owned by the given user',
      'S11 a cross-owner read is refused';
    ASSERT position('synthetic-owner-token' IN v_err) = 0,
      'S11 the refusal does not contain the token';
  END;

  BEGIN
    INSERT INTO public.facebook_user_credential_bindings (
      social_account_id, user_id, platform, credential_id,
      verified_facebook_user_id, evidence_source
    ) VALUES (
      fb_b, u_a, 'facebook', v_id, 'fb-user-owner', 'oauth_exchange'
    );
    RAISE EXCEPTION 'S11 failed: a cross-owner binding was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    PERFORM public.bind_facebook_user_credential(u_a, jsonb_build_object(
      'credential_id', v_id,
      'expected_revision', 1,
      'social_account_id', fb_b,
      'provenance_source', 'oauth_exchange',
      'verified_provider_identity', jsonb_build_object('facebook_user_id', 'fb-user-owner')
    ));
    RAISE EXCEPTION 'S11 failed: a cross-owner bind call was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err LIKE '%not an eligible Facebook or Instagram account owned by the given user%',
      'S11 a cross-owner bind is refused';
  END;
END $$;

RESET ROLE;

DO $$
BEGIN
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.bind_facebook_user_credential(
      'f11a0001-0000-4000-8000-000000000001',
      '{}'::jsonb);
    RAISE EXCEPTION 'S11 failed: anon called bind'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM 1 FROM public.facebook_user_credentials;
    RAISE EXCEPTION 'S11 failed: anon read the credential table'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.describe_facebook_user_credential(
      'f11a0001-0000-4000-8000-000000000001',
      'f11a0001-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'S11 failed: authenticated described a credential'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;

SET LOCAL ROLE service_role;

-- ---------------------------------------------------------------------------
-- S12. Zoned ISO is required. +0000 is accepted. now and zone-less are not.
-- failed cannot return to unknown until reconnect. Ordering still holds.
-- failure_count null is refused. Omitted expiry on the new writer is kept;
-- omitted expiry on the compatibility writer still clears.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  igd uuid := 'f11c0003-0000-4000-8000-000000000013';
  v jsonb;
  v_err text;
  v_gen bigint;
BEGIN
  BEGIN
    PERFORM public.write_instagram_account_capability(igd, u_a, jsonb_build_object(
      'permission_read_state', 'ok',
      'expected_credential_generation',
        (public.read_instagram_account_capability(igd, u_a)->>'credential_generation')::int,
      'granted_scopes', jsonb_build_array('instagram_basic'),
      'scopes_read_at', 'now'
    ));
    RAISE EXCEPTION 'S12 failed: now was accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG04' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err LIKE '%finite ISO-8601 timestamp%', 'S12 now is refused';

  BEGIN
    PERFORM public.write_instagram_account_capability(igd, u_a, jsonb_build_object(
      'permission_read_state', 'ok',
      'expected_credential_generation',
        (public.read_instagram_account_capability(igd, u_a)->>'credential_generation')::int,
      'granted_scopes', jsonb_build_array('instagram_basic'),
      'scopes_read_at', '2099-03-01T00:00:00'
    ));
    RAISE EXCEPTION 'S12 failed: a zone-less timestamp was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG04' THEN
    NULL;
  END;

  v_gen := (public.read_instagram_account_capability(igd, u_a)->>'credential_generation')::bigint;
  v := public.write_instagram_account_capability(igd, u_a, jsonb_build_object(
    'permission_read_state', 'failed',
    'expected_credential_generation', v_gen,
    'read_failed_at', '2099-03-01T00:00:00+0000',
    'read_error_code', 'META_TIMEOUT'
  ));
  ASSERT v->>'permission_read_state' = 'failed', 'S12 +0000 is a valid evidence timestamp';

  BEGIN
    PERFORM public.write_instagram_account_capability(igd, u_a, jsonb_build_object(
      'permission_read_state', 'unknown',
      'expected_credential_generation', v_gen
    ));
    RAISE EXCEPTION 'S12 failed: failed returned to unknown'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG05' THEN
    NULL;
  END;
  ASSERT (public.read_instagram_account_capability(igd, u_a)->>'permission_read_state')
           = 'failed',
    'S12 the failed lifecycle stays until reconnect';

  BEGIN
    PERFORM public.record_instagram_account_reconnect(
      igd, u_a, '{"reason":"evidence_reset"}'::jsonb);
    RAISE EXCEPTION 'S12 failed: a reconnect without a generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG03' THEN
    NULL;
  END;
  ASSERT (public.read_instagram_account_capability(igd, u_a)->>'permission_read_state')
           = 'failed',
    'S12 a reconnect without a generation writes nothing';

  v := public.record_instagram_account_reconnect(
    igd, u_a, jsonb_build_object(
      'reason', 'evidence_reset',
      'expected_credential_generation', v_gen
    ));
  ASSERT v->>'permission_read_state' = 'unknown',
    'S12 reconnect is the reset back to unknown';
  ASSERT (public.read_instagram_account_credential(igd, u_a)->>'found') = 'false',
    'S12 reconnect drops that account binding and, when it was the last, the secret';

  PERFORM public.write_instagram_account_capability(igd, u_a, jsonb_build_object(
    'permission_read_state', 'ok',
    'expected_credential_generation', (v->>'credential_generation')::int,
    'granted_scopes', jsonb_build_array('instagram_basic'),
    'scopes_read_at', '2099-04-02T00:00:00Z'
  ));
  BEGIN
    PERFORM public.write_instagram_account_capability(igd, u_a, jsonb_build_object(
      'permission_read_state', 'ok',
      'expected_credential_generation', (v->>'credential_generation')::int,
      'granted_scopes', jsonb_build_array('instagram_manage_insights'),
      'scopes_read_at', '2099-04-01T00:00:00Z'
    ));
    RAISE EXCEPTION 'S12 failed: an older timestamp was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG02' THEN
    NULL;
  END;

  v := public.record_instagram_account_reconnect(igd, u_a, jsonb_build_object(
    'login_kind', 'page_linked',
    'reason', 'page_linked_expiry',
    'expected_credential_generation',
      (public.read_instagram_account_capability(igd, u_a)->>'credential_generation')::int
  ));
  v := public.replace_instagram_account_credential(igd, u_a, jsonb_build_object(
    'credential_kind', 'facebook_user',
    'token', 'compatibility-expiry-token',
    'token_expires_at', '2027-08-01T00:00:00Z',
    'expected_credential_generation', (v->>'credential_generation')::int
  ));
  ASSERT (public.read_instagram_account_credential(igd, u_a)->>'token_expires_at') IS NOT NULL,
    'S12 the compatibility writer stores a zoned expiry';
  PERFORM public.replace_instagram_account_credential(igd, u_a, jsonb_build_object(
    'credential_kind', 'facebook_user',
    'token', 'compatibility-expiry-cleared',
    'expected_credential_generation', (v->>'credential_generation')::int
  ));
  ASSERT (public.read_instagram_account_credential(igd, u_a)->>'token_expires_at') IS NULL,
    'S12 an omitted compatibility expiry still clears the stored expiry';

  BEGIN
    PERFORM public.replace_instagram_account_credential(igd, u_a, jsonb_build_object(
      'credential_kind', 'facebook_user',
      'token', 'compatibility-stale',
      'expected_credential_generation', 0
    ));
    RAISE EXCEPTION 'S12 failed: a stale compatibility generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG01' THEN
    NULL;
  END;
  ASSERT (public.read_instagram_account_credential(igd, u_a)->>'token')
           = 'compatibility-expiry-cleared',
    'S12 a stale compatibility generation writes nothing';

  BEGIN
    PERFORM public.write_facebook_user_credential(
      u_a,
      jsonb_build_object(
        'credential_id', (
          SELECT credential_id FROM public.facebook_user_credential_bindings
           WHERE social_account_id = 'f11c0001-0000-4000-8000-000000000011'
        ),
        'expected_revision', 1,
        'accounts', jsonb_build_array(jsonb_build_object(
          'social_account_id', 'f11c0001-0000-4000-8000-000000000011',
          'failure_count', null
        ))
      )
    );
    RAISE EXCEPTION 'S12 failed: null failure_count was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC04' THEN
    NULL;
  END;
END $$;

-- ---------------------------------------------------------------------------
-- S13. A compatibility replacement of a shared secret fences the sibling.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  fb uuid := 'f11c0001-0000-4000-8000-000000000011';
  ig2 uuid := 'f11c0004-0000-4000-8000-000000000014';
  v_id uuid;
  v_gen bigint;
  v_before bigint;
BEGIN
  -- ig2's capability row was removed when the account... no, S10 deleted ig
  -- not ig2. ig2 still exists. Bind it to the owner token via compatibility
  -- by first attaching through the new API, then replacing through the old one.
  v_id := (
    SELECT credential_id FROM public.facebook_user_credential_bindings
     WHERE social_account_id = fb
  );
  v_gen := (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint;
  PERFORM public.bind_facebook_user_credential(u_a, jsonb_build_object(
    'credential_id', v_id,
    'expected_revision', 1,
    'social_account_id', ig2,
    'expected_capability_generation', v_gen,
    'provenance_source', 'oauth_exchange',
    'verified_provider_identity', jsonb_build_object(
      'facebook_user_id', 'fb-user-owner',
      'facebook_page_id', 'page-sibling',
      'instagram_user_id', 'ig-sibling'
    )
  ));
  v_before := (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint;
  PERFORM public.write_instagram_account_capability(
    ig2, u_a, '{"login_kind":"page_linked"}'::jsonb || jsonb_build_object(
      'expected_credential_generation', v_before
    )
  );
  BEGIN
    PERFORM public.replace_instagram_account_credential(
      ig2, u_a, jsonb_build_object(
        'credential_kind', 'facebook_user',
        'token', 'synthetic-sibling-omitted',
        'expected_credential_generation', v_before
      ));
    RAISE EXCEPTION 'S13 failed: a shared replacement without the bound set was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC04' THEN
    NULL;
  END;
  ASSERT (public.read_facebook_user_credential(u_a, v_id)->>'token') = 'synthetic-owner-token',
    'S13 a shared replacement without the bound set leaves the secret';
  ASSERT (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint
           = v_before,
    'S13 a shared replacement without the bound set leaves the generation';

  PERFORM public.replace_instagram_account_credential(
    ig2, u_a, jsonb_build_object(
      'credential_kind', 'facebook_user',
      'token', 'synthetic-sibling-replaced',
      'expected_credential_generation', v_before,
      'expected_bound_accounts', jsonb_build_array(
        jsonb_build_object(
          'social_account_id', ig2,
          'expected_capability_generation', v_before
        ),
        jsonb_build_object('social_account_id', fb)
      )
    ));
  ASSERT (public.read_facebook_user_account_credential(u_a, fb)->>'token')
           = 'synthetic-sibling-replaced',
    'S13 the compatibility writer replaces the shared secret when the bound set matches';
  ASSERT (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint
           = v_before + 1,
    'S13 the named account generation moves';
  ASSERT (public.read_facebook_user_credential(u_a, v_id)->>'revision') = '2',
    'S13 the shared replacement bumps the credential revision';
END $$;

-- ---------------------------------------------------------------------------
-- S14. An account-field update with no new User token fences only the
-- listed Instagram account and does not rotate the shared secret.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  fb uuid := 'f11c0001-0000-4000-8000-000000000011';
  ig2 uuid := 'f11c0004-0000-4000-8000-000000000014';
  v_id uuid;
  v jsonb;
  v_gen bigint;
  v_fb_token text;
BEGIN
  v_id := (
    SELECT credential_id FROM public.facebook_user_credential_bindings
     WHERE social_account_id = fb
  );
  v_gen := (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint;
  v_fb_token := (SELECT access_token FROM public.social_accounts WHERE id = fb);
  v := public.write_facebook_user_credential(u_a, jsonb_build_object(
    'credential_id', v_id,
    'expected_revision', 2,
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', ig2,
      'expected_capability_generation', v_gen,
      'access_token', 'ig-page-token-health-only',
      'needs_reauth', false
    ))
  ));
  ASSERT v->>'operation' = 'account_state_updated',
    'S14 a field update without a token is not a secret replacement';
  ASSERT v->>'revision' = '2', 'S14 the credential revision stays put';
  ASSERT position('synthetic-sibling-replaced' IN v::text) = 0,
    'S14 the status document does not contain the user token';
  ASSERT (public.read_facebook_user_credential(u_a, v_id)->>'token')
           = 'synthetic-sibling-replaced',
    'S14 the shared user token is unchanged';
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = ig2)
           = 'ig-page-token-health-only',
    'S14 the listed account token is updated';
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = fb) = v_fb_token,
    'S14 an unlisted account token is unchanged';
  ASSERT (public.read_instagram_account_capability(ig2, u_a)->>'credential_generation')::bigint
           = v_gen + 1,
    'S14 only the listed Instagram capability is fenced';
  ASSERT (public.read_instagram_account_capability(ig2, u_a)->>'generation_reason')
           = 'account_token_updated',
    'S14 the fence reason is the account update, not a secret replacement';
END $$;

-- ---------------------------------------------------------------------------
-- S15. Facebook page-token and health writes use connection_version.
-- Credential revision stays put, the shared User token is not rotated, and
-- an unlisted sibling is not modified. A second response that still holds
-- the pre-write connection version writes nothing.
-- ---------------------------------------------------------------------------
-- The suite switches to service_role above. Account rows are fixture data,
-- inserted as the harness role the same way S1's accounts are.
RESET ROLE;
INSERT INTO public.social_accounts
  (id, user_id, platform, platform_user_id, platform_username, access_token, ig_auth_type)
VALUES
  ('f11c0007-0000-4000-8000-000000000017', 'f11a0001-0000-4000-8000-000000000001',
   'facebook', 'page-fence', 'page_fence', 'page-token-initial', NULL),
  ('f11c0008-0000-4000-8000-000000000018', 'f11a0001-0000-4000-8000-000000000001',
   'facebook', 'page-fence-sib', 'page_fence_sib', 'page-token-sibling', NULL),
  ('f11c0009-0000-4000-8000-000000000019', 'f11a0001-0000-4000-8000-000000000001',
   'instagram', 'ig-fence', 'ig_fence', 'ig-token-fence', 'facebook_page');
SET LOCAL ROLE service_role;

DO $$
DECLARE
  u_a uuid := 'f11a0001-0000-4000-8000-000000000001';
  u_b uuid := 'f11b0002-0000-4000-8000-000000000002';
  fb uuid := 'f11c0007-0000-4000-8000-000000000017';
  sib uuid := 'f11c0008-0000-4000-8000-000000000018';
  ig uuid := 'f11c0009-0000-4000-8000-000000000019';
  v jsonb;
  v_id uuid;
  v_rev bigint;
  v_conn bigint;
  v_user text;
  v_err text;
  v_gen bigint;
BEGIN
  v := public.bind_facebook_user_credential(u_a, jsonb_build_object(
    'expected_absent', true,
    'token', 'synthetic-fence-user',
    'provenance_source', 'oauth_exchange',
    'provenance_captured_at', '2026-10-27T12:00:00Z',
    'social_account_id', fb,
    'verified_provider_identity', jsonb_build_object('facebook_user_id', 'fb-user-fence')
  ));
  v_id := (v->>'credential_id')::uuid;
  v_rev := (v->>'revision')::bigint;
  v_conn := (v->'bindings'->0->>'connection_version')::bigint;
  ASSERT v_rev = 1, 'S15 a new Facebook credential starts at revision 1';
  ASSERT v_conn = 1, 'S15 describe returns the captured connection version';
  ASSERT position('synthetic-fence-user' IN v::text) = 0,
    'S15 describe does not return the user token';
  v_user := (public.read_facebook_user_credential(u_a, v_id)->>'token');

  v := public.write_facebook_user_credential(u_a, jsonb_build_object(
    'credential_id', v_id,
    'expected_revision', v_rev,
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', fb,
      'expected_connection_version', v_conn,
      'access_token', 'synthetic-newer',
      'needs_reauth', true
    ))
  ));
  ASSERT v->>'operation' = 'account_state_updated',
    'S15 a Facebook field write is not a secret replacement';
  ASSERT (v->>'revision')::bigint = v_rev,
    'S15 a Facebook field write does not advance credential revision';
  ASSERT (v->'bindings'->0->>'connection_version')::bigint = v_conn + 1,
    'S15 the account connection version advances by one';
  ASSERT (public.read_facebook_user_credential(u_a, v_id)->>'token') = v_user,
    'S15 the shared user token is not rotated';
  ASSERT (SELECT access_token = 'synthetic-newer' AND needs_reauth
            FROM public.social_accounts WHERE id = fb),
    'S15 the newer page token and reauth state are stored';

  PERFORM public.bind_facebook_user_credential(u_a, jsonb_build_object(
    'credential_id', v_id,
    'expected_revision', v_rev,
    'social_account_id', sib,
    'provenance_source', 'oauth_exchange',
    'verified_provider_identity', jsonb_build_object('facebook_user_id', 'fb-user-fence')
  ));
  v := public.write_facebook_user_credential(u_a, jsonb_build_object(
    'credential_id', v_id,
    'expected_revision', v_rev,
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', sib,
      'expected_connection_version',
        (public.read_facebook_user_account_credential(u_a, sib)->>'connection_version')::int,
      'failure_count', 2
    ))
  ));
  ASSERT (public.read_facebook_user_credential(u_a, v_id)->>'token') = v_user,
    'S15 a sibling health field does not rotate the shared user token';
  ASSERT (public.read_facebook_user_credential(u_a, v_id)->>'revision')::bigint = v_rev,
    'S15 a sibling health field does not advance credential revision';
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = fb) = 'synthetic-newer',
    'S15 an unlisted account token is unchanged';
  ASSERT (SELECT needs_reauth FROM public.social_accounts WHERE id = fb),
    'S15 an unlisted account reauth flag is unchanged';
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = sib) = 'page-token-sibling',
    'S15 a failure_count update does not replace the sibling page token';
  ASSERT (SELECT failure_count FROM public.social_accounts WHERE id = sib) = 2,
    'S15 the listed failure count is partial';

  BEGIN
    PERFORM public.write_facebook_user_credential(u_a, jsonb_build_object(
      'credential_id', v_id,
      'expected_revision', v_rev,
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', fb,
        'expected_connection_version', v_conn,
        'access_token', 'synthetic-older',
        'needs_reauth', false
      ))
    ));
    RAISE EXCEPTION 'S15 failed: a stale Facebook account response was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC01' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err = 'stale connection version', 'S15 the stale response is typed';
  ASSERT (SELECT access_token = 'synthetic-newer' AND needs_reauth
            FROM public.social_accounts WHERE id = fb),
    'S15 the stale response writes neither token nor reauth state';
  ASSERT (public.read_facebook_user_credential(u_a, v_id)->>'token') = v_user,
    'S15 the stale response does not rotate the user token';
  ASSERT (SELECT failure_count FROM public.social_accounts WHERE id = sib) = 2,
    'S15 the stale response does not modify the sibling';

  -- S16. Detach captured C1 must not remove a later C2, and must not remove
  -- the same C1 after it is rebound at a new connection version.
  PERFORM public.unbind_facebook_user_credential(u_a, jsonb_build_object(
    'social_account_id', fb,
    'credential_id', v_id,
    'expected_revision', v_rev,
    'expected_connection_version', v_conn + 1
  ));
  v := public.bind_facebook_user_credential(u_a, jsonb_build_object(
    'expected_absent', true,
    'token', 'synthetic-fence-user-two',
    'provenance_source', 'oauth_exchange',
    'provenance_captured_at', '2026-10-27T12:10:00Z',
    'social_account_id', fb,
    'verified_provider_identity', jsonb_build_object('facebook_user_id', 'fb-user-fence')
  ));
  ASSERT (v->>'credential_id')::uuid <> v_id, 'S16 the rebound credential is a new row';
  ASSERT (v->>'revision')::bigint = 1, 'S16 the new credential also starts at revision 1';
  BEGIN
    PERFORM public.unbind_facebook_user_credential(u_a, jsonb_build_object(
      'social_account_id', fb,
      'credential_id', v_id,
      'expected_revision', v_rev,
      'expected_connection_version', v_conn + 1
    ));
    RAISE EXCEPTION 'S16 failed: a stale detach removed the new credential'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC01' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err = 'stale credential identity', 'S16 identity mismatch is typed';
  ASSERT (public.read_facebook_user_account_credential(u_a, fb)->>'credential_id')
           = v->>'credential_id',
    'S16 the new binding remains';
  ASSERT (public.read_facebook_user_account_credential(u_a, fb)->>'token')
           = 'synthetic-fence-user-two',
    'S16 the new secret remains';

  PERFORM public.unbind_facebook_user_credential(u_a, jsonb_build_object(
    'social_account_id', fb,
    'credential_id', (v->>'credential_id')::uuid,
    'expected_revision', 1,
    'expected_connection_version', (v->'bindings'->0->>'connection_version')::int
  ));
  PERFORM public.bind_facebook_user_credential(u_a, jsonb_build_object(
    'credential_id', v_id,
    'expected_revision', v_rev,
    'social_account_id', fb,
    'provenance_source', 'oauth_exchange',
    'verified_provider_identity', jsonb_build_object('facebook_user_id', 'fb-user-fence')
  ));
  BEGIN
    PERFORM public.unbind_facebook_user_credential(u_a, jsonb_build_object(
      'social_account_id', fb,
      'credential_id', v_id,
      'expected_revision', v_rev,
      'expected_connection_version', v_conn + 1
    ));
    RAISE EXCEPTION 'S16 failed: the same credential was detached with a burned version'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC01' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err = 'stale connection version',
    'S16 same-credential rebind is refused on the old connection version';
  ASSERT (public.read_facebook_user_account_credential(u_a, fb)->>'credential_id')::uuid = v_id,
    'S16 the rebound binding remains';
  ASSERT (public.read_facebook_user_account_credential(u_a, sib)->>'token') = v_user,
    'S16 the sibling still holds the original secret';

  -- S17. Instagram account-state fencing stays on capability generation.
  PERFORM public.write_instagram_account_capability(
    ig, u_a, '{"login_kind":"page_linked"}'::jsonb);
  v_gen := (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint;
  PERFORM public.bind_facebook_user_credential(u_a, jsonb_build_object(
    'credential_id', v_id,
    'expected_revision', v_rev,
    'social_account_id', ig,
    'expected_capability_generation', v_gen,
    'provenance_source', 'oauth_exchange',
    'verified_provider_identity', jsonb_build_object(
      'facebook_user_id', 'fb-user-fence',
      'facebook_page_id', 'page-fence',
      'instagram_user_id', 'ig-fence'
    )
  ));
  v_gen := (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint;
  v := public.write_facebook_user_credential(u_a, jsonb_build_object(
    'credential_id', v_id,
    'expected_revision', v_rev,
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', ig,
      'expected_capability_generation', v_gen,
      'access_token', 'ig-fence-newer',
      'needs_reauth', false
    ))
  ));
  ASSERT (v->>'revision')::bigint = v_rev,
    'S17 an Instagram field write does not advance the shared revision';
  ASSERT (public.read_instagram_account_capability(ig, u_a)->>'credential_generation')::bigint
           = v_gen + 1,
    'S17 the Instagram capability generation still advances';
  ASSERT (public.read_facebook_user_credential(u_a, v_id)->>'token') = v_user,
    'S17 the Instagram field write does not rotate the user token';
  BEGIN
    PERFORM public.write_facebook_user_credential(u_a, jsonb_build_object(
      'credential_id', v_id,
      'expected_revision', v_rev,
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', ig,
        'expected_capability_generation', v_gen,
        'access_token', 'ig-fence-stale'
      ))
    ));
    RAISE EXCEPTION 'S17 failed: a stale Instagram generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC01' THEN
    NULL;
  END;
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = ig) = 'ig-fence-newer',
    'S17 the stale Instagram response writes nothing';
  BEGIN
    PERFORM public.write_facebook_user_credential(u_a, jsonb_build_object(
      'credential_id', v_id,
      'expected_revision', v_rev,
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', ig,
        'expected_capability_generation', v_gen + 1,
        'expected_connection_version', 1,
        'access_token', 'ig-fence-bypass'
      ))
    ));
    RAISE EXCEPTION 'S17 failed: a connection version bypassed the Instagram fence'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC04' THEN
    NULL;
  END;
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = ig) = 'ig-fence-newer',
    'S17 the rejected Instagram payload writes nothing';

  -- S18. Cross-owner calls do not write.
  BEGIN
    PERFORM public.write_facebook_user_credential(u_b, jsonb_build_object(
      'credential_id', v_id,
      'expected_revision', v_rev,
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', fb,
        'expected_connection_version', 1,
        'access_token', 'cross-owner-token'
      ))
    ));
    RAISE EXCEPTION 'S18 failed: a cross-owner write was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = 'assert_failure' THEN
      RAISE;
    END IF;
  END;
  BEGIN
    PERFORM public.unbind_facebook_user_credential(u_b, jsonb_build_object(
      'social_account_id', fb,
      'credential_id', v_id,
      'expected_revision', v_rev,
      'expected_connection_version', 1
    ));
    RAISE EXCEPTION 'S18 failed: a cross-owner detach was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = 'assert_failure' THEN
      RAISE;
    END IF;
  END;
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = fb) = 'synthetic-newer',
    'S18 cross-owner calls leave the page token';
  ASSERT (public.read_facebook_user_account_credential(u_a, fb)->>'credential_id')::uuid = v_id,
    'S18 cross-owner calls leave the binding';
END $$;

RESET ROLE;

ROLLBACK;
\echo '=== facebook_user_credential_bindings: ALL CHECKS PASSED ==='
