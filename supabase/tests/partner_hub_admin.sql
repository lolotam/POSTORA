-- ============================================================================
-- partner_hub_admin.sql — Admin Partner Hub (20260902200000)
--
-- Proves: (1) every admin_partner_* reader refuses a non-admin with
-- insufficient_privilege; (2) a platform admin reads keys across workspaces
-- they are not a member of; (3) no reader projects a secret column;
-- (4) a platform admin can create and revoke a key in a foreign workspace and
-- the audit trail names the admin; (5) a workspace owner still can;
-- (6) latency_ms refuses a negative value.
--
-- Run with psql AS A SUPERUSER against a throwaway database with every
-- migration applied. NEVER against production.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== partner_hub_admin: start ==='

CREATE TEMP TABLE hub_ids (k TEXT PRIMARY KEY, id UUID NOT NULL);
INSERT INTO hub_ids VALUES
  ('admin',   '88888888-8888-8888-8888-888888888881'),
  ('owner_a', '88888888-8888-8888-8888-888888888882'),
  ('owner_b', '88888888-8888-8888-8888-888888888883'),
  ('nobody',  '88888888-8888-8888-8888-888888888884'),
  ('ws_a',    '99999999-9999-9999-9999-999999999991'),
  ('ws_b',    '99999999-9999-9999-9999-999999999992'),
  ('acct_a',  'aaaaaaaa-9999-9999-9999-999999999991'),
  ('acct_b',  'aaaaaaaa-9999-9999-9999-999999999992');

CREATE OR REPLACE FUNCTION pg_temp.hub_cleanup() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_ws uuid[] := ARRAY(SELECT id FROM hub_ids WHERE k IN ('ws_a','ws_b'));
  v_us uuid[] := ARRAY(SELECT id FROM hub_ids WHERE k IN ('admin','owner_a','owner_b','nobody'));
BEGIN
  DELETE FROM public.partner_webhook_deliveries WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_webhooks WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_api_usage WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_audit_logs WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_api_key_accounts WHERE workspace_id = ANY(v_ws);
  UPDATE public.partner_api_keys SET superseded_by_key_id = NULL WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_api_keys WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.social_accounts WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.workspaces WHERE id = ANY(v_ws);
  DELETE FROM public.workspace_members WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.user_roles WHERE user_id = ANY(v_us);
  DELETE FROM auth.users WHERE id = ANY(v_us);
END $$;

SELECT pg_temp.hub_cleanup();

CREATE OR REPLACE FUNCTION pg_temp.act_as(p_user UUID) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', p_user::text, false)::void;
$$;

