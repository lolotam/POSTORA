-- supabase/tests/instagram_capabilities.sql
-- Task 3a prerequisites (migration 20261026120000_instagram_capability_prerequisites.sql).
--
-- The capability relation is service-write-only and structurally bound to
-- social_accounts(id, user_id, platform). This suite proves:
--
--   S1  the grant surface: RLS on, zero policies, no client privilege at
--       all, service_role keeps write access, and every RPC is unreachable
--       by anon and authenticated.
--   S2  a cross-owner row cannot exist: the composite foreign key refuses
--       it, and so does the platform check.
--   S3  the RPCs refuse a caller that names the wrong owner - even as the
--       service role, which bypasses RLS entirely.
--   S4  unknown is not successful-empty: a legacy account (never read) and
--       a successful read that returned no scope are different states.
--   S5  a failed read never overwrites an established successful read.
--   S6  credential replacement and the generation move together.
--   S7  a reconnect drops the credential, resets the permission read state
--       and advances the generation.
--   S8  the generation-only bump advances the version and nothing else.
--   S9  a login kind change goes through the reconnect path only.
--   S10 malformed payloads and invalid states are refused.
--   S11 deleting the social account cascades the capability and the
--       credential away.
--   S12 the status projection never carries a secret.
--   S13 a permission result is bound to the generation observed when the
--       read started, evidence timestamps are finite strings and move
--       forward inside one generation, and a refused write leaves the row
--       unchanged.
--
-- Style: one transaction, fixtures inside, labelled asserts, expected errors
-- in nested BEGIN/EXCEPTION blocks, ROLLBACK, sentinel last. Fixture values
-- are synthetic ('...@example.invalid'); no secrets and no real data.
--
-- The suite SET ROLEs away from superuser for the RPC calls on purpose: the
-- service role bypasses RLS, so the ownership checks inside the RPCs are the
-- only thing under test, and they have to be exercised as the role that
-- actually calls them.

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures (superuser: RLS does not apply to the fixture writer).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  u_a        uuid := 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  u_b        uuid := 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
  acct_a     uuid := 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
  acct_b     uuid := 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
  acct_tk    uuid := 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
  acct_c     uuid := 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4';
  acct_d     uuid := 'c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c5';
  acct_e     uuid := 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c6c6';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (u_a, 'ig-cap-a-' || u_a::text || '@example.invalid'),
    (u_b, 'ig-cap-b-' || u_b::text || '@example.invalid');

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username,
     access_token, ig_auth_type)
  VALUES
    (acct_a,  u_a, 'instagram', 'ig-a',  'ig_a',  'page-token-a', 'facebook_page'),
    (acct_b,  u_b, 'instagram', 'ig-b',  'ig_b',  'page-token-b', 'business_login'),
    (acct_tk, u_a, 'tiktok',   'tp-a',  'tp_a',  'tiktok-token-a', NULL),
    (acct_c,  u_a, 'instagram', 'ig-c',  'ig_c',  'page-token-c', 'facebook_page'),
    (acct_d,  u_a, 'instagram', 'ig-d',  'ig_d',  'page-token-d', 'facebook_page'),
    (acct_e,  u_a, 'instagram', 'ig-e',  'ig_e',  'page-token-e', 'facebook_page');
END $$;

-- ---------------------------------------------------------------------------
-- S1 - the grant surface.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f TEXT;
BEGIN
  -- RLS is enabled on both relations.
  ASSERT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'public.instagram_account_capabilities'::regclass),
    'S1 RLS is enabled on instagram_account_capabilities';
  ASSERT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'public.instagram_account_credentials'::regclass),
    'S1 RLS is enabled on instagram_account_credentials';

  -- No policy of any kind survives on either relation. The service role
  -- bypasses RLS; there is no browser-visible door at all.
  ASSERT NOT EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname = 'public'
                        AND tablename IN ('instagram_account_capabilities',
                                         'instagram_account_credentials')),
    'S1 no policy exists on either Instagram capability relation';

  -- No client role holds any privilege on either relation.
  ASSERT NOT has_table_privilege('anon', 'public.instagram_account_capabilities',
                                 'SELECT, INSERT, UPDATE, DELETE'),
    'S1 anon holds no privilege on instagram_account_capabilities';
  ASSERT NOT has_table_privilege('authenticated', 'public.instagram_account_capabilities',
                                 'SELECT, INSERT, UPDATE, DELETE'),
    'S1 authenticated holds no privilege on instagram_account_capabilities';
  ASSERT NOT has_table_privilege('anon', 'public.instagram_account_credentials',
                                 'SELECT, INSERT, UPDATE, DELETE'),
    'S1 anon holds no privilege on instagram_account_credentials';
  ASSERT NOT has_table_privilege('authenticated', 'public.instagram_account_credentials',
                                 'SELECT, INSERT, UPDATE, DELETE'),
    'S1 authenticated holds no privilege on instagram_account_credentials';

  -- The service role keeps full access: it is the only writer. Each
  -- privilege is asserted on its own, because has_table_privilege with a
  -- list answers "any of these", not "all of these".
  ASSERT has_table_privilege('service_role', 'public.instagram_account_capabilities', 'SELECT'),
    'S1 service_role can SELECT instagram_account_capabilities';
  ASSERT has_table_privilege('service_role', 'public.instagram_account_capabilities', 'INSERT'),
    'S1 service_role can INSERT into instagram_account_capabilities';
  ASSERT has_table_privilege('service_role', 'public.instagram_account_capabilities', 'UPDATE'),
    'S1 service_role can UPDATE instagram_account_capabilities';
  ASSERT has_table_privilege('service_role', 'public.instagram_account_capabilities', 'DELETE'),
    'S1 service_role can DELETE from instagram_account_capabilities';
  ASSERT has_table_privilege('service_role', 'public.instagram_account_credentials', 'SELECT'),
    'S1 service_role can SELECT instagram_account_credentials';
  ASSERT has_table_privilege('service_role', 'public.instagram_account_credentials', 'INSERT'),
    'S1 service_role can INSERT into instagram_account_credentials';
  ASSERT has_table_privilege('service_role', 'public.instagram_account_credentials', 'UPDATE'),
    'S1 service_role can UPDATE instagram_account_credentials';
  ASSERT has_table_privilege('service_role', 'public.instagram_account_credentials', 'DELETE'),
    'S1 service_role can DELETE from instagram_account_credentials';

  -- Every RPC is unreachable by anon and authenticated, and reachable by
  -- the service role. The anon key alone must not be able to call any of
  -- them.
  FOREACH f IN ARRAY ARRAY[
    'public.instagram_account_capability_projection(uuid)',
    'public.read_instagram_account_capability(uuid,uuid)',
    'public.write_instagram_account_capability(uuid,uuid,jsonb)',
    'public.replace_instagram_account_credential(uuid,uuid,jsonb)',
    'public.record_instagram_account_reconnect(uuid,uuid,jsonb)',
    'public.bump_instagram_credential_generation(uuid,uuid,text,bigint)',
    'public.revoke_instagram_account_credential(uuid,uuid,text,bigint)',
    'public.read_instagram_account_credential(uuid,uuid)'
  ] LOOP
    ASSERT NOT has_function_privilege('anon', f, 'EXECUTE'),
      format('S1 anon cannot execute %s', f);
    ASSERT NOT has_function_privilege('authenticated', f, 'EXECUTE'),
      format('S1 authenticated cannot execute %s', f);
    ASSERT has_function_privilege('service_role', f, 'EXECUTE'),
      format('S1 service_role can execute %s', f);
  END LOOP;

  ASSERT to_regprocedure('public.bump_instagram_credential_generation(uuid,uuid,text)') IS NULL,
    'S1 the unfenced generation bump signature is gone';
  ASSERT to_regprocedure('public.revoke_instagram_account_credential(uuid,uuid,text)') IS NULL,
    'S1 the unfenced account revoke signature is gone';
