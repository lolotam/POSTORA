-- supabase/tests/meta_page_token_reconciliation.sql
-- Captured Page-token reconciliation (migration 20261028110000).
--
-- One transaction, synthetic fixtures, ROLLBACK. No provider calls, no real
-- tokens, no network. Proves the exact request and result contract, the
-- protected-identity comparisons, the selected-only transactional effects,
-- the preserved User grant and siblings, the refusal taxonomy, the browser
-- denial and the service grant.
--
-- The suite runs as the harness superuser, so every refusal here is a
-- refusal that survived the service role, except in S11, which deliberately
-- SET ROLEs away from it.
--
-- The token literals below are synthetic. No assertion message prints one.

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures.
--
--   owner A  0f1b0001-...  one workspace W1
--   A1  page-linked Instagram, bound to C1, the primary target
--   A2  page-linked Instagram, the sibling of A1 on C1
--   A3  Facebook Page, the third member of C1
--   A4  page-linked Instagram whose binding carries no verified identity
--   A5  direct Instagram, no Facebook binding
--   A6  page-linked Instagram, deactivated
--   A7  page-linked Instagram with a stale operational expiry and health
--   A8  page-linked Instagram on C2, whose User expiry is unknown
--   A9  page-linked Instagram, the drift target
--   A10 the sibling of A9 on C1, removed after a capture
--   A11 page-linked Instagram whose binding names another Facebook User
--   A12 page-linked Instagram whose canonical identity is not the verified one
--   A13 page-linked Instagram on C3, whose User grant expiry has passed
--   A14 page-linked Instagram, added to C1 after a capture
--   A15 page-linked Instagram, deleted after a capture
--   B1  owner B's page-linked Instagram, on C4
--
--   C1  the shared grant: known expiry, known subject
--   C2  a second grant: unknown expiry
--   C3  a grant whose expiry has already passed
--   C4  owner B's grant
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email)
VALUES
  ('0f1b0001-0000-4000-8000-000000000001', 'mpr-a@example.invalid'),
  ('0f1b0002-0000-4000-8000-000000000002', 'mpr-b@example.invalid');

INSERT INTO public.workspaces (id, name, owner_id, is_personal)
VALUES (
  '0f1b9001-0000-4000-8000-000000000001', 'mpr-w1',
  '0f1b0001-0000-4000-8000-000000000001', false
);

INSERT INTO public.social_accounts
  (id, user_id, workspace_id, platform, platform_user_id, platform_username,
   access_token, refresh_token, token_expires_at, is_active, failure_count,
   needs_reauth, last_refresh_error, last_alert_sent_at, account_metadata)
VALUES
  ('0f1ba001-0000-4000-8000-000000000011', '0f1b0001-0000-4000-8000-000000000001',
   '0f1b9001-0000-4000-8000-000000000001', 'instagram', 'ig-page-1', 'ig_page_1',
   'page-token-1', 'page-refresh-1', '2099-01-02T00:00:00Z', true, 0, false, NULL, NULL,
   '{"origin":"oauth"}'::jsonb),
  ('0f1ba002-0000-4000-8000-000000000012', '0f1b0001-0000-4000-8000-000000000001',
   '0f1b9001-0000-4000-8000-000000000001', 'instagram', 'ig-page-2', 'ig_page_2',
   'page-token-2', NULL, '2099-01-03T00:00:00Z', true, 0, false, NULL, NULL, NULL),
  ('0f1ba003-0000-4000-8000-000000000013', '0f1b0001-0000-4000-8000-000000000001',
   '0f1b9001-0000-4000-8000-000000000001', 'facebook', 'fb-page-1', 'fb_page_1',
   'fb-page-token-1', NULL, NULL, true, 0, false, NULL, NULL, NULL),
  ('0f1ba004-0000-4000-8000-000000000014', '0f1b0001-0000-4000-8000-000000000001',
   '0f1b9001-0000-4000-8000-000000000001', 'instagram', 'ig-migrated-1', 'ig_migrated_1',
   'migrated-token-1', NULL, '2099-01-04T00:00:00Z', true, 0, false, NULL, NULL, NULL),
  ('0f1ba005-0000-4000-8000-000000000015', '0f1b0001-0000-4000-8000-000000000001',
   '0f1b9001-0000-4000-8000-000000000001', 'instagram', 'ig-direct-1', 'ig_direct_1',
   'direct-token-1', 'direct-refresh-1', '2099-01-05T00:00:00Z', true, 0, false, NULL, NULL, NULL),
  ('0f1ba006-0000-4000-8000-000000000016', '0f1b0001-0000-4000-8000-000000000001',
   '0f1b9001-0000-4000-8000-000000000001', 'instagram', 'ig-inactive-1', 'ig_inactive_1',
   'inactive-token-1', NULL, '2099-01-06T00:00:00Z', true, 0, false, NULL, NULL, NULL),
  ('0f1ba007-0000-4000-8000-000000000017', '0f1b0001-0000-4000-8000-000000000001',
   '0f1b9001-0000-4000-8000-000000000001', 'instagram', 'ig-stale-1', 'ig_stale_1',
   'stale-token-1', 'stale-refresh-1', '2099-06-01T00:00:00Z', true, 3, true,
   'provider_error', '2026-01-01T00:00:00Z', '{"origin":"oauth"}'::jsonb),
  ('0f1ba008-0000-4000-8000-000000000018', '0f1b0001-0000-4000-8000-000000000001',
   '0f1b9001-0000-4000-8000-000000000001', 'instagram', 'ig-grant2-1', 'ig_grant2_1',
   'grant2-token-1', NULL, '2099-01-08T00:00:00Z', true, 0, false, NULL, NULL, NULL),
  ('0f1ba009-0000-4000-8000-000000000019', '0f1b0001-0000-4000-8000-000000000001',
   '0f1b9001-0000-4000-8000-000000000001', 'instagram', 'ig-member-1', 'ig_member_1',
   'member-token-1', NULL, '2099-01-09T00:00:00Z', true, 0, false, NULL, NULL, NULL),
  ('0f1ba010-0000-4000-8000-000000000020', '0f1b0001-0000-4000-8000-000000000001',
   '0f1b9001-0000-4000-8000-000000000001', 'instagram', 'ig-member-2', 'ig_member_2',
   'member-token-2', NULL, '2099-01-10T00:00:00Z', true, 0, false, NULL, NULL, NULL),
  ('0f1ba011-0000-4000-8000-000000000021', '0f1b0001-0000-4000-8000-000000000001',
   '0f1b9001-0000-4000-8000-000000000001', 'instagram', 'ig-userdrift-1', 'ig_userdrift_1',
   'userdrift-token-1', NULL, '2099-01-11T00:00:00Z', true, 0, false, NULL, NULL, NULL),
  ('0f1ba012-0000-4000-8000-000000000022', '0f1b0001-0000-4000-8000-000000000001',
   '0f1b9001-0000-4000-8000-000000000001', 'instagram', 'ig-canon-1', 'ig_canon_1',
   'canon-token-1', NULL, '2099-01-12T00:00:00Z', true, 0, false, NULL, NULL, NULL),
  ('0f1ba013-0000-4000-8000-000000000023', '0f1b0001-0000-4000-8000-000000000001',
   '0f1b9001-0000-4000-8000-000000000001', 'instagram', 'ig-expired-user-1', 'ig_expired_user_1',
   'expireduser-token-1', NULL, '2099-01-13T00:00:00Z', true, 0, false, NULL, NULL, NULL),
  ('0f1ba014-0000-4000-8000-000000000014', '0f1b0001-0000-4000-8000-000000000001',
   '0f1b9001-0000-4000-8000-000000000001', 'instagram', 'ig-newmember-1', 'ig_newmember_1',
   'newmember-token-1', NULL, '2099-01-14T00:00:00Z', true, 0, false, NULL, NULL, NULL),
  ('0f1ba015-0000-4000-8000-000000000015', '0f1b0001-0000-4000-8000-000000000001',
   '0f1b9001-0000-4000-8000-000000000001', 'instagram', 'ig-deleted-1', 'ig_deleted_1',
   'deleted-token-1', NULL, '2099-01-15T00:00:00Z', true, 0, false, NULL, NULL, NULL),
  ('0f1bb001-0000-4000-8000-000000000031', '0f1b0002-0000-4000-8000-000000000002',
   NULL, 'instagram', 'ig-page-b', 'ig_page_b',
   'page-token-b', NULL, '2099-01-16T00:00:00Z', true, 0, false, NULL, NULL, NULL);

-- The shared Facebook User grants. C3's expiry is already in the past: the
-- fixture is relative to the run clock, so it can never become "live" again.
INSERT INTO public.facebook_user_credentials (
  id, user_id, token, revision, lifecycle, token_expires_at, provider_user_id,
  provenance_source, provenance_captured_at
) VALUES
  ('0f1bc001-0000-4000-8000-000000000041', '0f1b0001-0000-4000-8000-000000000001',
   'user-token-1', 1, 'active', '2099-02-01T00:00:00Z', 'fb-user-1',
   'oauth_exchange', '2026-01-01T00:00:00Z'),
  ('0f1bc002-0000-4000-8000-000000000042', '0f1b0001-0000-4000-8000-000000000001',
   'user-token-2', 1, 'active', NULL, 'fb-user-2',
   'oauth_exchange', '2026-01-01T00:00:00Z'),
  ('0f1bc003-0000-4000-8000-000000000043', '0f1b0001-0000-4000-8000-000000000001',
   'user-token-3', 1, 'active', clock_timestamp() - INTERVAL '1 day', 'fb-user-3',
   'oauth_exchange', '2026-01-01T00:00:00Z'),
  ('0f1bc004-0000-4000-8000-000000000044', '0f1b0002-0000-4000-8000-000000000002',
   'user-token-b', 1, 'active', '2099-02-01T00:00:00Z', 'fb-user-b',
   'oauth_exchange', '2026-01-01T00:00:00Z');

