-- ============================================================================
-- partner_api_credential_lifecycle.sql
--
-- Proof for the D12 credential lifecycle added by
-- 20260831170000_partner_api_credential_lifecycle.sql:
--
--   public.create_partner_key()             (closes threat-review F3)
--   public.rotate_partner_key()             (D12 requirement 3)
--   public.revoke_partner_key()             (now audited -- closes F11)
--   public.partner_caller_may_manage_keys()
--   partner_api_keys.superseded_by_key_id
--
-- Run with psql AS A SUPERUSER against a THROWAWAY database with every
-- migration applied. NEVER against production: it writes rows.
--
--   psql "$THROWAWAY_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/partner_api_credential_lifecycle.sql
--
-- HOW IT PROVES THINGS
--   * Every RPC is SECURITY DEFINER and authorises via auth.uid(), which reads
--     request.jwt.claim.sub. Each check sets that GUC to impersonate a
--     specific actor -- so "an admin may, a member may not" is tested as the
--     functions will actually be called, not by reading their source.
--   * Positive controls run FIRST. Without them a negative result could just
--     mean the function is broken for everyone.
--   * Each expected refusal sits in its own BEGIN/EXCEPTION block, so one
--     expected failure does not abort the rest, and an ACCEPTED write that
--     should have been refused raises an uncaught exception -- with
--     ON_ERROR_STOP that exits psql non-zero.
--   * Nothing prints PASS unless the assertion actually held. `psql` exits 0
--     on a failed assertion inside a plain SELECT, which is why every check
--     RAISES instead of selecting.
--   * Self-cleaning, fixed UUIDs, re-runnable.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== partner_api_credential_lifecycle: start ==='

CREATE TEMP TABLE lifecycle_ids (k TEXT PRIMARY KEY, id UUID NOT NULL);
INSERT INTO lifecycle_ids VALUES
  ('owner_a',  '55555555-5555-5555-5555-555555555551'),
  ('viewer_a', '55555555-5555-5555-5555-555555555552'),
  ('outsider', '55555555-5555-5555-5555-555555555553'),
  ('owner_b',  '55555555-5555-5555-5555-555555555554'),
  ('ws_a',     '66666666-6666-6666-6666-666666666661'),
  ('ws_b',     '66666666-6666-6666-6666-666666666662'),
  ('acct_a',   '77777777-7777-7777-7777-777777777771'),
  ('acct_a2',  '77777777-7777-7777-7777-777777777773'),
  ('acct_b',   '77777777-7777-7777-7777-777777777772');

-- A 64-char hex digest, the shape create_partner_key enforces. Deliberately
-- NOT derived from any plaintext: no test here ever puts a real secret near
-- the database, which is the property P11 asserts.
\set hash_1 '\'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1\''
\set hash_2 '\'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2\''
\set hash_3 '\'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3\''

-- ---------------------------------------------------------------------------
-- Cleanup (before AND after, so a crashed earlier run cannot wedge this one)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.lifecycle_cleanup() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_ws uuid[] := ARRAY(SELECT id FROM lifecycle_ids WHERE k IN ('ws_a','ws_b'));
  v_us uuid[] := ARRAY(SELECT id FROM lifecycle_ids WHERE k IN ('owner_a','viewer_a','outsider','owner_b'));
BEGIN
  DELETE FROM public.partner_audit_logs WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_api_key_accounts WHERE workspace_id = ANY(v_ws);
  -- The successor pointer is a self-FK; null it before deleting so the order
  -- of deletion cannot matter.
  UPDATE public.partner_api_keys SET superseded_by_key_id = NULL WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_api_keys WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.social_accounts WHERE workspace_id = ANY(v_ws);
  -- Workspaces BEFORE members, which is the opposite of the children-first
  -- order partner_api_tenancy_negative.sql uses. A trigger enforces "a
  -- workspace must retain at least one owner", so deleting the membership
  -- rows first raises rather than tidying up. Deleting the workspace cascades
  -- to its members and sidesteps the guard entirely -- the guard exists to
  -- stop a workspace being orphaned, not to stop it being removed.
  DELETE FROM public.workspaces WHERE id = ANY(v_ws);
  DELETE FROM public.workspace_members WHERE workspace_id = ANY(v_ws);
  DELETE FROM auth.users WHERE id = ANY(v_us);