CREATE OR REPLACE FUNCTION pg_temp.must(p_cond BOOLEAN, p_label TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT p_cond THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_label; END IF;
END $$;

-- Every reader, called under the current actor; raises insufficient_privilege
-- or not. Used by H1 (must raise) and H2 (must not).
CREATE OR REPLACE FUNCTION pg_temp.reader_refused(p_sql TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- Seed: an admin who is a member of NO workspace, two workspace owners, an
-- outsider, two workspaces each with one WhatsApp account and one key.
-- ---------------------------------------------------------------------------
DO $seed$
DECLARE
  v_admin   uuid := (SELECT id FROM hub_ids WHERE k='admin');
  v_owner_a uuid := (SELECT id FROM hub_ids WHERE k='owner_a');
  v_owner_b uuid := (SELECT id FROM hub_ids WHERE k='owner_b');
  v_nobody  uuid := (SELECT id FROM hub_ids WHERE k='nobody');
  v_ws_a    uuid := (SELECT id FROM hub_ids WHERE k='ws_a');
  v_ws_b    uuid := (SELECT id FROM hub_ids WHERE k='ws_b');
  v_acct_a  uuid := (SELECT id FROM hub_ids WHERE k='acct_a');
  v_acct_b  uuid := (SELECT id FROM hub_ids WHERE k='acct_b');
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_admin,   'hub-admin@example.invalid'),
    (v_owner_a, 'hub-owner-a@example.invalid'),
    (v_owner_b, 'hub-owner-b@example.invalid'),
    (v_nobody,  'hub-nobody@example.invalid')
  ON CONFLICT (id) DO NOTHING;

  -- The signup trigger may have inserted a default 'user' role; the admin
  -- role is an additional row (UNIQUE (user_id, role)).
  INSERT INTO public.user_roles (user_id, role) VALUES (v_admin, 'admin')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.workspaces (id, name, owner_id) VALUES
    (v_ws_a, 'hub-ws-a', v_owner_a),
    (v_ws_b, 'hub-ws-b', v_owner_b)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
    (v_ws_a, v_owner_a, 'owner'),
    (v_ws_b, v_owner_b, 'owner')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, workspace_id, is_active)
  VALUES
    (v_acct_a, v_owner_a, 'whatsapp', 'hub-acct-a', 'hub-a', 'seed-a', v_ws_a, true),
    (v_acct_b, v_owner_b, 'whatsapp', 'hub-acct-b', 'hub-b', 'seed-b', v_ws_b, true)
  ON CONFLICT (id) DO NOTHING;

  -- One key per workspace, minted by its owner through the real RPC.
  PERFORM pg_temp.act_as(v_owner_a);
  PERFORM public.create_partner_key(v_ws_a, v_acct_a, 'hub key a', 'pk_live_hub1',
    'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
    ARRAY['messages:send'], 60, 100);
  PERFORM pg_temp.act_as(v_owner_b);
  PERFORM public.create_partner_key(v_ws_b, v_acct_b, 'hub key b', 'pk_test_hub2',
    'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
    ARRAY['posts:write'], 60, NULL, NULL, NULL, 'staging');
END $seed$;

-- ===========================================================================
-- H1 — a non-admin is refused by every reader
-- ===========================================================================
DO $h1$
DECLARE
  v_owner_a uuid := (SELECT id FROM hub_ids WHERE k='owner_a');
  v_nobody  uuid := (SELECT id FROM hub_ids WHERE k='nobody');
  v_key_a   uuid := (SELECT id FROM public.partner_api_keys WHERE key_prefix = 'pk_live_hub1');
  v_actor   uuid;
BEGIN
  FOREACH v_actor IN ARRAY ARRAY[v_owner_a, v_nobody] LOOP
    PERFORM pg_temp.act_as(v_actor);
    PERFORM pg_temp.must(pg_temp.reader_refused('SELECT * FROM public.admin_partner_hub_overview()'), 'H1 overview refused');
    PERFORM pg_temp.must(pg_temp.reader_refused('SELECT * FROM public.admin_partner_keys()'), 'H1 keys refused');
    PERFORM pg_temp.must(pg_temp.reader_refused('SELECT * FROM public.admin_partner_key_targets()'), 'H1 targets refused');
    PERFORM pg_temp.must(pg_temp.reader_refused(format('SELECT * FROM public.admin_partner_key_activity(%L)', v_key_a)), 'H1 activity refused');
    PERFORM pg_temp.must(pg_temp.reader_refused(format('SELECT * FROM public.admin_partner_key_webhook_deliveries(%L)', v_key_a)), 'H1 deliveries refused');
  END LOOP;
  -- No JWT at all (service role / anon): also refused.
  PERFORM set_config('request.jwt.claim.sub', '', false);
  PERFORM pg_temp.must(pg_temp.reader_refused('SELECT * FROM public.admin_partner_keys()'), 'H1 keys refused without a subject');
  RAISE NOTICE 'PASS H1: non-admins are refused by every reader';
END $h1$;