END $$;

-- ---------------------------------------------------------------------------
-- S2 - a cross-owner row cannot exist, structurally.
--
-- These are direct table writes as the service role. They prove the
-- composite foreign key, not a policy: a service-role write is exactly the
-- case RLS cannot stop.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  u_a     uuid := 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  u_b     uuid := 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
  acct_a  uuid := 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
BEGIN
  -- The account belongs to u_a. A capability row naming u_b is refused by
  -- the foreign key on (social_account_id, user_id, platform).
  BEGIN
    INSERT INTO public.instagram_account_capabilities
      (social_account_id, user_id, platform, login_kind)
    VALUES (acct_a, u_b, 'instagram', 'direct');
    RAISE EXCEPTION 'S2 failed: a cross-owner capability row was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- The account is an Instagram account. A capability row claiming another
  -- platform is refused by the platform check.
  BEGIN
    INSERT INTO public.instagram_account_capabilities
      (social_account_id, user_id, platform, login_kind)
    VALUES (acct_a, u_a, 'tiktok', 'direct');
    RAISE EXCEPTION 'S2 failed: a non-Instagram capability row was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Nothing was written by either attempt.
  ASSERT (SELECT count(*) FROM public.instagram_account_capabilities) = 0,
    'S2 no capability row survived a refused insert';

  -- The account that is not an Instagram account cannot carry a capability
  -- either, even for its real owner.
  BEGIN
    INSERT INTO public.instagram_account_capabilities
      (social_account_id, user_id, platform, login_kind)
    VALUES ('c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3'::uuid, u_a, 'instagram', 'direct');
    RAISE EXCEPTION 'S2 failed: a capability row for a TikTok account was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S3 - the RPCs refuse a caller that names the wrong owner.
--
-- Run as the service role on purpose: it bypasses RLS, so the owner check
-- inside the RPC is the only thing standing between the caller and another
-- user's row.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  u_a     uuid := 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  u_b     uuid := 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
  acct_a  uuid := 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
  acct_tk uuid := 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
BEGIN
  BEGIN
    PERFORM public.read_instagram_account_capability(acct_a, u_b);
    RAISE EXCEPTION 'S3 failed: a cross-owner capability read was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%not owned by the given user%',
      'S3 a cross-owner capability read is refused with the ownership error';
  END;

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_a, u_b, '{"login_kind":"direct"}'::jsonb);
    RAISE EXCEPTION 'S3 failed: a cross-owner capability write was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%not owned by the given user%',
      'S3 a cross-owner capability write is refused with the ownership error';
  END;

  BEGIN
    PERFORM public.replace_instagram_account_credential(
      acct_a, u_b, '{"credential_kind":"facebook_user","token":"cross-owner"}'::jsonb);
    RAISE EXCEPTION 'S3 failed: a cross-owner credential write was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%not owned by the given user%',
      'S3 a cross-owner credential write is refused with the ownership error';
  END;

  BEGIN
    PERFORM public.read_instagram_account_credential(acct_a, u_b);
    RAISE EXCEPTION 'S3 failed: a cross-owner credential read was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%not owned by the given user%',
      'S3 a cross-owner credential read is refused with the ownership error';
  END;

  -- The owner of a non-Instagram account cannot attach a capability to it.
  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_tk, u_a, '{"login_kind":"direct"}'::jsonb);
    RAISE EXCEPTION 'S3 failed: a capability was accepted for a TikTok account'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%not owned by the given user%',
      'S3 a non-Instagram account is refused with the ownership error';
  END;
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S4 - unknown is not successful-empty.
--
-- Three states that must stay distinguishable:
--   never read        -> unknown, scope set NOT authoritative
--   read, no scopes  -> ok, scope set authoritative, empty = a denial
--   read, scopes     -> ok, scope set authoritative
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  u_a    uuid := 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  acct_a uuid := 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
  v      jsonb;
BEGIN
  -- A legacy account: no capability record at all.
  v := public.read_instagram_account_capability(acct_a, u_a);
  ASSERT v->>'capability_present' = 'false',
    'S4 a legacy account has no capability record';
  ASSERT v->>'permission_read_state' = 'unknown',
    'S4 a legacy account reads as unknown';
  ASSERT v->>'scopes_authoritative' = 'false',
    'S4 a legacy scope set is not authoritative';
  ASSERT v->>'credential_generation' = '0',
    'S4 a legacy account starts at generation 0';

  -- First write: the trusted login kind, and still no permission read.
  v := public.write_instagram_account_capability(
    acct_a, u_a, '{"login_kind":"page_linked"}'::jsonb);
  ASSERT v->>'capability_present' = 'true',
    'S4 the capability record exists after the first write';
  ASSERT v->>'login_kind' = 'page_linked',
    'S4 the trusted login kind is stored';
  ASSERT v->>'permission_read_state' = 'unknown',
    'S4 the first write leaves the permission read state unknown';
  ASSERT v->>'scopes_authoritative' = 'false',
    'S4 an unknown scope set is not authoritative';
  ASSERT v->>'has_protected_credential' = 'false',
    'S4 no protected credential exists yet';

  -- A successful read that granted a scope.
  v := public.write_instagram_account_capability(
    acct_a, u_a,
    '{"permission_read_state":"ok","expected_credential_generation":0,"granted_scopes":["instagram_manage_insights","pages_read_engagement"],"scopes_read_at":"2026-10-26T09:00:00Z"}'::jsonb);
  ASSERT v->>'permission_read_state' = 'ok',
    'S4 a successful read is recorded as ok';
  ASSERT v->>'scopes_authoritative' = 'true',
    'S4 a successful read makes the scope set authoritative';
  ASSERT v->'granted_scopes' = '["instagram_manage_insights","pages_read_engagement"]'::jsonb,
    'S4 the granted scopes are stored as read';

  -- A successful read that granted NOTHING is a denial, not an unknown.
  v := public.write_instagram_account_capability(
    acct_a, u_a,
    '{"permission_read_state":"ok","expected_credential_generation":0,"granted_scopes":[],"scopes_read_at":"2026-10-26T10:00:00Z"}'::jsonb);
  ASSERT v->>'permission_read_state' = 'ok',
    'S4 a successful empty read is still ok';
  ASSERT v->>'scopes_authoritative' = 'true',
    'S4 a successful empty read IS authoritative';
  ASSERT v->'granted_scopes' = '[]'::jsonb,
    'S4 a successful empty read stores an empty scope set';

  -- A read that never succeeded, on an account that never had one.
  v := public.write_instagram_account_capability(
    'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2'::uuid,
    'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'::uuid,
    '{"login_kind":"direct","permission_read_state":"failed","expected_credential_generation":0,"read_failed_at":"2026-10-26T11:00:00Z","read_error_code":"META_TIMEOUT"}'::jsonb);
  ASSERT v->>'permission_read_state' = 'failed',
    'S4 a failed read is recorded as failed';
  ASSERT v->>'scopes_authoritative' = 'false',
    'S4 a failed read is not authoritative';
  ASSERT v->>'last_read_error_code' = 'META_TIMEOUT',
    'S4 the failure code is recorded';
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S5 - a failed read never overwrites an established successful read.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  u_a    uuid := 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  acct_a uuid := 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
  v      jsonb;
