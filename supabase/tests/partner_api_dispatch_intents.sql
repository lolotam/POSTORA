-- ============================================================================
-- partner_api_dispatch_intents.sql
--
-- Database proof for the D13 Stage 1 dispatch-intent table
-- (20260901120000_partner_dispatch_intents.sql):
--
--   * composite-FK account tenancy (an intent cannot name another
--     workspace's account)
--   * the no-FK-on-key_id compensating control (FOR KEY SHARE tenancy
--     trigger: a cross-workspace key attribution is refused)
--   * the CHECK surface (five states; known-sent names its wamid; a settled
--     verdict carries its replayable outcome)
--   * the natural key (one dispatch per (key_id, idempotency_key), EVER --
--     at-most-once made structural)
--   * the transition guard (rows are born intended; no path leads from
--     `indeterminate` -- or anywhere -- back toward re-dispatch; wamid is
--     immutable once set)
--   * LIFETIME: the intent outlives its key (no FK on key_id) while the
--     idempotency row cascades away (the deliberate contrast), and a
--     RESTRICT stops the account delete from erasing evidence
--   * the grant surface (anon/authenticated: nothing; service_role:
--     SELECT/INSERT plus column-level UPDATE only; nobody DELETEs)
--
-- Style follows partner_api_tenancy_negative.sql: each assertion in its own
-- BEGIN/EXCEPTION block so one expected failure cannot abort the rest; the
-- constraint name must appear in SQLERRM so the proof cannot be satisfied by
-- an unrelated failure; self-cleaning before and after; terminal sentinel as
-- the LAST stdout line (scripts/db-harness.sh refuses a no-plan suite whose
-- last line is not the sentinel).
--
-- Run as a SUPERUSER against a throwaway database with every migration
-- applied (the harness does this; the grant checks SET ROLE away from
-- superuser, which is the point of them).
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== partner_api_dispatch_intents: start ==='

DROP TABLE IF EXISTS pg_temp.dispatch_test_ids;
CREATE TEMP TABLE dispatch_test_ids (k TEXT PRIMARY KEY, id UUID NOT NULL);
INSERT INTO dispatch_test_ids VALUES
  ('user_a', '55555555-5555-4555-8555-555555555551'),
  ('user_b', '55555555-5555-4555-8555-555555555552'),
  ('ws_a',   '66666666-6666-4666-8666-666666666661'),
  ('ws_b',   '66666666-6666-4666-8666-666666666662'),
  ('acct_a', '77777777-7777-4777-8777-777777777771'),
  ('acct_b', '77777777-7777-4777-8777-777777777772'),
  ('key_a',  '88888888-8888-4888-8888-888888888881'),
  ('key_b',  '88888888-8888-4888-8888-888888888882');

-- ---------------------------------------------------------------------------
-- Cleanup before AND after: children before parents, so this keeps working
-- if a deletion action ever changes.
-- ---------------------------------------------------------------------------
DO $cleanup$
BEGIN
  DELETE FROM public.partner_dispatch_intents
   WHERE key_id IN (SELECT id FROM dispatch_test_ids WHERE k IN ('key_a','key_b'));
  DELETE FROM public.partner_api_idempotency
   WHERE key_id IN (SELECT id FROM dispatch_test_ids WHERE k IN ('key_a','key_b'));
  DELETE FROM public.partner_api_key_accounts
   WHERE key_id IN (SELECT id FROM dispatch_test_ids WHERE k IN ('key_a','key_b'));
  DELETE FROM public.partner_api_keys
   WHERE id IN (SELECT id FROM dispatch_test_ids WHERE k IN ('key_a','key_b'));
  DELETE FROM public.social_accounts
   WHERE id IN (SELECT id FROM dispatch_test_ids WHERE k IN ('acct_a','acct_b'));
  DELETE FROM public.workspaces
   WHERE id IN (SELECT id FROM dispatch_test_ids WHERE k IN ('ws_a','ws_b'));
  DELETE FROM auth.users
   WHERE id IN (SELECT id FROM dispatch_test_ids WHERE k IN ('user_a','user_b'));
END
$cleanup$;

DO $seed$
DECLARE
  v_user_a uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'user_a');
  v_user_b uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'user_b');
  v_ws_a   uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'ws_a');
  v_ws_b   uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'ws_b');
  v_acct_a uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'acct_a');
  v_acct_b uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'acct_b');
  v_key_a  uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'key_a');
  v_key_b  uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'key_b');
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_user_a, 'dispatch-test-a@example.invalid'),
    (v_user_b, 'dispatch-test-b@example.invalid')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspaces (id, name, owner_id) VALUES
    (v_ws_a, 'dispatch-test-ws-a', v_user_a),
    (v_ws_b, 'dispatch-test-ws-b', v_user_b)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, access_token, workspace_id)
  VALUES
    (v_acct_a, v_user_a, 'whatsapp', 'dispatch-acct-a', 'seed-token-a', v_ws_a),
    (v_acct_b, v_user_b, 'whatsapp', 'dispatch-acct-b', 'seed-token-b', v_ws_b)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.partner_api_keys
    (id, workspace_id, social_account_id, created_by, name, key_prefix, key_hash)
  VALUES
    (v_key_a, v_ws_a, v_acct_a, v_user_a, 'dispatch-test-key-a', 'dtk_a', 'dispatch-test-hash-a'),
    (v_key_b, v_ws_b, v_acct_b, v_user_b, 'dispatch-test-key-b', 'dtk_b', 'dispatch-test-hash-b')
  ON CONFLICT (id) DO NOTHING;
