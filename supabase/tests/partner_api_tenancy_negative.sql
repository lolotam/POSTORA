-- ============================================================================
-- partner_api_tenancy_negative.sql
--
-- Negative-tenancy proof for the Partner API v1 Phase 1 tables:
--
--   public.partner_api_key_accounts  (20260830120000_partner_api_key_accounts.sql)
--   public.partner_audit_logs        (20260830120100_partner_audit_logs.sql)
--
-- Lives beside supabase/tests/partner_api_test.sql, the existing partner API
-- database suite. It does NOT use that file's assert_eq helper, which can only
-- express "this value equals that one" and cannot express "this write must be
-- REFUSED" -- the entire point of every assertion here. Each check therefore
-- carries its own BEGIN/EXCEPTION block, which is also what keeps one expected
-- failure from aborting the rest.
--
-- It also does not wrap itself in that suite's outer BEGIN/ROLLBACK, but the
-- reason is narrower than an earlier draft of this comment claimed: a handled
-- PL/pgSQL exception does NOT abort an enclosing transaction, so an outer
-- ROLLBACK would in fact work for most of this file and would clean up for
-- free. The real reason is Positive 2, which deletes a social account and
-- asserts the audit trail survives the resulting cascade -- a committed,
-- cross-statement effect. That is the same reason partner_api_race_fixture.sql
-- is kept apart from the rolling-back suite. Explicit cleanup runs before and
-- after so the script stays re-runnable.
--
-- Run with psql AS A SUPERUSER (supabase_admin / postgres) against a
-- THROWAWAY database that already has every migration applied. NEVER run it
-- against production: it writes rows.
--
--   psql "$THROWAWAY_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/partner_api_tenancy_negative.sql
--
-- How it proves things:
--   * Seeds two workspaces (A and B), each with its own auth user, social
--     account and partner key.
--   * Positive controls FIRST: same-workspace writes are accepted. Without
--     these, every negative result could just mean "the table is broken".
--   * Each negative assertion runs in its own BEGIN/EXCEPTION block so one
--     expected failure does not abort the rest.
--   * If a write that MUST be rejected is ACCEPTED, the block raises an
--     uncaught exception and -- with ON_ERROR_STOP -- psql exits non-zero.
--     A silent "ok" is impossible: nothing prints PASS unless the expected
--     error came from the expected constraint.
--   * The FK assertions also verify the rejection came from the RIGHT
--     constraint (SQLERRM names it), so the proof cannot be satisfied by an
--     unrelated failure.
--   * Cleans up after itself (and before itself), fixed UUIDs throughout,
--     so it is re-runnable.
--
-- The FK checks run as superuser (FKs constrain every role equally); the
-- grant checks on partner_audit_logs SET ROLE away from superuser, because
-- a superuser bypasses privilege checks and would make that half of the
-- test meaningless.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== partner_api_tenancy_negative: start ==='

DROP TABLE IF EXISTS pg_temp.tenancy_test_ids;
CREATE TEMP TABLE tenancy_test_ids (k TEXT PRIMARY KEY, id UUID NOT NULL);
INSERT INTO tenancy_test_ids VALUES
  ('user_a', '11111111-1111-1111-1111-111111111111'),
  ('user_b', '11111111-1111-1111-1111-111111111112'),
  ('ws_a',   '22222222-2222-2222-2222-222222222221'),
  ('ws_b',   '22222222-2222-2222-2222-222222222222'),
  ('acct_a', '33333333-3333-3333-3333-333333333331'),
  ('acct_b', '33333333-3333-3333-3333-333333333332'),
  ('key_a',  '44444444-4444-4444-4444-444444444441'),
  ('key_b',  '44444444-4444-4444-4444-444444444442');