END $$;

SELECT pg_temp.lifecycle_cleanup();

-- Impersonate an actor exactly as PostgREST does.
CREATE OR REPLACE FUNCTION pg_temp.act_as(p_user UUID) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', p_user::text, false)::void;
$$;

CREATE OR REPLACE FUNCTION pg_temp.must(p_cond BOOLEAN, p_label TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT p_cond THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_label; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------
DO $seed$
DECLARE
  v_owner_a  uuid := (SELECT id FROM lifecycle_ids WHERE k='owner_a');
  v_viewer_a uuid := (SELECT id FROM lifecycle_ids WHERE k='viewer_a');
  v_outsider uuid := (SELECT id FROM lifecycle_ids WHERE k='outsider');
  v_owner_b  uuid := (SELECT id FROM lifecycle_ids WHERE k='owner_b');
  v_ws_a     uuid := (SELECT id FROM lifecycle_ids WHERE k='ws_a');
  v_ws_b     uuid := (SELECT id FROM lifecycle_ids WHERE k='ws_b');
  v_acct_a   uuid := (SELECT id FROM lifecycle_ids WHERE k='acct_a');
  v_acct_a2  uuid := (SELECT id FROM lifecycle_ids WHERE k='acct_a2');
  v_acct_b   uuid := (SELECT id FROM lifecycle_ids WHERE k='acct_b');
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_owner_a,  'lifecycle-owner-a@example.invalid'),
    (v_viewer_a, 'lifecycle-viewer-a@example.invalid'),
    (v_outsider, 'lifecycle-outsider@example.invalid'),
    (v_owner_b,  'lifecycle-owner-b@example.invalid')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspaces (id, name, owner_id) VALUES
    (v_ws_a, 'lifecycle-ws-a', v_owner_a),
    (v_ws_b, 'lifecycle-ws-b', v_owner_b)
  ON CONFLICT (id) DO NOTHING;

  -- owner_a manages; viewer_a deliberately holds a role that must NOT.
  -- workspace_members_role_check permits owner/admin/agent/viewer, and the
  -- lifecycle RPCs admit only the first two -- the same predicate
  -- revoke_partner_key() has always used.
  INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
    (v_ws_a, v_owner_a,  'owner'),
    (v_ws_a, v_viewer_a, 'viewer'),
    (v_ws_b, v_owner_b,  'owner')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, access_token, workspace_id)
  VALUES
    (v_acct_a,  v_owner_a, 'whatsapp', 'lifecycle-acct-a',  'seed-a',  v_ws_a),
    (v_acct_a2, v_owner_a, 'whatsapp', 'lifecycle-acct-a2', 'seed-a2', v_ws_a),
    (v_acct_b,  v_owner_b, 'whatsapp', 'lifecycle-acct-b',  'seed-b',  v_ws_b)
  ON CONFLICT (id) DO NOTHING;
END $seed$;

-- ===========================================================================
-- P1 / P3 -- creation is atomic, audited, and stamps the real actor
-- ===========================================================================
DO $p1$
DECLARE
  v_ws_a   uuid := (SELECT id FROM lifecycle_ids WHERE k='ws_a');
  v_acct_a uuid := (SELECT id FROM lifecycle_ids WHERE k='acct_a');
  v_acct_b uuid := (SELECT id FROM lifecycle_ids WHERE k='acct_b');
  v_owner  uuid := (SELECT id FROM lifecycle_ids WHERE k='owner_a');
  v_key    uuid;
  v_before INTEGER;
  v_after  INTEGER;
