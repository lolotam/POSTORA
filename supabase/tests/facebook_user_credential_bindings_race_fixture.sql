-- ============================================================================
-- supabase/tests/facebook_user_credential_bindings_race_fixture.sql
--
-- FIXTURE, NOT A SUITE. One connection cannot prove lock order or
-- stale-response serialization. The sequential suite is not that proof.
--
-- The harness refuses any tests/*.sql file that is not named in SUITES,
-- ISOLATED_SUITES, or EXCLUDED_FROM_SUITES. This file matches
-- instagram_tracking_schema_race_fixture.sql: a manual two-session
-- rehearsal, not a suite. scripts/db-harness.sh explicitly classifies it
-- in EXCLUDED_FROM_SUITES; run it separately with real concurrent sessions.
--
-- DISPOSABLE DATABASES ONLY. Prepare COMMITS a synthetic owner. Re-run with
-- -v disposable=1. There is no --cleanup switch; psql does not have one.
--
-- WHAT THIS PREPARES
--
--   One owner, two page-linked Instagram accounts and one Facebook account,
--   all bound to the same Facebook User credential. Capability generations
--   and the Facebook connection version are left at the values the
--   two-session driver reads back before it calls anything.
--
-- LOCK ORDER THE DRIVER MUST EXERCISE
--
--   replace_instagram_account_credential discovers the full bound set and
--   takes facebook_user_credential_lock_scope once, accounts in id order
--   then the credential. The driver calls that function on both Instagram
--   accounts at the same time. It must not take a target-account prefix
--   lock first. That prefix was the old deadlock (40P01) and is not the
--   fixed acquisition.
--
--   A correct rehearsal is: one replace commits, the other raises a typed
--   stale error (ICG01 or FUC01), neither session reports 40P01, and both
--   accounts keep one secret and matching capability generations.
--
--   The core control is the same shape for write_facebook_user_credential
--   and revoke_facebook_user_credential, using the versions captured before
--   either call. Serialized success then a typed stale refusal is enough.
--   A deadlock or a mix of the two tokens is not.
--
-- HOW TO REHEARSE
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 \
--     -f supabase/tests/facebook_user_credential_bindings_race_fixture.sql
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v cleanup=1 \
--     -f supabase/tests/facebook_user_credential_bindings_race_fixture.sql
-- ============================================================================

\if :{?disposable}
\else
\echo 'REFUSING: this fixture commits synthetic rows. Re-run with -v disposable=1 against a throwaway database only.'
\quit 2
\endif

\if :{?cleanup}
BEGIN;
DELETE FROM auth.users WHERE id = 'f1ace001-0000-4000-8000-000000000001';
COMMIT;
\echo '=== facebook_user_credential_bindings race fixture: cleaned synthetic owner ==='
\else
BEGIN;
INSERT INTO auth.users (id, email)
VALUES ('f1ace001-0000-4000-8000-000000000001', 'fuc-race@example.invalid');

INSERT INTO public.social_accounts
  (id, user_id, platform, platform_user_id, platform_username, access_token, ig_auth_type)
VALUES
  ('f1ace011-0000-4000-8000-000000000011', 'f1ace001-0000-4000-8000-000000000001',
   'instagram', 'race-ig-a', 'race_ig_a', 'synthetic-page-a', 'facebook_page'),
  ('f1ace012-0000-4000-8000-000000000012', 'f1ace001-0000-4000-8000-000000000001',
   'instagram', 'race-ig-b', 'race_ig_b', 'synthetic-page-b', 'facebook_page'),
  ('f1ace013-0000-4000-8000-000000000013', 'f1ace001-0000-4000-8000-000000000001',
   'facebook', 'race-fb', 'race_fb', 'synthetic-page-fb', NULL);

SET LOCAL ROLE service_role;
DO $prepare$
DECLARE
  u uuid := 'f1ace001-0000-4000-8000-000000000001';
  a uuid := 'f1ace011-0000-4000-8000-000000000011';
  b uuid := 'f1ace012-0000-4000-8000-000000000012';
  fb uuid := 'f1ace013-0000-4000-8000-000000000013';
  c uuid;
BEGIN
  PERFORM public.write_instagram_account_capability(a, u, '{"login_kind":"page_linked"}'::jsonb);
  PERFORM public.write_instagram_account_capability(b, u, '{"login_kind":"page_linked"}'::jsonb);
  PERFORM public.bind_facebook_user_credential(u, jsonb_build_object(
    'expected_absent', true,
    'token', 'synthetic-race-user',
    'provenance_source', 'oauth_exchange',
    'provenance_captured_at', '2026-10-27T12:00:00Z',
    'social_account_id', fb,
    'verified_provider_identity', jsonb_build_object('facebook_user_id', 'race-user')
  ));
  SELECT credential_id INTO c
    FROM public.facebook_user_credential_bindings
   WHERE social_account_id = fb;
  PERFORM public.bind_facebook_user_credential(u, jsonb_build_object(
    'credential_id', c,
    'expected_revision', 1,
    'social_account_id', a,
    'expected_capability_generation', 0,
    'provenance_source', 'oauth_exchange',
    'verified_provider_identity', jsonb_build_object(
      'facebook_user_id', 'race-user',
      'facebook_page_id', 'race-page-a',
      'instagram_user_id', 'race-ig-a'
    )
  ));
  PERFORM public.bind_facebook_user_credential(u, jsonb_build_object(
    'credential_id', c,
    'expected_revision', 1,
    'social_account_id', b,
    'expected_capability_generation', 0,
    'provenance_source', 'oauth_exchange',
    'verified_provider_identity', jsonb_build_object(
      'facebook_user_id', 'race-user',
      'facebook_page_id', 'race-page-b',
      'instagram_user_id', 'race-ig-b'
    )
  ));
END
$prepare$;
RESET ROLE;
COMMIT;
\echo '=== facebook_user_credential_bindings race fixture: prepared shared credential ==='
\endif