-- ===========================================================================
-- H2 — the admin reads across workspaces they do not belong to
-- ===========================================================================
DO $h2$
DECLARE
  v_admin uuid := (SELECT id FROM hub_ids WHERE k='admin');
  v_ws_a  uuid := (SELECT id FROM hub_ids WHERE k='ws_a');
  v_ws_b  uuid := (SELECT id FROM hub_ids WHERE k='ws_b');
  v_n     int;
BEGIN
  PERFORM pg_temp.act_as(v_admin);
  PERFORM pg_temp.must(NOT EXISTS (SELECT 1 FROM public.workspace_members WHERE user_id = v_admin),
    'H2 precondition: admin is a member of no workspace');
  SELECT count(*) INTO v_n FROM public.admin_partner_keys() k WHERE k.workspace_id IN (v_ws_a, v_ws_b);
  PERFORM pg_temp.must(v_n = 2, 'H2 admin sees both seeded keys');
  PERFORM pg_temp.must(
    (SELECT k.status FROM public.admin_partner_keys() k WHERE k.key_prefix = 'pk_live_hub1') = 'active',
    'H2 status is active');
  PERFORM pg_temp.must(
    (SELECT k.workspace_name FROM public.admin_partner_keys() k WHERE k.key_prefix = 'pk_test_hub2') = 'hub-ws-b',
    'H2 workspace name joined');
  PERFORM pg_temp.must(
    (SELECT k.environment FROM public.admin_partner_keys() k WHERE k.key_prefix = 'pk_test_hub2') = 'staging',
    'H2 environment projected');
  SELECT count(*) INTO v_n FROM public.admin_partner_key_targets() t WHERE t.workspace_id IN (v_ws_a, v_ws_b);
  PERFORM pg_temp.must(v_n = 2, 'H2 targets lists both WhatsApp accounts');
  PERFORM pg_temp.must((SELECT o.active_keys FROM public.admin_partner_hub_overview() o) >= 2,
    'H2 overview counts the active keys');
  RAISE NOTICE 'PASS H2: admin reads across foreign workspaces';
END $h2$;

-- ===========================================================================
-- H3 — no reader projects a secret column
-- ===========================================================================
DO $h3$
DECLARE
  v_fn text;
  v_bad int;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'admin_partner_hub_overview', 'admin_partner_keys', 'admin_partner_key_targets',
    'admin_partner_key_activity', 'admin_partner_key_webhook_deliveries'
  ] LOOP
    SELECT count(*) INTO v_bad
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL unnest(p.proargnames) AS arg
     WHERE n.nspname = 'public' AND p.proname = v_fn
       AND arg IN ('key_hash', 'secret', 'previous_secret');
    PERFORM pg_temp.must(v_bad = 0, format('H3 %s projects no secret column', v_fn));
  END LOOP;
  RAISE NOTICE 'PASS H3: no secret column in any reader';
END $h3$;

-- ===========================================================================
-- H4 — the admin creates and revokes in a foreign workspace; audit names them
-- ===========================================================================
DO $h4$
DECLARE
  v_admin  uuid := (SELECT id FROM hub_ids WHERE k='admin');
  v_ws_a   uuid := (SELECT id FROM hub_ids WHERE k='ws_a');
  v_acct_a uuid := (SELECT id FROM hub_ids WHERE k='acct_a');
  v_key    uuid;