BEGIN
  PERFORM pg_temp.act_as(v_owner);

  v_key := public.create_partner_key(
    v_ws_a, v_acct_a, 'lifecycle key 1', 'pk_live_aaaa',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
    ARRAY['messages:send','templates:read'], 60, NULL, NULL, 'req-p1');

  PERFORM pg_temp.must(v_key IS NOT NULL, 'P1 create returned a key id');
  PERFORM pg_temp.must(
    (SELECT count(*) FROM public.partner_api_keys WHERE id = v_key) = 1,
    'P1 key row exists');
  PERFORM pg_temp.must(
    (SELECT count(*) FROM public.partner_api_key_accounts
      WHERE key_id = v_key AND social_account_id = v_acct_a) = 1,
    'P1 binding row exists');
  PERFORM pg_temp.must(
    (SELECT count(*) FROM public.partner_audit_logs
      WHERE key_id = v_key AND action = 'create') = 1,
    'P1 exactly one create audit row');

  -- P3: the actor is the caller, taken from auth.uid() server-side.
  PERFORM pg_temp.must(
    (SELECT created_by FROM public.partner_api_keys WHERE id = v_key) = v_owner,
    'P3 created_by is the calling user');
  PERFORM pg_temp.must(
    (SELECT actor_id FROM public.partner_audit_logs
      WHERE key_id = v_key AND action='create') = v_owner,
    'P3 audit actor is the calling user');

  -- P1 atomicity: force the SECOND insert to fail (the binding's composite FK
  -- refuses an account from another workspace) and prove NO key row survives.
  -- This is the F3 failure -- an orphaned key with no binding -- made
  -- impossible rather than merely unlikely.
  SELECT count(*) INTO v_before FROM public.partner_api_keys WHERE workspace_id = v_ws_a;
  BEGIN
    PERFORM public.create_partner_key(
      v_ws_a, v_acct_b, 'should not survive', 'pk_live_bbbb',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9',
      ARRAY['messages:send']);
    RAISE EXCEPTION 'P1 ATOMICITY: creating a key bound to another workspace''s account was ACCEPTED';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL; -- expected
  END;
  SELECT count(*) INTO v_after FROM public.partner_api_keys WHERE workspace_id = v_ws_a;
  PERFORM pg_temp.must(v_before = v_after,
    'P1 a failed creation leaves NO key row behind');

  RAISE NOTICE 'PASS P1/P3: creation is atomic, bound, audited, and stamps the real actor';
END $p1$;

-- P3 (structural): created_by cannot be supplied by a caller. If it ever
-- became a parameter, an actor would be forgeable and the whole audit trail
-- would be worth nothing.
DO $p3$
BEGIN
  PERFORM pg_temp.must(
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.proname='create_partner_key'
        AND 'p_created_by' = ANY(p.proargnames)) = 0,
    'P3 create_partner_key must NOT accept a created_by parameter');
  RAISE NOTICE 'PASS P3: no caller-supplied actor';
END $p3$;

-- ===========================================================================
-- P2 -- only owner/admin may create
-- ===========================================================================
DO $p2$
DECLARE
  v_ws_a   uuid := (SELECT id FROM lifecycle_ids WHERE k='ws_a');
  v_acct_a uuid := (SELECT id FROM lifecycle_ids WHERE k='acct_a');
BEGIN
  FOR i IN 1..2 LOOP
    PERFORM pg_temp.act_as((SELECT id FROM lifecycle_ids
      WHERE k = CASE i WHEN 1 THEN 'viewer_a' ELSE 'outsider' END));
    BEGIN
      PERFORM public.create_partner_key(
        v_ws_a, v_acct_a, 'unauthorized', 'pk_live_xxxx',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa8',
        ARRAY['messages:send']);
      RAISE EXCEPTION 'P2: a non-managing user CREATED a partner key (case %)', i;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL; -- expected
    END;
  END LOOP;
  RAISE NOTICE 'PASS P2: a viewer and a non-member are both refused';
END $p2$;

-- ===========================================================================
-- P4 / P5 / P8 -- rotation
-- ===========================================================================
DO $p4$
DECLARE
  v_ws_a    uuid := (SELECT id FROM lifecycle_ids WHERE k='ws_a');
  v_acct_a  uuid := (SELECT id FROM lifecycle_ids WHERE k='acct_a');
  v_acct_a2 uuid := (SELECT id FROM lifecycle_ids WHERE k='acct_a2');
  v_owner   uuid := (SELECT id FROM lifecycle_ids WHERE k='owner_a');
  v_old     uuid;
  v_new     uuid;
  v_deadline TIMESTAMPTZ;