BEGIN
  -- acct_a is in state 'ok' with an empty (denied) scope set from S4.
  v := public.write_instagram_account_capability(
    acct_a, u_a,
    '{"permission_read_state":"failed","expected_credential_generation":0,"read_failed_at":"2026-10-26T12:00:00Z","read_error_code":"META_500"}'::jsonb);
  ASSERT v->>'permission_read_state' = 'ok',
    'S5 a failed read does not downgrade an established successful read';
  ASSERT v->>'scopes_authoritative' = 'true',
    'S5 the scope set stays authoritative after a failed read';
  ASSERT v->'granted_scopes' = '[]'::jsonb,
    'S5 the recorded scope set is unchanged after a failed read';
  ASSERT v->>'last_read_failed_at' IS NOT NULL,
    'S5 the failed read is still recorded';
  ASSERT v->>'last_read_error_code' = 'META_500',
    'S5 the failure code is still recorded';

  -- A later successful read clears the failure marker.
  v := public.write_instagram_account_capability(
    acct_a, u_a,
    '{"permission_read_state":"ok","expected_credential_generation":0,"granted_scopes":["instagram_basic"],"scopes_read_at":"2026-10-26T13:00:00Z"}'::jsonb);
  ASSERT v->>'last_read_failed_at' IS NULL,
    'S5 a successful read clears the failure marker';
  ASSERT v->'granted_scopes' = '["instagram_basic"]'::jsonb,
    'S5 a successful read replaces the scope set';

  -- A payload that says nothing about the state leaves it alone.
  -- An existing row still has to name the generation it observed.
  v := public.write_instagram_account_capability(
    acct_a, u_a, '{"login_kind":"page_linked","expected_credential_generation":0}'::jsonb);
  ASSERT v->>'permission_read_state' = 'ok',
    'S5 a payload without a state does not reset the state';
  ASSERT v->>'scopes_authoritative' = 'true',
    'S5 a payload without a state does not lose authority';
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S6 - credential replacement and the generation move together.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  u_a    uuid := 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  acct_a uuid := 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
  v      jsonb;
BEGIN
  -- The capability record exists (S4) and is page-linked. A replacement
  -- still has to name the generation captured before it runs.
  BEGIN
    PERFORM public.replace_instagram_account_credential(
      acct_a, u_a,
      '{"credential_kind":"facebook_user","token":"user-token-missing-generation","token_expires_at":"2026-12-26T00:00:00Z"}'::jsonb);
    RAISE EXCEPTION 'S6 failed: a replacement without a generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG03' THEN
    ASSERT SQLERRM = 'expected_credential_generation is required',
      'S6 a replacement without a generation is refused';
  END;
  ASSERT (public.read_instagram_account_credential(acct_a, u_a)->>'found') = 'false',
    'S6 a replacement without a generation stores nothing';
  ASSERT (public.read_instagram_account_capability(acct_a, u_a)->>'credential_generation') = '0',
    'S6 a replacement without a generation leaves generation 0';

  v := public.replace_instagram_account_credential(
    acct_a, u_a,
    '{"credential_kind":"facebook_user","token":"user-token-1","token_expires_at":"2026-12-26T00:00:00Z","expected_credential_generation":0}'::jsonb);
  ASSERT v->>'credential_generation' = '1',
    'S6 the first replacement moves the generation to 1';
  ASSERT v->>'has_protected_credential' = 'true',
    'S6 the replacement records that a protected credential exists';
  ASSERT v->>'generation_reason' = 'credential_replaced',
    'S6 the replacement records why the generation moved';

  -- The credential is readable, with the generation it was written at.
  v := public.read_instagram_account_credential(acct_a, u_a);
  ASSERT v->>'found' = 'true',
    'S6 the protected credential is found';
  ASSERT v->>'token' = 'user-token-1',
    'S6 the protected credential reads back';
  ASSERT v->>'credential_kind' = 'facebook_user',
    'S6 the credential kind is recorded';
  ASSERT v->>'credential_generation' = '1',
    'S6 the credential reads at the current generation';

  BEGIN
    PERFORM public.replace_instagram_account_credential(
      acct_a, u_a,
      '{"credential_kind":"facebook_user","token":"user-token-stale","expected_credential_generation":0}'::jsonb);
    RAISE EXCEPTION 'S6 failed: a stale replacement was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG01' THEN
    NULL;
  END;
  ASSERT (public.read_instagram_account_credential(acct_a, u_a)->>'token') = 'user-token-1',
    'S6 a stale replacement leaves the stored token untouched';
  ASSERT (public.read_instagram_account_capability(acct_a, u_a)->>'credential_generation') = '1',
    'S6 a stale replacement leaves the generation untouched';

  -- A second replacement moves the generation again, by exactly one.
  v := public.replace_instagram_account_credential(
    acct_a, u_a,
    '{"credential_kind":"facebook_user","token":"user-token-2","expected_credential_generation":1}'::jsonb);
  ASSERT v->>'credential_generation' = '2',
    'S6 the second replacement moves the generation to 2';
  v := public.read_instagram_account_credential(acct_a, u_a);
  ASSERT v->>'token' = 'user-token-2',
    'S6 the second replacement replaced the value';

  -- A refused replacement changes nothing: not the token, not the
  -- generation.
  BEGIN
    PERFORM public.replace_instagram_account_credential(
      acct_a, u_a, '{"credential_kind":"facebook_user","token":"   "}'::jsonb);
    RAISE EXCEPTION 'S6 failed: an empty token was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%token must not be empty%',
      'S6 an empty token is refused with the token error';
  END;

  v := public.read_instagram_account_credential(acct_a, u_a);
  ASSERT v->>'token' = 'user-token-2',
    'S6 a refused replacement leaves the stored token untouched';
  ASSERT v->>'credential_generation' = '2',
    'S6 a refused replacement leaves the generation untouched';

  -- Direct login keeps its account token in social_accounts. The Facebook
  -- User store must not accept it, even with the live generation.
  BEGIN
    PERFORM public.replace_instagram_account_credential(
      'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2'::uuid,
      'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'::uuid,
      '{"credential_kind":"facebook_user","token":"direct-login-token","expected_credential_generation":0}'::jsonb);
    RAISE EXCEPTION 'S6 failed: a direct-login Facebook user credential was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC02' THEN
    ASSERT SQLERRM = 'direct Instagram login cannot bind a Facebook user credential',
      'S6 direct Instagram is refused';
  END;
  ASSERT (public.read_instagram_account_credential(
            'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2'::uuid,
            'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'::uuid)->>'found') = 'false',
    'S6 a refused direct-login replacement stores nothing';
  ASSERT (public.read_instagram_account_capability(
            'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2'::uuid,
            'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'::uuid)->>'credential_generation') = '0',
    'S6 a refused direct-login replacement leaves the generation untouched';
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S6b - the credential write and the generation increment share ONE
-- transaction. A rolled back replacement must leave BOTH the token and the
-- generation as they were.
--
-- This has to run at the psql level: SAVEPOINT is transaction control, which
-- PL/pgSQL forbids inside a function body.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
BEGIN
  PERFORM public.replace_instagram_account_credential(
    'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'::uuid,
    'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'::uuid,
    '{"credential_kind":"facebook_user","token":"user-token-3","expected_credential_generation":2}'::jsonb);