END
$seed$;

-- ---------------------------------------------------------------------------
-- Positive control: a same-workspace intent is accepted, born `intended`.
-- Without this, every negative below could just mean "the table is broken".
-- ---------------------------------------------------------------------------
DO $positive$
DECLARE
  v_ws_a   uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'ws_a');
  v_acct_a uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'acct_a');
  v_key_a  uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'key_a');
  v_count  integer;
BEGIN
  INSERT INTO public.partner_dispatch_intents
    (id, workspace_id, key_id, social_account_id, idempotency_key, request_summary)
  VALUES
    ('99999999-9999-4999-8999-999999999901', v_ws_a, v_key_a, v_acct_a,
     'dispatch-test-ik-1', '{"recipient_phone":"96512345678","template_name":"t_v1"}');

  SELECT count(*) INTO v_count FROM public.partner_dispatch_intents
   WHERE key_id = v_key_a AND state = 'intended';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: positive control: expected 1 intended row for key_a, found %', v_count;
  END IF;
  RAISE NOTICE 'PASS: same-workspace intent accepted and born intended';
END
$positive$;

-- ---------------------------------------------------------------------------
-- Negative 1 (tenancy trigger on key_id): workspace and account are A's but
-- the KEY is B's. Must be refused by partner_dispatch_intents_assert_tenancy
-- -- the compensating control for key_id having no FK (spec 9.1).
-- ---------------------------------------------------------------------------
DO $neg_key_tenancy$
DECLARE
  v_ws_a   uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'ws_a');
  v_acct_a uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'acct_a');
  v_key_b  uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'key_b');
BEGIN
  BEGIN
    INSERT INTO public.partner_dispatch_intents
      (workspace_id, key_id, social_account_id, idempotency_key)
    VALUES (v_ws_a, v_key_b, v_acct_a, 'dispatch-test-ik-neg1');
    RAISE EXCEPTION 'FAIL: intent accepted whose KEY belongs to another workspace';
  EXCEPTION WHEN foreign_key_violation THEN
    IF SQLERRM NOT LIKE '%partner_dispatch_intents_assert_tenancy%' THEN
      RAISE EXCEPTION 'FAIL: rejected by the wrong constraint: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS: cross-workspace key refused by the FOR KEY SHARE tenancy trigger';
  END;
END
$neg_key_tenancy$;

-- ---------------------------------------------------------------------------
-- Negative 2 (composite FK): key and workspace are A's, but the ACCOUNT is
-- B's. Must be refused by partner_dispatch_intents_account_in_workspace.
-- ---------------------------------------------------------------------------
DO $neg_account_tenancy$
DECLARE
  v_ws_a   uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'ws_a');
  v_acct_b uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'acct_b');
  v_key_a  uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'key_a');