BEGIN
  PERFORM pg_temp.act_as(v_owner);

  v_old := public.create_partner_key(
    v_ws_a, v_acct_a, 'rotate me', 'pk_live_r001',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab1',
    ARRAY['messages:send','templates:read'], 120, 5000, NULL, 'req-p4');

  -- A second binding, so "every binding is copied" is a real claim rather
  -- than a claim about one row.
  INSERT INTO public.partner_api_key_accounts (key_id, social_account_id, workspace_id)
  VALUES (v_old, v_acct_a2, v_ws_a);

  v_new := public.rotate_partner_key(
    v_old, 'pk_live_r002',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab2',
    60, 'req-p4-rot');

  -- P4: inheritance
  PERFORM pg_temp.must(v_new <> v_old, 'P4 rotation minted a distinct key');
  PERFORM pg_temp.must(
    (SELECT scopes FROM public.partner_api_keys WHERE id=v_new)
      = (SELECT scopes FROM public.partner_api_keys WHERE id=v_old),
    'P4 successor inherits scopes');
  PERFORM pg_temp.must(
    (SELECT rate_limit_per_min FROM public.partner_api_keys WHERE id=v_new) = 120
    AND (SELECT monthly_quota FROM public.partner_api_keys WHERE id=v_new) = 5000,
    'P4 successor inherits rate limit and quota');
  PERFORM pg_temp.must(
    (SELECT count(*) FROM public.partner_api_key_accounts WHERE key_id=v_new) =
    (SELECT count(*) FROM public.partner_api_key_accounts WHERE key_id=v_old),
    'P4 every binding was copied');
  PERFORM pg_temp.must(
    NOT EXISTS (
      SELECT social_account_id FROM public.partner_api_key_accounts WHERE key_id=v_old
      EXCEPT
      SELECT social_account_id FROM public.partner_api_key_accounts WHERE key_id=v_new),
    'P4 the copied bindings are the SAME accounts, not merely the same count');

  -- P5: the predecessor is time-boxed and linked
  SELECT expires_at INTO v_deadline FROM public.partner_api_keys WHERE id=v_old;
  PERFORM pg_temp.must(v_deadline IS NOT NULL, 'P5 predecessor gained an expiry');
  PERFORM pg_temp.must(
    v_deadline > now() + interval '55 minutes' AND v_deadline < now() + interval '65 minutes',
    'P5 predecessor expiry is the 60-minute overlap deadline');
  PERFORM pg_temp.must(
    (SELECT superseded_by_key_id FROM public.partner_api_keys WHERE id=v_old) = v_new,
    'P5 predecessor points at its successor');
  -- The successor is NOT time-boxed by the overlap: the window bounds the OLD
  -- secret, not the new credential.
  PERFORM pg_temp.must(
    (SELECT expires_at FROM public.partner_api_keys WHERE id=v_new) IS NULL,
    'P5 successor did not inherit the overlap deadline');

  -- Audit: one rotate on the predecessor, one create on the successor.
  PERFORM pg_temp.must(
    (SELECT count(*) FROM public.partner_audit_logs WHERE key_id=v_old AND action='rotate') = 1,
    'P5 exactly one rotate audit row');
  PERFORM pg_temp.must(
    (SELECT count(*) FROM public.partner_audit_logs WHERE key_id=v_new AND action='create') = 1,
    'P5 the successor has its own create audit row');
  PERFORM pg_temp.must(
    (SELECT metadata->>'successor_key_id' FROM public.partner_audit_logs
      WHERE key_id=v_old AND action='rotate') = v_new::text,
    'P5 the rotate audit names the successor');

  RAISE NOTICE 'PASS P4/P5: successor inherits scopes, limits and every binding; predecessor time-boxed, linked and audited';
END $p4$;

-- P8 -- rotation must never EXTEND an expiry someone deliberately set
DO $p8$
DECLARE
  v_ws_a   uuid := (SELECT id FROM lifecycle_ids WHERE k='ws_a');
  v_acct_a uuid := (SELECT id FROM lifecycle_ids WHERE k='acct_a');
  v_owner  uuid := (SELECT id FROM lifecycle_ids WHERE k='owner_a');
  v_old    uuid;
  v_short  TIMESTAMPTZ := now() + interval '10 minutes';
  v_after  TIMESTAMPTZ;