-- ---------------------------------------------------------------------------
-- Cleanup (runs BEFORE seeding so a crashed earlier run cannot wedge this
-- one, and again at the end so the database is left clean).
-- Children are deleted before parents explicitly rather than leaning on the
-- cascade, so this cleanup keeps working if a deletion action ever changes.
-- ---------------------------------------------------------------------------
DO $cleanup$
BEGIN
  DELETE FROM public.partner_audit_logs
   WHERE workspace_id IN (SELECT id FROM tenancy_test_ids WHERE k IN ('ws_a','ws_b'));
  DELETE FROM public.partner_api_key_accounts
   WHERE key_id IN (SELECT id FROM tenancy_test_ids WHERE k IN ('key_a','key_b'));
  DELETE FROM public.partner_api_keys
   WHERE id IN (SELECT id FROM tenancy_test_ids WHERE k IN ('key_a','key_b'));
  DELETE FROM public.social_accounts
   WHERE id IN (SELECT id FROM tenancy_test_ids WHERE k IN ('acct_a','acct_b'));
  DELETE FROM public.workspaces
   WHERE id IN (SELECT id FROM tenancy_test_ids WHERE k IN ('ws_a','ws_b'));
  DELETE FROM auth.users
   WHERE id IN (SELECT id FROM tenancy_test_ids WHERE k IN ('user_a','user_b'));
END
$cleanup$;

-- ---------------------------------------------------------------------------
-- Seed: workspace A (user_a, acct_a, key_a) and workspace B (user_b, acct_b,
-- key_b). Every key is correctly bound to its own workspace's account.
-- ---------------------------------------------------------------------------
DO $seed$
DECLARE
  v_user_a uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'user_a');
  v_user_b uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'user_b');
  v_ws_a   uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'ws_a');
  v_ws_b   uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'ws_b');
  v_acct_a uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'acct_a');
  v_acct_b uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'acct_b');
  v_key_a  uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'key_a');
  v_key_b  uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'key_b');
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_user_a, 'tenancy-test-a@example.invalid'),
    (v_user_b, 'tenancy-test-b@example.invalid')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspaces (id, name, owner_id) VALUES
    (v_ws_a, 'tenancy-test-ws-a', v_user_a),
    (v_ws_b, 'tenancy-test-ws-b', v_user_b)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, access_token, workspace_id)
  VALUES
    (v_acct_a, v_user_a, 'whatsapp', 'tenancy-acct-a', 'seed-token-a', v_ws_a),
    (v_acct_b, v_user_b, 'whatsapp', 'tenancy-acct-b', 'seed-token-b', v_ws_b)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.partner_api_keys
    (id, workspace_id, social_account_id, created_by, name, key_prefix, key_hash)
  VALUES
    (v_key_a, v_ws_a, v_acct_a, v_user_a, 'tenancy-test-key-a', 'ttk_a', 'tenancy-test-hash-a'),
    (v_key_b, v_ws_b, v_acct_b, v_user_b, 'tenancy-test-key-b', 'ttk_b', 'tenancy-test-hash-b')
  ON CONFLICT (id) DO NOTHING;
END
$seed$;

-- ---------------------------------------------------------------------------
-- Positive controls: same-workspace writes must be ACCEPTED.
-- ---------------------------------------------------------------------------
DO $positive$
DECLARE
  v_ws_a   uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'ws_a');
  v_acct_a uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'acct_a');
  v_key_a  uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'key_a');
  v_user_a uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'user_a');
  v_count  integer;
BEGIN
  INSERT INTO public.partner_api_key_accounts (key_id, social_account_id, workspace_id)
  VALUES (v_key_a, v_acct_a, v_ws_a);

  SELECT count(*) INTO v_count
    FROM public.partner_api_key_accounts WHERE key_id = v_key_a;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: positive control partner_api_key_accounts: expected 1 row for key_a, found %', v_count;
  END IF;
  RAISE NOTICE 'PASS: same-workspace binding accepted (partner_api_key_accounts)';

  INSERT INTO public.partner_audit_logs (workspace_id, key_id, actor_id, action, request_id, metadata)
  VALUES (v_ws_a, v_key_a, v_user_a, 'create', 'tenancy-test-req-1',
          '{"key_prefix": "ttk_a"}');

  SELECT count(*) INTO v_count
    FROM public.partner_audit_logs WHERE key_id = v_key_a;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: positive control partner_audit_logs: expected 1 row for key_a, found %', v_count;
  END IF;
  RAISE NOTICE 'PASS: same-workspace audit row accepted (partner_audit_logs)';
END
$positive$;

-- ---------------------------------------------------------------------------
-- Negative 1 (partner_api_key_accounts): key and workspace are A's, but the
-- ACCOUNT is B's. Must be rejected by
-- partner_api_key_accounts_account_in_workspace. (A single-FK build that
-- keeps only this FK would also reject this -- that is not the
-- discriminating case; Negative 2 is.)
-- ---------------------------------------------------------------------------
DO $neg1$
DECLARE
  v_ws_a   uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'ws_a');
  v_acct_b uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'acct_b');
  v_key_a  uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'key_a');