BEGIN
  BEGIN
    INSERT INTO public.partner_dispatch_intents
      (workspace_id, key_id, social_account_id, idempotency_key)
    VALUES (v_ws_a, v_key_a, v_acct_b, 'dispatch-test-ik-neg2');
    RAISE EXCEPTION 'FAIL: intent accepted whose ACCOUNT belongs to another workspace';
  EXCEPTION WHEN foreign_key_violation THEN
    IF SQLERRM NOT LIKE '%partner_dispatch_intents_account_in_workspace%' THEN
      RAISE EXCEPTION 'FAIL: rejected by the wrong constraint: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS: cross-workspace account refused by the composite FK';
  END;
END
$neg_account_tenancy$;

-- ---------------------------------------------------------------------------
-- Negative 3 (CHECK surface): the five states; known-sent names its wamid;
-- a settled verdict carries its replayable outcome.
--
-- NOTE on ordering, because it shapes these tests: BEFORE triggers run ahead
-- of CHECK constraints. The wamid/outcome checks are therefore proven via
-- UPDATE (a transition the guard allows), and state_is_known -- which the
-- transition trigger would otherwise shadow for every write -- is proven
-- with the trigger temporarily disabled, as superuser, then re-enabled. A
-- weakened CHECK is caught here and nowhere else.
-- ---------------------------------------------------------------------------
DO $neg_checks$
DECLARE
  v_ws_a   uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'ws_a');
  v_acct_a uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'acct_a');
  v_key_a  uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'key_a');
  v_id     uuid;
BEGIN
  -- state_is_known, isolated from the transition trigger that would fire first.
  ALTER TABLE public.partner_dispatch_intents
    DISABLE TRIGGER partner_dispatch_intents_assert_transition_trg;
  BEGIN
    INSERT INTO public.partner_dispatch_intents
      (workspace_id, key_id, social_account_id, idempotency_key, state)
    VALUES (v_ws_a, v_key_a, v_acct_a, 'neg3a', 'retryable');
    RAISE EXCEPTION 'FAIL: an unknown state was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%partner_dispatch_intents_state_is_known%' THEN
      RAISE EXCEPTION 'FAIL: rejected by the wrong constraint: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS: unknown state refused by state_is_known (isolated from the transition trigger)';
  END;
  ALTER TABLE public.partner_dispatch_intents
    ENABLE TRIGGER partner_dispatch_intents_assert_transition_trg;

  -- sent without a wamid: UPDATE into a transition the guard allows, so the
  -- CHECK itself is what refuses.
  v_id := '99999999-9999-4999-8999-999999999902';
  INSERT INTO public.partner_dispatch_intents
    (id, workspace_id, key_id, social_account_id, idempotency_key)
  VALUES (v_id, v_ws_a, v_key_a, v_acct_a, 'neg3b');
  BEGIN
    UPDATE public.partner_dispatch_intents SET state = 'sent' WHERE id = v_id;
    RAISE EXCEPTION 'FAIL: a sent row without a wamid was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%partner_dispatch_intents_sent_names_wamid%' THEN
      RAISE EXCEPTION 'FAIL: rejected by the wrong constraint: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS: sent without wamid refused';
  END;

  -- failed without a replayable outcome.
  BEGIN
    UPDATE public.partner_dispatch_intents SET state = 'failed' WHERE id = v_id;
    RAISE EXCEPTION 'FAIL: a failed row without a replayable outcome was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%partner_dispatch_intents_settled_names_outcome%' THEN
      RAISE EXCEPTION 'FAIL: rejected by the wrong constraint: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS: settled without outcome refused';
  END;
END
$neg_checks$;

-- ---------------------------------------------------------------------------
-- Negative 4 (the natural key): the SAME (key_id, idempotency_key) cannot be
-- inserted twice. This is at-most-once made structural -- the takeover's
-- insert finds this constraint and stops; a second dispatch attempt for one
-- idempotency key is unrepresentable.
-- ---------------------------------------------------------------------------
DO $neg_unique$
DECLARE
  v_ws_a   uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'ws_a');
  v_acct_a uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'acct_a');
  v_key_a  uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'key_a');
BEGIN
  BEGIN
    INSERT INTO public.partner_dispatch_intents
      (workspace_id, key_id, social_account_id, idempotency_key)
    VALUES (v_ws_a, v_key_a, v_acct_a, 'dispatch-test-ik-1');
    RAISE EXCEPTION 'FAIL: a second intent for one (key, idempotency key) was accepted -- at-most-once is not structural';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: duplicate dispatch for one idempotency key refused by the natural key';
  END;