BEGIN
  PERFORM pg_temp.act_as(v_owner);
  v_old := public.create_partner_key(
    v_ws_a, v_acct_a, 'short lived', 'pk_live_s001',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac1',
    ARRAY['messages:send'], 60, NULL, v_short, 'req-p8');

  -- Ask for a 24-hour overlap on a key that expires in 10 minutes.
  PERFORM public.rotate_partner_key(
    v_old, 'pk_live_s002',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac2',
    1440, 'req-p8-rot');

  SELECT expires_at INTO v_after FROM public.partner_api_keys WHERE id=v_old;
  PERFORM pg_temp.must(v_after <= v_short,
    'P8 rotation must NOT extend an expiry that was already sooner -- that is a '
    'capability grant performed as a side effect');
  PERFORM pg_temp.must(
    (SELECT (metadata->>'overlap_expires_at')::timestamptz
       FROM public.partner_audit_logs WHERE key_id=v_old AND action='rotate') = v_after,
    'P8 the audit records the RESOLVED deadline, not the requested one');

  RAISE NOTICE 'PASS P8: an overlap can shorten a key''s life but never lengthen it';
END $p8$;

-- ===========================================================================
-- P6 -- within the window both keys are valid; after it, only the successor
-- ===========================================================================
DO $p6$
DECLARE
  v_ws_a   uuid := (SELECT id FROM lifecycle_ids WHERE k='ws_a');
  v_acct_a uuid := (SELECT id FROM lifecycle_ids WHERE k='acct_a');
  v_owner  uuid := (SELECT id FROM lifecycle_ids WHERE k='owner_a');
  v_old    uuid;
  v_new    uuid;
  v_expiry TIMESTAMPTZ;
BEGIN
  PERFORM pg_temp.act_as(v_owner);
  v_old := public.create_partner_key(
    v_ws_a, v_acct_a, 'overlap window', 'pk_live_w001',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad1',
    ARRAY['messages:send'], 60, NULL, NULL, 'req-p6');
  v_new := public.rotate_partner_key(
    v_old, 'pk_live_w002',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad2',
    30, 'req-p6-rot');

  SELECT expires_at INTO v_expiry FROM public.partner_api_keys WHERE id=v_old;

  -- Asserted against the SAME predicate authenticatePartnerKey uses:
  --   revoked_at IS NOT NULL -> key_revoked
  --   expires_at <= now()    -> key_expired
  -- (_shared/partnerApiKeys.ts). Written out here rather than calling the
  -- edge function, so this test keeps meaning if that code moves -- but if the
  -- RULE changes, this comment is the pointer to the other half.
  PERFORM pg_temp.must(
    (SELECT revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
       FROM public.partner_api_keys WHERE id=v_old),
    'P6 inside the window the OLD key still authenticates');
  PERFORM pg_temp.must(
    (SELECT revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
       FROM public.partner_api_keys WHERE id=v_new),
    'P6 inside the window the NEW key authenticates');

  -- Move time past the deadline by ageing the row, which is what the clock
  -- would have done.
  UPDATE public.partner_api_keys SET expires_at = now() - interval '1 second' WHERE id=v_old;
  PERFORM pg_temp.must(
    (SELECT NOT (expires_at IS NULL OR expires_at > now())
       FROM public.partner_api_keys WHERE id=v_old),
    'P6 after the window the OLD key no longer authenticates');
  PERFORM pg_temp.must(
    (SELECT revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
       FROM public.partner_api_keys WHERE id=v_new),
    'P6 after the window the NEW key still authenticates');

  RAISE NOTICE 'PASS P6: both keys valid during the overlap, only the successor after it';
END $p6$;