INSERT INTO public.facebook_user_credential_bindings (
  social_account_id, user_id, platform, credential_id,
  verified_facebook_user_id, verified_facebook_page_id, verified_instagram_user_id,
  evidence_source, connection_version
) VALUES
  ('0f1ba001-0000-4000-8000-000000000011', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', '0f1bc001-0000-4000-8000-000000000041',
   'fb-user-1', 'page-1', 'ig-page-1', 'oauth_exchange', 1),
  ('0f1ba002-0000-4000-8000-000000000012', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', '0f1bc001-0000-4000-8000-000000000041',
   'fb-user-1', 'page-1', 'ig-page-2', 'oauth_exchange', 1),
  ('0f1ba003-0000-4000-8000-000000000013', '0f1b0001-0000-4000-8000-000000000001',
   'facebook', '0f1bc001-0000-4000-8000-000000000041',
   'fb-user-1', NULL, NULL, 'oauth_exchange', 1),
  ('0f1ba004-0000-4000-8000-000000000014', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', '0f1bc001-0000-4000-8000-000000000041',
   NULL, NULL, NULL, 'migrated_instagram_account_credential', 1),
  ('0f1ba006-0000-4000-8000-000000000016', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', '0f1bc001-0000-4000-8000-000000000041',
   'fb-user-1', 'page-1', 'ig-inactive-1', 'oauth_exchange', 1),
  ('0f1ba007-0000-4000-8000-000000000017', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', '0f1bc001-0000-4000-8000-000000000041',
   'fb-user-1', 'page-1', 'ig-stale-1', 'oauth_exchange', 1),
  ('0f1ba008-0000-4000-8000-000000000018', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', '0f1bc002-0000-4000-8000-000000000042',
   'fb-user-2', 'page-2', 'ig-grant2-1', 'oauth_exchange', 1),
  ('0f1ba009-0000-4000-8000-000000000019', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', '0f1bc001-0000-4000-8000-000000000041',
   'fb-user-1', 'page-1', 'ig-member-1', 'oauth_exchange', 1),
  ('0f1ba010-0000-4000-8000-000000000020', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', '0f1bc001-0000-4000-8000-000000000041',
   'fb-user-1', 'page-1', 'ig-member-2', 'oauth_exchange', 1),
  ('0f1ba011-0000-4000-8000-000000000021', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', '0f1bc001-0000-4000-8000-000000000041',
   'fb-user-other', 'page-1', 'ig-userdrift-1', 'oauth_exchange', 1),
  ('0f1ba012-0000-4000-8000-000000000022', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', '0f1bc001-0000-4000-8000-000000000041',
   'fb-user-1', 'page-1', 'ig-page-9', 'oauth_exchange', 1),
  ('0f1ba013-0000-4000-8000-000000000023', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', '0f1bc003-0000-4000-8000-000000000043',
   'fb-user-3', 'page-3', 'ig-expired-user-1', 'oauth_exchange', 1),
  ('0f1ba015-0000-4000-8000-000000000015', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', '0f1bc001-0000-4000-8000-000000000041',
   'fb-user-1', 'page-1', 'ig-deleted-1', 'oauth_exchange', 1),
  ('0f1bb001-0000-4000-8000-000000000031', '0f1b0002-0000-4000-8000-000000000002',
   'instagram', '0f1bc004-0000-4000-8000-000000000044',
   'fb-user-b', 'page-b', 'ig-page-b', 'oauth_exchange', 1);

INSERT INTO public.facebook_user_credential_connection_fences (
  social_account_id, user_id, platform, connection_version
) VALUES
  ('0f1ba001-0000-4000-8000-000000000011', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 1),
  ('0f1ba002-0000-4000-8000-000000000012', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 1),
  ('0f1ba003-0000-4000-8000-000000000013', '0f1b0001-0000-4000-8000-000000000001',
   'facebook', 1),
  ('0f1ba004-0000-4000-8000-000000000014', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 1),
  ('0f1ba006-0000-4000-8000-000000000016', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 1),
  ('0f1ba007-0000-4000-8000-000000000017', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 1),
  ('0f1ba008-0000-4000-8000-000000000018', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 1),
  ('0f1ba009-0000-4000-8000-000000000019', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 1),
  ('0f1ba010-0000-4000-8000-000000000020', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 1),
  ('0f1ba011-0000-4000-8000-000000000021', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 1),
  ('0f1ba012-0000-4000-8000-000000000022', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 1),
  ('0f1ba013-0000-4000-8000-000000000023', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 1),
  ('0f1ba014-0000-4000-8000-000000000014', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 1),
  ('0f1ba015-0000-4000-8000-000000000015', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 1),
  ('0f1bb001-0000-4000-8000-000000000031', '0f1b0002-0000-4000-8000-000000000002',
   'instagram', 1);