END
$neg_unique$;

-- ---------------------------------------------------------------------------
-- Negative 5 (rows are born intended): an INSERT claiming a settled state
-- would skip the whole state machine -- a "sent" row nobody dispatched.
-- ---------------------------------------------------------------------------
DO $neg_born_intended$
DECLARE
  v_ws_a   uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'ws_a');
  v_acct_a uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'acct_a');
  v_key_a  uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'key_a');
BEGIN
  BEGIN
    INSERT INTO public.partner_dispatch_intents
      (workspace_id, key_id, social_account_id, idempotency_key, state, wamid, http_status, response_body)
    VALUES (v_ws_a, v_key_a, v_acct_a, 'neg5', 'sent', 'wamid.FORGE', 200, '{"success":true}');
    RAISE EXCEPTION 'FAIL: an intent was created directly in a settled state';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%partner_dispatch_intents_assert_transition%' THEN
      RAISE EXCEPTION 'FAIL: rejected by the wrong constraint: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS: intents must be born intended';
  END;
END
$neg_born_intended$;

-- ---------------------------------------------------------------------------
-- The transition guard. D13 invariant 4: "no transition leads from
-- indeterminate toward re-dispatch. There is no state meaning safe to
-- resend". Every refused row below is someone's plausible future "fix".
-- ---------------------------------------------------------------------------
DO $transitions$
DECLARE
  v_ws_a   uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'ws_a');
  v_acct_a uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'acct_a');
  v_key_a  uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'key_a');
  v_id     uuid;