END $$;

SAVEPOINT ig_cap_generation_probe;
DO $$
BEGIN
  PERFORM public.replace_instagram_account_credential(
    'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'::uuid,
    'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'::uuid,
    '{"credential_kind":"facebook_user","token":"user-token-4","expected_credential_generation":3}'::jsonb);
END $$;
ROLLBACK TO SAVEPOINT ig_cap_generation_probe;

DO $$
DECLARE
  v jsonb;
BEGIN
  v := public.read_instagram_account_credential(
    'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'::uuid,
    'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'::uuid);
  ASSERT v->>'token' = 'user-token-3',
    'S6b a rolled back replacement leaves the stored token untouched';
  ASSERT v->>'credential_generation' = '3',
    'S6b a rolled back replacement leaves the generation untouched';
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S7 - a reconnect drops the credential, resets the read state, advances the
-- generation.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  u_a    uuid := 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  acct_a uuid := 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
  v      jsonb;
BEGIN
  BEGIN
    PERFORM public.record_instagram_account_reconnect(
      acct_a, u_a, '{"reason":"user_reconnect"}'::jsonb);
    RAISE EXCEPTION 'S7 failed: a reconnect without a generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG03' THEN
    ASSERT SQLERRM = 'expected_credential_generation is required',
      'S7 a reconnect without a generation is refused';
  END;
  ASSERT (public.read_instagram_account_capability(acct_a, u_a)->>'credential_generation') = '3',
    'S7 a reconnect without a generation leaves the generation untouched';

  v := public.record_instagram_account_reconnect(
    acct_a, u_a,
    '{"reason":"user_reconnect","expected_credential_generation":3}'::jsonb);
  ASSERT v->>'credential_generation' = '4',
    'S7 a reconnect advances the generation';
  ASSERT v->>'generation_reason' = 'user_reconnect',
    'S7 a reconnect records why the generation moved';
  ASSERT v->>'has_protected_credential' = 'false',
    'S7 a reconnect drops the protected credential';
  ASSERT v->>'permission_read_state' = 'unknown',
    'S7 a reconnect resets the permission read state to unknown';
  ASSERT v->>'scopes_authoritative' = 'false',
    'S7 a reconnect leaves no authoritative scope set';
  ASSERT v->'granted_scopes' = '[]'::jsonb,
    'S7 a reconnect clears the recorded scope set';
  ASSERT v->>'reconnected_at' IS NOT NULL,
    'S7 a reconnect records when it happened';

  -- A missing credential is null, never an empty token.
  v := public.read_instagram_account_credential(acct_a, u_a);
  ASSERT v->>'found' = 'false',
    'S7 the dropped credential is reported as not found';
  ASSERT v->>'token' IS NULL,
    'S7 a missing credential reads as null, not as an empty token';
  ASSERT v->>'credential_generation' = '4',
    'S7 the credential read still reports the current generation';
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S8 - the generation-only bump moves the version and nothing else.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  u_a    uuid := 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  acct_a uuid := 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
  v      jsonb;
BEGIN
  BEGIN
    PERFORM public.bump_instagram_credential_generation(
      acct_a, u_a, 'token_refreshed', 0);
    RAISE EXCEPTION 'S8 failed: a stale bump was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG01' THEN
    NULL;
  END;
  ASSERT (public.read_instagram_account_capability(acct_a, u_a)->>'credential_generation') = '4',
    'S8 a stale bump leaves the generation untouched';

  v := public.bump_instagram_credential_generation(
    acct_a, u_a, 'token_refreshed', 4);
  ASSERT v->>'credential_generation' = '5',
    'S8 the bump advances the generation by one';
  ASSERT v->>'generation_reason' = 'token_refreshed',
    'S8 the bump records its reason';
  ASSERT v->>'permission_read_state' = 'unknown',
    'S8 the bump does not touch the permission read state';

  -- A bump for an account with no capability record is refused. acct_c is
  -- an Instagram account that no RPC has ever written a capability for.
  BEGIN
    PERFORM public.bump_instagram_credential_generation(
      'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4'::uuid,
      'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'::uuid,
      'token_refreshed', 0);
    RAISE EXCEPTION 'S8 failed: a bump succeeded without a capability record'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%no capability record%',
      'S8 a bump without a capability record is refused';
  END;
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S8b - a revocation removes the credential and advances the generation.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  u_a    uuid := 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  acct_a uuid := 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
  v      jsonb;