-- A Facebook Page has no Instagram capability row. That is deliberate: the
-- reconciliation of a Facebook Page must not require one.
INSERT INTO public.instagram_account_capabilities (
  social_account_id, user_id, platform, login_kind, permission_read_state,
  granted_scopes, scopes_read_at, credential_generation
) VALUES
  ('0f1ba001-0000-4000-8000-000000000011', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_basic', 'instagram_manage_insights'],
   '2026-01-01T00:00:00Z', 2),
  ('0f1ba002-0000-4000-8000-000000000012', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_basic'], '2026-01-01T00:00:00Z', 2),
  ('0f1ba004-0000-4000-8000-000000000014', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_basic'], '2026-01-01T00:00:00Z', 2),
  ('0f1ba005-0000-4000-8000-000000000015', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 'direct', 'unknown', ARRAY[]::TEXT[], NULL, 1),
  ('0f1ba006-0000-4000-8000-000000000016', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_basic'], '2026-01-01T00:00:00Z', 2),
  ('0f1ba007-0000-4000-8000-000000000017', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_basic'], '2026-01-01T00:00:00Z', 2),
  ('0f1ba008-0000-4000-8000-000000000018', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_basic'], '2026-01-01T00:00:00Z', 2),
  ('0f1ba009-0000-4000-8000-000000000019', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_basic'], '2026-01-01T00:00:00Z', 2),
  ('0f1ba010-0000-4000-8000-000000000020', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_basic'], '2026-01-01T00:00:00Z', 2),
  ('0f1ba011-0000-4000-8000-000000000021', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_basic'], '2026-01-01T00:00:00Z', 2),
  ('0f1ba012-0000-4000-8000-000000000022', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_basic'], '2026-01-01T00:00:00Z', 2),
  ('0f1ba013-0000-4000-8000-000000000023', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_basic'], '2026-01-01T00:00:00Z', 2),
  ('0f1ba014-0000-4000-8000-000000000014', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_basic'], '2026-01-01T00:00:00Z', 2),
  ('0f1ba015-0000-4000-8000-000000000015', '0f1b0001-0000-4000-8000-000000000001',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_basic'], '2026-01-01T00:00:00Z', 2),
  ('0f1bb001-0000-4000-8000-000000000031', '0f1b0002-0000-4000-8000-000000000002',
   'instagram', 'page_linked', 'ok', ARRAY['instagram_basic'], '2026-01-01T00:00:00Z', 2);

-- The partner substrate. One workspace with one subscriber to the
-- reauthorization event, so a success can be shown to produce no outbox row.
INSERT INTO public.partner_api_keys (
  workspace_id, social_account_id, key_hash, key_prefix, name, scopes
) VALUES (
  '0f1b9001-0000-4000-8000-000000000001',
  '0f1ba001-0000-4000-8000-000000000011',
  'mpr-hash-a', 'pk_live_mpra', 'mpr-key-a', ARRAY['webhooks:manage']
);

INSERT INTO public.partner_webhooks (
  workspace_id, created_by_key_id, url, events, secret
) VALUES (
  '0f1b9001-0000-4000-8000-000000000001',
  (SELECT id FROM public.partner_api_keys WHERE key_hash = 'mpr-hash-a'),
  'https://hooks.example.com/mpr-1',
  ARRAY['account.reauthorization_required'],
  'mpr-secret-1'
);

-- ---------------------------------------------------------------------------
-- S1. The boundary. The new writer is service-only, its helpers are
--     owner-only, nothing was added to the schema, and the accepted
--     lifecycle RPCs keep their exact surface.
-- ---------------------------------------------------------------------------
DO $s1$
DECLARE
  f_sig regprocedure;
  v_helper RECORD;
  v_n INTEGER;
BEGIN
  f_sig := 'public.write_meta_page_reconciliation_success(uuid,jsonb)'::regprocedure;

  ASSERT has_function_privilege('service_role', f_sig, 'EXECUTE'),
    'S1 service_role may execute the page reconciliation writer';
  ASSERT NOT has_function_privilege('anon', f_sig, 'EXECUTE'),
    'S1 anon may not execute the page reconciliation writer';
  ASSERT NOT has_function_privilege('authenticated', f_sig, 'EXECUTE'),
    'S1 authenticated may not execute the page reconciliation writer';

  SELECT count(*) INTO v_n
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'write_meta_page_reconciliation_success'
     AND p.prosecdef
     AND p.provolatile = 'v'
     AND p.proconfig @> ARRAY['search_path=public'];
  ASSERT v_n = 1,
    'S1 the writer is SECURITY DEFINER, volatile and has a controlled search_path';

  FOR v_helper IN
    SELECT p.oid::regprocedure AS sig, p.prosecdef AS prosecdef
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE 'meta\_page\_reconciliation\_%'
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

  -- No relation, and no column, was added by this contract.
  SELECT count(*) INTO v_n
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
     AND c.relname LIKE 'meta\_page\_reconciliation\_%';
  ASSERT v_n = 0, 'S1 no page reconciliation relation exists';

  -- The accepted lifecycle RPCs keep their exact service-only surface.
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

  -- The capture relation is untouched: RLS, no browser policy, no secret
  -- column.
  ASSERT (SELECT c.relrowsecurity
            FROM pg_class AS c
            JOIN pg_namespace AS n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public'
             AND c.relname = 'meta_account_refresh_captures'),
    'S1 RLS is still enabled on the capture relation';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policy AS p
      JOIN pg_class AS c ON c.oid = p.polrelid
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'meta_account_refresh_captures'
  ), 'S1 no browser policy exists on the capture relation';
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'meta_account_refresh_captures'
       AND column_name IN (
         'token', 'access_token', 'refresh_token', 'secret', 'provider_response'
       )
  ), 'S1 the capture relation still holds no secret column';
END
$s1$;

-- ---------------------------------------------------------------------------
-- S2. The positive Page-linked Instagram reconciliation. The derived Page
--     token lands on the selected account only, the expiry becomes unknown,
--     the failure evidence is reset, the generation advances exactly once,
--     the User grant is untouched and every sibling keeps its state.
-- ---------------------------------------------------------------------------
DO $s2$
DECLARE
  v_owner CONSTANT uuid := '0f1b0001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1ba001-0000-4000-8000-000000000011';
  v_sibling CONSTANT uuid := '0f1ba002-0000-4000-8000-000000000012';
  v_facebook CONSTANT uuid := '0f1ba003-0000-4000-8000-000000000013';
  v_credential CONSTANT uuid := '0f1bc001-0000-4000-8000-000000000041';
  v_capture UUID;
  v_result JSONB;
  v_keys TEXT[];
  v_token TEXT;
  v_expiry TIMESTAMPTZ;
  v_refresh TEXT;
  v_reauth BOOLEAN;
  v_failures INTEGER;
  v_error TEXT;
  v_active BOOLEAN;
  v_metadata JSONB;
  v_generation BIGINT;
  v_scopes TEXT[];
  v_read_state TEXT;
  v_cred_token TEXT;
  v_cred_revision BIGINT;
  v_cred_expiry TIMESTAMPTZ;
  v_cred_provenance TEXT;
  v_cred_subject TEXT;
  v_sib_token TEXT;
  v_sib_expiry TIMESTAMPTZ;
  v_sib_failures INTEGER;
  v_sib_generation BIGINT;
  v_fb_connection BIGINT;
  v_fb_fence BIGINT;
BEGIN
  v_result := public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))));

  ASSERT (v_result ->> 'operation') = 'facebook_user_token',
    'S2 the capture is a shared Facebook User grant capture';
  ASSERT jsonb_array_length(v_result -> 'capture' -> 'targets') = 1,
    'S2 the capture holds exactly one explicit target';
  ASSERT jsonb_array_length(v_result -> 'capture' -> 'members') > 1,
    'S2 the capture holds the complete membership of the grant';
  ASSERT (v_result -> 'tokens' -> 0 ->> 'scope') = 'credential',
    'S2 the captured material is the User secret, not the operational token';

  v_capture := (v_result ->> 'capture_id')::uuid;

  v_result := public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'operation', 'page_reconciliation',
    'fields', jsonb_build_object(
      'access_token', 'derived-page-token-1',
      'facebook_page_id', 'page-1',
      'instagram_user_id', 'ig-page-1',
      'token_expires_at', NULL)));

  -- The result carries exactly the contracted keys and nothing else.
  SELECT array_agg(t.key ORDER BY t.key) INTO v_keys
    FROM jsonb_object_keys(v_result) AS t(key);
  ASSERT v_keys = ARRAY[
    'account', 'applied', 'capture_id', 'credential_generation',
    'credential_id', 'credential_revision', 'expiry_state', 'operation'],
    'S2 the result carries exactly the contracted keys';

  ASSERT (v_result ->> 'applied')::boolean IS TRUE,
    'S2 the reconciliation applied';
  ASSERT v_result ->> 'operation' = 'page_reconciliation',
    'S2 the result names the reconciliation operation';
  ASSERT v_result ->> 'expiry_state' = 'unknown',
    'S2 the result reports an unknown expiry';
  ASSERT v_result ->> 'credential_id' = v_credential::text,
    'S2 the result names the captured grant';
  ASSERT (v_result ->> 'credential_revision')::bigint = 1,
    'S2 the reported credential revision is unchanged';
  ASSERT (v_result ->> 'credential_generation')::bigint = 3,
    'S2 the reported generation is the advanced one';
  ASSERT (v_result -> 'account' ->> 'found')::boolean IS TRUE,
    'S2 the result carries the committed account state';
  ASSERT (v_result -> 'account' ->> 'social_account_id') = v_account::text,
    'S2 the account state names the selected account';
  ASSERT (v_result -> 'account' ->> 'token_expires_at') IS NULL,
    'S2 the account state reports the unknown expiry';
  ASSERT v_result -> 'account' ->> 'access_token' IS NULL,
    'S2 the result never returns a token';

  -- The selected account.
  SELECT sa.access_token, sa.token_expires_at, sa.refresh_token, sa.needs_reauth,
         sa.failure_count, sa.last_refresh_error, sa.is_active, sa.account_metadata
    INTO v_token, v_expiry, v_refresh, v_reauth, v_failures, v_error,
         v_active, v_metadata
    FROM public.social_accounts AS sa
   WHERE sa.id = v_account;
  ASSERT v_token = 'derived-page-token-1',
    'S2 the derived Page token is the operational token';
  ASSERT v_expiry IS NULL,
    'S2 the operational expiry is unknown';
  ASSERT v_refresh = 'page-refresh-1',
    'S2 the refresh token is preserved';
  ASSERT v_reauth IS FALSE,
    'S2 the reauthorization flag is untouched';
  ASSERT v_failures = 0,
    'S2 the failure evidence is reset';
  ASSERT v_error IS NULL,
    'S2 the last refresh error is cleared';
  ASSERT v_active IS TRUE,
    'S2 the account stays active';
  ASSERT v_metadata = '{"origin":"oauth"}'::jsonb,
    'S2 the account metadata is untouched';

  SELECT c.credential_generation, c.granted_scopes, c.permission_read_state
    INTO v_generation, v_scopes, v_read_state
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_account;
  ASSERT v_generation = 3,
    'S2 the capability generation advanced exactly once';
  ASSERT v_scopes = ARRAY['instagram_basic', 'instagram_manage_insights'],
    'S2 the granted scopes are untouched';
  ASSERT v_read_state = 'ok',
    'S2 the permission read state is untouched';

  -- The User grant is never written.
  SELECT c.token, c.revision, c.token_expires_at, c.provenance_source,
         c.provider_user_id
    INTO v_cred_token, v_cred_revision, v_cred_expiry, v_cred_provenance,
         v_cred_subject
    FROM public.facebook_user_credentials AS c
   WHERE c.id = v_credential;
  ASSERT v_cred_token = 'user-token-1',
    'S2 the User secret is not rotated';
  ASSERT v_cred_revision = 1,
    'S2 the User credential revision is not advanced';
  ASSERT v_cred_expiry = '2099-02-01T00:00:00Z'::TIMESTAMPTZ,
    'S2 the User credential expiry is not written';
  ASSERT v_cred_provenance = 'oauth_exchange',
    'S2 the User credential provenance is not written';
  ASSERT v_cred_subject = 'fb-user-1',
    'S2 the User credential subject is not written';

  -- The unselected siblings keep everything.
  SELECT sa.access_token, sa.token_expires_at, sa.failure_count
    INTO v_sib_token, v_sib_expiry, v_sib_failures
    FROM public.social_accounts AS sa
   WHERE sa.id = v_sibling;
  ASSERT v_sib_token = 'page-token-2',
    'S2 the sibling token is untouched';
  ASSERT v_sib_expiry = '2099-01-03T00:00:00Z'::TIMESTAMPTZ,
    'S2 the sibling expiry is untouched';
  ASSERT v_sib_failures = 0,
    'S2 the sibling health is untouched';
  SELECT c.credential_generation INTO v_sib_generation
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_sibling;
  ASSERT v_sib_generation = 2,
    'S2 no sibling fence was bumped';

  SELECT b.connection_version INTO v_fb_connection
    FROM public.facebook_user_credential_bindings AS b
   WHERE b.social_account_id = v_facebook;
  SELECT f.connection_version INTO v_fb_fence
    FROM public.facebook_user_credential_connection_fences AS f
   WHERE f.social_account_id = v_facebook;
  ASSERT v_fb_connection = 1,
    'S2 the Facebook sibling binding fence was not bumped';
  ASSERT v_fb_fence = 1,
    'S2 the Facebook sibling connection fence was not bumped';

  -- The capture is consumed once and its stored operation is not renamed.
  ASSERT (SELECT c.status FROM public.meta_account_refresh_captures AS c
           WHERE c.id = v_capture) = 'completed',
    'S2 the capture was closed as completed';
  ASSERT (SELECT c.operation FROM public.meta_account_refresh_captures AS c
           WHERE c.id = v_capture) = 'facebook_user_token',
    'S2 the stored capture operation was not renamed';

  -- A closed capture is never writable again.
  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'derived-page-token-2',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-page-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S2 failed: a closed capture was written again'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN
    NULL;
  END;
END
$s2$;

-- ---------------------------------------------------------------------------
-- S3. The positive Facebook Page reconciliation. A Facebook Page has no
--     Instagram capability, its binding carries legitimately null Page and
--     Instagram evidence, its authority is the connection fence, and the
--     reported generation is null.
-- ---------------------------------------------------------------------------
DO $s3$
DECLARE
  v_owner CONSTANT uuid := '0f1b0001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1ba003-0000-4000-8000-000000000013';
  v_sibling CONSTANT uuid := '0f1ba001-0000-4000-8000-000000000011';
  v_credential CONSTANT uuid := '0f1bc001-0000-4000-8000-000000000041';
  v_capture UUID;
  v_result JSONB;
  v_connection BIGINT;
  v_fence BIGINT;
  v_token TEXT;
  v_expiry TIMESTAMPTZ;
  v_cred_token TEXT;
  v_cred_revision BIGINT;
  v_sib_token TEXT;
  v_sib_generation BIGINT;
BEGIN
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  v_result := public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'operation', 'page_reconciliation',
    'fields', jsonb_build_object(
      'access_token', 'derived-fb-token-1',
      'facebook_page_id', 'fb-page-1',
      'instagram_user_id', NULL,
      'token_expires_at', NULL)));

  ASSERT (v_result ->> 'applied')::boolean IS TRUE,
    'S3 the Facebook reconciliation applied';
  ASSERT v_result ->> 'credential_generation' IS NULL,
    'S3 a Facebook Page reports no capability generation';
  ASSERT v_result ->> 'expiry_state' = 'unknown',
    'S3 a Facebook Page reports an unknown expiry';
  ASSERT (v_result ->> 'credential_revision')::bigint = 1,
    'S3 the credential revision is unchanged';
  ASSERT (v_result -> 'account' ->> 'login_kind') IS NULL,
    'S3 a Facebook Page needs no Instagram capability';

  SELECT b.connection_version INTO v_connection
    FROM public.facebook_user_credential_bindings AS b
   WHERE b.social_account_id = v_account;
  SELECT f.connection_version INTO v_fence
    FROM public.facebook_user_credential_connection_fences AS f
   WHERE f.social_account_id = v_account;
  ASSERT v_connection = 2,
    'S3 the binding fence advanced exactly once';
  ASSERT v_fence = 2,
    'S3 the connection fence advanced exactly once';

  SELECT sa.access_token, sa.token_expires_at INTO v_token, v_expiry
    FROM public.social_accounts AS sa
   WHERE sa.id = v_account;
  ASSERT v_token = 'derived-fb-token-1',
    'S3 the derived Page token is the operational token';
  ASSERT v_expiry IS NULL,
    'S3 the operational expiry is unknown';

  SELECT c.token, c.revision INTO v_cred_token, v_cred_revision
    FROM public.facebook_user_credentials AS c
   WHERE c.id = v_credential;
  ASSERT v_cred_token = 'user-token-1',
    'S3 the User secret is not rotated';
  ASSERT v_cred_revision = 1,
    'S3 the User credential revision is not advanced';

  SELECT sa.access_token INTO v_sib_token
    FROM public.social_accounts AS sa
   WHERE sa.id = v_sibling;
  ASSERT v_sib_token = 'derived-page-token-1',
    'S3 the Instagram sibling keeps its reconciled token';
  SELECT c.credential_generation INTO v_sib_generation
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_sibling;
  ASSERT v_sib_generation = 3,
    'S3 the Instagram sibling generation is untouched by the Facebook write';
END
$s3$;

-- ---------------------------------------------------------------------------
-- S4. The explicit null clears a stale operational expiry to unknown, and
--     the failure evidence is reset while the reauthorization flag, the
--     refresh token, the activity and the metadata are preserved.
-- ---------------------------------------------------------------------------
DO $s4$
DECLARE
  v_owner CONSTANT uuid := '0f1b0001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1ba007-0000-4000-8000-000000000017';
  v_capture UUID;
  v_result JSONB;
  v_expiry TIMESTAMPTZ;
  v_failures INTEGER;
  v_error TEXT;
  v_reauth BOOLEAN;
  v_refresh TEXT;
  v_active BOOLEAN;
  v_metadata JSONB;
  v_alert TIMESTAMPTZ;
BEGIN
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  v_result := public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'operation', 'page_reconciliation',
    'fields', jsonb_build_object(
      'access_token', 'derived-stale-token-1',
      'facebook_page_id', 'page-1',
      'instagram_user_id', 'ig-stale-1',
      'token_expires_at', NULL)));

  ASSERT (v_result ->> 'applied')::boolean IS TRUE,
    'S4 the reconciliation applied';

  SELECT sa.token_expires_at, sa.failure_count, sa.last_refresh_error,
         sa.needs_reauth, sa.refresh_token, sa.is_active, sa.account_metadata,
         sa.last_alert_sent_at
    INTO v_expiry, v_failures, v_error, v_reauth, v_refresh, v_active,
         v_metadata, v_alert
    FROM public.social_accounts AS sa
   WHERE sa.id = v_account;

  ASSERT v_expiry IS NULL,
    'S4 the explicit null cleared the stale operational expiry';
  ASSERT v_failures = 0,
    'S4 the failure count was reset';
  ASSERT v_error IS NULL,
    'S4 the last refresh error was cleared';
  ASSERT v_reauth IS TRUE,
    'S4 the reauthorization flag is preserved, not cleared';
  ASSERT v_refresh = 'stale-refresh-1',
    'S4 the refresh token is preserved';
  ASSERT v_active IS TRUE,
    'S4 the account stays active';
  ASSERT v_metadata = '{"origin":"oauth"}'::jsonb,
    'S4 the account metadata is preserved';
  ASSERT v_alert = '2026-01-01T00:00:00Z'::TIMESTAMPTZ,
    'S4 the alert marker is not touched by a success';
