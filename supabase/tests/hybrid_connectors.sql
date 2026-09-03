-- ============================================================================
-- hybrid_connectors.sql — Hybrid connector registry and call tracking
--
-- Run only as a superuser against the disposable database created by
-- scripts/db-harness.sh. The suite commits its assertions and cleans its rows.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== hybrid_connectors: start ==='

CREATE TEMP TABLE hybrid_ids (k TEXT PRIMARY KEY, id UUID NOT NULL);
INSERT INTO hybrid_ids VALUES
  ('admin',    '77777777-7777-4777-8777-777777777771'),
  ('owner_a',  '77777777-7777-4777-8777-777777777772'),
  ('owner_b',  '77777777-7777-4777-8777-777777777773'),
  ('viewer_a', '77777777-7777-4777-8777-777777777774'),
  ('outsider', '77777777-7777-4777-8777-777777777775'),
  ('ws_a',     '77777777-7777-4777-8777-777777777781'),
  ('ws_b',     '77777777-7777-4777-8777-777777777782'),
  ('acct_a',   '77777777-7777-4777-8777-777777777791'),
  ('acct_b',   '77777777-7777-4777-8777-777777777792'),
  ('conn_a',   '77777777-7777-4777-8777-7777777777a1'),
  ('conn_b',   '77777777-7777-4777-8777-7777777777b1'),
  ('tool_a',   '77777777-7777-4777-8777-7777777777c1'),
  ('tool_b',   '77777777-7777-4777-8777-7777777777c2'),
  ('key_a',    '77777777-7777-4777-8777-7777777777d1');

CREATE OR REPLACE FUNCTION pg_temp.hybrid_cleanup() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_ws UUID[] := ARRAY(SELECT id FROM hybrid_ids WHERE k IN ('ws_a', 'ws_b'));
  v_users UUID[] := ARRAY(SELECT id FROM hybrid_ids WHERE k IN ('admin', 'owner_a', 'owner_b', 'viewer_a', 'outsider'));
BEGIN
  DELETE FROM public.connector_call_logs WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.ai_agent_tool_accounts WHERE user_id = ANY(v_users);
  DELETE FROM public.ai_agent_tools WHERE user_id = ANY(v_users);
  DELETE FROM public.connector_connections WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_api_usage WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_audit_logs WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_api_key_accounts WHERE workspace_id = ANY(v_ws);
  UPDATE public.partner_api_keys SET superseded_by_key_id = NULL WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.partner_api_keys WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.social_accounts WHERE workspace_id = ANY(v_ws);
  -- Workspaces before members: deleting the last owner row directly trips the
  -- "must retain at least one owner" trigger; the workspace delete cascades instead.
  DELETE FROM public.workspaces WHERE id = ANY(v_ws);
  DELETE FROM public.workspace_members WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.user_roles WHERE user_id = ANY(v_users);
  DELETE FROM auth.users WHERE id = ANY(v_users);
END $$;

CREATE OR REPLACE FUNCTION pg_temp.act_as(p_user UUID) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', p_user::text, false)::void;
$$;