BEGIN
  -- Helper locals for the intent under test.
  v_id := '99999999-9999-4999-8999-999999999910';

  -- ALLOWED: intended -> sent (with wamid + outcome).
  INSERT INTO public.partner_dispatch_intents
    (id, workspace_id, key_id, social_account_id, idempotency_key)
  VALUES (v_id, v_ws_a, v_key_a, v_acct_a, 'transitions-1');

  UPDATE public.partner_dispatch_intents
     SET state = 'sent', wamid = 'wamid.T1', http_status = 200,
         response_body = '{"success":true}'::jsonb
   WHERE id = v_id;
  RAISE NOTICE 'PASS: intended -> sent allowed';

  -- ALLOWED: sent -> reconciled_sent (same wamid).
  UPDATE public.partner_dispatch_intents
     SET state = 'reconciled_sent' WHERE id = v_id;
  RAISE NOTICE 'PASS: sent -> reconciled_sent allowed';

  -- REFUSED: reconciled_sent is terminal.
  BEGIN
    UPDATE public.partner_dispatch_intents SET state = 'sent' WHERE id = v_id;
    RAISE EXCEPTION 'FAIL: a terminal reconciled_sent row was moved';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%partner_dispatch_intents_assert_transition%' THEN
      RAISE EXCEPTION 'FAIL: rejected by the wrong constraint: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS: reconciled_sent is terminal';
  END;

  -- The takeover verdict and its dead ends, on a fresh row.
  v_id := '99999999-9999-4999-8999-999999999911';
  INSERT INTO public.partner_dispatch_intents
    (id, workspace_id, key_id, social_account_id, idempotency_key)
  VALUES (v_id, v_ws_a, v_key_a, v_acct_a, 'transitions-2');
  UPDATE public.partner_dispatch_intents SET state = 'indeterminate' WHERE id = v_id;
  RAISE NOTICE 'PASS: intended -> indeterminate (the takeover verdict) allowed';

  -- ALLOWED: indeterminate -> reconciled_sent (the webhook's positive signal).
  UPDATE public.partner_dispatch_intents
     SET state = 'reconciled_sent', wamid = 'wamid.T2' WHERE id = v_id;
  RAISE NOTICE 'PASS: indeterminate -> reconciled_sent allowed';

  -- REFUSED: indeterminate -> sent, and every road back to `intended`.
  -- The refused UPDATEs are made FULLY valid (wamid, status, outcome all
  -- supplied) so the transition guard is the ONLY constraint that can
  -- reject: a mutation that weakens the guard makes the UPDATE succeed, and
  -- a mutation that hides behind another constraint is exposed by the
  -- SQLERRM name check. This exact mutation escaped an earlier version of
  -- this suite, which accepted any check_violation.
  v_id := '99999999-9999-4999-8999-999999999912';
  INSERT INTO public.partner_dispatch_intents
    (id, workspace_id, key_id, social_account_id, idempotency_key)
  VALUES (v_id, v_ws_a, v_key_a, v_acct_a, 'transitions-3');
  UPDATE public.partner_dispatch_intents SET state = 'indeterminate' WHERE id = v_id;

  BEGIN
    UPDATE public.partner_dispatch_intents
       SET state = 'sent', wamid = 'wamid.T3', http_status = 200,
           response_body = '{"success":true}'::jsonb
     WHERE id = v_id;
    RAISE EXCEPTION 'FAIL: indeterminate -> sent was accepted -- there is no state meaning safe to resend';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%partner_dispatch_intents_assert_transition%' THEN
      RAISE EXCEPTION 'FAIL: rejected by the wrong constraint: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS: indeterminate -> sent refused';
  END;
  BEGIN
    UPDATE public.partner_dispatch_intents SET state = 'intended' WHERE id = v_id;
    RAISE EXCEPTION 'FAIL: indeterminate -> intended was accepted -- re-dispatch became representable';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%partner_dispatch_intents_assert_transition%' THEN
      RAISE EXCEPTION 'FAIL: rejected by the wrong constraint: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS: indeterminate -> intended refused';
  END;

  -- REFUSED: failed is terminal too.
  v_id := '99999999-9999-4999-8999-999999999913';
  INSERT INTO public.partner_dispatch_intents
    (id, workspace_id, key_id, social_account_id, idempotency_key)
  VALUES (v_id, v_ws_a, v_key_a, v_acct_a, 'transitions-4');
  UPDATE public.partner_dispatch_intents
     SET state = 'failed', http_status = 422, response_body = '{"success":false}'::jsonb
   WHERE id = v_id;
  BEGIN
    UPDATE public.partner_dispatch_intents SET state = 'intended' WHERE id = v_id;
    RAISE EXCEPTION 'FAIL: failed -> intended was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%partner_dispatch_intents_assert_transition%' THEN
      RAISE EXCEPTION 'FAIL: rejected by the wrong constraint: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS: failed -> intended refused';
  END;

  -- REFUSED: the wamid is immutable once set.
  v_id := '99999999-9999-4999-8999-999999999914';
  INSERT INTO public.partner_dispatch_intents
    (id, workspace_id, key_id, social_account_id, idempotency_key)
  VALUES (v_id, v_ws_a, v_key_a, v_acct_a, 'transitions-5');
  UPDATE public.partner_dispatch_intents
     SET state = 'sent', wamid = 'wamid.T5', http_status = 200,
         response_body = '{"success":true}'::jsonb
   WHERE id = v_id;
  BEGIN
    UPDATE public.partner_dispatch_intents
       SET state = 'reconciled_sent', wamid = 'wamid.DIFFERENT' WHERE id = v_id;
    RAISE EXCEPTION 'FAIL: a recorded wamid was overwritten with another';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%partner_dispatch_intents_assert_transition%' THEN
      RAISE EXCEPTION 'FAIL: rejected by the wrong constraint: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS: wamid is immutable once set';
  END;
END
$transitions$;

-- ---------------------------------------------------------------------------
-- Lifetime 1: THE INTENT MUST OUTLIVE ITS KEY. Deleting key_b directly (no
-- usage rows block it) cascades the idempotency row away -- the deliberate
-- contrast -- while the dispatch intent survives as durable evidence.
-- ---------------------------------------------------------------------------
DO $pos_survives_key$
DECLARE
  v_ws_b   uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'ws_b');
  v_acct_b uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'acct_b');
  v_key_b  uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'key_b');