END
$s4$;

-- ---------------------------------------------------------------------------
-- S5. The request contract. Exactly three payload keys, exactly four field
--     keys, all four required, an explicit JSON null expiry, no unknown
--     field, and a clean token and provider identifier. Every refusal is
--     MAR01 or MAR06, and none of them touches the capture or the account.
-- ---------------------------------------------------------------------------
DO $s5$
DECLARE
  v_owner CONSTANT uuid := '0f1b0001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1ba002-0000-4000-8000-000000000012';
  v_capture UUID;
  v_before JSONB;
  v_after JSONB;
  v_fields JSONB;
  v_payload JSONB;
  v_state TEXT;
  v_msg TEXT;
  v_edge TEXT;
  v_edges TEXT[];
  v_all TEXT;
BEGIN
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  SELECT jsonb_build_object(
           'token', sa.access_token,
           'expiry', sa.token_expires_at,
           'failures', sa.failure_count,
           'generation', c.credential_generation)
    INTO v_before
    FROM public.social_accounts AS sa
    JOIN public.instagram_account_capabilities AS c
      ON c.social_account_id = sa.id
   WHERE sa.id = v_account;

  v_fields := jsonb_build_object(
    'access_token', 'a-clean-token',
    'facebook_page_id', 'page-1',
    'instagram_user_id', 'ig-page-2',
    'token_expires_at', NULL);

  -- The well-formed request is the control: it is refused only because the
  -- capture is consumed by S6's sibling tests later, so it is exercised
  -- here as a shape reference and its capture is re-taken afterwards.
  v_payload := jsonb_build_object(
    'capture_id', v_capture,
    'operation', 'page_reconciliation',
    'fields', v_fields);

  -- An unknown top-level key.
  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner,
      v_payload || jsonb_build_object('unexpected', TRUE));
    RAISE EXCEPTION 'S5 failed: an unknown payload key was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  -- A missing capture id.
  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner,
      (v_payload - 'capture_id'));
    RAISE EXCEPTION 'S5 failed: a missing capture id was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  -- A capture id that is not a string, and one that is not a uuid.
  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner,
      v_payload || jsonb_build_object('capture_id', 17));
    RAISE EXCEPTION 'S5 failed: a numeric capture id was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner,
      v_payload || jsonb_build_object('capture_id', 'not-a-uuid'));
    RAISE EXCEPTION 'S5 failed: a malformed capture id was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  -- A missing operation, and a null operation.
  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner,
      (v_payload - 'operation'));
    RAISE EXCEPTION 'S5 failed: a missing operation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner,
      v_payload || jsonb_build_object('operation', NULL));
    RAISE EXCEPTION 'S5 failed: a null operation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  -- Another writer's operation is refused with the operation class, not the
  -- payload class.
  FOREACH v_state IN ARRAY ARRAY[
    'page_token', 'facebook_user_token', 'direct_token', 'Page_Reconciliation'
  ] LOOP
    BEGIN
      PERFORM public.write_meta_page_reconciliation_success(v_owner,
        v_payload || jsonb_build_object('operation', v_state));
      RAISE EXCEPTION 'S5 failed: the operation % was accepted', v_state
        USING ERRCODE = 'assert_failure';
    EXCEPTION WHEN SQLSTATE 'MAR06' THEN NULL;
    END;
  END LOOP;

  -- A missing fields object, and a fields object that is not an object.
  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner,
      (v_payload - 'fields'));
    RAISE EXCEPTION 'S5 failed: a missing fields object was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner,
      v_payload || jsonb_build_object('fields', 'not-an-object'));
    RAISE EXCEPTION 'S5 failed: a non-object fields was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  -- Every field is required. A missing property is not a null.
  FOREACH v_state IN ARRAY ARRAY[
    'access_token', 'facebook_page_id', 'instagram_user_id', 'token_expires_at'
  ] LOOP
    BEGIN
      PERFORM public.write_meta_page_reconciliation_success(v_owner,
        v_payload || jsonb_build_object(
          'fields', v_fields - v_state));
      RAISE EXCEPTION 'S5 failed: the missing field % was accepted', v_state
        USING ERRCODE = 'assert_failure';
    EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
    END;
  END LOOP;

  -- The expiry must be an explicit JSON null. A timestamp, a number and a
  -- boolean are all refused: this contract has no known-expiry support.
  FOREACH v_state IN ARRAY ARRAY[
    '2099-01-01T00:00:00Z', '2099-01-01T00:00:00+00:00'
  ] LOOP
    BEGIN
      PERFORM public.write_meta_page_reconciliation_success(v_owner,
        v_payload || jsonb_build_object(
          'fields', v_fields || jsonb_build_object('token_expires_at', v_state)));
      RAISE EXCEPTION 'S5 failed: a supplied expiry was accepted'
        USING ERRCODE = 'assert_failure';
    EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
    END;
  END LOOP;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner,
      v_payload || jsonb_build_object(
        'fields', v_fields || jsonb_build_object('token_expires_at', 1)));
    RAISE EXCEPTION 'S5 failed: a numeric expiry was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  -- No other field is accepted: not a refresh token, not a User credential,
  -- not an account id, not a health field, not scopes, not metadata.
  FOREACH v_state IN ARRAY ARRAY[
    'refresh_token', 'user_token', 'token', 'credential_id', 'social_account_id',
    'account_id', 'needs_reauth', 'failure_count', 'last_refresh_error',
    'is_active', 'granted_scopes', 'scopes', 'account_metadata',
    'provider_user_id', 'expiry_state'
  ] LOOP
    BEGIN
      PERFORM public.write_meta_page_reconciliation_success(v_owner,
        v_payload || jsonb_build_object(
          'fields', v_fields || jsonb_build_object(v_state, 'x')));
      RAISE EXCEPTION 'S5 failed: the field % was accepted', v_state
        USING ERRCODE = 'assert_failure';
    EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
    END;
  END LOOP;

  -- The token must be a clean literal. The control characters are
  -- built with chr() so this fixture file stays printable.
  FOREACH v_state IN ARRAY ARRAY[
    '',
    ' leading-space',
    'trailing-space ',
    'line' || chr(10) || 'break',
    'tab' || chr(9) || 'character',
    'del' || chr(127) || 'character'
  ] LOOP
    BEGIN
      PERFORM public.write_meta_page_reconciliation_success(v_owner,
        v_payload || jsonb_build_object(
          'fields', v_fields || jsonb_build_object('access_token', v_state)));
      RAISE EXCEPTION 'S5 failed: an unclean token was accepted'
        USING ERRCODE = 'assert_failure';
    EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
    END;
  END LOOP;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner,
      v_payload || jsonb_build_object(
        'fields', v_fields || jsonb_build_object(
          'access_token', repeat('t', 4097))));
    RAISE EXCEPTION 'S5 failed: an over-long token was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner,
      v_payload || jsonb_build_object(
        'fields', v_fields || jsonb_build_object('access_token', 17)));
    RAISE EXCEPTION 'S5 failed: a numeric token was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  -- The provider identifiers must be clean and bounded. A numeric-only
  -- restriction is deliberately NOT applied: a provider identifier is not
  -- guaranteed to be a number.
  FOREACH v_state IN ARRAY ARRAY['', ' leading-space', 'trailing-space '] LOOP
    BEGIN
      PERFORM public.write_meta_page_reconciliation_success(v_owner,
        v_payload || jsonb_build_object(
          'fields', v_fields || jsonb_build_object('facebook_page_id', v_state)));
      RAISE EXCEPTION 'S5 failed: an unclean Page identifier was accepted'
        USING ERRCODE = 'assert_failure';
    EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
    END;
  END LOOP;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner,
      v_payload || jsonb_build_object(
        'fields', v_fields || jsonb_build_object(
          'facebook_page_id', repeat('p', 129))));
    RAISE EXCEPTION 'S5 failed: an over-long Page identifier was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner,
      v_payload || jsonb_build_object(
        'fields', v_fields || jsonb_build_object('facebook_page_id', 17)));
    RAISE EXCEPTION 'S5 failed: a numeric Page identifier was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner,
      v_payload || jsonb_build_object(
        'fields', v_fields || jsonb_build_object('instagram_user_id', 17)));
    RAISE EXCEPTION 'S5 failed: a numeric Instagram identifier was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  -- A null owner is refused before anything is read.
  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(NULL, v_payload);
    RAISE EXCEPTION 'S5 failed: a null owner was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  -- A payload that is not an object at all.
  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, '"nope"'::JSONB);
    RAISE EXCEPTION 'S5 failed: a non-object payload was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  -- ECMAScript trim edges, at both ends and as a whitespace-only value.
  -- btrim() with no character set removes only U+0020, so NBSP and BOM at
  -- the edge used to be accepted. The refusal is MAR01, before any identity
  -- comparison, and the submitted literal is not repaired. The code point
  -- in the message is the edge character, never the credential.
  v_edges := ARRAY[
    chr(9), chr(10), chr(11), chr(12), chr(13),
    chr(32), chr(160), chr(5760),
    chr(8192), chr(8193), chr(8194), chr(8195), chr(8196),
    chr(8197), chr(8198), chr(8199), chr(8200), chr(8201), chr(8202),
    chr(8232), chr(8233), chr(8239), chr(8287), chr(12288),
    chr(65279)
  ];
  v_all := '';
  FOREACH v_edge IN ARRAY v_edges LOOP
    v_all := v_all || v_edge;
    FOREACH v_state IN ARRAY ARRAY[
      v_edge || 'core-token', 'core-token' || v_edge, v_edge
    ] LOOP
      BEGIN
        PERFORM public.write_meta_page_reconciliation_success(v_owner,
          v_payload || jsonb_build_object(
            'fields', v_fields || jsonb_build_object('access_token', v_state)));
        RAISE EXCEPTION 'S5 failed: token edge U+%s was accepted',
          to_hex(ascii(v_edge))
          USING ERRCODE = 'assert_failure';
      EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
      END;
    END LOOP;

    FOREACH v_state IN ARRAY ARRAY[
      v_edge || 'page-1', 'page-1' || v_edge, v_edge
    ] LOOP
      BEGIN
        PERFORM public.write_meta_page_reconciliation_success(v_owner,
          v_payload || jsonb_build_object(
            'fields', v_fields || jsonb_build_object('facebook_page_id', v_state)));
        RAISE EXCEPTION 'S5 failed: Page identifier edge U+%s was accepted',
          to_hex(ascii(v_edge))
          USING ERRCODE = 'assert_failure';
      EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
      END;
    END LOOP;

    FOREACH v_state IN ARRAY ARRAY[
      v_edge || 'ig-page-2', 'ig-page-2' || v_edge, v_edge
    ] LOOP
      BEGIN
        PERFORM public.write_meta_page_reconciliation_success(v_owner,
          v_payload || jsonb_build_object(
            'fields', v_fields || jsonb_build_object('instagram_user_id', v_state)));
        RAISE EXCEPTION 'S5 failed: Instagram identifier edge U+%s was accepted',
          to_hex(ascii(v_edge))
          USING ERRCODE = 'assert_failure';
      EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
      END;
    END LOOP;
  END LOOP;

  -- The whole trim set, and NBSP beside BOM, is still edge whitespace.
  FOREACH v_state IN ARRAY ARRAY[
    v_all,
    chr(160) || chr(65279) || 'core-token',
    'core-token' || chr(65279) || chr(160)
  ] LOOP
    BEGIN
      PERFORM public.write_meta_page_reconciliation_success(v_owner,
        v_payload || jsonb_build_object(
          'fields', v_fields || jsonb_build_object('access_token', v_state)));
      RAISE EXCEPTION 'S5 failed: a mixed token edge was accepted'
        USING ERRCODE = 'assert_failure';
    EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
    END;
  END LOOP;

  FOREACH v_state IN ARRAY ARRAY[
    v_all,
    chr(160) || chr(65279) || 'page-1',
    'page-1' || chr(65279) || chr(160)
  ] LOOP
    BEGIN
      PERFORM public.write_meta_page_reconciliation_success(v_owner,
        v_payload || jsonb_build_object(
          'fields', v_fields || jsonb_build_object('facebook_page_id', v_state)));
      RAISE EXCEPTION 'S5 failed: a mixed Page identifier edge was accepted'
        USING ERRCODE = 'assert_failure';
    EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
    END;
  END LOOP;

  FOREACH v_state IN ARRAY ARRAY[
    v_all,
    chr(160) || chr(65279) || 'ig-page-2',
    'ig-page-2' || chr(65279) || chr(160)
  ] LOOP
    BEGIN
      PERFORM public.write_meta_page_reconciliation_success(v_owner,
        v_payload || jsonb_build_object(
          'fields', v_fields || jsonb_build_object('instagram_user_id', v_state)));
      RAISE EXCEPTION 'S5 failed: a mixed Instagram identifier edge was accepted'
        USING ERRCODE = 'assert_failure';
    EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
    END;
  END LOOP;

  -- None of the refusals touched the capture or the account.
  ASSERT (SELECT c.status FROM public.meta_account_refresh_captures AS c
           WHERE c.id = v_capture) = 'open',
    'S5 the refused requests left the capture open';

  SELECT jsonb_build_object(
           'token', sa.access_token,
           'expiry', sa.token_expires_at,
           'failures', sa.failure_count,
           'generation', c.credential_generation)
    INTO v_after
    FROM public.social_accounts AS sa
    JOIN public.instagram_account_capabilities AS c
      ON c.social_account_id = sa.id
   WHERE sa.id = v_account;
  ASSERT v_after = v_before,
    'S5 the refused requests changed nothing';