CREATE OR REPLACE FUNCTION pg_temp.must(p_condition BOOLEAN, p_label TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_label; END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.reader_refused(p_sql TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN true;
END $$;

SELECT pg_temp.hybrid_cleanup();

DO $seed$
DECLARE
  v_admin UUID := (SELECT id FROM hybrid_ids WHERE k = 'admin');
  v_owner_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'owner_a');
  v_owner_b UUID := (SELECT id FROM hybrid_ids WHERE k = 'owner_b');
  v_viewer_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'viewer_a');
  v_outsider UUID := (SELECT id FROM hybrid_ids WHERE k = 'outsider');
  v_ws_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'ws_a');
  v_ws_b UUID := (SELECT id FROM hybrid_ids WHERE k = 'ws_b');
  v_acct_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'acct_a');
  v_acct_b UUID := (SELECT id FROM hybrid_ids WHERE k = 'acct_b');
  v_conn_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'conn_a');
  v_conn_b UUID := (SELECT id FROM hybrid_ids WHERE k = 'conn_b');
  v_tool_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'tool_a');
  v_tool_b UUID := (SELECT id FROM hybrid_ids WHERE k = 'tool_b');
  v_key_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'key_a');
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_admin, 'hybrid-admin@example.invalid'),
    (v_owner_a, 'hybrid-owner-a@example.invalid'),
    (v_owner_b, 'hybrid-owner-b@example.invalid'),
    (v_viewer_a, 'hybrid-viewer-a@example.invalid'),
    (v_outsider, 'hybrid-outsider@example.invalid')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles (user_id, role) VALUES (v_admin, 'admin')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.workspaces (id, name, owner_id, is_personal) VALUES
    (v_ws_a, 'hybrid-ws-a', v_owner_a, false),
    (v_ws_b, 'hybrid-ws-b', v_owner_b, false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
    (v_ws_a, v_owner_a, 'owner'),
    (v_ws_a, v_viewer_a, 'viewer'),
    (v_ws_b, v_owner_b, 'owner')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, workspace_id, is_active)
  VALUES
    (v_acct_a, v_owner_a, 'whatsapp', 'hybrid-acct-a', 'hybrid-a', 'seed-a', v_ws_a, true),
    (v_acct_b, v_owner_b, 'whatsapp', 'hybrid-acct-b', 'hybrid-b', 'seed-b', v_ws_b, true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.partner_api_keys
    (id, workspace_id, social_account_id, created_by, name, key_prefix, key_hash, scopes)
  VALUES
    (v_key_a, v_ws_a, v_acct_a, v_owner_a, 'hybrid key', 'pk_test_hybrid',
     '7777777777777777777777777777777777777777777777777777777777777777', ARRAY['accounts:read'])
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.connector_connections
    (id, workspace_id, connector_type, toolkit, composio_auth_config_id, external_account_id, status)
  VALUES
    (v_conn_a, v_ws_a, 'google_sheets', 'googlesheets', 'ac-hybrid-a', 'external-a', 'active'),
    (v_conn_b, v_ws_b, 'slack', 'slack', 'ac-hybrid-b', 'external-b', 'active');

  INSERT INTO public.ai_agent_tools
    (id, user_id, name, description, connector_type, auth_strategy, connection_id, social_account_id, platform, scope)
  VALUES
    (v_tool_a, v_owner_a, 'hybrid sheets', 'test tool a', 'google_sheets', 'composio_oauth', v_conn_a, v_acct_a, 'whatsapp', 'account'),
    (v_tool_b, v_owner_b, 'hybrid slack', 'test tool b', 'slack', 'composio_oauth', v_conn_b, v_acct_b, 'whatsapp', 'account');

  INSERT INTO public.connector_call_logs
    (workspace_id, tool_id, connection_id, partner_key_id, connector_type, auth_strategy, action_name, source, status, error_code, request_id, latency_ms, created_at)
  VALUES
    (v_ws_a, v_tool_a, v_conn_a, v_key_a, 'google_sheets', 'composio_oauth', 'read', 'partner', 'success', NULL, 'hybrid-1', 10, now()),
    (v_ws_a, v_tool_a, v_conn_a, v_key_a, 'google_sheets', 'composio_oauth', 'read', 'partner', 'failed', 'vendor_failure', 'hybrid-2', 20, now()),
    (v_ws_a, v_tool_a, v_conn_a, v_key_a, 'google_sheets', 'composio_oauth', 'read', 'partner', 'timeout', 'connector_timeout', 'hybrid-3', 30, now()),
    (v_ws_a, v_tool_a, v_conn_a, NULL, 'google_sheets', 'composio_oauth', 'write', 'agent', 'refused', 'connector_write_not_allowed', 'hybrid-4', 40, now()),
    (v_ws_b, v_tool_b, v_conn_b, NULL, 'slack', 'composio_oauth', 'search', 'agent', 'success', NULL, 'hybrid-5', 50, now());
END $seed$;

GRANT SELECT ON hybrid_ids TO authenticated, service_role;

-- (1) A tool owner cannot attach a connection from another workspace.
DO $cross_workspace$
DECLARE
  v_owner_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'owner_a');
  v_conn_b UUID := (SELECT id FROM hybrid_ids WHERE k = 'conn_b');