BEGIN
  BEGIN
    INSERT INTO public.partner_api_key_accounts (key_id, social_account_id, workspace_id)
    VALUES (v_key_a, v_acct_b, v_ws_a);
    RAISE EXCEPTION 'FAIL: partner_api_key_accounts accepted a binding whose ACCOUNT is from another workspace';
  EXCEPTION WHEN foreign_key_violation THEN
    IF SQLERRM NOT LIKE '%partner_api_key_accounts_account_in_workspace%' THEN
      RAISE EXCEPTION 'FAIL: rejected by the wrong constraint: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS: account-from-workspace-B binding rejected by account_in_workspace FK';
  END;
END
$neg1$;

-- ---------------------------------------------------------------------------
-- Negative 2 (partner_api_key_accounts) -- THIS IS THE TEST'S ENTIRE POINT.
--
-- The KEY is workspace A's, while the row's workspace_id and ACCOUNT are
-- workspace B's.
--
--   THIS ASSERTION IS WHAT CATCHES THE SINGLE-COMPOSITE-FK MISTAKE.
--
-- If partner_api_key_accounts had been built with ONLY the
-- (social_account_id, workspace_id) FK -- the v1.0 error spec D4 corrects --
-- this insert would be ACCEPTED: the account legitimately belongs to
-- workspace B, so the one FK is satisfied, and workspace A's key would be
-- silently bound to workspace B's account. Only the second composite FK
-- (key_id, workspace_id) -> partner_api_keys (id, workspace_id) rejects it.
-- If this block ever reports FAIL, tenancy is broken in exactly the way
-- spec section 9.1 forbids.
-- ---------------------------------------------------------------------------
DO $neg2$
DECLARE
  v_ws_b   uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'ws_b');
  v_acct_b uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'acct_b');
  v_key_a  uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'key_a');
BEGIN
  BEGIN
    INSERT INTO public.partner_api_key_accounts (key_id, social_account_id, workspace_id)
    VALUES (v_key_a, v_acct_b, v_ws_b);
    RAISE EXCEPTION 'FAIL: partner_api_key_accounts accepted workspace A''s KEY bound to workspace B''s account+workspace -- the single-FK mistake (spec D4/9.1) is live in this database';
  EXCEPTION WHEN foreign_key_violation THEN
    IF SQLERRM NOT LIKE '%partner_api_key_accounts_key_in_workspace%' THEN
      RAISE EXCEPTION 'FAIL: rejected by the wrong constraint: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS: key-from-workspace-A binding rejected by key_in_workspace FK (the single-FK mistake would have accepted it)';
  END;
END
$neg2$;

-- ---------------------------------------------------------------------------
-- Negative 3 (partner_audit_logs): workspace_id is B's, key_id is A's. Must
-- be rejected by partner_audit_logs_assert_tenancy -- an audit row must
-- not be attributable to a workspace other than its target key's (spec
-- section 9.1). A build with a plain single-column FK key_id ->
-- partner_api_keys(id) would ACCEPT this insert.
-- ---------------------------------------------------------------------------
DO $neg3$
DECLARE
  v_ws_b  uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'ws_b');
  v_key_a uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'key_a');
BEGIN
  BEGIN
    INSERT INTO public.partner_audit_logs (workspace_id, key_id, action)
    VALUES (v_ws_b, v_key_a, 'rotate');
    RAISE EXCEPTION 'FAIL: partner_audit_logs accepted an audit row attributed to workspace B for workspace A''s key';
  EXCEPTION WHEN foreign_key_violation THEN
    IF SQLERRM NOT LIKE '%partner_audit_logs_assert_tenancy%' THEN
      RAISE EXCEPTION 'FAIL: rejected by the wrong constraint: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS: cross-workspace audit attribution rejected by key_in_workspace FK';
  END;
END
$neg3$;

-- ---------------------------------------------------------------------------
-- Negative 3b (partner_audit_logs): the NULL-key_id escape hatch.
--
-- A composite FK is MATCH SIMPLE: with ANY referencing column NULL, the
-- constraint is not checked. So a nullable key_id would let this row be
-- written against ANY workspace while naming another workspace's key in
-- metadata, walking straight past the FK that Negative 3 just proved works.
-- Negative 3 cannot catch this -- it only ever supplies a non-null key_id,
-- which is exactly how the hole survived the first review of this file.
--
-- key_id NOT NULL is what closes it. If this block ever reports FAIL, the
-- column has been made nullable again and the tenancy invariant is void for
-- every audit row that omits its target.
-- ---------------------------------------------------------------------------
DO $neg3b$
DECLARE
  v_ws_b  uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'ws_b');
  v_key_a uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'key_a');