END
$s5$;

-- ---------------------------------------------------------------------------
-- S5b. The same boundary, asked of the helpers themselves. A writer that
--      stopped calling them would still be caught by S5; a helper that
--      drifted from the writer would be caught here. MAR01 is required:
--      another exception is not a pass. Valid literals come back unchanged,
--      including an interior NBSP and a non-trim character. A numeric-looking
--      identifier is opaque text, not a number to reject.
-- ---------------------------------------------------------------------------
DO $s5b$
DECLARE
  v_edge TEXT;
  v_edges TEXT[];
  v_all TEXT := '';
  v_state TEXT;
  v_literal TEXT;
  v_id TEXT;
  v_zw TEXT;
  v_max TEXT;
BEGIN
  v_edges := ARRAY[
    chr(9), chr(10), chr(11), chr(12), chr(13),
    chr(32), chr(160), chr(5760),
    chr(8192), chr(8193), chr(8194), chr(8195), chr(8196),
    chr(8197), chr(8198), chr(8199), chr(8200), chr(8201), chr(8202),
    chr(8232), chr(8233), chr(8239), chr(8287), chr(12288),
    chr(65279)
  ];

  FOREACH v_edge IN ARRAY v_edges LOOP
    v_all := v_all || v_edge;
    FOREACH v_state IN ARRAY ARRAY[
      v_edge || 'core-token', 'core-token' || v_edge, v_edge
    ] LOOP
      BEGIN
        PERFORM public.meta_page_reconciliation_require_token(v_state);
        RAISE EXCEPTION 'S5b failed: token edge U+%s was accepted',
          to_hex(ascii(v_edge))
          USING ERRCODE = 'assert_failure';
      EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
      END;
    END LOOP;

    FOREACH v_state IN ARRAY ARRAY[
      v_edge || 'page-1', 'page-1' || v_edge, v_edge
    ] LOOP
      BEGIN
        PERFORM public.meta_page_reconciliation_require_identifier(
          v_state, 'facebook_page_id');
        RAISE EXCEPTION 'S5b failed: identifier edge U+%s was accepted',
          to_hex(ascii(v_edge))
          USING ERRCODE = 'assert_failure';
      EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
      END;
    END LOOP;
  END LOOP;

  BEGIN
    PERFORM public.meta_page_reconciliation_require_token(v_all);
    RAISE EXCEPTION 'S5b failed: a whitespace-only token was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  BEGIN
    PERFORM public.meta_page_reconciliation_require_identifier(v_all, 'instagram_user_id');
    RAISE EXCEPTION 'S5b failed: a whitespace-only identifier was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  BEGIN
    PERFORM public.meta_page_reconciliation_require_token('a' || chr(10) || 'b');
    RAISE EXCEPTION 'S5b failed: an interior control was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  BEGIN
    PERFORM public.meta_page_reconciliation_require_token('a' || chr(127) || 'b');
    RAISE EXCEPTION 'S5b failed: an interior DEL was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  v_literal := 'paired-' || chr(160) || 'literal-' || chr(233);
  ASSERT public.meta_page_reconciliation_require_token(v_literal) = v_literal,
    'S5b an interior NBSP beside a non-trim character is preserved';
  ASSERT convert_to(public.meta_page_reconciliation_require_token(v_literal), 'UTF8')
       = convert_to(v_literal, 'UTF8'),
    'S5b the preserved token is the same UTF-8 bytes';
  ASSERT position(chr(160) IN public.meta_page_reconciliation_require_token(v_literal)) > 1,
    'S5b the preserved NBSP is not an edge';

  v_id := 'ig-' || chr(160) || 'opaque-' || chr(233);
  ASSERT public.meta_page_reconciliation_require_identifier(v_id, 'instagram_user_id') = v_id,
    'S5b an interior NBSP in an opaque identifier is preserved';
  ASSERT convert_to(
           public.meta_page_reconciliation_require_identifier(v_id, 'instagram_user_id'),
           'UTF8') = convert_to(v_id, 'UTF8'),
    'S5b the preserved identifier is the same UTF-8 bytes';
  ASSERT public.meta_page_reconciliation_require_identifier('17', 'facebook_page_id') = '17',
    'S5b a numeric-looking identifier is not refused';
  ASSERT public.meta_page_reconciliation_require_token('a-clean-token') = 'a-clean-token',
    'S5b a clean token literal is preserved';

  -- U+200B is not in the trim set. Banning it would be a new character rule.
  v_zw := chr(8203) || 'token' || chr(8203);
  ASSERT public.meta_page_reconciliation_require_token(v_zw) = v_zw,
    'S5b a non-trim format character at the edge is preserved';
  ASSERT public.meta_page_reconciliation_require_identifier(
           chr(8203) || 'id' || chr(8203), 'facebook_page_id')
       = chr(8203) || 'id' || chr(8203),
    'S5b a non-trim format character around an identifier is preserved';

  v_max := repeat('t', 4096);
  ASSERT public.meta_page_reconciliation_require_token(v_max) = v_max,
    'S5b a 4096-character token is preserved';
  BEGIN
    PERFORM public.meta_page_reconciliation_require_token(repeat('t', 4097));
    RAISE EXCEPTION 'S5b failed: an over-long token was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;

  v_max := repeat('p', 128);
  ASSERT public.meta_page_reconciliation_require_identifier(v_max, 'facebook_page_id') = v_max,
    'S5b a 128-character identifier is preserved';
  BEGIN
    PERFORM public.meta_page_reconciliation_require_identifier(repeat('p', 129), 'facebook_page_id');
    RAISE EXCEPTION 'S5b failed: an over-long identifier was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR01' THEN NULL;
  END;