BEGIN
  BEGIN
    INSERT INTO public.ai_agent_tools
      (user_id, name, description, connector_type, auth_strategy, connection_id, scope)
    VALUES (v_owner_a, 'cross-workspace', 'must fail', 'slack', 'composio_oauth', v_conn_b, 'all_accounts');
    RAISE EXCEPTION 'unexpected success: cross-workspace connection was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 1: cross-workspace connection is refused';
END $cross_workspace$;

-- (2) The strategy/connection pairing is mandatory.
DO $strategy_pairing$
DECLARE
  v_owner_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'owner_a');
BEGIN
  BEGIN
    INSERT INTO public.ai_agent_tools
      (user_id, name, description, connector_type, auth_strategy, scope)
    VALUES (v_owner_a, 'missing-connection', 'must fail', 'google_sheets', 'composio_oauth', 'all_accounts');
    RAISE EXCEPTION 'unexpected success: composio strategy without a connection was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 2: composio strategy requires connection_id';
END $strategy_pairing$;

-- (3) RLS exposes only the caller's workspace; service_role can write.
SET ROLE authenticated;
SELECT pg_temp.act_as((SELECT id FROM hybrid_ids WHERE k = 'owner_a'));
DO $rls_member$
DECLARE
  v_ws_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'ws_a');
  v_ws_b UUID := (SELECT id FROM hybrid_ids WHERE k = 'ws_b');
BEGIN
  PERFORM pg_temp.must((SELECT count(*) FROM public.connector_connections WHERE workspace_id IN (v_ws_a, v_ws_b)) = 1,
    'RLS member sees one connection');
  PERFORM pg_temp.must(EXISTS (SELECT 1 FROM public.connector_connections WHERE workspace_id = v_ws_a),
    'RLS member sees own connection');
  PERFORM pg_temp.must(NOT EXISTS (SELECT 1 FROM public.connector_connections WHERE workspace_id = v_ws_b),
    'RLS member cannot see other connection');
  PERFORM pg_temp.must((SELECT count(*) FROM public.connector_call_logs WHERE workspace_id IN (v_ws_a, v_ws_b)) = 4,
    'RLS member sees only own call logs');
END $rls_member$;
RESET ROLE;
SET ROLE service_role;
INSERT INTO public.connector_call_logs
  (workspace_id, connector_type, auth_strategy, action_name, source, status, request_id)
VALUES
  ('77777777-7777-4777-8777-777777777781', 'custom_rest', 'manual_credentials', 'service-probe', 'test', 'success', 'hybrid-service');
RESET ROLE;
SELECT pg_temp.must(EXISTS (SELECT 1 FROM public.connector_call_logs WHERE request_id = 'hybrid-service'),
  'service_role writes the ledger');
\echo 'PASS 3: RLS member isolation and service-role write'

-- (4) Admin readers fail loudly for a normal member and return data for admin.
DO $admin_readers$
DECLARE
  v_owner_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'owner_a');
  v_admin UUID := (SELECT id FROM hybrid_ids WHERE k = 'admin');
  v_key_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'key_a');