BEGIN
  PERFORM pg_temp.act_as(v_admin);
  v_key := public.create_partner_key(v_ws_a, v_acct_a, 'hub admin-minted', 'pk_live_hub3',
    'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3',
    ARRAY['accounts:read'], 60, 10);
  PERFORM pg_temp.must(
    (SELECT created_by FROM public.partner_api_keys WHERE id = v_key) = v_admin,
    'H4 created_by is the admin');
  PERFORM pg_temp.must(EXISTS (
    SELECT 1 FROM public.partner_audit_logs
     WHERE key_id = v_key AND action = 'create' AND actor_id = v_admin),
    'H4 create audit row names the admin');
  PERFORM pg_temp.must(public.revoke_partner_key(v_key, 'hub test'), 'H4 admin revokes');
  PERFORM pg_temp.must(
    (SELECT revoked_by FROM public.partner_api_keys WHERE id = v_key) = v_admin,
    'H4 revoked_by is the admin');
  PERFORM pg_temp.must(EXISTS (
    SELECT 1 FROM public.partner_audit_logs
     WHERE key_id = v_key AND action = 'revoke' AND actor_id = v_admin),
    'H4 revoke audit row names the admin');
  PERFORM pg_temp.must(NOT public.revoke_partner_key(v_key, 'again'), 'H4 second revoke is a no-op');
  PERFORM pg_temp.must(
    (SELECT k.status FROM public.admin_partner_keys() k WHERE k.id = v_key) = 'revoked',
    'H4 status reads revoked');
  RAISE NOTICE 'PASS H4: admin lifecycle in a foreign workspace is audited';
END $h4$;

-- ===========================================================================
-- H5 — a workspace owner still manages their own keys; an outsider cannot
-- ===========================================================================
DO $h5$
DECLARE
  v_owner_b uuid := (SELECT id FROM hub_ids WHERE k='owner_b');
  v_nobody  uuid := (SELECT id FROM hub_ids WHERE k='nobody');
  v_key_b   uuid := (SELECT id FROM public.partner_api_keys WHERE key_prefix = 'pk_test_hub2');
BEGIN
  PERFORM pg_temp.act_as(v_nobody);
  PERFORM pg_temp.must(NOT public.revoke_partner_key(v_key_b, 'outsider'), 'H5 outsider cannot revoke');
  PERFORM pg_temp.act_as(v_owner_b);
  PERFORM pg_temp.must(public.revoke_partner_key(v_key_b, 'owner'), 'H5 owner revokes own key');
  RAISE NOTICE 'PASS H5: owner path unchanged, outsider refused';
END $h5$;

-- ===========================================================================
-- H6 — ledger columns: activity projects them; negative latency is refused
-- ===========================================================================
DO $h6$
DECLARE
  v_admin uuid := (SELECT id FROM hub_ids WHERE k='admin');
  v_ws_a  uuid := (SELECT id FROM hub_ids WHERE k='ws_a');
  v_key_a uuid := (SELECT id FROM public.partner_api_keys WHERE key_prefix = 'pk_live_hub1');
  v_rows  int;
BEGIN
  INSERT INTO public.partner_api_usage (key_id, workspace_id, action, billable, http_status, request_id, latency_ms)
  VALUES (v_key_a, v_ws_a, 'list_accounts', false, 200, 'req-hub-1', 42);
  BEGIN
    INSERT INTO public.partner_api_usage (key_id, workspace_id, action, billable, http_status, latency_ms)
    VALUES (v_key_a, v_ws_a, 'list_accounts', false, 200, -1);
    RAISE EXCEPTION 'H6: negative latency was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  PERFORM pg_temp.act_as(v_admin);
  SELECT count(*) INTO v_rows FROM public.admin_partner_key_activity(v_key_a, 10) a
   WHERE a.request_id = 'req-hub-1' AND a.latency_ms = 42;
  PERFORM pg_temp.must(v_rows = 1, 'H6 activity projects request_id and latency_ms');
  PERFORM pg_temp.must((SELECT count(*) FROM public.admin_partner_key_activity(v_key_a, 0)) = 1,
    'H6 limit is clamped to at least 1');
  BEGIN
    PERFORM * FROM public.admin_partner_key_activity('00000000-0000-0000-0000-000000000000');
    RAISE EXCEPTION 'H6: unknown key returned rows';
  EXCEPTION WHEN no_data_found THEN
    NULL;
  END;
  RAISE NOTICE 'PASS H6: ledger columns and activity reader';
END $h6$;

SELECT pg_temp.hub_cleanup();
\echo '=== partner_hub_admin: ALL CHECKS PASSED ==='