END
$s5b$;

-- ---------------------------------------------------------------------------
-- S6. The authority. Ownership, capture state, operation, target count,
--     eligibility, membership, versions and the captured User expiry.
-- ---------------------------------------------------------------------------
DO $s6$
DECLARE
  v_owner CONSTANT uuid := '0f1b0001-0000-4000-8000-000000000001';
  v_other CONSTANT uuid := '0f1b0002-0000-4000-8000-000000000002';
  v_account CONSTANT uuid := '0f1ba009-0000-4000-8000-000000000019';
  v_sibling CONSTANT uuid := '0f1ba010-0000-4000-8000-000000000020';
  v_newmember CONSTANT uuid := '0f1ba014-0000-4000-8000-000000000014';
  v_deleted CONSTANT uuid := '0f1ba015-0000-4000-8000-000000000015';
  v_inactive CONSTANT uuid := '0f1ba006-0000-4000-8000-000000000016';
  v_direct CONSTANT uuid := '0f1ba005-0000-4000-8000-000000000015';
  v_expired_user CONSTANT uuid := '0f1ba013-0000-4000-8000-000000000023';
  v_credential CONSTANT uuid := '0f1bc001-0000-4000-8000-000000000041';
  v_capture UUID;
  v_foreign UUID;
  v_before JSONB;
  v_after JSONB;
  v_msg TEXT;