BEGIN
  -- Put a credential back so the revocation has something to remove.
  v := public.replace_instagram_account_credential(
    acct_a, u_a,
    '{"credential_kind":"facebook_user","token":"user-token-revoked","expected_credential_generation":5}'::jsonb);
  ASSERT v->>'credential_generation' = '6',
    'S8b the credential is stored at generation 6';
  ASSERT v->>'has_protected_credential' = 'true',
    'S8b a credential is present before the revocation';

  BEGIN
    PERFORM public.revoke_instagram_account_credential(acct_a, u_a, 'provider_revoked', 5);
    RAISE EXCEPTION 'S8b failed: a stale revocation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG01' THEN
    NULL;
  END;
  ASSERT (public.read_instagram_account_credential(acct_a, u_a)->>'found') = 'true',
    'S8b a stale revocation leaves the credential in place';
  ASSERT (public.read_instagram_account_capability(acct_a, u_a)->>'credential_generation') = '6',
    'S8b a stale revocation leaves the generation untouched';

  v := public.revoke_instagram_account_credential(acct_a, u_a, 'provider_revoked', 6);
  ASSERT v->>'credential_generation' = '7',
    'S8b the revocation advances the generation';
  ASSERT v->>'has_protected_credential' = 'false',
    'S8b the revocation removes the credential';
  ASSERT v->>'generation_reason' = 'provider_revoked',
    'S8b the revocation records its reason';

  v := public.read_instagram_account_credential(acct_a, u_a);
  ASSERT v->>'found' = 'false',
    'S8b the revoked credential is not found';
  ASSERT v->>'token' IS NULL,
    'S8b the revoked credential reads as null, not as an empty token';

  -- A cross-owner revocation is refused.
  BEGIN
    PERFORM public.revoke_instagram_account_credential(
      acct_a, 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'::uuid, 'provider_revoked', 0);
    RAISE EXCEPTION 'S8b failed: a cross-owner revocation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%not owned by the given user%',
      'S8b a cross-owner revocation is refused with the ownership error';
  END;
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S9 - a login kind change goes through the reconnect path only.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  u_a    uuid := 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  acct_a uuid := 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
  v      jsonb;
BEGIN
  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_a, u_a, '{"login_kind":"direct","expected_credential_generation":7}'::jsonb);
    RAISE EXCEPTION 'S9 failed: the login kind changed without a reconnect'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%requires record_instagram_account_reconnect%',
      'S9 a login kind change is refused with the reconnect error';
  END;

  -- The reconnect path is the one that may change it.
  v := public.record_instagram_account_reconnect(
    acct_a, u_a,
    '{"login_kind":"direct","reason":"reauth_as_direct","expected_credential_generation":7}'::jsonb);
  ASSERT v->>'login_kind' = 'direct',
    'S9 a reconnect may set the new login kind';
  ASSERT v->>'credential_generation' = '8',
    'S9 the reconnect advanced the generation again';
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S10 - malformed payloads and invalid states are refused.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  u_a    uuid := 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  acct_a uuid := 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
BEGIN
  -- Not an object.
  BEGIN
    PERFORM public.write_instagram_account_capability(acct_a, u_a, '[]'::jsonb);
    RAISE EXCEPTION 'S10 failed: a non-object payload was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%must be a JSON object%',
      'S10 a non-object payload is refused';
  END;

  -- An unknown key.
  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_a, u_a, '{"login_kind":"direct","is_admin":true}'::jsonb);
    RAISE EXCEPTION 'S10 failed: an unknown payload key was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%unsupported payload key%',
      'S10 an unknown payload key is refused';
  END;

  -- An invalid login kind.
  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_a, u_a, '{"login_kind":"EAAS"}'::jsonb);
    RAISE EXCEPTION 'S10 failed: an invalid login kind was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%login_kind must be direct or page_linked%',
      'S10 an invalid login kind is refused';
  END;

  -- An invalid permission read state.
  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_a, u_a, '{"permission_read_state":"granted","expected_credential_generation":8}'::jsonb);
    RAISE EXCEPTION 'S10 failed: an invalid permission read state was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%permission_read_state must be unknown, ok or failed%',
      'S10 an invalid permission read state is refused';
  END;

  -- A successful read without the scope set it claims.
  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_a, u_a, '{"permission_read_state":"ok","expected_credential_generation":8,"scopes_read_at":"2026-10-26T09:00:00Z"}'::jsonb);
    RAISE EXCEPTION 'S10 failed: a successful read without scopes was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%granted_scopes is required%',
      'S10 a successful read without a scope set is refused';
  END;

  -- A scope set that is not an array.
  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_a, u_a, '{"permission_read_state":"ok","expected_credential_generation":8,"granted_scopes":"instagram_basic","scopes_read_at":"2026-10-26T09:00:00Z"}'::jsonb);
    RAISE EXCEPTION 'S10 failed: a non-array scope set was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%granted_scopes must be an array%',
      'S10 a non-array scope set is refused';
  END;

  -- A scope set holding something that is not a string.
  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_a, u_a, '{"permission_read_state":"ok","expected_credential_generation":8,"granted_scopes":[1,2],"scopes_read_at":"2026-10-26T09:00:00Z"}'::jsonb);
    RAISE EXCEPTION 'S10 failed: a non-string scope was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%only non-empty strings%',
      'S10 a scope set with a non-string element is refused';
  END;

  -- A malformed timestamp.
  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_a, u_a, '{"permission_read_state":"ok","expected_credential_generation":8,"granted_scopes":["instagram_basic"],"scopes_read_at":"not-a-date"}'::jsonb);
    RAISE EXCEPTION 'S10 failed: a malformed timestamp was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%must be a finite ISO-8601 timestamp%',
      'S10 a malformed timestamp is refused';
  END;

  -- A failed read without its failure time.
  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_a, u_a, '{"permission_read_state":"failed","expected_credential_generation":8}'::jsonb);
    RAISE EXCEPTION 'S10 failed: a failed read without a failure time was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%read_failed_at is required%',
      'S10 a failed read without a failure time is refused';
  END;

  -- A credential of the wrong kind.
  BEGIN
    PERFORM public.replace_instagram_account_credential(
      acct_a, u_a, '{"credential_kind":"page_token","token":"x"}'::jsonb);
    RAISE EXCEPTION 'S10 failed: an unknown credential kind was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%credential_kind must be facebook_user%',
      'S10 an unknown credential kind is refused';
  END;

  -- A credential write before the capability record exists.
  BEGIN
    PERFORM public.replace_instagram_account_credential(
      'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4'::uuid,
      'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'::uuid,
      '{"credential_kind":"facebook_user","token":"x","expected_credential_generation":0}'::jsonb);
    RAISE EXCEPTION 'S10 failed: a credential was written without a capability record'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%no capability record%',
      'S10 a credential write without a capability record is refused';
  END;
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S13 - generation fence, evidence timestamps, unchanged refusal.
--
-- Reproductions from the Task 3a review:
--   * a successful read with JSON null / number / infinity is not proof
--   * a permission result must name the generation from when the read
--     started; after reconnect, replace, or revoke the old result does not
--     write
--   * on one generation, an older grant does not overwrite a newer denial
-- A caught refusal leaves the stored document identical. The savepoint
-- below repeats that for one stale write at transaction-control scope.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  u_a     uuid := 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  acct_a  uuid := 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
  acct_d  uuid := 'c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c5';
  acct_e  uuid := 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c6c6';
  v_bad   jsonb;
  v_err   text;
  v_before jsonb;
  v_after  jsonb;
  v_t1      timestamptz := clock_timestamp() + interval '1 second';
  v_t2      timestamptz := clock_timestamp() + interval '2 seconds';
  v_t3      timestamptz := clock_timestamp() + interval '3 seconds';
  v_t1_text text;
  v_t2_text text;
  v_t3_text text;