BEGIN
  PERFORM pg_temp.act_as(v_owner_a);
  PERFORM pg_temp.must(pg_temp.reader_refused('SELECT * FROM public.admin_connector_overview()'), 'overview refuses non-admin');
  PERFORM pg_temp.must(pg_temp.reader_refused('SELECT * FROM public.admin_connector_usage_by_type(30)'), 'by-type refuses non-admin');
  PERFORM pg_temp.must(pg_temp.reader_refused('SELECT * FROM public.admin_connector_usage_by_key(30)'), 'by-key refuses non-admin');
  PERFORM pg_temp.must(pg_temp.reader_refused('SELECT * FROM public.admin_connector_connections(NULL)'), 'connections refuses non-admin');
  PERFORM pg_temp.must(pg_temp.reader_refused(format('SELECT * FROM public.admin_partner_key_connector_activity(%L)', v_key_a)),
    'activity refuses non-admin');
  PERFORM pg_temp.act_as(v_admin);
  PERFORM pg_temp.must((SELECT count(*) FROM public.admin_connector_overview()) = 1, 'admin reads overview');
  PERFORM pg_temp.must((SELECT count(*) FROM public.admin_connector_usage_by_type(30)) >= 2, 'admin reads usage by type');
  PERFORM pg_temp.must((SELECT count(*) FROM public.admin_connector_usage_by_key(30)) >= 1, 'admin reads usage by key');
  PERFORM pg_temp.must((SELECT count(*) FROM public.admin_connector_connections(NULL)) >= 2, 'admin reads connections');
  PERFORM pg_temp.must((SELECT count(*) FROM public.admin_partner_key_connector_activity(v_key_a, 50)) = 3,
    'admin reads key activity');
  RAISE NOTICE 'PASS 4: admin reader gates and successful reads';
END $admin_readers$;

-- (5) Workspace usage returns no rows for outsiders and keeps refused separate.
DO $workspace_usage$
DECLARE
  v_owner_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'owner_a');
  v_outsider UUID := (SELECT id FROM hybrid_ids WHERE k = 'outsider');
  v_ws_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'ws_a');
  v_tool_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'tool_a');
BEGIN
  PERFORM pg_temp.act_as(v_outsider);
  PERFORM pg_temp.must((SELECT count(*) FROM public.workspace_connector_usage(v_ws_a, 30)) = 0,
    'non-member gets no workspace usage');
  PERFORM pg_temp.act_as(v_owner_a);
  PERFORM pg_temp.must(EXISTS (
    SELECT 1 FROM public.workspace_connector_usage(v_ws_a, 30) u
    WHERE u.tool_id = v_tool_a AND u.calls = 4 AND u.failures = 2 AND u.refused = 1 AND u.p50_latency_ms = 25
  ), 'member gets correct calls, failures, refused, and p50');
  RAISE NOTICE 'PASS 5: workspace usage is gated and correctly aggregated';
END $workspace_usage$;

-- (6) Revocation is role-gated and atomically disables dependent tools.
DO $revocation$
DECLARE
  v_viewer_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'viewer_a');
  v_owner_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'owner_a');
  v_admin UUID := (SELECT id FROM hybrid_ids WHERE k = 'admin');
  v_conn_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'conn_a');
  v_conn_b UUID := (SELECT id FROM hybrid_ids WHERE k = 'conn_b');
  v_tool_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'tool_a');
  v_tool_b UUID := (SELECT id FROM hybrid_ids WHERE k = 'tool_b');
BEGIN
  PERFORM pg_temp.act_as(v_viewer_a);
  BEGIN
    PERFORM public.revoke_connector_connection(v_conn_a);
    RAISE EXCEPTION 'unexpected success: viewer revoked a connection';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  PERFORM pg_temp.must((SELECT status FROM public.connector_connections WHERE id = v_conn_a) = 'active',
    'viewer refusal leaves connection active');
  PERFORM pg_temp.must((SELECT is_enabled FROM public.ai_agent_tools WHERE id = v_tool_a),
    'viewer refusal leaves tool enabled');

  PERFORM pg_temp.act_as(v_owner_a);
  PERFORM public.revoke_connector_connection(v_conn_a);
  PERFORM pg_temp.must((SELECT status FROM public.connector_connections WHERE id = v_conn_a) = 'revoked',
    'owner revokes own connection');
  PERFORM pg_temp.must(NOT (SELECT is_enabled FROM public.ai_agent_tools WHERE id = v_tool_a),
    'owner revocation disables dependent tool');

  PERFORM pg_temp.act_as(v_admin);
  PERFORM public.revoke_connector_connection(v_conn_b);
  PERFORM pg_temp.must((SELECT status FROM public.connector_connections WHERE id = v_conn_b) = 'revoked',
    'platform admin revokes foreign connection');
  PERFORM pg_temp.must(NOT (SELECT is_enabled FROM public.ai_agent_tools WHERE id = v_tool_b),
    'admin revocation disables dependent tool');
  RAISE NOTICE 'PASS 6: revoke gate and atomic tool disable';