BEGIN
  -- An unknown capture id.
  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', '0f9c9999-0000-4000-8000-000000000099',
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-member-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S6 failed: an unknown capture was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR02' THEN NULL;
  END;

  -- Another owner's capture is refused structurally, even for its owner.
  v_foreign := (public.begin_meta_account_refresh(v_other, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', '0f1bb001-0000-4000-8000-000000000031',
      'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_foreign,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-b',
        'instagram_user_id', 'ig-page-b',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S6 failed: a foreign capture was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR02' THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%owner%',
      format('S6 the refusal names the owner (got %s)', v_msg);
  END;

  -- A capture of another operation is refused with the operation class.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'page_token'))))
    ->> 'capture_id')::uuid;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-member-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S6 failed: a page operational capture was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR06' THEN NULL;
  END;

  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_direct, 'operation', 'direct_token'))))
    ->> 'capture_id')::uuid;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-direct-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S6 failed: a direct capture was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR06' THEN NULL;
  END;

  -- A capture that names several explicit targets is not eligible for this
  -- single-target operation.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(
      jsonb_build_object('social_account_id', v_account, 'operation', 'facebook_user_token'),
      jsonb_build_object('social_account_id', v_sibling, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-member-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S6 failed: a multi-target capture was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR03' THEN NULL;
  END;

  -- An inactive target is not reconciled and is never reactivated. The
  -- capture is taken while the account is still active, so the refusal
  -- belongs to the writer, not to the capture.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_inactive, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  UPDATE public.social_accounts SET is_active = false WHERE id = v_inactive;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-inactive-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S6 failed: an inactive target was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR03' THEN NULL;
  END;

  ASSERT (SELECT sa.is_active FROM public.social_accounts AS sa
           WHERE sa.id = v_inactive) IS FALSE,
    'S6 the refusal did not reactivate the account';

  UPDATE public.social_accounts SET is_active = true WHERE id = v_inactive;

  -- The capture itself refuses an ineligible account, so no capture exists
  -- for a deactivated target.
  UPDATE public.social_accounts SET is_active = false WHERE id = v_inactive;

  BEGIN
    PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
      'accounts', jsonb_build_array(jsonb_build_object(
        'social_account_id', v_inactive, 'operation', 'facebook_user_token'))));
    RAISE EXCEPTION 'S6 failed: a deactivated account was captured'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR03' THEN NULL;
  END;

  UPDATE public.social_accounts SET is_active = true WHERE id = v_inactive;

  -- A deleted target is gone.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_deleted, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  DELETE FROM public.social_accounts WHERE id = v_deleted;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-deleted-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S6 failed: a deleted target was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR02' THEN NULL;
  END;

  -- A member that LEFT the grant after the capture is a refusal.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  DELETE FROM public.facebook_user_credential_bindings
   WHERE social_account_id = v_sibling;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-member-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S6 failed: a changed membership was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  -- A member that JOINED the grant after the capture is a refusal too.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  INSERT INTO public.facebook_user_credential_bindings (
    social_account_id, user_id, platform, credential_id,
    verified_facebook_user_id, verified_facebook_page_id, verified_instagram_user_id,
    evidence_source, connection_version
  ) VALUES (
    v_newmember, v_owner, 'instagram', v_credential,
    'fb-user-1', 'page-1', 'ig-newmember-1', 'oauth_exchange', 1);

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-member-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S6 failed: an enlarged membership was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  -- A credential revision that moved after the capture is a refusal.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  UPDATE public.facebook_user_credentials
     SET revision = revision + 1
   WHERE id = v_credential;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-member-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S6 failed: a moved credential revision was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  -- A binding connection version that moved after the capture is a refusal.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  UPDATE public.facebook_user_credential_bindings
     SET connection_version = connection_version + 1
   WHERE social_account_id = v_account;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-member-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S6 failed: a moved binding version was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  -- A capability generation that moved after the capture is a refusal.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  UPDATE public.instagram_account_capabilities
     SET credential_generation = credential_generation + 1
   WHERE social_account_id = v_account;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-member-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S6 failed: a moved capability generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  -- A provider subject that moved after the capture is a refusal.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  UPDATE public.facebook_user_credentials
     SET provider_user_id = 'fb-user-moved'
   WHERE id = v_credential;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-member-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S6 failed: a moved provider subject was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  -- A captured User expiry that no longer describes the live grant is a
  -- refusal. An unknown expiry is never turned into a known one.
  UPDATE public.facebook_user_credentials
     SET provider_user_id = 'fb-user-1'
   WHERE id = v_credential;

  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  UPDATE public.facebook_user_credentials
     SET token_expires_at = '2099-03-01T00:00:00Z'
   WHERE id = v_credential;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-member-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S6 failed: a moved User expiry was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  -- A KNOWN captured User expiry that has already passed is a refusal. The
  -- grant is dead; the reconciliation is not the path that renews it.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_expired_user, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-3',
        'instagram_user_id', 'ig-expired-user-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S6 failed: an expired User grant was reconciled'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR07' THEN NULL;
  END;

  -- An expired capture is refused.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  UPDATE public.meta_account_refresh_captures
     SET captured_at = clock_timestamp() - INTERVAL '1 hour',
         expires_at = clock_timestamp() - INTERVAL '1 minute'
   WHERE id = v_capture;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-member-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S6 failed: an expired capture was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  -- A superseded capture is refused. The newest attempt wins.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  PERFORM public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))));

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-member-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S6 failed: a superseded capture was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;
END
$s6$;

-- ---------------------------------------------------------------------------
-- S7. The protected identity. The service may only assert an identity the
--     locked binding already proves. Missing evidence refuses; it is never
--     bootstrapped.
-- ---------------------------------------------------------------------------
DO $s7$
DECLARE
  v_owner CONSTANT uuid := '0f1b0001-0000-4000-8000-000000000001';
  v_migrated CONSTANT uuid := '0f1ba004-0000-4000-8000-000000000014';
  v_userdrift CONSTANT uuid := '0f1ba011-0000-4000-8000-000000000021';
  v_canon CONSTANT uuid := '0f1ba012-0000-4000-8000-000000000022';
  v_account CONSTANT uuid := '0f1ba001-0000-4000-8000-000000000011';
  v_facebook CONSTANT uuid := '0f1ba003-0000-4000-8000-000000000013';
  v_capture UUID;
  v_before JSONB;
  v_after JSONB;
BEGIN
  SELECT jsonb_build_object(
           'token', sa.access_token,
           'expiry', sa.token_expires_at,
           'failures', sa.failure_count)
    INTO v_before
    FROM public.social_accounts AS sa
   WHERE sa.id = v_account;

  -- The submitted Page identity must equal the binding's verified Page.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'another-page',
        'instagram_user_id', 'ig-page-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S7 failed: a wrong Page identity was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  -- The submitted Instagram identity must equal the binding's verified
  -- Instagram identity.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'another-instagram',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S7 failed: a wrong Instagram identity was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  -- An Instagram target may not be reconciled with a null identity.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', NULL,
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S7 failed: a null Instagram identity was accepted for Instagram'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  -- A binding with no verified identity at all is missing evidence, not an
  -- empty string to match. It is never bootstrapped.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_migrated, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-migrated-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S7 failed: missing protected evidence was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  -- A binding that names another Facebook User is contradictory evidence.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_userdrift, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-userdrift-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S7 failed: a contradictory Facebook User identity was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  -- The submitted Instagram identity must equal the CAPTURED canonical
  -- identity as well as the binding's verified identity.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_canon, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-page-9',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S7 failed: an identity that is not the captured one was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  -- A Facebook Page carries no Instagram identity.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_facebook, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'fb-page-1',
        'instagram_user_id', 'ig-page-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S7 failed: a Facebook Page with an Instagram identity was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  -- A Facebook Page with a wrong Page identity is refused.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_facebook, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'another-page',
        'instagram_user_id', NULL,
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S7 failed: a Facebook Page with a wrong Page identity was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  -- None of the refusals changed the selected account.
  SELECT jsonb_build_object(
           'token', sa.access_token,
           'expiry', sa.token_expires_at,
           'failures', sa.failure_count)
    INTO v_after
    FROM public.social_accounts AS sa
   WHERE sa.id = v_account;
  ASSERT v_after = v_before,
    'S7 the refused identities changed nothing';
END
$s7$;

-- ---------------------------------------------------------------------------
-- S8. The unknown User expiry. It is not invented into a validity proof:
--     the reconciliation succeeds, the User expiry stays unknown, and the
--     operational expiry is unknown too.
-- ---------------------------------------------------------------------------
DO $s8$
DECLARE
  v_owner CONSTANT uuid := '0f1b0001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1ba008-0000-4000-8000-000000000018';
  v_credential CONSTANT uuid := '0f1bc002-0000-4000-8000-000000000042';
  v_capture UUID;
  v_result JSONB;
  v_expiry TIMESTAMPTZ;
  v_account_expiry TIMESTAMPTZ;
BEGIN
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  v_result := public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'operation', 'page_reconciliation',
    'fields', jsonb_build_object(
      'access_token', 'derived-grant2-token-1',
      'facebook_page_id', 'page-2',
      'instagram_user_id', 'ig-grant2-1',
      'token_expires_at', NULL)));

  ASSERT (v_result ->> 'applied')::boolean IS TRUE,
    'S8 an unknown User expiry does not block the reconciliation';
  ASSERT v_result ->> 'expiry_state' = 'unknown',
    'S8 the operational expiry is reported as unknown';

  SELECT c.token_expires_at INTO v_expiry
    FROM public.facebook_user_credentials AS c
   WHERE c.id = v_credential;
  ASSERT v_expiry IS NULL,
    'S8 the unknown User expiry was not invented into a known one';

  SELECT sa.token_expires_at INTO v_account_expiry
    FROM public.social_accounts AS sa
   WHERE sa.id = v_account;
  ASSERT v_account_expiry IS NULL,
    'S8 the operational expiry is unknown';
END
$s8$;

-- ---------------------------------------------------------------------------
-- S9. The competition. A successful reconciliation closes the capture, and
--     neither the accepted success writer nor the accepted failure writer
--     can consume it afterwards. The reverse order is refused too.
-- ---------------------------------------------------------------------------
DO $s9$
DECLARE
  v_owner CONSTANT uuid := '0f1b0001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1ba001-0000-4000-8000-000000000011';
  v_capture UUID;
  v_result JSONB;
BEGIN
  -- The accepted shared-grant writer consumes the capture first.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  v_result := public.write_meta_account_refresh_success(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'operation', 'facebook_user_token',
    'fields', jsonb_build_object('token', 'rotated-user-token')));

  ASSERT (v_result ->> 'applied')::boolean IS TRUE,
    'S9 the accepted shared-grant writer still works';

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-page-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S9 failed: a consumed capture was reconciled'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;

  -- The accepted failure writer consumes the capture first.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  v_result := public.record_meta_refresh_failure(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'social_account_id', v_account,
    'error_category', 'provider_transient'));

  ASSERT (v_result ->> 'applied')::boolean IS TRUE,
    'S9 the accepted failure writer still works';

  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', v_capture,
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-page-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S9 failed: a failed capture was reconciled'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'MAR04' THEN NULL;
  END;