-- ===========================================================================
-- P7 -- rotation refusals
-- ===========================================================================
DO $p7$
DECLARE
  v_ws_a   uuid := (SELECT id FROM lifecycle_ids WHERE k='ws_a');
  v_acct_a uuid := (SELECT id FROM lifecycle_ids WHERE k='acct_a');
  v_owner  uuid := (SELECT id FROM lifecycle_ids WHERE k='owner_a');
  v_owner_b uuid := (SELECT id FROM lifecycle_ids WHERE k='owner_b');
  v_k1 uuid; v_k2 uuid; v_k3 uuid;
BEGIN
  PERFORM pg_temp.act_as(v_owner);

  -- (a) revoked
  v_k1 := public.create_partner_key(v_ws_a, v_acct_a, 'revoked', 'pk_live_v001',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae1', ARRAY['messages:send']);
  PERFORM public.revoke_partner_key(v_k1, 'test');
  BEGIN
    PERFORM public.rotate_partner_key(v_k1, 'pk_live_v002',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae2', 60);
    RAISE EXCEPTION 'P7a: rotating a REVOKED key was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- (b) already superseded -- a second rotation would mint an orphan successor
  v_k2 := public.create_partner_key(v_ws_a, v_acct_a, 'double', 'pk_live_d001',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaf1', ARRAY['messages:send']);
  PERFORM public.rotate_partner_key(v_k2, 'pk_live_d002',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaf2', 60);
  BEGIN
    PERFORM public.rotate_partner_key(v_k2, 'pk_live_d003',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaf3', 60);
    RAISE EXCEPTION 'P7b: rotating an ALREADY-SUPERSEDED key was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- (c) cross-workspace. The refusal must be indistinguishable from "no such
  -- key", or key ids become enumerable by any member of another workspace.
  v_k3 := public.create_partner_key(v_ws_a, v_acct_a, 'foreign', 'pk_live_f001',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab01', ARRAY['messages:send']);
  PERFORM pg_temp.act_as(v_owner_b);
  BEGIN
    PERFORM public.rotate_partner_key(v_k3, 'pk_live_f002',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab02', 60);
    RAISE EXCEPTION 'P7c: another workspace''s owner ROTATED this key';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;

  -- (d) an out-of-range overlap
  PERFORM pg_temp.act_as(v_owner);
  BEGIN
    PERFORM public.rotate_partner_key(v_k3, 'pk_live_f003',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab03', -1);
    RAISE EXCEPTION 'P7d: a NEGATIVE overlap was accepted -- rotation would silently revoke';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.rotate_partner_key(v_k3, 'pk_live_f004',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab04', 43201);
    RAISE EXCEPTION 'P7d: an overlap beyond 30 days was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  RAISE NOTICE 'PASS P7: revoked, already-rotated, cross-workspace and out-of-range rotations all refused';
END $p7$;

-- ===========================================================================
-- P9 -- revocation is audited, and ONLY when it actually happened
-- ===========================================================================
DO $p9$
DECLARE
  v_ws_a   uuid := (SELECT id FROM lifecycle_ids WHERE k='ws_a');
  v_acct_a uuid := (SELECT id FROM lifecycle_ids WHERE k='acct_a');
  v_owner  uuid := (SELECT id FROM lifecycle_ids WHERE k='owner_a');
  v_viewer uuid := (SELECT id FROM lifecycle_ids WHERE k='viewer_a');
  v_key uuid;
  v_ok  BOOLEAN;
BEGIN
  PERFORM pg_temp.act_as(v_owner);
  v_key := public.create_partner_key(v_ws_a, v_acct_a, 'revoke me', 'pk_live_x001',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac01', ARRAY['messages:send']);

  v_ok := public.revoke_partner_key(v_key, 'leaked in a log');
  PERFORM pg_temp.must(v_ok, 'P9 the first revocation succeeds');
  PERFORM pg_temp.must(
    (SELECT count(*) FROM public.partner_audit_logs WHERE key_id=v_key AND action='revoke') = 1,
    'P9 exactly one revoke audit row');
  PERFORM pg_temp.must(
    (SELECT metadata->>'reason' FROM public.partner_audit_logs
      WHERE key_id=v_key AND action='revoke') = 'leaked in a log',
    'P9 the reason is recorded');

  -- A SECOND revocation changes nothing and must leave no trail. An audit log
  -- that records attempts is a different and much less trustworthy artifact
  -- than one that records events.
  v_ok := public.revoke_partner_key(v_key, 'again');
  PERFORM pg_temp.must(NOT v_ok, 'P9 re-revoking returns false');
  PERFORM pg_temp.must(
    (SELECT count(*) FROM public.partner_audit_logs WHERE key_id=v_key AND action='revoke') = 1,
    'P9 a REFUSED revocation appends NO audit row');

  -- And a revocation refused for lack of authority likewise leaves nothing.
  PERFORM pg_temp.act_as(v_viewer);
  v_ok := public.revoke_partner_key(
    (SELECT id FROM public.partner_api_keys
      WHERE workspace_id=v_ws_a AND revoked_at IS NULL LIMIT 1), 'not mine');
  PERFORM pg_temp.must(NOT v_ok, 'P9 a viewer cannot revoke');

  RAISE NOTICE 'PASS P9: revocation audited exactly once, refusals leave no trail';
END $p9$;

-- ===========================================================================
-- P10 -- the RPCs cannot be steered across a tenancy boundary
-- ===========================================================================
DO $p10$
DECLARE
  v_ws_a   uuid := (SELECT id FROM lifecycle_ids WHERE k='ws_a');
  v_ws_b   uuid := (SELECT id FROM lifecycle_ids WHERE k='ws_b');
  v_acct_a uuid := (SELECT id FROM lifecycle_ids WHERE k='acct_a');
  v_owner  uuid := (SELECT id FROM lifecycle_ids WHERE k='owner_a');
BEGIN
  -- Creating INTO another workspace: refused by authority, not by luck.
  PERFORM pg_temp.act_as(v_owner);
  BEGIN
    PERFORM public.create_partner_key(v_ws_b, v_acct_a, 'cross', 'pk_live_c001',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad01', ARRAY['messages:send']);
    RAISE EXCEPTION 'P10: workspace A''s owner created a key in workspace B';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- No audit row may have been written into B by that attempt.
  PERFORM pg_temp.must(
    (SELECT count(*) FROM public.partner_audit_logs WHERE workspace_id = v_ws_b) = 0,
    'P10 a refused cross-workspace creation wrote no audit row into the target workspace');

  RAISE NOTICE 'PASS P10: no RPC writes across a workspace boundary';
END $p10$;

-- ===========================================================================
-- P11 -- no plaintext secret is anywhere in the database
-- ===========================================================================
DO $p11$
DECLARE
  v_hits INTEGER;
BEGIN
  -- Every key_hash must look like a SHA-256 hex digest. A plaintext key
  -- (pk_live_...) reaching this column is the failure this asserts against.
  SELECT count(*) INTO v_hits FROM public.partner_api_keys
   WHERE workspace_id IN (SELECT id FROM lifecycle_ids WHERE k IN ('ws_a','ws_b'))
     AND key_hash !~ '^[0-9a-f]{64}$';
  PERFORM pg_temp.must(v_hits = 0, 'P11 every key_hash is a 64-char hex digest, never a plaintext key');

  SELECT count(*) INTO v_hits FROM public.partner_api_keys
   WHERE workspace_id IN (SELECT id FROM lifecycle_ids WHERE k IN ('ws_a','ws_b'))
     AND key_hash LIKE 'pk_live_%';
  PERFORM pg_temp.must(v_hits = 0, 'P11 no plaintext key is stored as a hash');

  -- The audit metadata records the PREFIX (which is not secret and is what an
  -- operator matches a key by) but must never carry the key itself.
  SELECT count(*) INTO v_hits FROM public.partner_audit_logs
   WHERE workspace_id IN (SELECT id FROM lifecycle_ids WHERE k IN ('ws_a','ws_b'))
     AND metadata::text ~ 'pk_live_[A-Za-z0-9]{20,}';
  PERFORM pg_temp.must(v_hits = 0, 'P11 no full-length key appears in audit metadata');

  RAISE NOTICE 'PASS P11: no plaintext secret reached the database';
END $p11$;

-- ---------------------------------------------------------------------------
SELECT pg_temp.lifecycle_cleanup();
\echo '=== partner_api_credential_lifecycle: ALL CHECKS PASSED ==='