END $revocation$;

-- (7) Activity rejects unknown keys and clamps both limit boundaries.
DO $activity_bounds$
DECLARE
  v_admin UUID := (SELECT id FROM hybrid_ids WHERE k = 'admin');
  v_key_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'key_a');
BEGIN
  PERFORM pg_temp.act_as(v_admin);
  BEGIN
    PERFORM * FROM public.admin_partner_key_connector_activity('00000000-0000-0000-0000-000000000000', 50);
    RAISE EXCEPTION 'unexpected success: unknown key returned activity';
  EXCEPTION WHEN no_data_found THEN
    NULL;
  END;
  PERFORM pg_temp.must((SELECT count(*) FROM public.admin_partner_key_connector_activity(v_key_a, 0)) = 1,
    'activity limit clamps to one');
  PERFORM pg_temp.must((SELECT count(*) FROM public.admin_partner_key_connector_activity(v_key_a, 500)) = 3,
    'activity limit clamps to 200 without dropping seeded rows');
  RAISE NOTICE 'PASS 7: activity missing-key and limit behavior';
END $activity_bounds$;

-- (8) Ledger checks reject negative latency and unknown statuses.
DO $ledger_checks$
DECLARE
  v_ws_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'ws_a');
BEGIN
  BEGIN
    INSERT INTO public.connector_call_logs
      (workspace_id, connector_type, auth_strategy, action_name, source, status, latency_ms)
    VALUES (v_ws_a, 'custom_rest', 'manual_credentials', 'invalid-latency', 'test', 'success', -1);
    RAISE EXCEPTION 'unexpected success: negative latency was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO public.connector_call_logs
      (workspace_id, connector_type, auth_strategy, action_name, source, status)
    VALUES (v_ws_a, 'custom_rest', 'manual_credentials', 'invalid-status', 'test', 'weird');
    RAISE EXCEPTION 'unexpected success: unknown status was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 8: ledger checks reject invalid values';
END $ledger_checks$;

-- (9) Both maintenance jobs are registered once.
SELECT pg_temp.must(
  (SELECT count(*) FROM cron.job WHERE jobname IN ('connector_logs_retention', 'connector_connections_sweep')) = 2,
  'both connector cron jobs are registered');
\echo 'PASS 9: connector maintenance jobs registered'

-- (10) All seven new registry values insert; an unregistered value is refused.
DO $connector_types$
DECLARE
  v_owner_a UUID := (SELECT id FROM hybrid_ids WHERE k = 'owner_a');
  v_type TEXT;
BEGIN
  FOREACH v_type IN ARRAY ARRAY['google_sheets', 'slack', 'google_calendar', 'hubspot', 'notion', 'airtable', 'youtube'] LOOP
    INSERT INTO public.ai_agent_tools (user_id, name, description, connector_type, auth_strategy, scope)
    VALUES (v_owner_a, 'manual-' || v_type, 'connector type check', v_type, 'manual_credentials', 'all_accounts');
  END LOOP;
  PERFORM pg_temp.must((SELECT count(*) FROM public.ai_agent_tools WHERE user_id = v_owner_a AND name LIKE 'manual-%') = 7,
    'all seven new connector types insert');
  BEGIN
    INSERT INTO public.ai_agent_tools (user_id, name, description, connector_type, auth_strategy, scope)
    VALUES (v_owner_a, 'manual-daftra', 'must fail', 'daftra', 'manual_credentials', 'all_accounts');
    RAISE EXCEPTION 'unexpected success: daftra was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 10: connector type allow-list is exact';
END $connector_types$;

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT pg_temp.hybrid_cleanup();
\echo '=== hybrid_connectors: ALL CHECKS PASSED ==='