END
$s9$;

-- ---------------------------------------------------------------------------
-- S10. A success produces no outbox row and no alert marker. The accepted
--      failure path is unchanged: it still produces exactly one event.
-- ---------------------------------------------------------------------------
DO $s10$
DECLARE
  v_owner CONSTANT uuid := '0f1b0001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1ba002-0000-4000-8000-000000000012';
  v_capture UUID;
  v_outbox_before INTEGER;
  v_outbox_after INTEGER;
  v_outbox INTEGER;
  v_result JSONB;
BEGIN
  SELECT count(*) INTO v_outbox_before
    FROM public.partner_webhook_deliveries;

  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  v_result := public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'operation', 'page_reconciliation',
    'fields', jsonb_build_object(
      'access_token', 'derived-page-token-2',
      'facebook_page_id', 'page-1',
      'instagram_user_id', 'ig-page-2',
      'token_expires_at', NULL)));

  ASSERT (v_result ->> 'applied')::boolean IS TRUE,
    'S10 the reconciliation applied';

  SELECT count(*) INTO v_outbox_after
    FROM public.partner_webhook_deliveries;
  ASSERT v_outbox_after = v_outbox_before,
    'S10 a success enqueued no outbox row';

  -- The accepted failure path still produces exactly one event.
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  v_result := public.record_meta_refresh_failure(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'social_account_id', v_account,
    'error_category', 'provider_auth_revoked'));

  SELECT count(*) INTO v_outbox
    FROM public.partner_webhook_deliveries AS d
   WHERE d.event_type = 'account.reauthorization_required'
     AND d.payload ->> 'account_id' = 'acc_' || v_account::text;
  ASSERT v_outbox = 1,
    'S10 the accepted failure path still produces exactly one event';
END
$s10$;

-- ---------------------------------------------------------------------------
-- S11. The browser denial and the service grant. The catalog says anon and
--      authenticated may not execute the writer; this proves it by trying.
-- ---------------------------------------------------------------------------
DO $s11$
DECLARE
  v_owner CONSTANT uuid := '0f1b0001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1ba001-0000-4000-8000-000000000011';
  v_capture UUID;
  v_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', '00000000-0000-4000-8000-000000000001',
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-page-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S11 failed: anon executed the reconciliation writer'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
      'capture_id', '00000000-0000-4000-8000-000000000001',
      'operation', 'page_reconciliation',
      'fields', jsonb_build_object(
        'access_token', 'a-clean-token',
        'facebook_page_id', 'page-1',
        'instagram_user_id', 'ig-page-1',
        'token_expires_at', NULL)));
    RAISE EXCEPTION 'S11 failed: authenticated executed the reconciliation writer'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  RESET ROLE;

  -- The service role reaches it and the reconciliation applies.
  EXECUTE 'SET LOCAL ROLE service_role';
  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  v_result := public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'operation', 'page_reconciliation',
    'fields', jsonb_build_object(
      'access_token', 'derived-service-token-1',
      'facebook_page_id', 'page-1',
      'instagram_user_id', 'ig-page-1',
      'token_expires_at', NULL)));

  ASSERT (v_result ->> 'applied')::boolean IS TRUE,
    'S11 the service role reconciled the Page token';

  RESET ROLE;
END
$s11$;

-- ---------------------------------------------------------------------------
-- S12. The stored capture operation is unchanged. The discriminator selects
--      this writer; it does not extend the accepted operation enum.
-- ---------------------------------------------------------------------------
DO $s12$
DECLARE
  v_n INTEGER;
BEGIN
  BEGIN
    INSERT INTO public.meta_account_refresh_captures (
      user_id, capture_version, operation, status, captured_at, expires_at, capture
    ) VALUES (
      '0f1b0001-0000-4000-8000-000000000001', 1, 'page_reconciliation', 'open',
      clock_timestamp(), clock_timestamp() + INTERVAL '30 minutes', '{}'::jsonb
    );
    RAISE EXCEPTION 'S12 failed: a new capture operation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  SELECT count(*) INTO v_n
    FROM pg_constraint AS c
    JOIN pg_class AS r ON r.oid = c.conrelid
    JOIN pg_namespace AS n ON n.oid = r.relnamespace
   WHERE n.nspname = 'public'
     AND r.relname = 'meta_account_refresh_captures'
     AND c.conname = 'meta_account_refresh_captures_operation_chk'
     AND pg_get_constraintdef(c.oid) LIKE '%facebook_user_token%';
  ASSERT v_n = 1,
    'S12 the accepted operation constraint is still in place';
END
$s12$;

-- ---------------------------------------------------------------------------
-- S13. The paired literal. The same NBSP that S5 refuses at an edge is
--      stored byte for byte when it sits inside an otherwise clean token.
--      The identifiers stay the locked binding values. The User grant and
--      every unselected account stay as they were.
-- ---------------------------------------------------------------------------
DO $s13$
DECLARE
  v_owner CONSTANT uuid := '0f1b0001-0000-4000-8000-000000000001';
  v_account CONSTANT uuid := '0f1ba002-0000-4000-8000-000000000012';
  v_credential CONSTANT uuid := '0f1bc001-0000-4000-8000-000000000041';
  v_literal CONSTANT TEXT := 'paired-' || chr(160) || 'literal-' || chr(233);
  v_capture UUID;
  v_result JSONB;
  v_stored TEXT;
  v_gen_before BIGINT;
  v_gen_after BIGINT;
  v_sib_before TEXT;
  v_sib_after TEXT;
  v_user_before TEXT;
  v_user_after TEXT;
  v_keep_before JSONB;
  v_keep_after JSONB;
BEGIN
  SELECT c.credential_generation INTO v_gen_before
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_account;

  SELECT md5(jsonb_agg(to_jsonb(sa) ORDER BY sa.id)::TEXT) INTO v_sib_before
    FROM public.social_accounts AS sa
   WHERE sa.user_id = v_owner
     AND sa.id <> v_account;

  SELECT md5(to_jsonb(c)::TEXT) INTO v_user_before
    FROM public.facebook_user_credentials AS c
   WHERE c.id = v_credential;

  SELECT jsonb_build_object(
           'refresh', sa.refresh_token,
           'reauth', sa.needs_reauth,
           'active', sa.is_active,
           'metadata', sa.account_metadata)
    INTO v_keep_before
    FROM public.social_accounts AS sa
   WHERE sa.id = v_account;

  v_capture := (public.begin_meta_account_refresh(v_owner, jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'social_account_id', v_account, 'operation', 'facebook_user_token'))))
    ->> 'capture_id')::uuid;

  v_result := public.write_meta_page_reconciliation_success(v_owner, jsonb_build_object(
    'capture_id', v_capture,
    'operation', 'page_reconciliation',
    'fields', jsonb_build_object(
      'access_token', v_literal,
      'facebook_page_id', 'page-1',
      'instagram_user_id', 'ig-page-2',
      'token_expires_at', NULL)));

  ASSERT (v_result ->> 'applied')::boolean IS TRUE,
    'S13 the interior-NBSP literal was reconciled';
  ASSERT v_result ->> 'expiry_state' = 'unknown',
    'S13 the expiry stays unknown';
  ASSERT (v_result ->> 'credential_generation')::BIGINT = v_gen_before + 1,
    'S13 the selected generation advanced once';

  SELECT sa.access_token INTO v_stored
    FROM public.social_accounts AS sa
   WHERE sa.id = v_account;
  ASSERT v_stored = v_literal,
    format('S13 the stored token bytes differ (stored %s, literal %s)',
      octet_length(v_stored), octet_length(v_literal));
  ASSERT convert_to(v_stored, 'UTF8') = convert_to(v_literal, 'UTF8'),
    'S13 the stored token is the submitted UTF-8 bytes';
  ASSERT position(chr(160) IN v_stored) > 1
     AND position(chr(160) IN v_stored) < char_length(v_stored),
    'S13 the stored NBSP is interior';

  SELECT c.credential_generation INTO v_gen_after
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_account;
  ASSERT v_gen_after = v_gen_before + 1,
    'S13 the capability generation advanced once';

  ASSERT (SELECT c.status FROM public.meta_account_refresh_captures AS c
           WHERE c.id = v_capture) = 'completed',
    'S13 the capture was consumed once';

  SELECT jsonb_build_object(
           'refresh', sa.refresh_token,
           'reauth', sa.needs_reauth,
           'active', sa.is_active,
           'metadata', sa.account_metadata)
    INTO v_keep_after
    FROM public.social_accounts AS sa
   WHERE sa.id = v_account;
  ASSERT v_keep_after = v_keep_before,
    'S13 refresh, reauth, activity and metadata are preserved';

  SELECT md5(jsonb_agg(to_jsonb(sa) ORDER BY sa.id)::TEXT) INTO v_sib_after
    FROM public.social_accounts AS sa
   WHERE sa.user_id = v_owner
     AND sa.id <> v_account;
  ASSERT v_sib_after = v_sib_before,
    'S13 no unselected account changed';

  SELECT md5(to_jsonb(c)::TEXT) INTO v_user_after
    FROM public.facebook_user_credentials AS c
   WHERE c.id = v_credential;
  ASSERT v_user_after = v_user_before,
    'S13 the User grant row is unchanged';
END
$s13$;

ROLLBACK;

\echo 'meta_page_token_reconciliation: ALL CHECKS PASSED'