BEGIN
  BEGIN
    INSERT INTO public.partner_audit_logs (workspace_id, key_id, action, metadata)
    VALUES (v_ws_b, NULL, 'rotate', jsonb_build_object('key_id', v_key_a));
    RAISE EXCEPTION 'FAIL: partner_audit_logs accepted a NULL key_id -- this row names workspace A''s key while being attributed to workspace B';
  -- Either rejection is correct, and which one fires is an implementation
  -- detail rather than the property under test. The column is NOT NULL, but a
  -- BEFORE INSERT trigger runs ahead of constraint evaluation, so in the
  -- current design the tenancy trigger sees the NULL first and raises
  -- foreign_key_violation. The security property -- a targetless audit row
  -- cannot be written -- holds either way, so both are accepted here rather
  -- than pinning the test to whichever check happens to win the race today.
  EXCEPTION WHEN not_null_violation OR foreign_key_violation THEN
    RAISE NOTICE 'PASS: NULL key_id refused (a targetless audit row cannot be written)';
  END;
END
$neg3b$;

-- ---------------------------------------------------------------------------
-- Positive 2 (partner_audit_logs): THE TRAIL MUST SURVIVE ITS KEY.
--
-- This is the property the whole no-FK-plus-trigger design exists to create,
-- and it is the one an FK cannot give. Both FK options were tried and both
-- failed here: RESTRICT made disconnecting a WhatsApp account impossible for
-- any audited key, and CASCADE deleted the trail during that same ordinary
-- disconnect. An audit log erased by routine product operation is not an
-- audit log.
--
-- Deleting the key's social account cascades into partner_api_keys
-- (foundation: partner_api_keys_account_in_workspace). The audit row must
-- still be there afterwards. If this block reports FAIL, someone has put a
-- foreign key back on key_id and the trail is deletable again.
-- ---------------------------------------------------------------------------
DO $pos2$
DECLARE
  v_ws_b   uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'ws_b');
  v_acct_b uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'acct_b');
  v_key_b  uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'key_b');
  v_count  integer;
BEGIN
  INSERT INTO public.partner_audit_logs (workspace_id, key_id, action, key_prefix)
  VALUES (v_ws_b, v_key_b, 'create', 'ttk_b');

  -- The ordinary disconnect path: delete the social account. This must
  -- succeed, and must take the key with it.
  DELETE FROM public.social_accounts WHERE id = v_acct_b;

  IF EXISTS (SELECT 1 FROM public.partner_api_keys WHERE id = v_key_b) THEN
    RAISE EXCEPTION 'FAIL: deleting the social account did not remove its key -- this test is no longer exercising what it claims';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.partner_audit_logs WHERE key_id = v_key_b;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: the audit trail did not survive deletion of its key (found % rows, expected 1) -- a foreign key on key_id has been reintroduced', v_count;
  END IF;
  RAISE NOTICE 'PASS: audit trail survived deletion of its key and social account (disconnect no longer erases history)';
END
$pos2$;

-- ---------------------------------------------------------------------------
-- Negative 3c: a partner key cannot change workspace.
--
-- This is the half of the audit tenancy control that the INSERT-time check
-- cannot provide. Locking the key while writing an audit row stops a
-- concurrent move; nothing there stops a move that happens a week LATER, which
-- would silently orphan every audit row already attributed to the old
-- workspace. A composite FK would have refused that update -- since this table
-- deliberately has no FK on key_id, partner_api_keys_workspace_is_immutable
-- has to.
--
-- The concurrent half of the same control was proven separately with two live
-- psql sessions (the second blocked on FOR KEY SHARE, then was refused here);
-- that cannot be expressed in a single-session script, so this asserts the
-- durable half that can.
-- ---------------------------------------------------------------------------
DO $neg3c$
DECLARE
  v_ws_b  uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'ws_b');
  v_key_a uuid := (SELECT id FROM tenancy_test_ids WHERE k = 'key_a');