BEGIN
  v_t1_text := to_char(v_t1 AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  v_t2_text := to_char(v_t2 AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  v_t3_text := to_char(v_t3 AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');

  -- Invalid success timestamps never create a row. null, number, infinity,
  -- empty: each must be the timestamp error, not some other refusal.
  FOR v_bad IN
    SELECT e.value
      FROM jsonb_array_elements(
             '[null, 1, "infinity", "-infinity", "", "   "]'::jsonb
           ) AS e(value)
  LOOP
    BEGIN
      PERFORM public.write_instagram_account_capability(
        acct_e, u_a,
        jsonb_build_object(
          'login_kind', 'page_linked',
          'permission_read_state', 'ok',
          'expected_credential_generation', 0,
          'granted_scopes', jsonb_build_array('instagram_manage_insights'),
          'scopes_read_at', v_bad));
      RAISE EXCEPTION 'S13 failed: an invalid success timestamp was accepted'
        USING ERRCODE = 'assert_failure';
    EXCEPTION WHEN SQLSTATE 'ICG04' THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    ASSERT v_err LIKE '%scopes_read_at must be a finite ISO-8601 timestamp%',
      format('S13 success timestamp %s is the timestamp error', v_bad);
  END LOOP;

  FOR v_bad IN
    SELECT e.value
      FROM jsonb_array_elements(
             '[null, 1, "infinity", "-infinity", ""]'::jsonb
           ) AS e(value)
  LOOP
    BEGIN
      PERFORM public.write_instagram_account_capability(
        acct_e, u_a,
        jsonb_build_object(
          'login_kind', 'page_linked',
          'permission_read_state', 'failed',
          'expected_credential_generation', 0,
          'read_failed_at', v_bad,
          'read_error_code', 'META_TIMEOUT'));
      RAISE EXCEPTION 'S13 failed: an invalid failure timestamp was accepted'
        USING ERRCODE = 'assert_failure';
    EXCEPTION WHEN SQLSTATE 'ICG04' THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    ASSERT v_err LIKE '%read_failed_at must be a finite ISO-8601 timestamp%',
      format('S13 failure timestamp %s is the timestamp error', v_bad);
  END LOOP;

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_e, u_a,
      '{"login_kind":"page_linked","permission_read_state":"ok","granted_scopes":["instagram_basic"],"scopes_read_at":"2026-10-26T08:00:00Z"}'::jsonb);
    RAISE EXCEPTION 'S13 failed: a create without a generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG03' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err = 'expected_credential_generation is required',
    'S13 creating a state-bearing row requires a generation';

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_e, u_a,
      '{"login_kind":"page_linked","expected_credential_generation":4}'::jsonb);
    RAISE EXCEPTION 'S13 failed: creation at generation 4 was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG03' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err LIKE '%must be 0 when creating%',
    'S13 creation must name generation 0';

  ASSERT (SELECT count(*) FROM public.instagram_account_capabilities
           WHERE social_account_id = acct_e) = 0,
    'S13 refused creates leave no capability row';

  -- Login-kind-only creation may omit the generation. Explicit 0 is the
  -- same control write.
  v_after := public.write_instagram_account_capability(
    acct_d, u_a,
    '{"login_kind":"page_linked","expected_credential_generation":0}'::jsonb);
  ASSERT v_after->>'permission_read_state' = 'unknown',
    'S13 login-kind creation with generation 0 stays unknown';
  ASSERT v_after->>'credential_generation' = '0',
    'S13 login-kind creation is born at generation 0';
  ASSERT v_after->>'scopes_authoritative' = 'false',
    'S13 login-kind creation is not a successful read';

  v_before := public.read_instagram_account_capability(acct_d, u_a);

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_d, u_a, '{"login_kind":"page_linked"}'::jsonb);
    RAISE EXCEPTION 'S13 failed: an existing write without a generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG03' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err = 'expected_credential_generation is required',
    'S13 an existing login-kind write requires a generation';
  ASSERT public.read_instagram_account_capability(acct_d, u_a) = v_before,
    'S13 a missing generation leaves the row unchanged';

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_d, u_a,
      '{"permission_read_state":"ok","expected_credential_generation":"0","granted_scopes":["instagram_basic"],"scopes_read_at":"2026-10-26T08:00:00Z"}'::jsonb);
    RAISE EXCEPTION 'S13 failed: a string generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG03' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err LIKE '%non-negative integer%',
    'S13 a string generation is refused';

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_d, u_a,
      '{"permission_read_state":"ok","expected_credential_generation":null,"granted_scopes":["instagram_basic"],"scopes_read_at":"2026-10-26T08:00:00Z"}'::jsonb);
    RAISE EXCEPTION 'S13 failed: a null generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG03' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_d, u_a,
      '{"permission_read_state":"ok","expected_credential_generation":1.5,"granted_scopes":["instagram_basic"],"scopes_read_at":"2026-10-26T08:00:00Z"}'::jsonb);
    RAISE EXCEPTION 'S13 failed: a fractional generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG03' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_d, u_a,
      '{"permission_read_state":"ok","expected_credential_generation":-1,"granted_scopes":["instagram_basic"],"scopes_read_at":"2026-10-26T08:00:00Z"}'::jsonb);
    RAISE EXCEPTION 'S13 failed: a negative generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG03' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_d, u_a,
      '{"permission_read_state":"ok","expected_credential_generation":2,"granted_scopes":["instagram_manage_insights"],"scopes_read_at":"2026-10-26T08:00:00Z"}'::jsonb);
    RAISE EXCEPTION 'S13 failed: generation 2 was accepted on a new row'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG01' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err LIKE 'stale credential generation%',
    'S13 a mismatched generation is the stale-generation error';
  ASSERT public.read_instagram_account_capability(acct_d, u_a) = v_before,
    'S13 a stale generation leaves the row unchanged';

  -- Same generation: a grant, then a newer successful denial, then an
  -- older grant and an older failure. Neither older result may write.
  v_after := public.write_instagram_account_capability(
    acct_d, u_a,
    '{"permission_read_state":"ok","expected_credential_generation":0,"granted_scopes":["instagram_manage_insights"],"scopes_read_at":"2026-10-26T08:00:00Z"}'::jsonb);
  ASSERT v_after->>'permission_read_state' = 'ok',
    'S13 a generation-0 success is recorded';
  ASSERT v_after->>'scopes_authoritative' = 'true',
    'S13 a generation-0 success is authoritative';
  ASSERT v_after->'granted_scopes' = '["instagram_manage_insights"]'::jsonb,
    'S13 the generation-0 grant is stored';

  v_after := public.write_instagram_account_capability(
    acct_d, u_a,
    '{"permission_read_state":"ok","expected_credential_generation":0,"granted_scopes":[],"scopes_read_at":"2026-10-26T09:00:00Z"}'::jsonb);
  ASSERT v_after->>'scopes_authoritative' = 'true',
    'S13 a newer empty read stays a successful denial';
  ASSERT v_after->'granted_scopes' = '[]'::jsonb,
    'S13 the newer denial stores an empty scope set';
  v_before := v_after;

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_d, u_a,
      '{"permission_read_state":"ok","expected_credential_generation":0,"granted_scopes":["instagram_manage_insights"],"scopes_read_at":"2026-10-01T00:00:00Z"}'::jsonb);
    RAISE EXCEPTION 'S13 failed: an older grant overwrote a newer denial'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG02' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err LIKE '%not newer than the stored read%',
    'S13 an older grant is the stale-evidence error';
  v_after := public.read_instagram_account_capability(acct_d, u_a);
  ASSERT v_after = v_before,
    'S13 an older grant leaves the newer denial unchanged';
  ASSERT v_after->>'scopes_authoritative' = 'true',
    'S13 the newer denial stays authoritative';
  ASSERT v_after->'granted_scopes' = '[]'::jsonb,
    'S13 the older grant does not restore scopes';

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_d, u_a,
      '{"permission_read_state":"ok","expected_credential_generation":0,"granted_scopes":["instagram_basic"],"scopes_read_at":"2026-10-26T09:00:00Z"}'::jsonb);
    RAISE EXCEPTION 'S13 failed: an equal-timestamp grant was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG02' THEN
    NULL;
  END;
  ASSERT public.read_instagram_account_capability(acct_d, u_a) = v_before,
    'S13 an equal evidence timestamp leaves the row unchanged';

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_d, u_a,
      '{"permission_read_state":"failed","expected_credential_generation":0,"read_failed_at":"2026-10-26T08:30:00Z","read_error_code":"META_TIMEOUT"}'::jsonb);
    RAISE EXCEPTION 'S13 failed: an older failure was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG02' THEN
    NULL;
  END;
  ASSERT public.read_instagram_account_capability(acct_d, u_a) = v_before,
    'S13 an older failure does not mark the newer denial';

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_d, u_a,
      '{"permission_read_state":"ok","expected_credential_generation":0,"granted_scopes":["instagram_basic"],"scopes_read_at":"2026-10-26T09:30:00Z","read_failed_at":"2026-10-26T09:30:00Z"}'::jsonb);
    RAISE EXCEPTION 'S13 failed: mixed success and failure fields were accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG04' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err LIKE '%cannot include failure fields%',
    'S13 mixed success and failure fields are refused';
  ASSERT public.read_instagram_account_capability(acct_d, u_a) = v_before,
    'S13 mixed fields leave the row unchanged';

  -- A newer failure records itself and does not downgrade the denial.
  v_after := public.write_instagram_account_capability(
    acct_d, u_a,
    '{"permission_read_state":"failed","expected_credential_generation":0,"read_failed_at":"2026-10-26T10:00:00Z","read_error_code":"META_500"}'::jsonb);
  ASSERT v_after->>'permission_read_state' = 'ok',
    'S13 a newer failure does not downgrade the successful denial';
  ASSERT v_after->'granted_scopes' = '[]'::jsonb,
    'S13 a newer failure keeps the denied scope set';
  ASSERT v_after->>'scopes_authoritative' = 'true',
    'S13 a newer failure keeps the denial authoritative';
  ASSERT v_after->>'last_read_error_code' = 'META_500',
    'S13 a newer failure is recorded';
  v_before := v_after;

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_d, u_a,
      '{"permission_read_state":"ok","expected_credential_generation":0,"granted_scopes":["instagram_manage_insights"],"scopes_read_at":"2026-10-26T09:30:00Z"}'::jsonb);
    RAISE EXCEPTION 'S13 failed: a grant older than the failure was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG02' THEN
    NULL;
  END;
  ASSERT public.read_instagram_account_capability(acct_d, u_a) = v_before,
    'S13 a grant older than the recorded failure leaves the row unchanged';

  -- Review probe: reconnect, then the in-flight success from the previous
  -- generation. Generation becomes 1. The old result must not restore scopes.
  v_after := public.record_instagram_account_reconnect(
    acct_d, u_a,
    '{"login_kind":"direct","reason":"review_reconnect","expected_credential_generation":0}'::jsonb);
  ASSERT v_after->>'credential_generation' = '1',
    'S13 the review reconnect advances generation to 1';
  ASSERT v_after->>'login_kind' = 'direct',
    'S13 the review reconnect stores the new login kind';
  ASSERT v_after->>'permission_read_state' = 'unknown',
    'S13 the review reconnect clears the permission read';
  ASSERT v_after->'granted_scopes' = '[]'::jsonb,
    'S13 the review reconnect clears scopes';
  v_before := v_after;

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_d, u_a,
      '{"permission_read_state":"ok","granted_scopes":["instagram_manage_insights"],"scopes_read_at":"2026-10-01T00:00:00Z"}'::jsonb);
    RAISE EXCEPTION 'S13 failed: the review probe was accepted without a generation'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG03' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err = 'expected_credential_generation is required',
    'S13 the review probe without a generation is refused';
  ASSERT public.read_instagram_account_capability(acct_d, u_a) = v_before,
    'S13 the review probe without a generation writes nothing';

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_d, u_a,
      '{"permission_read_state":"ok","expected_credential_generation":0,"granted_scopes":["instagram_manage_insights"],"scopes_read_at":"2026-10-01T00:00:00Z"}'::jsonb);
    RAISE EXCEPTION 'S13 failed: the pre-reconnect success was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG01' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err LIKE 'stale credential generation%',
    'S13 the pre-reconnect success is a stale generation';
  v_after := public.read_instagram_account_capability(acct_d, u_a);
  ASSERT v_after = v_before,
    'S13 the pre-reconnect success leaves the reconnected row unchanged';
  ASSERT v_after->>'scopes_authoritative' = 'false',
    'S13 a stale success does not become authoritative';
  ASSERT v_after->'granted_scopes' = '[]'::jsonb,
    'S13 a stale success does not restore scopes';
  ASSERT v_after->>'login_kind' = 'direct',
    'S13 a stale success does not undo the new login kind';
  ASSERT v_after->>'credential_generation' = '1',
    'S13 a stale success does not move the generation';

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_d, u_a,
      '{"permission_read_state":"failed","expected_credential_generation":0,"read_failed_at":"2026-10-26T12:00:00Z","read_error_code":"META_TIMEOUT"}'::jsonb);
    RAISE EXCEPTION 'S13 failed: a pre-reconnect failure was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG01' THEN
    NULL;
  END;
  ASSERT public.read_instagram_account_capability(acct_d, u_a) = v_before,
    'S13 a pre-reconnect failure marker writes nothing';

  -- Attaching the NEW generation to a read that started before it is still
  -- stale: the evidence timestamp predates this generation.
  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_d, u_a,
      '{"permission_read_state":"ok","expected_credential_generation":1,"granted_scopes":["instagram_manage_insights"],"scopes_read_at":"2026-10-01T00:00:00Z"}'::jsonb);
    RAISE EXCEPTION 'S13 failed: an old timestamp on the new generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG02' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err LIKE '%predates the current credential generation%',
    'S13 an old read start on the new generation predates that generation';
  ASSERT public.read_instagram_account_capability(acct_d, u_a) = v_before,
    'S13 an old read start on the new generation writes nothing';

  -- A read that actually started on generation 1 is accepted.
  v_after := public.write_instagram_account_capability(
    acct_d, u_a,
    jsonb_build_object(
      'permission_read_state', 'ok',
      'expected_credential_generation', 1,
      'granted_scopes', jsonb_build_array('instagram_basic'),
      'scopes_read_at', v_t1_text));
  ASSERT v_after->>'permission_read_state' = 'ok',
    'S13 a read started on the new generation is recorded';
  ASSERT v_after->>'scopes_authoritative' = 'true',
    'S13 a read started on the new generation is authoritative';
  ASSERT v_after->'granted_scopes' = '["instagram_basic"]'::jsonb,
    'S13 the post-reconnect grant is stored';
  ASSERT v_after->>'credential_generation' = '1',
    'S13 a permission read does not itself advance the generation';

  -- Direct login cannot take a Facebook User credential.
  v_before := public.read_instagram_account_capability(acct_d, u_a);
  BEGIN
    PERFORM public.replace_instagram_account_credential(
      acct_d, u_a,
      '{"credential_kind":"facebook_user","token":"review-token-not-a-secret","expected_credential_generation":1}'::jsonb);
    RAISE EXCEPTION 'S13 failed: a direct-login replacement was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'FUC02' THEN
    NULL;
  END;
  ASSERT public.read_instagram_account_capability(acct_d, u_a) = v_before,
    'S13 a direct-login replacement writes nothing';

  -- The positive replacement is page-linked. Reconnect with the generation
  -- captured above, then restore the grant that replacement must keep.
  v_after := public.record_instagram_account_reconnect(
    acct_d, u_a,
    '{"login_kind":"page_linked","reason":"page_linked_credential","expected_credential_generation":1}'::jsonb);
  ASSERT v_after->>'login_kind' = 'page_linked',
    'S13 the credential replacement account is page-linked';
  ASSERT v_after->>'credential_generation' = '2',
    'S13 the page-linked reconnect advances the generation to 2';
  v_after := public.write_instagram_account_capability(
    acct_d, u_a,
    jsonb_build_object(
      'permission_read_state', 'ok',
      'expected_credential_generation', 2,
      'granted_scopes', jsonb_build_array('instagram_basic'),
      'scopes_read_at', v_t1_text));
  ASSERT v_after->>'credential_generation' = '2',
    'S13 restoring the grant does not advance the generation';

  v_after := public.replace_instagram_account_credential(
    acct_d, u_a,
    '{"credential_kind":"facebook_user","token":"review-token-not-a-secret","expected_credential_generation":2}'::jsonb);
  ASSERT v_after->>'credential_generation' = '3',
    'S13 replacement advances the generation to 3';
  ASSERT v_after->'granted_scopes' = '["instagram_basic"]'::jsonb,
    'S13 replacement keeps the current scope set';
  v_before := v_after;

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_d, u_a,
      jsonb_build_object(
        'permission_read_state', 'ok',
        'expected_credential_generation', 2,
        'granted_scopes', jsonb_build_array('instagram_manage_insights'),
        'scopes_read_at', v_t2_text));
    RAISE EXCEPTION 'S13 failed: a pre-replacement success was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG01' THEN
    NULL;
  END;
  v_after := public.read_instagram_account_capability(acct_d, u_a);
  ASSERT v_after = v_before,
    'S13 a pre-replacement success leaves the row unchanged';
  ASSERT v_after->'granted_scopes' = '["instagram_basic"]'::jsonb,
    'S13 a pre-replacement success does not replace scopes';

  -- Revocation: same fence. The timestamp would otherwise be acceptable.
  v_after := public.revoke_instagram_account_credential(
    acct_d, u_a, 'provider_revoked', 3);
  ASSERT v_after->>'credential_generation' = '4',
    'S13 revocation advances the generation to 4';
  ASSERT v_after->>'has_protected_credential' = 'false',
    'S13 revocation removes the credential';
  ASSERT v_after->'granted_scopes' = '["instagram_basic"]'::jsonb,
    'S13 revocation does not itself clear a successful read';
  v_before := v_after;

  BEGIN
    PERFORM public.write_instagram_account_capability(
      acct_d, u_a,
      jsonb_build_object(
        'permission_read_state', 'ok',
        'expected_credential_generation', 2,
        'granted_scopes', jsonb_build_array('pages_show_list'),
        'scopes_read_at', v_t3_text));
    RAISE EXCEPTION 'S13 failed: a pre-revocation success was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG01' THEN
    NULL;
  END;
  v_after := public.read_instagram_account_capability(acct_d, u_a);
  ASSERT v_after = v_before,
    'S13 a pre-revocation success leaves the row unchanged';
  ASSERT v_after->'granted_scopes' = '["instagram_basic"]'::jsonb,
    'S13 a pre-revocation success does not restore or replace scopes';
  ASSERT v_after->>'has_protected_credential' = 'false',
    'S13 a pre-revocation success does not recreate the credential';
  ASSERT v_after->>'credential_generation' = '4',
    'S13 a pre-revocation success does not move the generation';

  -- Stored ok/failed rows cannot omit or carry a non-finite timestamp,
  -- including a direct service-role update that bypasses the RPC.
  v_before := public.read_instagram_account_capability(acct_a, u_a);
  BEGIN
    UPDATE public.instagram_account_capabilities
       SET permission_read_state = 'ok',
           scopes_read_at = NULL
     WHERE social_account_id = acct_a;
    RAISE EXCEPTION 'S13 failed: ok with a null timestamp was stored'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err LIKE '%instagram_account_capabilities_ok_read_at_chk%',
    'S13 stored ok state requires scopes_read_at';
  ASSERT public.read_instagram_account_capability(acct_a, u_a) = v_before,
    'S13 a rejected ok timestamp update leaves the account unchanged';

  BEGIN
    UPDATE public.instagram_account_capabilities
       SET permission_read_state = 'ok',
           scopes_read_at = 'infinity'
     WHERE social_account_id = acct_a;
    RAISE EXCEPTION 'S13 failed: an infinite success timestamp was stored'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err LIKE '%instagram_account_capabilities_scopes_read_at_finite_chk%',
    'S13 stored success timestamps must be finite';
  ASSERT public.read_instagram_account_capability(acct_a, u_a) = v_before,
    'S13 a rejected infinite timestamp leaves the account unchanged';

  BEGIN
    UPDATE public.instagram_account_capabilities
       SET permission_read_state = 'failed',
           last_read_failed_at = NULL
     WHERE social_account_id = acct_a;
    RAISE EXCEPTION 'S13 failed: failed with a null timestamp was stored'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  ASSERT v_err LIKE '%instagram_account_capabilities_failed_read_at_chk%',
    'S13 stored failed state requires last_read_failed_at';
  ASSERT public.read_instagram_account_capability(acct_a, u_a) = v_before,
    'S13 a rejected failed timestamp update leaves the account unchanged';
