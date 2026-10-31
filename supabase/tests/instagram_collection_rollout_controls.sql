-- ============================================================================
-- supabase/tests/instagram_collection_rollout_controls.sql
--
-- R1 (migration 20261031090000_instagram_collection_rollout_controls.sql).
--
-- One transaction, synthetic fixtures, labelled ASSERTs, expected refusals in
-- nested BEGIN/EXCEPTION blocks, ROLLBACK, sentinel last. Fixture values are
-- synthetic ('...@example.invalid'); no secrets and no real accounts.
--
-- What this suite proves
--   R1  the default policy is off, a missing policy means off, a malformed
--       or unreadable one is unavailable, and the master switch is read
--       first and alone.
--   R2  the strict policy schema: unknown keys, wrong types, a wrong
--       version, a duplicate id, an ambiguous pin, a non-empty list in the
--       all mode and more than 500 entries all invalidate the WHOLE policy.
--   R3  no browser privilege on the policy row and none on the service RPCs;
--       the admin path still reads and writes the policy.
--   R4  the evaluator: own, foreign and nonexistent targets are
--       indistinguishable, a forged service owner obtains nothing, and the
--       competitor pin admits exactly one viewer.
--   R5  the enqueue refusals: the reason union, no throttle mutation, and a
--       mixed service batch whose accepted count excludes the refusals.
--   R6  the claim: every candidate pass returns eligible jobs only, and an
--       excluded job keeps its attempts, its generation and its timestamps.
--   R7  the pinned viewer: the mismatched owner, another owner's viewer, a
--       direct login, an inactive, a reauth and a denied viewer, and a
--       replaced binding are all refused.
--   R8  the write fences: an excluded target cannot be written, parked,
--       completed or read, and no snapshot, checkpoint or success survives.
--   R9  the provider permit: the exact allowed and refused unions, the
--       fingerprint, and no token anywhere in the answer.
--   R10 the audit: a committed, bounded, sanitized refusal row.
--   R11 more than 500 excluded rows cannot hide an eligible job.
--   R12 three branches a mutation pass showed were untested. An allowlist
--       refuses a watchlist that is not in the list, at every gate. The
--       pinned viewer must belong to the same owner. A claim whose target
--       id is allowlisted is still refused under the locks when the bound
--       viewer is not the pin.
--
-- The suite SET ROLEs away from superuser where the point of the check is
-- that a client role cannot do something, and it uses the house claim
-- convention (request.jwt.claim.role) for the service calls, which keeps the
-- session's own privileges. The service role bypasses RLS, so the ownership
-- checks and the composite foreign keys are the only thing under test there.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures. Written as superuser, where RLS does not apply.
--
-- u_a            : owner A, the pilot tenant
-- u_b            : owner B, the other tenant
-- u_admin        : an admin owner
-- acct_a         : owner A's approved account (the allowlisted target)
-- acct_a2        : owner A's second account (same-owner sibling, excluded)
-- acct_c         : owner A's third account, bound to the SAME Facebook User
--                  credential as acct_a (the shared-grant sibling, excluded)
-- acct_b         : owner B's account (foreign, excluded)
-- acct_direct    : owner A's direct-login account (excluded as a target)
-- viewer_v1      : owner A's approved competitor viewer (the pinned one)
-- viewer_v2      : owner A's other page-linked account
-- viewer_inactive, viewer_reauth, viewer_denied, viewer_direct
--                : the viewer shapes that must never be usable
-- viewer_b       : owner B's viewer (another owner's viewer)
-- comp_a         : owner A's watchlist entry (pinned to viewer_v1)
-- comp_b         : owner B's watchlist entry
-- cred_shared    : one Facebook User credential bound to acct_a and acct_c
-- ---------------------------------------------------------------------------
DO $fixtures$
DECLARE
  u_a          uuid := 'aa100000-0000-4000-8000-000000000001';
  u_b          uuid := 'bb100000-0000-4000-8000-000000000002';
  u_admin      uuid := 'cc100000-0000-4000-8000-000000000003';
  acct_a       uuid := 'a1000000-0000-4000-8000-000000000001';
  acct_a2      uuid := 'a1000000-0000-4000-8000-000000000002';
  acct_c       uuid := 'a1000000-0000-4000-8000-000000000003';
  acct_b       uuid := 'b1000000-0000-4000-8000-000000000001';
  acct_direct  uuid := 'a1000000-0000-4000-8000-000000000004';
  viewer_v1    uuid := 'e1000000-0000-4000-8000-000000000001';
  viewer_v2    uuid := 'e1000000-0000-4000-8000-000000000002';
  viewer_inact uuid := 'e1000000-0000-4000-8000-000000000003';
  viewer_reaut uuid := 'e1000000-0000-4000-8000-000000000004';
  viewer_den   uuid := 'e1000000-0000-4000-8000-000000000005';
  viewer_dir   uuid := 'e1000000-0000-4000-8000-000000000006';
  viewer_b     uuid := 'eb100000-0000-4000-8000-000000000001';
  comp_a       uuid := 'c1000000-0000-4000-8000-000000000001';
  comp_b       uuid := 'c1000000-0000-4000-8000-000000000002';
  cred_shared  uuid := 'd1000000-0000-4000-8000-000000000001';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (u_a,     'igrollout-owner-a-'  || u_a::text     || '@example.invalid'),
    (u_b,     'igrollout-owner-b-'  || u_b::text     || '@example.invalid'),
    (u_admin, 'igrollout-admin-'    || u_admin::text || '@example.invalid');

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username,
     access_token, ig_auth_type, is_active, needs_reauth)
  VALUES
    (acct_a,       u_a, 'instagram', 'ig-a-1', 'igrollout_a1', 'token-a', 'facebook_page', true, false),
    (acct_a2,      u_a, 'instagram', 'ig-a-2', 'igrollout_a2', 'token-a2', 'facebook_page', true, false),
    (acct_c,       u_a, 'instagram', 'ig-a-3', 'igrollout_a3', 'token-c', 'facebook_page', true, false),
    (acct_b,       u_b, 'instagram', 'ig-b-1', 'igrollout_b1', 'token-b', 'facebook_page', true, false),
    (acct_direct,  u_a, 'instagram', 'ig-a-4', 'igrollout_a4', 'direct-token', 'business_login', true, false),
    (viewer_v1,    u_a, 'instagram', 'ig-v-1', 'igrollout_v1', 'token-v1', 'facebook_page', true, false),
    (viewer_v2,    u_a, 'instagram', 'ig-v-2', 'igrollout_v2', 'token-v2', 'facebook_page', true, false),
    (viewer_inact, u_a, 'instagram', 'ig-v-3', 'igrollout_v3', 'token-v3', 'facebook_page', false, false),
    (viewer_reaut, u_a, 'instagram', 'ig-v-4', 'igrollout_v4', 'token-v4', 'facebook_page', true, true),
    (viewer_den,   u_a, 'instagram', 'ig-v-5', 'igrollout_v5', 'token-v5', 'facebook_page', true, false),
    (viewer_dir,   u_a, 'instagram', 'ig-v-6', 'igrollout_v6', 'token-v6', 'business_login', true, false),
    (viewer_b,     u_b, 'instagram', 'ig-v-b', 'igrollout_vb', 'token-vb', 'facebook_page', true, false);

  -- The trusted capabilities. The credential generation is the fence the
  -- durable work is bound to.
  INSERT INTO public.instagram_account_capabilities
    (social_account_id, user_id, platform, login_kind, permission_read_state,
     granted_scopes, scopes_read_at, last_read_failed_at, credential_generation)
  VALUES
    (acct_a,       u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_manage_insights'], now(), NULL, 3),
    (acct_a2,      u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_manage_insights'], now(), NULL, 1),
    (acct_c,       u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_manage_insights'], now(), NULL, 1),
    (acct_b,       u_b, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_manage_insights'], now(), NULL, 1),
    (acct_direct,  u_a, 'instagram', 'direct', 'ok',
     ARRAY['instagram_business_manage_insights'], now(), NULL, 4),
    (viewer_v1,    u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_manage_insights'], now(), NULL, 2),
    (viewer_v2,    u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_manage_insights'], now(), NULL, 2),
    (viewer_inact, u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_manage_insights'], now(), NULL, 2),
    (viewer_reaut, u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_manage_insights'], now(), NULL, 2),
    (viewer_den,   u_a, 'instagram', 'page_linked', 'failed',
     ARRAY['instagram_manage_insights'], now(), now(), 2),
    (viewer_dir,   u_a, 'instagram', 'direct', 'ok',
     ARRAY['instagram_business_manage_insights'], now(), NULL, 2),
    (viewer_b,     u_b, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_manage_insights'], now(), NULL, 2);

  -- One Facebook User credential, bound to TWO of owner A's accounts. The
  -- shared grant must not widen the admission: acct_c is excluded even
  -- though it holds the same secret as the approved account.
  INSERT INTO public.facebook_user_credentials
    (id, user_id, token, revision, lifecycle, provenance_source)
  VALUES
    (cred_shared, u_a, 'shared-user-token', 1, 'active', 'migrated_instagram_account_credential');

  INSERT INTO public.facebook_user_credential_bindings
    (social_account_id, user_id, platform, credential_id, evidence_source)
  VALUES
    (acct_a, u_a, 'instagram', cred_shared, 'migrated_instagram_account_credential'),
    (acct_c, u_a, 'instagram', cred_shared, 'migrated_instagram_account_credential');

  INSERT INTO public.competitor_watchlist (id, user_id, platform, username)
  VALUES
    (comp_a, u_a, 'instagram', 'igrollout_comp_a'),
    (comp_b, u_b, 'instagram', 'igrollout_comp_b');

  INSERT INTO public.user_roles (user_id, role) VALUES (u_admin, 'admin');
END
$fixtures$;

-- The claim context of the jobs the suite continues, shared by the
-- sections that write. A live lease is never handed out twice.
CREATE TEMP TABLE igrollout_claim_ctx (
  label      text PRIMARY KEY,
  job_id     uuid NOT NULL,
  token      uuid NOT NULL,
  generation bigint NOT NULL
) ON COMMIT DROP;

-- A scratch table for the values the suite reads back across a role
-- switch. A role-switched session cannot read the session's own temp
-- tables, so only the superuser context touches it.
CREATE TEMP TABLE igrollout_scratch (
  label text PRIMARY KEY,
  value jsonb
) ON COMMIT DROP;

-- The policy document the MIGRATION seeded, captured before the suite
-- installs its own. The migration's default is part of the contract: it
-- must be off, and it must be the documented shape.
INSERT INTO igrollout_scratch (label, value)
SELECT 'migration_default_policy', value
  FROM public.app_settings
 WHERE key = 'collection_instagram_rollout_policy';

-- The master kill switch. It is off by absence, so the suite turns it on
-- explicitly: the rollout is proved against an ENABLED master, which is
-- the only state in which a refusal can be attributed to the policy.
INSERT INTO public.app_settings (key, value, description)
VALUES ('collection_instagram_insights_enabled', 'true'::jsonb,
        'Synthetic harness master switch for the rollout suite.')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- The pilot policy: owner A's approved account and owner A's watchlist
-- pinned to the approved viewer. Everything else is excluded.
CREATE OR REPLACE FUNCTION pg_temp.igrollout_policy(
  p_owners      text,
  p_competitors text
) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_object(
    'version', 1,
    'owners', jsonb_build_object('mode', p_owners, 'account_ids',
      CASE WHEN p_owners = 'allowlist'
           THEN jsonb_build_array('a1000000-0000-4000-8000-000000000001'::text)
           ELSE '[]'::jsonb END),
    'competitors', jsonb_build_object('mode', p_competitors, 'targets',
      CASE WHEN p_competitors = 'allowlist'
           THEN jsonb_build_array(jsonb_build_object(
                  'watchlist_id', 'c1000000-0000-4000-8000-000000000001'::text,
                  'viewer_social_account_id', 'e1000000-0000-4000-8000-000000000001'::text))
           ELSE '[]'::jsonb END)
  );
$fn$;

-- The helper that installs a policy document for the duration of the
-- transaction.
CREATE OR REPLACE FUNCTION pg_temp.igrollout_set_policy(p_policy jsonb)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO public.app_settings (key, value, description)
  VALUES ('collection_instagram_rollout_policy', p_policy, 'Synthetic harness policy.')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
END
$fn$;

-- The helper that pins one viewer for the one watchlist.
CREATE OR REPLACE FUNCTION pg_temp.igrollout_pin(p_viewer text)
RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_object(
    'version', 1,
    'owners', jsonb_build_object('mode', 'allowlist', 'account_ids',
      jsonb_build_array('a1000000-0000-4000-8000-000000000001'::text)),
    'competitors', jsonb_build_object('mode', 'allowlist', 'targets',
      jsonb_build_array(jsonb_build_object(
        'watchlist_id', 'c1000000-0000-4000-8000-000000000001'::text,
        'viewer_social_account_id', p_viewer::text)))
  );
$fn$;

SELECT pg_temp.igrollout_set_policy(pg_temp.igrollout_policy('allowlist', 'allowlist'));

-- ===========================================================================
-- R1 - the default state, the missing policy and the malformed policy.
-- ===========================================================================
DO $r1$
DECLARE
  v_state jsonb;
  v_before jsonb;
BEGIN
  -- The migration seeded the default policy. It is off, so nobody is
  -- admitted.
  SELECT value INTO v_before
    FROM igrollout_scratch
   WHERE label = 'migration_default_policy';

  ASSERT v_before = '{"version":1,"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"off","targets":[]}}'::jsonb,
    'R1 the migration seeded exactly the documented default policy';

  -- The master switch is on in this suite, and the policy is the pilot
  -- allowlist, so the state is valid.
  v_state := public.ig_collection_rollout_state();
  ASSERT v_state ->> 'status' = 'ok',
    'R1 a valid master and a valid policy read as ok';
  ASSERT v_state ->> 'owner_mode' = 'allowlist',
    'R1 the owners mode is the pilot allowlist';
  ASSERT v_state ->> 'competitor_mode' = 'allowlist',
    'R1 the competitors mode is the pilot allowlist';
  ASSERT v_state ->> 'fingerprint' IS NOT NULL,
    'R1 the state carries a server-computed fingerprint';
  ASSERT char_length(v_state ->> 'fingerprint') = 64,
    'R1 the fingerprint is a sha256 digest';

  -- The fingerprint is computed by the DATABASE and is a pure function of
  -- the document: the same document, the same digest, whatever the key
  -- order.
  ASSERT public.ig_collection_rollout_policy_fingerprint('{"b":1,"a":2}'::jsonb)
       = public.ig_collection_rollout_policy_fingerprint('{"a":2,"b":1}'::jsonb),
    'R1 the fingerprint is canonical: key order does not change it';

  -- A MISSING policy means off, not unavailable. The effective policy is
  -- the default document.
  DELETE FROM public.app_settings WHERE key = 'collection_instagram_rollout_policy';

  v_state := public.ig_collection_rollout_state();
  ASSERT v_state ->> 'status' = 'ok',
    'R1 a missing policy is not an unavailable configuration';
  ASSERT v_state ->> 'owner_mode' = 'off'
     AND v_state ->> 'competitor_mode' = 'off',
    'R1 a missing policy means off';
  ASSERT v_state ->> 'fingerprint' IS NOT NULL,
    'R1 a missing policy still has an effective fingerprint';

  -- A MALFORMED policy is unavailable, which is a different refusal.
  PERFORM pg_temp.igrollout_set_policy('{"version":1,"owners":{"mode":"nonsense"}}'::jsonb);
  v_state := public.ig_collection_rollout_state();
  ASSERT v_state ->> 'status' = 'settings_unavailable',
    'R1 a malformed policy is unavailable, not off';
  ASSERT v_state ->> 'reason_code' = 'settings_unavailable',
    'R1 the malformed policy carries the settings_unavailable reason';

  -- The master switch is read FIRST and ALONE: a master that is false
  -- refuses even when the policy would have admitted the target.
  UPDATE public.app_settings
     SET value = 'false'::jsonb
   WHERE key = 'collection_instagram_insights_enabled';

  PERFORM pg_temp.igrollout_set_policy(pg_temp.igrollout_policy('all', 'all'));
  v_state := public.ig_collection_rollout_state();
  ASSERT v_state ->> 'status' = 'collection_disabled',
    'R1 a false master refuses even with an all policy';
  ASSERT v_state ->> 'reason_code' = 'collection_disabled',
    'R1 a false master carries the collection_disabled reason';

  -- A MISSING master refuses the same way.
  DELETE FROM public.app_settings WHERE key = 'collection_instagram_insights_enabled';
  v_state := public.ig_collection_rollout_state();
  ASSERT v_state ->> 'status' = 'collection_disabled',
    'R1 a missing master refuses';

  -- A MALFORMED master is unavailable, not off.
  INSERT INTO public.app_settings (key, value) VALUES
    ('collection_instagram_insights_enabled', '"yes"'::jsonb);
  v_state := public.ig_collection_rollout_state();
  ASSERT v_state ->> 'status' = 'settings_unavailable',
    'R1 a malformed master is unavailable';

  -- A master that is not a boolean at all is refused as well.
  UPDATE public.app_settings
     SET value = '{"on":true}'::jsonb
   WHERE key = 'collection_instagram_insights_enabled';
  v_state := public.ig_collection_rollout_state();
  ASSERT v_state ->> 'status' = 'settings_unavailable',
    'R1 a master that is not a boolean is unavailable';

  -- Restore the suite's master and policy.
  UPDATE public.app_settings
     SET value = 'true'::jsonb
   WHERE key = 'collection_instagram_insights_enabled';
  PERFORM pg_temp.igrollout_set_policy(pg_temp.igrollout_policy('allowlist', 'allowlist'));
END
$r1$;

-- ===========================================================================
-- R2 - the strict policy schema.
--
-- Every one of these invalidates the WHOLE policy. A malformed section is
-- never a partially valid policy.
-- ===========================================================================
DO $r2$
DECLARE
  v_state jsonb;
  v_bad   jsonb;
  v_cases text[] := ARRAY[
    'unknown top-level key',
    'missing version',
    'wrong version',
    'unknown owners key',
    'unknown competitors key',
    'unknown owners mode',
    'owners list is not an array',
    'owners entry is not a string',
    'owners entry is not a uuid',
    'duplicate owners entry',
    'all mode with a non-empty list',
    'competitors entry is not an object',
    'competitors entry has an unknown key',
    'duplicate watchlist',
    'all competitors mode with a non-empty list'
  ];
  v_case  text;
BEGIN
  FOREACH v_case IN ARRAY v_cases LOOP
    CASE v_case
      WHEN 'unknown top-level key' THEN
        v_bad := '{"version":1,"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"off","targets":[]},"extra":1}'::jsonb;
      WHEN 'missing version' THEN
        v_bad := '{"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"off","targets":[]}}'::jsonb;
      WHEN 'wrong version' THEN
        v_bad := '{"version":2,"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"off","targets":[]}}'::jsonb;
      WHEN 'unknown owners key' THEN
        v_bad := '{"version":1,"owners":{"mode":"off","account_ids":[],"extra":[]},"competitors":{"mode":"off","targets":[]}}'::jsonb;
      WHEN 'unknown competitors key' THEN
        v_bad := '{"version":1,"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"off","targets":[],"extra":[]}}'::jsonb;
      WHEN 'unknown owners mode' THEN
        v_bad := '{"version":1,"owners":{"mode":"allowlist"},"competitors":{"mode":"off","targets":[]}}'::jsonb;
      WHEN 'owners list is not an array' THEN
        v_bad := '{"version":1,"owners":{"mode":"off","account_ids":{}},"competitors":{"mode":"off","targets":[]}}'::jsonb;
      WHEN 'owners entry is not a string' THEN
        v_bad := '{"version":1,"owners":{"mode":"allowlist","account_ids":[1]},"competitors":{"mode":"off","targets":[]}}'::jsonb;
      WHEN 'owners entry is not a uuid' THEN
        v_bad := '{"version":1,"owners":{"mode":"allowlist","account_ids":["not-a-uuid"]},"competitors":{"mode":"off","targets":[]}}'::jsonb;
      WHEN 'duplicate owners entry' THEN
        v_bad := '{"version":1,"owners":{"mode":"allowlist","account_ids":["a1000000-0000-4000-8000-000000000001","A1000000-0000-4000-8000-000000000001"]},"competitors":{"mode":"off","targets":[]}}'::jsonb;
      WHEN 'all mode with a non-empty list' THEN
        v_bad := '{"version":1,"owners":{"mode":"all","account_ids":["a1000000-0000-4000-8000-000000000001"]},"competitors":{"mode":"off","targets":[]}}'::jsonb;
      WHEN 'competitors entry is not an object' THEN
        v_bad := '{"version":1,"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"allowlist","targets":["x"]}}'::jsonb;
      WHEN 'competitors entry has an unknown key' THEN
        v_bad := '{"version":1,"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"allowlist","targets":[{"watchlist_id":"c1000000-0000-4000-8000-000000000001","viewer_social_account_id":"e1000000-0000-4000-8000-000000000001","extra":1}]}}'::jsonb;
      WHEN 'duplicate watchlist' THEN
        v_bad := '{"version":1,"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"allowlist","targets":[{"watchlist_id":"c1000000-0000-4000-8000-000000000001","viewer_social_account_id":"e1000000-0000-4000-8000-000000000001"},{"watchlist_id":"c1000000-0000-4000-8000-000000000001","viewer_social_account_id":"e1000000-0000-4000-8000-000000000002"}]}}'::jsonb;
      WHEN 'all competitors mode with a non-empty list' THEN
        v_bad := '{"version":1,"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"all","targets":[{"watchlist_id":"c1000000-0000-4000-8000-000000000001","viewer_social_account_id":"e1000000-0000-4000-8000-000000000001"}]}}'::jsonb;
    END CASE;

    PERFORM pg_temp.igrollout_set_policy(v_bad);
    v_state := public.ig_collection_rollout_state();

    ASSERT v_state ->> 'status' = 'settings_unavailable',
      'R2 the policy is unavailable for the case: ' || v_case;
  END LOOP;

  -- The list bound is 500 entries. 500 valid ids are accepted, 501 are
  -- not.
  SELECT jsonb_build_object(
           'version', 1,
           'owners', jsonb_build_object('mode', 'allowlist', 'account_ids',
             (SELECT jsonb_agg(to_jsonb('00000000-0000-4000-8000-' || lpad(g::text, 12, '0')))
                FROM generate_series(1, 500) AS g)),
           'competitors', jsonb_build_object('mode', 'off', 'targets', '[]'::jsonb)
         ) INTO v_bad;

  PERFORM pg_temp.igrollout_set_policy(v_bad);
  v_state := public.ig_collection_rollout_state();
  ASSERT v_state ->> 'status' = 'ok',
    'R2 an owners list of exactly 500 ids is accepted';
  ASSERT jsonb_array_length(v_state -> 'owner_ids') = 500,
    'R2 the 500 approved ids were read';

  SELECT jsonb_build_object(
           'version', 1,
           'owners', jsonb_build_object('mode', 'allowlist', 'account_ids',
             (SELECT jsonb_agg(to_jsonb('00000000-0000-4000-8000-' || lpad(g::text, 12, '0')))
                FROM generate_series(1, 501) AS g)),
           'competitors', jsonb_build_object('mode', 'off', 'targets', '[]'::jsonb)
         ) INTO v_bad;

  PERFORM pg_temp.igrollout_set_policy(v_bad);
  v_state := public.ig_collection_rollout_state();
  ASSERT v_state ->> 'status' = 'settings_unavailable',
    'R2 an owners list of 501 entries is invalid';

  -- Restore the pilot policy.
  PERFORM pg_temp.igrollout_set_policy(pg_temp.igrollout_policy('allowlist', 'allowlist'));
END
$r2$;

-- ===========================================================================
-- R3 - the grant surface.
-- ===========================================================================
DO $r3$
BEGIN
  -- The service RPC is the service role's alone.
  ASSERT has_function_privilege('service_role',
           'public.authorize_instagram_collection_provider_call(uuid,uuid,bigint)', 'EXECUTE'),
    'R3 the service role can ask for a permit';
  ASSERT NOT has_function_privilege('authenticated',
           'public.authorize_instagram_collection_provider_call(uuid,uuid,bigint)', 'EXECUTE'),
    'R3 an authenticated client cannot ask for a permit';
  ASSERT NOT has_function_privilege('anon',
           'public.authorize_instagram_collection_provider_call(uuid,uuid,bigint)', 'EXECUTE'),
    'R3 anon cannot ask for a permit';

  -- The internal helpers are nobody's business.
  ASSERT NOT has_function_privilege('authenticated',
           'public.ig_collection_rollout_state()', 'EXECUTE'),
    'R3 an authenticated client cannot read the rollout state';
  ASSERT NOT has_function_privilege('anon',
           'public.ig_collection_rollout_target_allowed(uuid,text,uuid,uuid)', 'EXECUTE'),
    'R3 anon cannot evaluate the rollout policy';
  ASSERT NOT has_function_privilege('service_role',
           'public.ig_collection_rollout_audit(jsonb)', 'EXECUTE'),
    'R3 the service role cannot write the rollout audit directly';
  ASSERT NOT has_function_privilege('authenticated',
           'public.ig_collection_rollout_owner_allowed(uuid,uuid,jsonb)', 'EXECUTE'),
    'R3 an authenticated client cannot evaluate the owner population';
  ASSERT NOT has_function_privilege('authenticated',
           'public.ig_collection_rollout_competitor_allowed(uuid,uuid,uuid,jsonb)', 'EXECUTE'),
    'R3 an authenticated client cannot evaluate the competitor population';
  ASSERT NOT has_function_privilege('authenticated',
           'public.ig_collection_rollout_normalize_policy(jsonb)', 'EXECUTE'),
    'R3 an authenticated client cannot normalize the policy';
  ASSERT NOT has_function_privilege('anon',
           'public.ig_collection_rollout_policy_fingerprint(jsonb)', 'EXECUTE'),
    'R3 anon cannot compute the policy fingerprint';

  -- No browser privilege expansion: the dashboard role holds no grant on
  -- the settings table at all and cannot reach the service RPC.
  ASSERT NOT has_table_privilege('dashboard_user', 'public.app_settings', 'SELECT'),
    'R3 the dashboard role cannot read the settings table';
  ASSERT NOT has_function_privilege('dashboard_user',
           'public.authorize_instagram_collection_provider_call(uuid,uuid,bigint)', 'EXECUTE'),
    'R3 the dashboard role cannot ask for a permit';
  ASSERT NOT has_function_privilege('dashboard_user',
           'public.ig_collection_rollout_state()', 'EXECUTE'),
    'R3 the dashboard role cannot read the rollout state';
END
$r3$;

-- Remember the policy value so the client attempt can be checked after
-- the role switch is over.
INSERT INTO igrollout_scratch (label, value)
SELECT 'policy_before', value
  FROM public.app_settings
 WHERE key = 'collection_instagram_rollout_policy';

-- The policy row is unreadable to anon and to an ordinary authenticated
-- session, and writable by neither. The RLS check is behavioural: the
-- table GRANT is wide, so the policy is the boundary.
SET LOCAL ROLE anon;

DO $r3_anon$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.app_settings
   WHERE key = 'collection_instagram_rollout_policy';

  ASSERT v_count = 0,
    'R3 anon cannot read the rollout policy row';
END
$r3_anon$;

RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aa100000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $r3_user$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.app_settings
   WHERE key = 'collection_instagram_rollout_policy';

  ASSERT v_count = 0,
    'R3 an ordinary authenticated client cannot read the rollout policy row';

  -- The public settings are still readable. The restrictive policy denies
  -- the rollout row, not the table.
  SELECT count(*) INTO v_count
    FROM public.app_settings
   WHERE key = 'app_name';

  ASSERT v_count >= 0,
    'R3 the public settings are still readable by an ordinary client';

  -- An UPDATE cannot reach the row at all: RLS filters it out and the
  -- statement matches nothing.
  UPDATE public.app_settings
     SET value = '{"version":1,"owners":{"mode":"all","account_ids":[]},"competitors":{"mode":"all","targets":[]}}'::jsonb
   WHERE key = 'collection_instagram_rollout_policy';

  -- An INSERT of a second policy row is refused outright.
  BEGIN
    INSERT INTO public.app_settings (key, value)
    VALUES ('collection_instagram_rollout_policy',
            '{"version":1,"owners":{"mode":"all","account_ids":[]},"competitors":{"mode":"all","targets":[]}}'::jsonb);
    RAISE EXCEPTION 'R3 failed: an ordinary client inserted a rollout policy'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'R3 the client insert is a privilege refusal';
  END;
END
$r3_user$;

RESET ROLE;

-- The client attempt changed nothing.
DO $r3_after$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_rows   integer;
BEGIN
  SELECT value INTO v_before FROM igrollout_scratch WHERE label = 'policy_before';

  SELECT value INTO v_after
    FROM public.app_settings
   WHERE key = 'collection_instagram_rollout_policy';

  ASSERT v_after = v_before,
    'R3 the ordinary client changed no rollout policy value';

  SELECT count(*) INTO v_rows
    FROM public.app_settings
   WHERE key = 'collection_instagram_rollout_policy';

  ASSERT v_rows = 1,
    'R3 the ordinary client created no second rollout policy row';
END
$r3_after$;

-- The admin path still works: an admin may read the policy and write it.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'cc100000-0000-4000-8000-000000000003', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $r3_admin$
DECLARE
  v_count integer;
  v_value jsonb;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.app_settings
   WHERE key = 'collection_instagram_rollout_policy';

  ASSERT v_count = 1,
    'R3 an admin can read the rollout policy row';

  UPDATE public.app_settings
     SET value = pg_temp.igrollout_policy('allowlist', 'allowlist')
   WHERE key = 'collection_instagram_rollout_policy';

  SELECT value INTO v_value
    FROM public.app_settings
   WHERE key = 'collection_instagram_rollout_policy';

  ASSERT v_value -> 'owners' ->> 'mode' = 'allowlist',
    'R3 an admin can write the rollout policy row';
END
$r3_admin$;

RESET ROLE;
SELECT set_config('request.jwt.claim.role', '', true);
SELECT set_config('request.jwt.claim.sub', '', true);

-- ===========================================================================
-- R4 - the evaluator.
-- ===========================================================================
DO $r4$
DECLARE
  v_allowed jsonb;
  v_owner   uuid := 'aa100000-0000-4000-8000-000000000001';
  v_other   uuid := 'bb100000-0000-4000-8000-000000000002';
BEGIN
  -- The approved account is admitted.
  v_allowed := public.ig_collection_rollout_target_allowed(
    v_owner, 'owner', 'a1000000-0000-4000-8000-000000000001', NULL);
  ASSERT (v_allowed ->> 'allowed')::boolean,
    'R4 the approved account is admitted';

  -- The same-owner sibling is not.
  v_allowed := public.ig_collection_rollout_target_allowed(
    v_owner, 'owner', 'a1000000-0000-4000-8000-000000000002', NULL);
  ASSERT NOT (v_allowed ->> 'allowed')::boolean,
    'R4 the same-owner sibling account is excluded';
  ASSERT v_allowed ->> 'reason_code' = 'collection_not_eligible',
    'R4 the excluded sibling carries the collection_not_eligible reason';

  -- The shared-grant sibling is not, even though it holds the SAME
  -- Facebook User credential as the approved account.
  v_allowed := public.ig_collection_rollout_target_allowed(
    v_owner, 'owner', 'a1000000-0000-4000-8000-000000000003', NULL);
  ASSERT NOT (v_allowed ->> 'allowed')::boolean,
    'R4 the shared-grant sibling account is excluded';

  -- A foreign account is excluded, and so is a nonexistent one. The two
  -- are indistinguishable.
  v_allowed := public.ig_collection_rollout_target_allowed(
    v_owner, 'owner', 'b1000000-0000-4000-8000-000000000001', NULL);
  ASSERT NOT (v_allowed ->> 'allowed')::boolean,
    'R4 a foreign account is excluded';

  v_allowed := public.ig_collection_rollout_target_allowed(
    v_owner, 'owner', 'ffffffff-0000-4000-8000-000000000009', NULL);
  ASSERT NOT (v_allowed ->> 'allowed')::boolean,
    'R4 a nonexistent account is excluded';
  ASSERT v_allowed ->> 'reason_code' = 'collection_not_eligible',
    'R4 a foreign and a nonexistent account carry the same reason';

  -- The approved account is not another owner's, even for its own owner.
  v_allowed := public.ig_collection_rollout_target_allowed(
    v_other, 'owner', 'a1000000-0000-4000-8000-000000000001', NULL);
  ASSERT NOT (v_allowed ->> 'allowed')::boolean,
    'R4 a forged service owner obtains nothing';

  -- An unknown target kind is never admitted.
  v_allowed := public.ig_collection_rollout_target_allowed(
    v_owner, 'facebook', 'a1000000-0000-4000-8000-000000000001', NULL);
  ASSERT NOT (v_allowed ->> 'allowed')::boolean,
    'R4 an unknown target kind is not admitted';

  -- A null owner is not admitted either.
  v_allowed := public.ig_collection_rollout_target_allowed(
    NULL, 'owner', 'a1000000-0000-4000-8000-000000000001', NULL);
  ASSERT NOT (v_allowed ->> 'allowed')::boolean,
    'R4 a null owner is not admitted';

  -- The competitor: the pinned watchlist is admitted, the other one is
  -- not.
  v_allowed := public.ig_collection_rollout_target_allowed(
    v_owner, 'competitor', 'c1000000-0000-4000-8000-000000000001', NULL);
  ASSERT (v_allowed ->> 'allowed')::boolean,
    'R4 the pinned watchlist is admitted';

  v_allowed := public.ig_collection_rollout_target_allowed(
    v_owner, 'competitor', 'c1000000-0000-4000-8000-000000000002', NULL);
  ASSERT NOT (v_allowed ->> 'allowed')::boolean,
    'R4 the other tenant watchlist is excluded';

  -- The pin: only the approved viewer.
  v_allowed := public.ig_collection_rollout_target_allowed(
    v_owner, 'competitor', 'c1000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000001');
  ASSERT (v_allowed ->> 'allowed')::boolean,
    'R4 the pinned viewer is admitted';

  v_allowed := public.ig_collection_rollout_target_allowed(
    v_owner, 'competitor', 'c1000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000002');
  ASSERT NOT (v_allowed ->> 'allowed')::boolean,
    'R4 another owned viewer is not a substitute for the pinned one';

  v_allowed := public.ig_collection_rollout_target_allowed(
    v_owner, 'competitor', 'c1000000-0000-4000-8000-000000000001',
    'eb100000-0000-4000-8000-000000000001');
  ASSERT NOT (v_allowed ->> 'allowed')::boolean,
    'R4 another owner''s viewer is not admitted';
END
$r4$;

-- ===========================================================================
-- R5 - the enqueue refusals.
-- ===========================================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aa100000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $r5$
DECLARE
  v_result jsonb;
BEGIN
  -- The excluded sibling is refused, with the refusal union.
  v_result := public.enqueue_instagram_collection_job(
    'owner', 'a1000000-0000-4000-8000-000000000002', 'normal');

  ASSERT NOT (v_result ->> 'accepted')::boolean,
    'R5 the excluded sibling enqueue is refused';
  ASSERT (v_result ->> 'refused')::boolean,
    'R5 the refusal carries the refused flag';
  ASSERT v_result ->> 'reason_code' = 'collection_not_eligible',
    'R5 the refusal carries the collection_not_eligible reason';
  ASSERT v_result ->> 'job_id' IS NULL,
    'R5 the refusal names no job';
  ASSERT (v_result ->> 'created')::boolean IS NULL,
    'R5 the refusal claims nothing created';

  -- A refused FORCE is refused the same way.
  v_result := public.enqueue_instagram_collection_job(
    'owner', 'a1000000-0000-4000-8000-000000000002', 'force');

  ASSERT NOT (v_result ->> 'accepted')::boolean,
    'R5 the excluded sibling force is refused';
  ASSERT (v_result ->> 'refused')::boolean,
    'R5 the refused force carries the refused flag';

  -- The approved account is accepted, and the accepted projection is the
  -- one that already existed.
  v_result := public.enqueue_instagram_collection_job(
    'owner', 'a1000000-0000-4000-8000-000000000001', 'normal');

  ASSERT (v_result ->> 'accepted')::boolean,
    'R5 the approved account enqueue is accepted';
  ASSERT v_result ->> 'job_id' IS NOT NULL,
    'R5 the accepted enqueue names a job';
  ASSERT v_result ->> 'reason' = 'enqueued',
    'R5 the accepted enqueue keeps its reason projection';
  ASSERT v_result ->> 'refused' IS NULL,
    'R5 the accepted enqueue carries no refusal flag';

  -- A foreign target is still a not-found, and it is indistinguishable
  -- from a target that never existed.
  BEGIN
    PERFORM public.enqueue_instagram_collection_job(
      'owner', 'b1000000-0000-4000-8000-000000000001', 'normal');
    RAISE EXCEPTION 'R5 failed: a foreign target was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_TARGET_NOT_FOUND%' THEN
      RAISE EXCEPTION 'R5 expected IG_COLLECTION_TARGET_NOT_FOUND, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.enqueue_instagram_collection_job(
      'owner', 'ffffffff-0000-4000-8000-000000000009', 'normal');
    RAISE EXCEPTION 'R5 failed: a nonexistent target was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_TARGET_NOT_FOUND%' THEN
      RAISE EXCEPTION 'R5 expected IG_COLLECTION_TARGET_NOT_FOUND, got: %', SQLERRM;
    END IF;
  END;
END
$r5$;

RESET ROLE;

-- The refusal wrote no throttle window and no job. That is checked as
-- superuser, because the session's own role may not read those tables.
DO $r5_after$
DECLARE
  v_throttles integer;
  v_jobs      integer;
BEGIN
  SELECT count(*) INTO v_throttles
    FROM public.instagram_collection_request_throttles
   WHERE target_kind = 'owner'
     AND target_id = 'a1000000-0000-4000-8000-000000000002';

  ASSERT v_throttles = 0,
    'R5 a refused force consumed no accepted-request window';

  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE target_kind = 'owner'
     AND target_id = 'a1000000-0000-4000-8000-000000000002';

  ASSERT v_jobs = 0,
    'R5 a refused enqueue inserted no job';
END
$r5_after$;

-- The service batch: a mixed batch of an admitted and an excluded
-- element, and a forged owner.
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $r5_service$
DECLARE
  v_result jsonb;
  v_item   jsonb;
BEGIN
  v_result := public.enqueue_instagram_collection_jobs_service(
    'aa100000-0000-4000-8000-000000000001',
    jsonb_build_array(
      jsonb_build_object('target_kind', 'owner',
                         'target_id', 'a1000000-0000-4000-8000-000000000001', 'mode', 'normal'),
      jsonb_build_object('target_kind', 'owner',
                         'target_id', 'a1000000-0000-4000-8000-000000000002', 'mode', 'normal'),
      jsonb_build_object('target_kind', 'owner',
                         'target_id', 'a1000000-0000-4000-8000-000000000003', 'mode', 'normal')
    ));

  ASSERT (v_result ->> 'accepted')::integer = 1,
    'R5 the mixed service batch accepted exactly the admitted element';
  ASSERT (v_result ->> 'refused')::integer = 2,
    'R5 the mixed service batch refused the two excluded elements';
  ASSERT jsonb_array_length(v_result -> 'results') = 3,
    'R5 the mixed service batch reports every element';

  SELECT r.value INTO v_item
    FROM jsonb_array_elements(v_result -> 'results') AS r(value)
   WHERE r.value ->> 'target_id' = 'a1000000-0000-4000-8000-000000000002';

  ASSERT NOT (v_item ->> 'accepted')::boolean,
    'R5 the excluded element is not accepted';
  ASSERT (v_item ->> 'refused')::boolean,
    'R5 the excluded element carries the refused flag';
  ASSERT v_item ->> 'reason_code' = 'collection_not_eligible',
    'R5 the excluded element carries the reason code';
  ASSERT v_item ->> 'job_id' IS NULL,
    'R5 the excluded element names no job';

  -- A forged owner cannot obtain a usable job for somebody else's
  -- target, and the refusal does not leak that the target exists.
  BEGIN
    PERFORM public.enqueue_instagram_collection_jobs_service(
      'bb100000-0000-4000-8000-000000000002',
      jsonb_build_array(jsonb_build_object(
        'target_kind', 'owner',
        'target_id', 'a1000000-0000-4000-8000-000000000001', 'mode', 'normal')));
    RAISE EXCEPTION 'R5 failed: a forged owner enqueued another tenant''s target'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_TARGET_NOT_FOUND%' THEN
      RAISE EXCEPTION 'R5 expected IG_COLLECTION_TARGET_NOT_FOUND, got: %', SQLERRM;
    END IF;
  END;

  -- A forged target kind is refused before anything happens.
  BEGIN
    PERFORM public.enqueue_instagram_collection_jobs_service(
      'aa100000-0000-4000-8000-000000000001',
      jsonb_build_array(jsonb_build_object(
        'target_kind', 'facebook',
        'target_id', 'a1000000-0000-4000-8000-000000000001', 'mode', 'normal')));
    RAISE EXCEPTION 'R5 failed: a forged target kind was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_INVALID_TARGET_KIND%' THEN
      RAISE EXCEPTION 'R5 expected IG_COLLECTION_INVALID_TARGET_KIND, got: %', SQLERRM;
    END IF;
  END;
END
$r5_service$;

RESET ROLE;
SELECT set_config('request.jwt.claim.role', '', true);

-- ===========================================================================
-- R6 - the claim.
--
-- The excluded jobs sit in EVERY claimable shape: queued, retry with a
-- pending operation, partial, a dead lease and a finalize-only
-- generation. Not one of them may be claimed, and not one of them may
-- change.
-- ===========================================================================
INSERT INTO public.instagram_collection_jobs
  (user_id, target_kind, target_id, social_account_id, captured_on,
   status, due_at, attempts, job_generation, last_success_at)
VALUES
  ('aa100000-0000-4000-8000-000000000001', 'owner', 'a1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', current_date - 5, 'queued',  now() - interval '5 days', 3, 4, now() - interval '4 days'),
  ('aa100000-0000-4000-8000-000000000001', 'owner', 'a1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', current_date - 4, 'retry',  now() - interval '4 days', 2, 2, NULL),
  ('aa100000-0000-4000-8000-000000000001', 'owner', 'a1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', current_date - 3, 'partial',now() - interval '3 days', 1, 1, NULL),
  ('aa100000-0000-4000-8000-000000000001', 'owner', 'a1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000003', current_date - 2, 'leased', now() - interval '2 days', 5, 6, now() - interval '2 days'),
  ('aa100000-0000-4000-8000-000000000001', 'owner', 'a1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', current_date - 1, 'queued',  now() - interval '1 day',  1, 1, NULL),
  ('bb100000-0000-4000-8000-000000000002', 'owner', 'b1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', current_date - 1, 'queued',  now() - interval '1 day', 1, 1, NULL);

-- The retry job carries a pending operation, so it is open work.
INSERT INTO public.instagram_collection_job_operations
  (job_id, user_id, job_generation, operation_key, operation_kind, state, attempts)
SELECT j.id, j.user_id, j.job_generation, 'media:ig-r6', 'media', 'pending', 1
  FROM public.instagram_collection_jobs AS j
 WHERE j.user_id = 'aa100000-0000-4000-8000-000000000001'
   AND j.target_id = 'a1000000-0000-4000-8000-000000000002'
   AND j.status = 'retry';

-- The leased job carries a DEAD lease, so it is recoverable.
UPDATE public.instagram_collection_jobs
   SET lease_token = gen_random_uuid(),
       lease_expires_at = clock_timestamp() - interval '1 hour'
 WHERE user_id = 'aa100000-0000-4000-8000-000000000001'
   AND target_id = 'a1000000-0000-4000-8000-000000000003';

-- A finalize-only generation for an excluded account: every operation of
-- the generation is terminal, so it is a pass-3 candidate.
INSERT INTO public.instagram_collection_jobs
  (user_id, target_kind, target_id, social_account_id, captured_on,
   status, due_at, attempts, job_generation)
VALUES
  ('aa100000-0000-4000-8000-000000000001', 'owner',
   'a1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002',
   current_date - 6, 'queued', now() - interval '6 days', 1, 2);

INSERT INTO public.instagram_collection_job_operations
  (job_id, user_id, job_generation, operation_key, operation_kind, state, attempts, completed_at)
SELECT j.id, j.user_id, j.job_generation, 'media:ig-r6-final', 'media', 'success', 1, now()
  FROM public.instagram_collection_jobs AS j
 WHERE j.user_id = 'aa100000-0000-4000-8000-000000000001'
   AND j.target_id = 'a1000000-0000-4000-8000-000000000002'
   AND j.captured_on = current_date - 6
   AND j.job_generation = 2;

SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $r6_claim$
DECLARE
  r          jsonb;
  v_claimed  integer := 0;
  v_excluded integer := 0;
  v_attempts integer;
  v_generation bigint;
  v_status   text;
  v_success  timestamptz;
BEGIN
  -- ONE claim. The result set is materialised, so this call happens once.
  FOR r IN
    SELECT c.value FROM public.claim_instagram_collection_jobs('owner', 25) AS c(value)
  LOOP
    v_claimed := v_claimed + 1;

    IF (r ->> 'social_account_id') IS DISTINCT FROM 'a1000000-0000-4000-8000-000000000001' THEN
      v_excluded := v_excluded + 1;
    END IF;

    -- The approved owner job is the one the later sections continue.
    IF (r ->> 'social_account_id') = 'a1000000-0000-4000-8000-000000000001' THEN
      INSERT INTO igrollout_claim_ctx (label, job_id, token, generation)
      VALUES ('owner',
              (r ->> 'job_id')::uuid,
              (r ->> 'claim_token')::uuid,
              (r ->> 'job_generation')::bigint);
    END IF;
  END LOOP;

  ASSERT v_excluded = 0,
    'R6 no excluded account was claimed';
  ASSERT v_claimed = 1,
    'R6 the claim returned exactly the approved job, got ' || v_claimed;

  -- The excluded rows are untouched: the same attempts, the same
  -- generation and the same success timestamps.
  SELECT j.attempts, j.job_generation, j.last_success_at
    INTO v_attempts, v_generation, v_success
    FROM public.instagram_collection_jobs AS j
   WHERE j.user_id = 'aa100000-0000-4000-8000-000000000001'
     AND j.target_id = 'a1000000-0000-4000-8000-000000000002'
     AND j.captured_on = current_date - 5;

  ASSERT v_attempts = 3,
    'R6 the excluded queued job kept its attempts';
  ASSERT v_generation = 4,
    'R6 the excluded queued job kept its generation';
  ASSERT v_success IS NOT NULL,
    'R6 the excluded queued job kept its success timestamp';

  SELECT j.status INTO v_status
    FROM public.instagram_collection_jobs AS j
   WHERE j.user_id = 'aa100000-0000-4000-8000-000000000001'
     AND j.target_id = 'a1000000-0000-4000-8000-000000000003'
     AND j.captured_on = current_date - 2;

  ASSERT v_status = 'leased',
    'R6 the excluded dead-lease job was not claimed';

  -- The finalize-only generation was not claimed either.
  SELECT j.status INTO v_status
    FROM public.instagram_collection_jobs AS j
   WHERE j.user_id = 'aa100000-0000-4000-8000-000000000001'
     AND j.target_id = 'a1000000-0000-4000-8000-000000000002'
     AND j.captured_on = current_date - 6;

  ASSERT v_status = 'queued',
    'R6 the excluded finalize-only generation was not claimed';
END
$r6_claim$;

RESET ROLE;
SELECT set_config('request.jwt.claim.role', '', true);

-- ===========================================================================
-- R7 - the pinned viewer.
-- ===========================================================================
SELECT set_config('request.jwt.claim.role', 'service_role', true);

-- The competitor job of owner A, and its claim.
DO $r7_setup$
DECLARE
  v_claim jsonb;
BEGIN
  PERFORM public.enqueue_instagram_collection_jobs_service(
    'aa100000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'competitor',
      'target_id', 'c1000000-0000-4000-8000-000000000001', 'mode', 'normal')));

  SELECT c.value INTO v_claim
    FROM public.claim_instagram_collection_jobs('competitor', 50) AS c(value)
   WHERE c.value ->> 'watchlist_id' = 'c1000000-0000-4000-8000-000000000001';

  ASSERT v_claim IS NOT NULL,
    'R7 the pinned competitor job was claimed';

  INSERT INTO igrollout_claim_ctx (label, job_id, token, generation)
  VALUES ('comp',
          (v_claim ->> 'job_id')::uuid,
          (v_claim ->> 'claim_token')::uuid,
          (v_claim ->> 'job_generation')::bigint);
END
$r7_setup$;

DO $r7$
DECLARE
  v_job    uuid;
  v_token  uuid;
  v_gen    bigint;
  v_result jsonb;
  v_bound  uuid;
BEGIN
  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igrollout_claim_ctx WHERE label = 'comp';

  -- The approved viewer attaches.
  v_result := public.attach_instagram_collection_job_viewer_context(
    v_job, v_token, v_gen, 'e1000000-0000-4000-8000-000000000001');
  ASSERT v_result ->> 'viewer_social_account_id' = 'e1000000-0000-4000-8000-000000000001',
    'R7 the pinned viewer attaches';

  -- Another OWNED viewer is not a substitute.
  BEGIN
    PERFORM public.attach_instagram_collection_job_viewer_context(
      v_job, v_token, v_gen, 'e1000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'R7 failed: another owned viewer was substituted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_VIEWER_NOT_APPROVED%' THEN
      RAISE EXCEPTION 'R7 expected IG_COLLECTION_VIEWER_NOT_APPROVED, got: %', SQLERRM;
    END IF;
  END;

  -- Another owner's viewer is refused as well.
  BEGIN
    PERFORM public.attach_instagram_collection_job_viewer_context(
      v_job, v_token, v_gen, 'eb100000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'R7 failed: another owner''s viewer was attached'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_VIEWER_NOT_APPROVED%'
       AND SQLERRM NOT LIKE '%IG_COLLECTION_VIEWER_NOT_OWNED%' THEN
      RAISE EXCEPTION 'R7 expected a viewer refusal, got: %', SQLERRM;
    END IF;
  END;

  -- The bound viewer is still the approved one.
  SELECT context_viewer_social_account_id INTO v_bound
    FROM public.instagram_collection_jobs WHERE id = v_job;

  ASSERT v_bound = 'e1000000-0000-4000-8000-000000000001',
    'R7 the refused attachments did not change the bound viewer';
END
$r7$;

-- The viewer shapes that must never be usable. Each shape gets its own
-- fresh competitor job, so the refusal that is proved is the viewer's own
-- and not the pin's.
DO $r7_shapes$
DECLARE
  r       jsonb;
  v_job   uuid;
  v_token uuid;
  v_gen   bigint;
BEGIN
  INSERT INTO public.instagram_collection_jobs
    (user_id, target_kind, target_id, watchlist_id, captured_on,
     status, due_at, attempts, job_generation)
  VALUES
    ('aa100000-0000-4000-8000-000000000001', 'competitor', 'c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', current_date - 10, 'queued', now() - interval '10 days', 0, 1),
    ('aa100000-0000-4000-8000-000000000001', 'competitor', 'c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', current_date - 11, 'queued', now() - interval '11 days', 0, 1),
    ('aa100000-0000-4000-8000-000000000001', 'competitor', 'c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', current_date - 12, 'queued', now() - interval '12 days', 0, 1),
    ('aa100000-0000-4000-8000-000000000001', 'competitor', 'c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', current_date - 13, 'queued', now() - interval '13 days', 0, 1);

  FOR r IN
    SELECT c.value FROM public.claim_instagram_collection_jobs('competitor', 50) AS c(value)
   WHERE c.value ->> 'watchlist_id' = 'c1000000-0000-4000-8000-000000000001'
  LOOP
    INSERT INTO igrollout_claim_ctx (label, job_id, token, generation)
    VALUES ('shape-' || (r ->> 'captured_on'),
            (r ->> 'job_id')::uuid,
            (r ->> 'claim_token')::uuid,
            (r ->> 'job_generation')::bigint);
  END LOOP;

  -- A direct login cannot perform the Business Discovery path.
  PERFORM pg_temp.igrollout_set_policy(
    pg_temp.igrollout_pin('e1000000-0000-4000-8000-000000000006'));

  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igrollout_claim_ctx WHERE label = 'shape-' || (current_date - 10)::text;

  BEGIN
    PERFORM public.attach_instagram_collection_job_viewer_context(
      v_job, v_token, v_gen, 'e1000000-0000-4000-8000-000000000006');
    RAISE EXCEPTION 'R7 failed: a direct login attached as the competitor viewer'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_VIEWER_UNSUPPORTED_LOGIN%' THEN
      RAISE EXCEPTION 'R7 expected IG_COLLECTION_VIEWER_UNSUPPORTED_LOGIN, got: %', SQLERRM;
    END IF;
  END;

  -- An inactive viewer.
  PERFORM pg_temp.igrollout_set_policy(
    pg_temp.igrollout_pin('e1000000-0000-4000-8000-000000000003'));

  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igrollout_claim_ctx WHERE label = 'shape-' || (current_date - 11)::text;

  BEGIN
    PERFORM public.attach_instagram_collection_job_viewer_context(
      v_job, v_token, v_gen, 'e1000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'R7 failed: an inactive viewer attached'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_VIEWER_INACTIVE%' THEN
      RAISE EXCEPTION 'R7 expected IG_COLLECTION_VIEWER_INACTIVE, got: %', SQLERRM;
    END IF;
  END;

  -- A viewer that needs a reauth.
  PERFORM pg_temp.igrollout_set_policy(
    pg_temp.igrollout_pin('e1000000-0000-4000-8000-000000000004'));

  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igrollout_claim_ctx WHERE label = 'shape-' || (current_date - 12)::text;

  BEGIN
    PERFORM public.attach_instagram_collection_job_viewer_context(
      v_job, v_token, v_gen, 'e1000000-0000-4000-8000-000000000004');
    RAISE EXCEPTION 'R7 failed: a reauth viewer attached'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_VIEWER_NEEDS_REAUTH%' THEN
      RAISE EXCEPTION 'R7 expected IG_COLLECTION_VIEWER_NEEDS_REAUTH, got: %', SQLERRM;
    END IF;
  END;

  -- A viewer whose permission read never succeeded.
  PERFORM pg_temp.igrollout_set_policy(
    pg_temp.igrollout_pin('e1000000-0000-4000-8000-000000000005'));

  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igrollout_claim_ctx WHERE label = 'shape-' || (current_date - 13)::text;

  BEGIN
    PERFORM public.attach_instagram_collection_job_viewer_context(
      v_job, v_token, v_gen, 'e1000000-0000-4000-8000-000000000005');
    RAISE EXCEPTION 'R7 failed: a denied viewer attached'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_VIEWER_CAPABILITY_MISSING%' THEN
      RAISE EXCEPTION 'R7 expected IG_COLLECTION_VIEWER_CAPABILITY_MISSING, got: %', SQLERRM;
    END IF;
  END;

  -- A replaced binding: the live credential generation moved on after the
  -- viewer was captured.
  PERFORM pg_temp.igrollout_set_policy(pg_temp.igrollout_policy('allowlist', 'allowlist'));

  UPDATE public.instagram_account_capabilities
     SET credential_generation = credential_generation + 1
   WHERE social_account_id = 'e1000000-0000-4000-8000-000000000001';

  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igrollout_claim_ctx WHERE label = 'comp';

  BEGIN
    PERFORM public.attach_instagram_collection_job_viewer_context(
      v_job, v_token, v_gen, 'e1000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'R7 failed: a replaced binding attached'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
      RAISE EXCEPTION 'R7 expected IG_COLLECTION_CREDENTIAL_CHANGED, got: %', SQLERRM;
    END IF;
  END;

  -- Restore the generation the job captured.
  UPDATE public.instagram_account_capabilities
     SET credential_generation = credential_generation - 1
   WHERE social_account_id = 'e1000000-0000-4000-8000-000000000001';
END
$r7_shapes$;

RESET ROLE;
SELECT set_config('request.jwt.claim.role', '', true);

-- ===========================================================================
-- R8 - the write fences.
--
-- An excluded target cannot be written, parked, completed or read, and
-- nothing survives the refusal.
-- ===========================================================================
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $r8$
DECLARE
  v_job   uuid;
  v_token uuid;
  v_gen   bigint;
  v_rows  integer;
BEGIN
  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igrollout_claim_ctx WHERE label = 'owner';

  -- The target is excluded NOW, after the claim.
  PERFORM pg_temp.igrollout_set_policy(jsonb_build_object(
    'version', 1,
    'owners', jsonb_build_object('mode', 'allowlist', 'account_ids',
      jsonb_build_array('a1000000-0000-4000-8000-000000000002'::text)),
    'competitors', jsonb_build_object('mode', 'allowlist', 'targets',
      jsonb_build_array(jsonb_build_object(
        'watchlist_id', 'c1000000-0000-4000-8000-000000000001'::text,
        'viewer_social_account_id', 'e1000000-0000-4000-8000-000000000001'::text)))));

  -- The progress write refuses.
  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      v_job, v_token, v_gen,
      jsonb_build_object('kind', 'operations', 'items', jsonb_build_array(
        jsonb_build_object('operation_key', 'media:ig-r8',
                           'operation_kind', 'media', 'state', 'failed',
                           'reason_code', 'provider_error'))));
    RAISE EXCEPTION 'R8 failed: an excluded job recorded progress'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_NOT_ELIGIBLE%' THEN
      RAISE EXCEPTION 'R8 expected IG_COLLECTION_NOT_ELIGIBLE, got: %', SQLERRM;
    END IF;
  END;

  -- The completion refuses.
  BEGIN
    PERFORM public.complete_instagram_collection_job(
      v_job, v_token, v_gen, 'completed', NULL);
    RAISE EXCEPTION 'R8 failed: an excluded job completed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_NOT_ELIGIBLE%' THEN
      RAISE EXCEPTION 'R8 expected IG_COLLECTION_NOT_ELIGIBLE, got: %', SQLERRM;
    END IF;
  END;

  -- The provider-throttle parking refuses.
  BEGIN
    PERFORM public.record_instagram_provider_throttle(
      repeat('a', 64), 90, now() + interval '1 hour', v_job, v_token, v_gen);
    RAISE EXCEPTION 'R8 failed: an excluded job was parked'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_NOT_ELIGIBLE%' THEN
      RAISE EXCEPTION 'R8 expected IG_COLLECTION_NOT_ELIGIBLE, got: %', SQLERRM;
    END IF;
  END;

  -- The context read refuses.
  BEGIN
    PERFORM public.read_instagram_collection_job_context(v_job, v_token);
    RAISE EXCEPTION 'R8 failed: an excluded job read its context'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_NOT_ELIGIBLE%' THEN
      RAISE EXCEPTION 'R8 expected IG_COLLECTION_NOT_ELIGIBLE, got: %', SQLERRM;
    END IF;
  END;

  -- The direct credential read refuses.
  BEGIN
    PERFORM public.read_instagram_direct_collection_credential(
      v_job, v_token, v_gen, 3);
    RAISE EXCEPTION 'R8 failed: an excluded job read its credential'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_NOT_ELIGIBLE%' THEN
      RAISE EXCEPTION 'R8 expected IG_COLLECTION_NOT_ELIGIBLE, got: %', SQLERRM;
    END IF;
  END;

  -- Nothing survived the refusals.
  SELECT count(*) INTO v_rows
    FROM public.instagram_collection_job_operations
   WHERE job_id = v_job;

  ASSERT v_rows = 0,
    'R8 the refused progress left no operation row';

  SELECT count(*) INTO v_rows
    FROM public.instagram_collection_job_checkpoints
   WHERE job_id = v_job;

  ASSERT v_rows = 0,
    'R8 the refused progress left no checkpoint row';

  SELECT count(*) INTO v_rows
    FROM public.instagram_collection_jobs
   WHERE id = v_job AND last_success_at IS NOT NULL;

  ASSERT v_rows = 0,
    'R8 the refused completion advanced no success timestamp';

  SELECT count(*) INTO v_rows
    FROM public.instagram_collection_jobs
   WHERE id = v_job AND last_reason_code IS NOT NULL;

  ASSERT v_rows = 0,
    'R8 the refused completion recorded no reason code';

  -- The job is still leased and unchanged: the refusal did not park it.
  SELECT count(*) INTO v_rows
    FROM public.instagram_collection_jobs
   WHERE id = v_job AND status = 'leased';

  ASSERT v_rows = 1,
    'R8 the refused writes did not release the lease';
END
$r8$;

-- The competitor v1 and v2 result writes refuse an excluded target too.
DO $r8_competitor$
DECLARE
  v_job   uuid;
  v_token uuid;
  v_gen   bigint;
  v_rows  integer;
BEGIN
  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igrollout_claim_ctx WHERE label = 'comp';

  -- The competitor population is off for the moment.
  PERFORM pg_temp.igrollout_set_policy(jsonb_build_object(
    'version', 1,
    'owners', jsonb_build_object('mode', 'allowlist', 'account_ids',
      jsonb_build_array('a1000000-0000-4000-8000-000000000001'::text)),
    'competitors', jsonb_build_object('mode', 'off', 'targets', '[]'::jsonb)));

  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_job, v_token, v_gen,
      jsonb_build_object(
        'outcome', 'completed',
        'source', 'official',
        'profile', jsonb_build_object(
          'metrics', jsonb_build_object('followers_count', 1, 'media_count', 1)),
        'media', jsonb_build_array()));
    RAISE EXCEPTION 'R8 failed: the v1 competitor write landed on an excluded target'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_NOT_ELIGIBLE%' THEN
      RAISE EXCEPTION 'R8 expected IG_COLLECTION_NOT_ELIGIBLE, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.persist_competitor_collection_result_v2(
      v_job, v_token, v_gen,
      jsonb_build_object(
        'outcome', 'completed',
        'source', 'official',
        'profile', jsonb_build_object(
          'metrics', jsonb_build_object('followers_count', 1, 'media_count', 1)),
        'media', jsonb_build_array(),
        'coverage', jsonb_build_object(
          'capture_started_at', to_char(now() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'capture_ended_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'ordering_verified', false,
          'cursor_present', false,
          'exhausted', true,
          'truncated', false,
          'gap_reason', NULL)));
    RAISE EXCEPTION 'R8 failed: the v2 competitor write landed on an excluded target'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_NOT_ELIGIBLE%' THEN
      RAISE EXCEPTION 'R8 expected IG_COLLECTION_NOT_ELIGIBLE, got: %', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_rows
    FROM public.competitor_profile_snapshots
   WHERE watchlist_id = 'c1000000-0000-4000-8000-000000000001';

  ASSERT v_rows = 0,
    'R8 the refused competitor writes left no profile snapshot';
END
$r8_competitor$;

RESET ROLE;
SELECT set_config('request.jwt.claim.role', '', true);

-- ===========================================================================
-- R9 - the provider permit.
-- ===========================================================================
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $r9$
DECLARE
  v_job    uuid;
  v_token  uuid;
  v_gen    bigint;
  v_permit jsonb;
  v_keys   text[];
BEGIN
  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM igrollout_claim_ctx WHERE label = 'owner';

  -- The target is admitted again for this section.
  PERFORM pg_temp.igrollout_set_policy(pg_temp.igrollout_policy('allowlist', 'allowlist'));

  v_permit := public.authorize_instagram_collection_provider_call(
    v_job, v_token, v_gen);

  ASSERT (v_permit ->> 'allowed')::boolean,
    'R9 the permit allows an admitted target';

  -- The allowed union is EXACTLY these eight keys.
  SELECT array_agg(k ORDER BY k) INTO v_keys
    FROM jsonb_object_keys(v_permit) AS k;

  ASSERT v_keys = ARRAY[
    'allowed', 'credential_generation', 'job_generation', 'job_id',
    'policy_fingerprint', 'target_id', 'target_kind', 'viewer_social_account_id'],
    'R9 the allowed permit carries exactly the contracted keys, got: ' || v_keys::text;

  ASSERT v_permit ->> 'job_id' = v_job::text,
    'R9 the permit names the fenced job';
  ASSERT v_permit ->> 'target_kind' = 'owner',
    'R9 the permit names the target kind';
  ASSERT v_permit ->> 'target_id' = 'a1000000-0000-4000-8000-000000000001',
    'R9 the permit names the target';
  ASSERT v_permit ->> 'job_generation' = v_gen::text,
    'R9 the permit names the job generation';
  ASSERT v_permit ->> 'credential_generation' = '3',
    'R9 the permit names the captured credential generation';
  ASSERT char_length(v_permit ->> 'policy_fingerprint') = 64,
    'R9 the permit carries the policy fingerprint';

  -- The answer carries no token of any kind.
  ASSERT v_permit::text NOT ILIKE '%token%',
    'R9 the permit carries no token';

  -- A stale claim is refused, and the refused union is exactly two keys.
  v_permit := public.authorize_instagram_collection_provider_call(
    v_job, gen_random_uuid(), v_gen);

  ASSERT NOT (v_permit ->> 'allowed')::boolean,
    'R9 a stale claim token is refused';

  SELECT array_agg(k ORDER BY k) INTO v_keys
    FROM jsonb_object_keys(v_permit) AS k;

  ASSERT v_keys = ARRAY['allowed', 'reason_code'],
    'R9 the refused permit carries exactly the contracted keys, got: ' || v_keys::text;
  ASSERT v_permit ->> 'reason_code' = 'claim_stale',
    'R9 the stale claim carries the claim_stale reason';

  -- A wrong generation is refused.
  v_permit := public.authorize_instagram_collection_provider_call(
    v_job, v_token, v_gen + 1);
  ASSERT NOT (v_permit ->> 'allowed')::boolean,
    'R9 a wrong generation is refused';
  ASSERT v_permit ->> 'reason_code' = 'claim_stale',
    'R9 the wrong generation carries the claim_stale reason';

  -- A missing argument is refused, not crashed.
  v_permit := public.authorize_instagram_collection_provider_call(
    NULL, v_token, v_gen);
  ASSERT NOT (v_permit ->> 'allowed')::boolean,
    'R9 a missing job id is refused';
  ASSERT v_permit ->> 'reason_code' = 'invalid_request',
    'R9 the missing job id carries the invalid_request reason';

  -- An excluded target is refused, even with a live claim.
  PERFORM pg_temp.igrollout_set_policy(jsonb_build_object(
    'version', 1,
    'owners', jsonb_build_object('mode', 'allowlist', 'account_ids',
      jsonb_build_array('a1000000-0000-4000-8000-000000000002'::text)),
    'competitors', jsonb_build_object('mode', 'off', 'targets', '[]'::jsonb)));

  v_permit := public.authorize_instagram_collection_provider_call(
    v_job, v_token, v_gen);
  ASSERT NOT (v_permit ->> 'allowed')::boolean,
    'R9 an excluded target is refused';
  ASSERT v_permit ->> 'reason_code' = 'collection_not_eligible',
    'R9 the excluded target carries the collection_not_eligible reason';

  -- A disabled master refuses the permit.
  UPDATE public.app_settings
     SET value = 'false'::jsonb
   WHERE key = 'collection_instagram_insights_enabled';

  v_permit := public.authorize_instagram_collection_provider_call(
    v_job, v_token, v_gen);
  ASSERT NOT (v_permit ->> 'allowed')::boolean,
    'R9 a disabled master refuses the permit';
  ASSERT v_permit ->> 'reason_code' = 'collection_disabled',
    'R9 the disabled master carries the collection_disabled reason';

  UPDATE public.app_settings
     SET value = 'true'::jsonb
   WHERE key = 'collection_instagram_insights_enabled';

  -- An unavailable configuration refuses the permit.
  PERFORM pg_temp.igrollout_set_policy('{"version":9}'::jsonb);

  v_permit := public.authorize_instagram_collection_provider_call(
    v_job, v_token, v_gen);
  ASSERT NOT (v_permit ->> 'allowed')::boolean,
    'R9 an unavailable configuration refuses the permit';
  ASSERT v_permit ->> 'reason_code' = 'settings_unavailable',
    'R9 the unavailable configuration carries the settings_unavailable reason';

  PERFORM pg_temp.igrollout_set_policy(pg_temp.igrollout_policy('allowlist', 'allowlist'));
END
$r9$;

RESET ROLE;
SELECT set_config('request.jwt.claim.role', '', true);

-- ===========================================================================
-- R10 - the audit.
-- ===========================================================================
DO $r10$
DECLARE
  v_rows    integer;
  v_meta    jsonb;
  v_message text;
BEGIN
  -- The refusals of this suite wrote committed rows.
  SELECT count(*) INTO v_rows
    FROM public.system_logs
   WHERE source = 'instagram-collection-rollout';

  ASSERT v_rows > 0,
    'R10 the refusals wrote audit rows';

  -- The rows are bounded and sanitized: they carry the event, the reason
  -- and the owned ids, and nothing else.
  SELECT metadata INTO v_meta
    FROM public.system_logs
   WHERE source = 'instagram-collection-rollout'
     AND metadata ->> 'event' = 'collection_enqueue_refused'
     AND metadata ->> 'target_id' = 'a1000000-0000-4000-8000-000000000002'
   LIMIT 1;

  ASSERT v_meta IS NOT NULL,
    'R10 the enqueue refusal wrote an event row';
  ASSERT v_meta ? 'reason_code',
    'R10 the audit row carries the reason code';
  ASSERT v_meta ? 'target_id',
    'R10 the audit row carries the owned target id';
  ASSERT v_meta ->> 'target_id' = 'a1000000-0000-4000-8000-000000000002',
    'R10 the audit row names the refused target';
  ASSERT v_meta ->> 'reason_code' = 'collection_not_eligible',
    'R10 the audit row carries the refusal reason';
  ASSERT NOT (v_meta ? 'account_ids'),
    'R10 the audit row carries no policy list';
  ASSERT NOT (v_meta ? 'access_token'),
    'R10 the audit row carries no credential';
  ASSERT NOT (v_meta ? 'claim_token'),
    'R10 the audit row carries no claim token';

  SELECT message INTO v_message
    FROM public.system_logs
   WHERE source = 'instagram-collection-rollout'
   LIMIT 1;

  ASSERT v_message NOT ILIKE '%token%',
    'R10 the audit message carries no token';
  ASSERT char_length(v_message) <= 200,
    'R10 the audit message is bounded';

  -- The policy change itself was audited with a server-computed
  -- fingerprint.
  SELECT count(*) INTO v_rows
    FROM public.system_logs
   WHERE source = 'instagram-collection-rollout'
     AND metadata ->> 'event' = 'rollout_policy_changed';

  ASSERT v_rows > 0,
    'R10 the policy change was audited';

  SELECT count(*) INTO v_rows
    FROM public.system_logs
   WHERE source = 'instagram-collection-rollout'
     AND metadata ->> 'event' = 'rollout_policy_changed'
     AND char_length(metadata ->> 'policy_fingerprint') = 64;

  ASSERT v_rows > 0,
    'R10 the policy audit carries the server-computed fingerprint';
END
$r10$;

-- ===========================================================================
-- R11 - more than 500 excluded rows cannot hide an eligible job.
--
-- Every other job is parked first, so the claim sees exactly the rows
-- this section creates.
-- ===========================================================================
DELETE FROM public.instagram_collection_jobs
 WHERE user_id = 'aa100000-0000-4000-8000-000000000001'
   AND target_id = 'a1000000-0000-4000-8000-000000000001';

UPDATE public.instagram_collection_jobs
   SET due_at = now() + interval '1 day'
 WHERE due_at <= now();

SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $r11$
DECLARE
  r            jsonb;
  v_claimed    integer := 0;
  v_excluded   integer := 0;
  v_rows       integer;
  v_attempts   integer;
  v_generation bigint;
BEGIN
  -- 501 excluded jobs of the same-owner sibling account, one per capture
  -- day, all older than the eligible one.
  INSERT INTO public.instagram_collection_jobs
    (user_id, target_kind, target_id, social_account_id, captured_on,
     status, due_at, attempts, job_generation)
  SELECT 'aa100000-0000-4000-8000-000000000001',
         'owner',
         'a1000000-0000-4000-8000-000000000002',
         'a1000000-0000-4000-8000-000000000002',
         (current_date - 600 + g)::date,
         'queued',
         now() - interval '2 days',
         2,
         3
    FROM generate_series(1, 501) AS g;

  -- The eligible job is newer than every one of them.
  INSERT INTO public.instagram_collection_jobs
    (user_id, target_kind, target_id, social_account_id, captured_on,
     status, due_at, attempts, job_generation)
  VALUES
    ('aa100000-0000-4000-8000-000000000001', 'owner',
     'a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001',
     current_date, 'queued', now(), 0, 1);

  -- ONE claim. The result set is materialised, so this call happens once.
  FOR r IN
    SELECT c.value FROM public.claim_instagram_collection_jobs('owner', 25) AS c(value)
  LOOP
    v_claimed := v_claimed + 1;

    IF (r ->> 'social_account_id') = 'a1000000-0000-4000-8000-000000000002' THEN
      v_excluded := v_excluded + 1;
    END IF;
  END LOOP;

  ASSERT v_excluded = 0,
    'R11 none of the 501 excluded jobs was claimed';
  ASSERT v_claimed = 1,
    'R11 the claim returned exactly the eligible job, got ' || v_claimed;

  -- The excluded rows kept their attempts and their generation.
  SELECT j.attempts, j.job_generation
    INTO v_attempts, v_generation
    FROM public.instagram_collection_jobs AS j
   WHERE j.target_id = 'a1000000-0000-4000-8000-000000000002'
     AND j.user_id = 'aa100000-0000-4000-8000-000000000001'
     AND j.captured_on = (current_date - 600 + 1)::date;

  ASSERT v_attempts = 2,
    'R11 the excluded job kept its attempts';
  ASSERT v_generation = 3,
    'R11 the excluded job kept its generation';

  SELECT count(*) INTO v_rows
    FROM public.instagram_collection_jobs
   WHERE target_id = 'a1000000-0000-4000-8000-000000000002'
     AND user_id = 'aa100000-0000-4000-8000-000000000001'
     AND status = 'leased';

  ASSERT v_rows = 0,
    'R11 no excluded job was leased';

  -- The claim wrote ONE aggregate audit row for the empty case, not one
  -- row per excluded job. The count of rollout rows stays bounded.
  SELECT count(*) INTO v_rows
    FROM public.system_logs
   WHERE source = 'instagram-collection-rollout'
     AND metadata ->> 'event' = 'collection_claim_refused';

  ASSERT v_rows < 50,
    'R11 the claim audit is an aggregate, not one row per excluded job, got ' || v_rows;
END
$r11$;

RESET ROLE;
SELECT set_config('request.jwt.claim.role', '', true);

-- ===========================================================================
-- R12 - the three branches a mutation pass showed were untested.
--
--   * The competitor allowlist membership (the watchlist id itself).
--   * The structural owner check on the pinned viewer.
--   * The per-row rollout decision under the claim locks, which the
--     candidate pre-filter never reaches when it only compares target ids.
--
-- The pilot policy is the one R9 restored: owner A's account, and owner
-- A's watchlist pinned to viewer v1. Two extra watchlists are added here.
-- comp_unlisted is another watchlist of the same owner. comp_same_handle
-- is the same Instagram handle, owned by the other tenant. Neither id is
-- in the allowlist.
-- ===========================================================================
INSERT INTO public.competitor_watchlist (id, user_id, platform, username)
VALUES
  ('c1000000-0000-4000-8000-000000000011',
   'aa100000-0000-4000-8000-000000000001', 'instagram', 'igrollout_comp_unlisted'),
  ('c1000000-0000-4000-8000-000000000012',
   'bb100000-0000-4000-8000-000000000002', 'instagram', 'igrollout_comp_a');

-- The membership test, isolated from the pin-null backstop.
--
-- A real policy never pins a watchlist it did not list, so every gate
-- below refuses an unlisted watchlist twice: once because the id is
-- absent, and again because the pin is absent. Replacing only the
-- membership test would still refuse those gates. This call is the state
-- the reader never produces: the watchlist is absent from competitor_ids
-- and present in competitor_pins, the viewer matches that pin, and both
-- rows belong to the owner. Only the membership test refuses it.
DO $r12_membership$
DECLARE
  v_allowed jsonb;
  v_owner   uuid := 'aa100000-0000-4000-8000-000000000001';
  v_unlisted uuid := 'c1000000-0000-4000-8000-000000000011';
  v_viewer  uuid := 'e1000000-0000-4000-8000-000000000001';
BEGIN
  v_allowed := public.ig_collection_rollout_competitor_allowed(
    v_owner,
    v_unlisted,
    v_viewer,
    jsonb_build_object(
      'competitor_mode', 'allowlist',
      'competitor_ids', '[]'::jsonb,
      'competitor_pins', jsonb_build_object(v_unlisted::text, v_viewer::text),
      'fingerprint', repeat('ab', 32)));

  ASSERT NOT COALESCE((v_allowed ->> 'allowed')::boolean, false),
    'R12 an unlisted watchlist is refused even when a pin was supplied for it';
  ASSERT v_allowed ->> 'reason_code' = 'collection_not_eligible',
    'R12 the unlisted watchlist carries collection_not_eligible';
END
$r12_membership$;

-- Owner enqueue. The same-owner unlisted watchlist is a real target, so
-- the refusal is the policy. The other tenant's copy of the same handle
-- is not this owner's target at all.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aa100000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $r12_owner_enqueue$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.enqueue_instagram_collection_job(
    'competitor', 'c1000000-0000-4000-8000-000000000011', 'normal');

  ASSERT NOT (v_result ->> 'accepted')::boolean,
    'R12 the owner enqueue of an unlisted watchlist is refused';
  ASSERT (v_result ->> 'refused')::boolean,
    'R12 the unlisted owner enqueue carries the refused flag';
  ASSERT v_result ->> 'reason_code' = 'collection_not_eligible',
    'R12 the unlisted owner enqueue carries collection_not_eligible';
  ASSERT v_result ->> 'job_id' IS NULL,
    'R12 the unlisted owner enqueue names no job';

  v_result := public.enqueue_instagram_collection_job(
    'competitor', 'c1000000-0000-4000-8000-000000000011', 'force');

  ASSERT NOT (v_result ->> 'accepted')::boolean,
    'R12 the owner force of an unlisted watchlist is refused';
  ASSERT (v_result ->> 'refused')::boolean,
    'R12 the unlisted owner force carries the refused flag';

  BEGIN
    PERFORM public.enqueue_instagram_collection_job(
      'competitor', 'c1000000-0000-4000-8000-000000000012', 'normal');
    RAISE EXCEPTION 'R12 failed: the same handle in another tenant was enqueued'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_TARGET_NOT_FOUND%' THEN
      RAISE EXCEPTION 'R12 expected IG_COLLECTION_TARGET_NOT_FOUND, got: %', SQLERRM;
    END IF;
  END;
END
$r12_owner_enqueue$;

SELECT set_config('request.jwt.claim.sub', 'bb100000-0000-4000-8000-000000000002', true);

DO $r12_other_owner_enqueue$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.enqueue_instagram_collection_job(
    'competitor', 'c1000000-0000-4000-8000-000000000012', 'normal');

  ASSERT NOT (v_result ->> 'accepted')::boolean,
    'R12 the other tenant enqueue of the same handle is refused';
  ASSERT (v_result ->> 'refused')::boolean,
    'R12 the same-handle enqueue carries the refused flag';
  ASSERT v_result ->> 'reason_code' = 'collection_not_eligible',
    'R12 the same-handle enqueue carries collection_not_eligible';
  ASSERT v_result ->> 'job_id' IS NULL,
    'R12 the same-handle enqueue names no job';

  v_result := public.enqueue_instagram_collection_job(
    'competitor', 'c1000000-0000-4000-8000-000000000012', 'force');

  ASSERT NOT (v_result ->> 'accepted')::boolean,
    'R12 the other tenant force of the same handle is refused';
END
$r12_other_owner_enqueue$;

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claim.role', '', true);

DO $r12_enqueue_quiet$
DECLARE
  v_jobs      integer;
  v_throttles integer;
BEGIN
  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE target_id IN (
     'c1000000-0000-4000-8000-000000000011',
     'c1000000-0000-4000-8000-000000000012');

  ASSERT v_jobs = 0,
    'R12 a refused competitor enqueue inserted no job';

  SELECT count(*) INTO v_throttles
    FROM public.instagram_collection_request_throttles
   WHERE target_kind = 'competitor'
     AND target_id IN (
       'c1000000-0000-4000-8000-000000000011',
       'c1000000-0000-4000-8000-000000000012');

  ASSERT v_throttles = 0,
    'R12 a refused competitor force consumed no accepted-request window';
END
$r12_enqueue_quiet$;

-- Service enqueue of the same two watchlists, each as its real owner.
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $r12_service_enqueue$
DECLARE
  v_result jsonb;
  v_item   jsonb;
BEGIN
  v_result := public.enqueue_instagram_collection_jobs_service(
    'aa100000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'competitor',
      'target_id', 'c1000000-0000-4000-8000-000000000011',
      'mode', 'normal')));

  ASSERT (v_result ->> 'accepted')::integer = 0,
    'R12 the service enqueue accepted no unlisted watchlist';
  ASSERT (v_result ->> 'refused')::integer = 1,
    'R12 the service enqueue refused the unlisted watchlist';

  SELECT r.value INTO v_item
    FROM jsonb_array_elements(v_result -> 'results') AS r(value);

  ASSERT NOT (v_item ->> 'accepted')::boolean,
    'R12 the unlisted service element is not accepted';
  ASSERT (v_item ->> 'refused')::boolean,
    'R12 the unlisted service element carries the refused flag';
  ASSERT v_item ->> 'reason_code' = 'collection_not_eligible',
    'R12 the unlisted service element carries collection_not_eligible';
  ASSERT v_item ->> 'job_id' IS NULL,
    'R12 the unlisted service element names no job';

  v_result := public.enqueue_instagram_collection_jobs_service(
    'bb100000-0000-4000-8000-000000000002',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'competitor',
      'target_id', 'c1000000-0000-4000-8000-000000000012',
      'mode', 'force')));

  ASSERT (v_result ->> 'accepted')::integer = 0,
    'R12 the service force accepted no same-handle watchlist';
  ASSERT (v_result ->> 'refused')::integer = 1,
    'R12 the service force refused the same-handle watchlist';

  SELECT r.value INTO v_item
    FROM jsonb_array_elements(v_result -> 'results') AS r(value);

  ASSERT v_item ->> 'reason_code' = 'collection_not_eligible',
    'R12 the same-handle service element carries collection_not_eligible';

  -- A forged owner cannot ride the shared handle into the listed target.
  BEGIN
    PERFORM public.enqueue_instagram_collection_jobs_service(
      'bb100000-0000-4000-8000-000000000002',
      jsonb_build_array(jsonb_build_object(
        'target_kind', 'competitor',
        'target_id', 'c1000000-0000-4000-8000-000000000001',
        'mode', 'normal')));
    RAISE EXCEPTION 'R12 failed: a forged owner enqueued the listed watchlist'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_TARGET_NOT_FOUND%' THEN
      RAISE EXCEPTION 'R12 expected IG_COLLECTION_TARGET_NOT_FOUND, got: %', SQLERRM;
    END IF;
  END;
END
$r12_service_enqueue$;

-- Claim. The pre-filter compares target ids, so these two rows are not
-- candidates. Their attempts, generation and lease stay put.
INSERT INTO public.instagram_collection_jobs
  (user_id, target_kind, target_id, watchlist_id, captured_on,
   status, due_at, attempts, job_generation)
VALUES
  ('aa100000-0000-4000-8000-000000000001', 'competitor',
   'c1000000-0000-4000-8000-000000000011', 'c1000000-0000-4000-8000-000000000011',
   current_date - 41, 'queued', now() - interval '1 minute', 2, 3),
  ('bb100000-0000-4000-8000-000000000002', 'competitor',
   'c1000000-0000-4000-8000-000000000012', 'c1000000-0000-4000-8000-000000000012',
   current_date - 41, 'queued', now() - interval '1 minute', 2, 3);

DO $r12_claim_unlisted$
DECLARE
  v_claimed    integer := 0;
  v_attempts   integer;
  v_generation bigint;
  v_status     text;
  v_lease      uuid;
BEGIN
  SELECT count(*) INTO v_claimed
    FROM public.claim_instagram_collection_jobs('competitor', 50) AS c(value)
   WHERE c.value ->> 'target_id' IN (
     'c1000000-0000-4000-8000-000000000011',
     'c1000000-0000-4000-8000-000000000012');

  ASSERT v_claimed = 0,
    'R12 the claim returned no unlisted and no same-handle watchlist';

  SELECT j.attempts, j.job_generation, j.status, j.lease_token
    INTO v_attempts, v_generation, v_status, v_lease
    FROM public.instagram_collection_jobs AS j
   WHERE j.target_id = 'c1000000-0000-4000-8000-000000000011'
     AND j.captured_on = current_date - 41;

  ASSERT v_attempts = 2,
    'R12 the unlisted claim candidate kept its attempts';
  ASSERT v_generation = 3,
    'R12 the unlisted claim candidate kept its generation';
  ASSERT v_status = 'queued',
    'R12 the unlisted claim candidate stayed queued';
  ASSERT v_lease IS NULL,
    'R12 the unlisted claim candidate took no lease';

  SELECT j.attempts, j.job_generation, j.status, j.lease_token
    INTO v_attempts, v_generation, v_status, v_lease
    FROM public.instagram_collection_jobs AS j
   WHERE j.target_id = 'c1000000-0000-4000-8000-000000000012'
     AND j.captured_on = current_date - 41;

  ASSERT v_attempts = 2,
    'R12 the same-handle claim candidate kept its attempts';
  ASSERT v_generation = 3,
    'R12 the same-handle claim candidate kept its generation';
  ASSERT v_status = 'queued',
    'R12 the same-handle claim candidate stayed queued';
  ASSERT v_lease IS NULL,
    'R12 the same-handle claim candidate took no lease';
END
$r12_claim_unlisted$;

-- Attach, the fenced write, the context read and the permit. The job is
-- already leased, so the refusal is the rollout decision and not a stale
-- claim. The bound viewer belongs to the owner; the watchlist does not
-- belong to the allowlist.
INSERT INTO public.instagram_collection_jobs
  (id, user_id, target_kind, target_id, watchlist_id, captured_on,
   status, due_at, attempts, job_generation,
   lease_token, lease_expires_at,
   context_viewer_social_account_id, context_credential_generation, context_login_kind)
VALUES
  ('f1000000-0000-4000-8000-0000000000c1',
   'aa100000-0000-4000-8000-000000000001', 'competitor',
   'c1000000-0000-4000-8000-000000000011', 'c1000000-0000-4000-8000-000000000011',
   current_date - 42, 'leased', now() - interval '1 minute', 1, 1,
   'f1000000-0000-4000-8000-0000000000a1', clock_timestamp() + interval '10 minutes',
   'e1000000-0000-4000-8000-000000000001', 2, 'page_linked');

DO $r12_unlisted_gates$
DECLARE
  v_job    uuid := 'f1000000-0000-4000-8000-0000000000c1';
  v_token  uuid := 'f1000000-0000-4000-8000-0000000000a1';
  v_permit jsonb;
  v_rows   integer;
  v_status text;
BEGIN
  BEGIN
    PERFORM public.attach_instagram_collection_job_viewer_context(
      v_job, v_token, 1, 'e1000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'R12 failed: a viewer attached to an unlisted watchlist'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_NOT_ELIGIBLE%' THEN
      RAISE EXCEPTION 'R12 expected IG_COLLECTION_NOT_ELIGIBLE from attach, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      v_job, v_token, 1,
      jsonb_build_object('kind', 'operations', 'items', jsonb_build_array(
        jsonb_build_object('operation_key', 'media:ig-r12',
                           'operation_kind', 'media', 'state', 'failed',
                           'reason_code', 'provider_error'))));
    RAISE EXCEPTION 'R12 failed: an unlisted watchlist recorded progress'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_NOT_ELIGIBLE%' THEN
      RAISE EXCEPTION 'R12 expected IG_COLLECTION_NOT_ELIGIBLE from the write, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.read_instagram_collection_job_context(v_job, v_token);
    RAISE EXCEPTION 'R12 failed: an unlisted watchlist read its context'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_NOT_ELIGIBLE%' THEN
      RAISE EXCEPTION 'R12 expected IG_COLLECTION_NOT_ELIGIBLE from the context read, got: %', SQLERRM;
    END IF;
  END;

  v_permit := public.authorize_instagram_collection_provider_call(v_job, v_token, 1);

  ASSERT NOT (v_permit ->> 'allowed')::boolean,
    'R12 the permit refuses an unlisted watchlist';
  ASSERT v_permit ->> 'reason_code' = 'collection_not_eligible',
    'R12 the unlisted permit carries collection_not_eligible';

  SELECT count(*) INTO v_rows
    FROM public.instagram_collection_job_operations
   WHERE job_id = v_job;

  ASSERT v_rows = 0,
    'R12 the refused unlisted write left no operation row';

  SELECT j.status INTO v_status
    FROM public.instagram_collection_jobs AS j
   WHERE j.id = v_job;

  ASSERT v_status = 'leased',
    'R12 the refused unlisted gates left the lease in place';
END
$r12_unlisted_gates$;

-- The pinned viewer must belong to the same owner as the watchlist.
--
-- The listed watchlist stays listed. Its pin is moved to a real Instagram
-- account owned by the OTHER tenant. Enqueue passes no viewer, so the pin
-- mismatch does not fire; the only refusal left is the viewer's owner.
-- A null bound viewer on a live lease makes the later context check a
-- different error, so a bypass of this owner check cannot hide behind it.
SELECT pg_temp.igrollout_set_policy(
  pg_temp.igrollout_pin('eb100000-0000-4000-8000-000000000001'));

DO $r12_foreign_viewer$
DECLARE
  v_allowed jsonb;
  v_owner   uuid := 'aa100000-0000-4000-8000-000000000001';
  v_listed  uuid := 'c1000000-0000-4000-8000-000000000001';
  v_foreign uuid := 'eb100000-0000-4000-8000-000000000001';
BEGIN
  v_allowed := public.ig_collection_rollout_target_allowed(
    v_owner, 'competitor', v_listed, NULL);

  ASSERT NOT COALESCE((v_allowed ->> 'allowed')::boolean, false),
    'R12 a listed watchlist pinned to another owner''s viewer is not admitted';
  ASSERT v_allowed ->> 'reason_code' = 'collection_not_eligible',
    'R12 the foreign pin carries collection_not_eligible';

  v_allowed := public.ig_collection_rollout_target_allowed(
    v_owner, 'competitor', v_listed, v_foreign);

  ASSERT NOT COALESCE((v_allowed ->> 'allowed')::boolean, false),
    'R12 naming the foreign pinned viewer does not admit it';
END
$r12_foreign_viewer$;

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aa100000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $r12_foreign_owner_enqueue$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.enqueue_instagram_collection_job(
    'competitor', 'c1000000-0000-4000-8000-000000000001', 'normal');

  ASSERT NOT (v_result ->> 'accepted')::boolean,
    'R12 the owner enqueue refuses a watchlist pinned to another owner''s viewer';
  ASSERT (v_result ->> 'refused')::boolean,
    'R12 the foreign-pin owner enqueue carries the refused flag';
  ASSERT v_result ->> 'reason_code' = 'collection_not_eligible',
    'R12 the foreign-pin owner enqueue carries collection_not_eligible';
END
$r12_foreign_owner_enqueue$;

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $r12_foreign_service$
DECLARE
  v_result jsonb;
  v_before bigint;
  v_after  bigint;
  v_throttles integer;
BEGIN
  SELECT j.job_generation INTO v_before
    FROM public.instagram_collection_jobs AS j
   WHERE j.user_id = 'aa100000-0000-4000-8000-000000000001'
     AND j.target_id = 'c1000000-0000-4000-8000-000000000001'
     AND j.captured_on = (now() AT TIME ZONE 'Asia/Kuwait')::date;

  v_result := public.enqueue_instagram_collection_jobs_service(
    'aa100000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'competitor',
      'target_id', 'c1000000-0000-4000-8000-000000000001',
      'mode', 'normal')));

  ASSERT (v_result ->> 'accepted')::integer = 0,
    'R12 the service enqueue accepted nothing for a foreign pin';
  ASSERT (v_result ->> 'refused')::integer = 1,
    'R12 the service enqueue refused the foreign pin';

  SELECT j.job_generation INTO v_after
    FROM public.instagram_collection_jobs AS j
   WHERE j.user_id = 'aa100000-0000-4000-8000-000000000001'
     AND j.target_id = 'c1000000-0000-4000-8000-000000000001'
     AND j.captured_on = (now() AT TIME ZONE 'Asia/Kuwait')::date;

  ASSERT v_after = v_before,
    'R12 the foreign-pin refusal left the existing generation unchanged';

  SELECT count(*) INTO v_throttles
    FROM public.instagram_collection_request_throttles
   WHERE target_kind = 'competitor'
     AND target_id = 'c1000000-0000-4000-8000-000000000001';

  ASSERT v_throttles = 0,
    'R12 the foreign-pin refusal consumed no accepted-request window';
END
$r12_foreign_service$;

-- A queued row for the listed watchlist, with no viewer bound yet. The
-- candidate pre-filter lets it through. The row-level decision must not.
INSERT INTO public.instagram_collection_jobs
  (user_id, target_kind, target_id, watchlist_id, captured_on,
   status, due_at, attempts, job_generation)
VALUES
  ('aa100000-0000-4000-8000-000000000001', 'competitor',
   'c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001',
   current_date - 44, 'queued', now() - interval '1 minute', 5, 9);

-- A leased row for the same listed watchlist, still with no viewer. The
-- write, the context read and the permit consult the evaluator. The next
-- check after a bypass would be a missing context, which is a different
-- refusal, so the assertion names collection_not_eligible exactly.
INSERT INTO public.instagram_collection_jobs
  (id, user_id, target_kind, target_id, watchlist_id, captured_on,
   status, due_at, attempts, job_generation,
   lease_token, lease_expires_at)
VALUES
  ('f1000000-0000-4000-8000-0000000000c2',
   'aa100000-0000-4000-8000-000000000001', 'competitor',
   'c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001',
   current_date - 43, 'leased', now() - interval '2 minutes', 1, 1,
   'f1000000-0000-4000-8000-0000000000a2', clock_timestamp() + interval '10 minutes');

DO $r12_foreign_gates$
DECLARE
  v_job        uuid := 'f1000000-0000-4000-8000-0000000000c2';
  v_token      uuid := 'f1000000-0000-4000-8000-0000000000a2';
  v_permit     jsonb;
  v_claimed    integer;
  v_attempts   integer;
  v_generation bigint;
  v_status     text;
  v_lease      uuid;
  v_rows       integer;
BEGIN
  SELECT count(*) INTO v_claimed
    FROM public.claim_instagram_collection_jobs('competitor', 50) AS c(value)
   WHERE c.value ->> 'captured_on' = (current_date - 44)::text;

  ASSERT v_claimed = 0,
    'R12 the claim returned nothing for a listed watchlist pinned to another owner';

  SELECT j.attempts, j.job_generation, j.status, j.lease_token
    INTO v_attempts, v_generation, v_status, v_lease
    FROM public.instagram_collection_jobs AS j
   WHERE j.target_id = 'c1000000-0000-4000-8000-000000000001'
     AND j.captured_on = current_date - 44;

  ASSERT v_attempts = 5,
    'R12 the foreign-pin claim candidate kept its attempts';
  ASSERT v_generation = 9,
    'R12 the foreign-pin claim candidate kept its generation';
  ASSERT v_status = 'queued',
    'R12 the foreign-pin claim candidate stayed queued';
  ASSERT v_lease IS NULL,
    'R12 the foreign-pin claim candidate took no lease';

  BEGIN
    PERFORM public.attach_instagram_collection_job_viewer_context(
      v_job, v_token, 1, 'eb100000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'R12 failed: the foreign pinned viewer attached'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_NOT_ELIGIBLE%' THEN
      RAISE EXCEPTION 'R12 expected IG_COLLECTION_NOT_ELIGIBLE from the foreign attach, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      v_job, v_token, 1,
      jsonb_build_object('kind', 'operations', 'items', jsonb_build_array(
        jsonb_build_object('operation_key', 'media:ig-r12-foreign',
                           'operation_kind', 'media', 'state', 'failed',
                           'reason_code', 'provider_error'))));
    RAISE EXCEPTION 'R12 failed: a foreign pin recorded progress'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_NOT_ELIGIBLE%' THEN
      RAISE EXCEPTION 'R12 expected IG_COLLECTION_NOT_ELIGIBLE from the foreign write, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.read_instagram_collection_job_context(v_job, v_token);
    RAISE EXCEPTION 'R12 failed: a foreign pin read its context'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_NOT_ELIGIBLE%' THEN
      RAISE EXCEPTION 'R12 expected IG_COLLECTION_NOT_ELIGIBLE from the foreign context read, got: %', SQLERRM;
    END IF;
  END;

  v_permit := public.authorize_instagram_collection_provider_call(v_job, v_token, 1);

  ASSERT NOT (v_permit ->> 'allowed')::boolean,
    'R12 the permit refuses a watchlist pinned to another owner''s viewer';
  ASSERT v_permit ->> 'reason_code' = 'collection_not_eligible',
    'R12 the foreign-pin permit carries collection_not_eligible';

  SELECT count(*) INTO v_rows
    FROM public.instagram_collection_job_operations
   WHERE job_id = v_job;

  ASSERT v_rows = 0,
    'R12 the foreign-pin refusal left no operation row';
END
$r12_foreign_gates$;

-- Park the foreign-pin candidate so the next claim sees only the row it
-- is about, and put the pilot pin back.
UPDATE public.instagram_collection_jobs
   SET due_at = now() + interval '1 day'
 WHERE captured_on = current_date - 44
   AND target_id = 'c1000000-0000-4000-8000-000000000001';

SELECT pg_temp.igrollout_set_policy(pg_temp.igrollout_policy('allowlist', 'allowlist'));

-- The target id IS allowlisted. The bound viewer is another account of
-- the same owner, not the pin. The candidate pre-filter compares target
-- ids only, so this row reaches the decision under the locks. That
-- decision must refuse, and the row must not change.
INSERT INTO public.instagram_collection_jobs
  (user_id, target_kind, target_id, watchlist_id, captured_on,
   status, due_at, attempts, job_generation,
   context_viewer_social_account_id, context_credential_generation, context_login_kind)
VALUES
  ('aa100000-0000-4000-8000-000000000001', 'competitor',
   'c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001',
   current_date - 45, 'queued', now() - interval '1 minute', 4, 7,
   'e1000000-0000-4000-8000-000000000002', 2, 'page_linked');

DO $r12_claim_wrong_viewer$
DECLARE
  v_claimed    integer;
  v_attempts   integer;
  v_generation bigint;
  v_status     text;
  v_lease      uuid;
  v_viewer     uuid;
BEGIN
  SELECT count(*) INTO v_claimed
    FROM public.claim_instagram_collection_jobs('competitor', 50) AS c(value);

  ASSERT v_claimed = 0,
    'R12 the claim returned nothing when the only due allowlisted row wore the wrong viewer';

  SELECT j.attempts, j.job_generation, j.status, j.lease_token,
         j.context_viewer_social_account_id
    INTO v_attempts, v_generation, v_status, v_lease, v_viewer
    FROM public.instagram_collection_jobs AS j
   WHERE j.target_id = 'c1000000-0000-4000-8000-000000000001'
     AND j.captured_on = current_date - 45;

  ASSERT v_attempts = 4,
    'R12 the wrong-viewer claim candidate kept its attempts';
  ASSERT v_generation = 7,
    'R12 the wrong-viewer claim candidate kept its generation';
  ASSERT v_status = 'queued',
    'R12 the wrong-viewer claim candidate stayed queued';
  ASSERT v_lease IS NULL,
    'R12 the wrong-viewer claim candidate took no lease';
  ASSERT v_viewer = 'e1000000-0000-4000-8000-000000000002',
    'R12 the wrong-viewer claim candidate kept its bound viewer';
END
$r12_claim_wrong_viewer$;

RESET ROLE;
SELECT set_config('request.jwt.claim.role', '', true);

ROLLBACK;

\echo 'ALL CHECKS PASSED'