BEGIN
  INSERT INTO public.partner_dispatch_intents
    (id, workspace_id, key_id, social_account_id, idempotency_key)
  VALUES ('99999999-9999-4999-8999-999999999920', v_ws_b, v_key_b, v_acct_b, 'survives-key');

  INSERT INTO public.partner_api_idempotency (key_id, idempotency_key, request_hash, state)
  VALUES (v_key_b, 'survives-key', 'hash-survives', 'processing');

  DELETE FROM public.partner_api_keys WHERE id = v_key_b;

  IF EXISTS (SELECT 1 FROM public.partner_api_idempotency WHERE key_id = v_key_b) THEN
    RAISE EXCEPTION 'FAIL: the idempotency row did not cascade with its key -- this test is no longer exercising what it claims';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.partner_dispatch_intents WHERE key_id = v_key_b) THEN
    RAISE EXCEPTION 'FAIL: the dispatch intent did NOT survive deletion of its key -- a foreign key on key_id has been reintroduced, and dispatch evidence is deletable again';
  END IF;
  RAISE NOTICE 'PASS: the intent outlives its key while the idempotency row cascades away';
END
$pos_survives_key$;

-- ---------------------------------------------------------------------------
-- Lifetime 2: an account with dispatch evidence cannot be deleted. The
-- composite FK is RESTRICT, like partner_api_usage: this table is evidence,
-- not configuration, and the routine "disconnect account" operation must not
-- erase the record that a message may have reached a customer.
-- ---------------------------------------------------------------------------
DO $neg_account_delete$
DECLARE
  v_ws_a   uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'ws_a');
  v_acct_a uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'acct_a');
  v_key_a  uuid := (SELECT id FROM dispatch_test_ids WHERE k = 'key_a');
BEGIN
  INSERT INTO public.partner_dispatch_intents
    (id, workspace_id, key_id, social_account_id, idempotency_key)
  VALUES ('99999999-9999-4999-8999-999999999921', v_ws_a, v_key_a, v_acct_a, 'blocks-account-delete');

  BEGIN
    DELETE FROM public.social_accounts WHERE id = v_acct_a;
    RAISE EXCEPTION 'FAIL: deleting the WhatsApp account erased dispatch evidence';
  EXCEPTION WHEN foreign_key_violation THEN
    IF SQLERRM NOT LIKE '%partner_dispatch_intents_account_in_workspace%' THEN
      RAISE EXCEPTION 'FAIL: rejected by the wrong constraint: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS: account deletion with dispatch evidence is refused (RESTRICT, like the billing ledger)';
  END;
END
$neg_account_delete$;

-- ---------------------------------------------------------------------------
-- The grant surface. anon and authenticated hold NOTHING; service_role may
-- read, insert and update the state-machine columns but cannot re-attribute
-- a row (column-level UPDATE) and nobody can DELETE. The service_role INSERT
-- also proves the tenancy trigger's EXECUTE grant exists -- without it every
-- production dispatch would fail inside the trigger.
-- SET ROLE at statement level: role changes are not allowed inside DO blocks.
-- ---------------------------------------------------------------------------
\echo '--- dispatch intents as anon: everything refused ---'
SET ROLE anon;
DO $grants_anon$
BEGIN
  BEGIN
    PERFORM 1 FROM public.partner_dispatch_intents;
    RAISE EXCEPTION 'FAIL: anon SELECT was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: SELECT refused for anon';
  END;
  BEGIN
    INSERT INTO public.partner_dispatch_intents DEFAULT VALUES;
    RAISE EXCEPTION 'FAIL: anon INSERT was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: INSERT refused for anon';
  END;
  BEGIN
    UPDATE public.partner_dispatch_intents SET state = 'sent';
    RAISE EXCEPTION 'FAIL: anon UPDATE was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE refused for anon';
  END;
  BEGIN
    DELETE FROM public.partner_dispatch_intents;
    RAISE EXCEPTION 'FAIL: anon DELETE was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: DELETE refused for anon';
  END;
END
$grants_anon$;
RESET ROLE;

\echo '--- dispatch intents as authenticated: everything refused ---'
SET ROLE authenticated;
DO $grants_authenticated$
BEGIN
  BEGIN
    PERFORM 1 FROM public.partner_dispatch_intents;
    RAISE EXCEPTION 'FAIL: authenticated SELECT was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: SELECT refused for authenticated';
  END;
  BEGIN
    INSERT INTO public.partner_dispatch_intents DEFAULT VALUES;
    RAISE EXCEPTION 'FAIL: authenticated INSERT was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: INSERT refused for authenticated';
  END;
END
$grants_authenticated$;
RESET ROLE;