END $$;

CREATE TEMP TABLE ig_cap_s13_snapshot (doc jsonb) ON COMMIT DROP;

INSERT INTO ig_cap_s13_snapshot
SELECT public.read_instagram_account_capability(
  'c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c5'::uuid,
  'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'::uuid);

SAVEPOINT ig_cap_stale_read;

DO $$
BEGIN
  BEGIN
    PERFORM public.write_instagram_account_capability(
      'c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c5'::uuid,
      'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'::uuid,
      '{"permission_read_state":"ok","expected_credential_generation":0,"granted_scopes":["instagram_manage_insights"],"scopes_read_at":"2026-10-01T00:00:00Z"}'::jsonb);
    RAISE EXCEPTION 'S13 failed: savepoint stale write was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'ICG01' THEN
    NULL;
  END;
END $$;

ROLLBACK TO SAVEPOINT ig_cap_stale_read;

DO $$
DECLARE
  v_now jsonb;
  v_then jsonb;
BEGIN
  SELECT doc INTO v_then FROM ig_cap_s13_snapshot;
  v_now := public.read_instagram_account_capability(
    'c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c5'::uuid,
    'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'::uuid);
  ASSERT v_now = v_then,
    'S13 rolling back a stale write leaves the stored capability unchanged';
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S12 - the status projection never carries a secret.
--
-- Checked before the cascade, while a credential is actually stored.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  v jsonb;
BEGIN
  -- S9 left this account on direct login. A Facebook User credential
  -- requires page_linked, and the generation captured before the switch.
  v := public.record_instagram_account_reconnect(
    'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'::uuid,
    'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'::uuid,
    '{"login_kind":"page_linked","reason":"projection_credential","expected_credential_generation":8}'::jsonb);
  PERFORM public.replace_instagram_account_credential(
    'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'::uuid,
    'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'::uuid,
    format('{"credential_kind":"facebook_user","token":"super-secret-value","expected_credential_generation":%s}',
           v->>'credential_generation')::jsonb);

  v := public.read_instagram_account_capability(
    'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'::uuid,
    'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'::uuid);
  ASSERT NOT (v ? 'token'),
    'S12 the status projection has no token key';
  ASSERT NOT (v ? 'user_token'),
    'S12 the status projection has no user_token key';
  ASSERT NOT (v ? 'credential'),
    'S12 the status projection has no credential key';
  ASSERT position('super-secret-value' in v::text) = 0,
    'S12 the status projection does not contain the credential value';
  ASSERT v->>'has_protected_credential' = 'true',
    'S12 the status projection reports the credential PRESENCE only';
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- S11 - deleting the social account cascades the capability and the
-- credential away.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  acct_a uuid := 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
BEGIN
  DELETE FROM public.social_accounts WHERE id = acct_a;

  ASSERT (SELECT count(*) FROM public.instagram_account_capabilities
           WHERE social_account_id = acct_a) = 0,
    'S11 deleting the account cascades the capability row away';
  ASSERT (SELECT count(*) FROM public.instagram_account_credentials
           WHERE social_account_id = acct_a) = 0,
    'S11 deleting the account cascades the credential row away';
END $$;

ROLLBACK;
\echo '=== instagram_capabilities: ALL CHECKS PASSED ==='