BEGIN
  BEGIN
    UPDATE public.partner_api_keys SET workspace_id = v_ws_b WHERE id = v_key_a;
    RAISE EXCEPTION 'FAIL: a partner key was moved between workspaces -- every audit row already written against its old workspace is now orphaned';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%partner_api_keys_workspace_is_immutable%' THEN
      RAISE;
    END IF;
    RAISE NOTICE 'PASS: partner key workspace is immutable (audit rows cannot be orphaned by a later move)';
  END;
END
$neg3c$;

-- ---------------------------------------------------------------------------
-- Negative 4 (partner_audit_logs grants): append-only is a GRANT-level
-- property. UPDATE and DELETE must be refused for every non-owner role,
-- including service_role (which bypasses RLS but NOT privilege checks).
-- Each role is tested in its own block; SET ROLE happens at statement level
-- because role changes are not allowed inside a DO block.
-- ---------------------------------------------------------------------------
\echo '--- audit UPDATE/DELETE as service_role ---'
SET ROLE service_role;
DO $grants_service$
BEGIN
  BEGIN
    UPDATE public.partner_audit_logs SET metadata = '{"tamper": true}'::jsonb;
    RAISE EXCEPTION 'FAIL: service_role UPDATE on partner_audit_logs was ACCEPTED -- append-only is not enforced';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE on partner_audit_logs refused for service_role';
  END;
  BEGIN
    DELETE FROM public.partner_audit_logs;
    RAISE EXCEPTION 'FAIL: service_role DELETE on partner_audit_logs was ACCEPTED -- append-only is not enforced';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: DELETE on partner_audit_logs refused for service_role';
  END;
END
$grants_service$;
RESET ROLE;

\echo '--- audit UPDATE/DELETE as authenticated ---'
SET ROLE authenticated;
DO $grants_auth$
BEGIN
  BEGIN
    UPDATE public.partner_audit_logs SET metadata = '{"tamper": true}'::jsonb;
    RAISE EXCEPTION 'FAIL: authenticated UPDATE on partner_audit_logs was ACCEPTED -- append-only is not enforced';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE on partner_audit_logs refused for authenticated';
  END;
  BEGIN
    DELETE FROM public.partner_audit_logs;
    RAISE EXCEPTION 'FAIL: authenticated DELETE on partner_audit_logs was ACCEPTED -- append-only is not enforced';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: DELETE on partner_audit_logs refused for authenticated';
  END;
END
$grants_auth$;
RESET ROLE;

\echo '--- audit UPDATE/DELETE as anon ---'
SET ROLE anon;
DO $grants_anon$
BEGIN
  BEGIN
    UPDATE public.partner_audit_logs SET metadata = '{"tamper": true}'::jsonb;
    RAISE EXCEPTION 'FAIL: anon UPDATE on partner_audit_logs was ACCEPTED -- append-only is not enforced';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE on partner_audit_logs refused for anon';
  END;
  BEGIN
    DELETE FROM public.partner_audit_logs;
    RAISE EXCEPTION 'FAIL: anon DELETE on partner_audit_logs was ACCEPTED -- append-only is not enforced';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: DELETE on partner_audit_logs refused for anon';
  END;
END
$grants_anon$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Cleanup: same order as the leading cleanup, leave nothing behind.
-- ---------------------------------------------------------------------------
DO $cleanup$
BEGIN
  DELETE FROM public.partner_audit_logs
   WHERE workspace_id IN (SELECT id FROM tenancy_test_ids WHERE k IN ('ws_a','ws_b'));
  DELETE FROM public.partner_api_key_accounts
   WHERE key_id IN (SELECT id FROM tenancy_test_ids WHERE k IN ('key_a','key_b'));
  DELETE FROM public.partner_api_keys
   WHERE id IN (SELECT id FROM tenancy_test_ids WHERE k IN ('key_a','key_b'));
  DELETE FROM public.social_accounts
   WHERE id IN (SELECT id FROM tenancy_test_ids WHERE k IN ('acct_a','acct_b'));
  DELETE FROM public.workspaces
   WHERE id IN (SELECT id FROM tenancy_test_ids WHERE k IN ('ws_a','ws_b'));
  DELETE FROM auth.users
   WHERE id IN (SELECT id FROM tenancy_test_ids WHERE k IN ('user_a','user_b'));
END
$cleanup$;

DROP TABLE pg_temp.tenancy_test_ids;

\echo '=== partner_api_tenancy_negative: ALL CHECKS PASSED ==='