\echo '--- dispatch intents as service_role: state machine yes, re-attribution and DELETE never ---'
SET ROLE service_role;
DO $grants_service$
DECLARE
  -- Literal constants, NOT reads of the pg_temp table: that table belongs to
  -- the superuser session, and reading it under SET ROLE would fail on
  -- privileges and turn this block into a test of the wrong thing.
  v_ws_a   uuid := '66666666-6666-4666-8666-666666666661';
  v_ws_b   uuid := '66666666-6666-4666-8666-666666666662';
  v_acct_a uuid := '77777777-7777-4777-8777-777777777771';
  v_key_a  uuid := '88888888-8888-4888-8888-888888888881';
  v_count  integer;
BEGIN
  -- INSERT through the tenancy trigger: proves both the table grant and the
  -- EXECUTE grant on partner_dispatch_intents_assert_tenancy.
  INSERT INTO public.partner_dispatch_intents
    (id, workspace_id, key_id, social_account_id, idempotency_key)
  VALUES ('99999999-9999-4999-8999-999999999930', v_ws_a, v_key_a, v_acct_a, 'service-role-insert');

  SELECT count(*) INTO v_count FROM public.partner_dispatch_intents WHERE id = '99999999-9999-4999-8999-999999999930';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: service_role INSERT through the tenancy trigger failed silently';
  END IF;
  RAISE NOTICE 'PASS: service_role INSERT + SELECT work (trigger EXECUTE grant present)';

  -- The state machine's own UPDATE works.
  UPDATE public.partner_dispatch_intents
     SET state = 'sent', wamid = 'wamid.SR', http_status = 200,
         response_body = '{"success":true}'::jsonb
   WHERE id = '99999999-9999-4999-8999-999999999930';
  RAISE NOTICE 'PASS: service_role UPDATE of the state columns works';

  -- Re-attribution is refused at the COLUMN level: the INSERT-time tenancy
  -- trigger cannot guard an UPDATE, so the grant is what guards it.
  BEGIN
    UPDATE public.partner_dispatch_intents
       SET workspace_id = v_ws_b
     WHERE id = '99999999-9999-4999-8999-999999999930';
    RAISE EXCEPTION 'FAIL: service_role moved an intent to another workspace -- re-attribution is possible';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE of workspace_id refused (column-level grant)';
  END;
  BEGIN
    UPDATE public.partner_dispatch_intents
       SET idempotency_key = 'moved'
     WHERE id = '99999999-9999-4999-8999-999999999930';
    RAISE EXCEPTION 'FAIL: service_role changed an intent''s idempotency_key';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE of idempotency_key refused (column-level grant)';
  END;

  BEGIN
    DELETE FROM public.partner_dispatch_intents WHERE key_id = v_key_a;
    RAISE EXCEPTION 'FAIL: service_role DELETE was accepted -- evidence is erasable by any code path';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: DELETE refused for service_role';
  END;
END
$grants_service$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Cleanup, same order as the leading cleanup.
-- ---------------------------------------------------------------------------
DO $cleanup$
BEGIN
  DELETE FROM public.partner_dispatch_intents
   WHERE key_id IN (SELECT id FROM dispatch_test_ids WHERE k IN ('key_a','key_b'));
  DELETE FROM public.partner_api_idempotency
   WHERE key_id IN (SELECT id FROM dispatch_test_ids WHERE k IN ('key_a','key_b'));
  DELETE FROM public.partner_api_key_accounts
   WHERE key_id IN (SELECT id FROM dispatch_test_ids WHERE k IN ('key_a','key_b'));
  DELETE FROM public.partner_api_keys
   WHERE id IN (SELECT id FROM dispatch_test_ids WHERE k IN ('key_a','key_b'));
  DELETE FROM public.social_accounts
   WHERE id IN (SELECT id FROM dispatch_test_ids WHERE k IN ('acct_a','acct_b'));
  DELETE FROM public.workspaces
   WHERE id IN (SELECT id FROM dispatch_test_ids WHERE k IN ('ws_a','ws_b'));
  DELETE FROM auth.users
   WHERE id IN (SELECT id FROM dispatch_test_ids WHERE k IN ('user_a','user_b'));
END
$cleanup$;

DROP TABLE pg_temp.dispatch_test_ids;

\echo '=== partner_api_dispatch_intents: ALL CHECKS PASSED ==='
