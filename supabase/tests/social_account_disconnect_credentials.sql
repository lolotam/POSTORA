-- supabase/tests/social_account_disconnect_credentials.sql
-- Migration 20261105120000.
--
-- One transaction, synthetic fixtures, ROLLBACK. Proves an owner can
-- disconnect a Facebook account that holds a protected credential binding,
-- and that the cascade still removes the binding and the orphaned secret
-- (production 2026-11-05: the delete failed with permission denied).

BEGIN;

DO $$
DECLARE
  u_a uuid := 'd15c0001-0000-4000-8000-000000000001';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES (u_a, 'disconnect-' || u_a::text || '@example.invalid');

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token)
  VALUES
    ('d15c0002-0000-4000-8000-000000000002', u_a, 'facebook', 'page-d', 'page_d', 'page-token-d');
END $$;

SET LOCAL ROLE service_role;

DO $$
DECLARE
  v jsonb;
BEGIN
  v := public.bind_facebook_user_credential('d15c0001-0000-4000-8000-000000000001', jsonb_build_object(
    'expected_absent', true,
    'token', 'synthetic-user-token-d',
    'token_expires_at', '2027-01-01T00:00:00Z',
    'provenance_source', 'oauth_exchange',
    'provenance_captured_at', '2026-11-05T12:00:00Z',
    'social_account_id', 'd15c0002-0000-4000-8000-000000000002',
    'verified_provider_identity', jsonb_build_object('facebook_user_id', 'fb-user-d'),
    'account', jsonb_build_object(
      'access_token', 'page-token-d-replaced',
      'needs_reauth', false,
      'failure_count', 0,
      'last_refresh_error', null,
      'last_refresh_attempt_at', '2026-11-05T12:00:00+0000'
    )
  ));
END $$;

RESET ROLE;

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM public.facebook_user_credential_bindings
     WHERE social_account_id = 'd15c0002-0000-4000-8000-000000000002'
  ), 'D0 the fixture holds a protected binding';
  ASSERT (SELECT prosecdef FROM pg_proc
           WHERE oid = 'public.facebook_user_credential_binding_deleted()'::regprocedure),
    'D0 the binding cleanup trigger runs as its owner';
  ASSERT NOT has_function_privilege('authenticated',
      'public.facebook_user_credential_binding_deleted()', 'EXECUTE'),
    'D0 authenticated cannot execute the cleanup trigger function';
END $$;

-- D1. The owner disconnects the account from the browser path.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"d15c0001-0000-4000-8000-000000000001","role":"authenticated"}', true);

DELETE FROM public.social_accounts
 WHERE id = 'd15c0002-0000-4000-8000-000000000002';

RESET ROLE;

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.social_accounts
     WHERE id = 'd15c0002-0000-4000-8000-000000000002'
  ), 'D1 the owner disconnect removed the account';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.facebook_user_credential_bindings
     WHERE social_account_id = 'd15c0002-0000-4000-8000-000000000002'
  ), 'D1 the binding cascaded away';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.facebook_user_credentials
     WHERE user_id = 'd15c0001-0000-4000-8000-000000000001'
  ), 'D1 the orphaned Facebook User secret was purged';
END $$;

ROLLBACK;
