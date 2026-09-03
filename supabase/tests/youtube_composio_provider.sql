-- ============================================================================
-- youtube_composio_provider.sql — Slice F provider columns on social_accounts
--
-- Run only as a superuser against the disposable database created by
-- scripts/db-harness.sh. The suite commits its assertions and cleans its rows.
-- Mirrors supabase/tests/hybrid_connectors.sql.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== youtube_composio_provider: start ==='

CREATE TEMP TABLE yt_ids (k TEXT PRIMARY KEY, id UUID NOT NULL);
INSERT INTO yt_ids VALUES
  ('admin', '88888888-8888-4888-8888-888888888871'),
  ('owner', '88888888-8888-4888-8888-888888888872'),
  ('ws',    '88888888-8888-4888-8888-888888888881'),
  ('acct',  '88888888-8888-4888-8888-888888888891'),
  ('conn',  '88888888-8888-4888-8888-8888888888a1'),
  ('tool',  '88888888-8888-4888-8888-8888888888c1');

CREATE OR REPLACE FUNCTION pg_temp.yt_cleanup() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_ws UUID[] := ARRAY(SELECT id FROM yt_ids WHERE k IN ('ws'));
  v_users UUID[] := ARRAY(SELECT id FROM yt_ids WHERE k IN ('admin', 'owner'));
BEGIN
  DELETE FROM public.ai_agent_tool_accounts WHERE user_id = ANY(v_users);
  DELETE FROM public.ai_agent_tools WHERE user_id = ANY(v_users);
  DELETE FROM public.social_accounts WHERE workspace_id = ANY(v_ws);
  DELETE FROM public.connector_connections WHERE workspace_id = ANY(v_ws);
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

SELECT pg_temp.yt_cleanup();

DO $seed$
DECLARE
  v_admin UUID := (SELECT id FROM yt_ids WHERE k = 'admin');
  v_owner UUID := (SELECT id FROM yt_ids WHERE k = 'owner');
  v_ws UUID := (SELECT id FROM yt_ids WHERE k = 'ws');
  v_acct UUID := (SELECT id FROM yt_ids WHERE k = 'acct');
  v_conn UUID := (SELECT id FROM yt_ids WHERE k = 'conn');
  v_tool UUID := (SELECT id FROM yt_ids WHERE k = 'tool');
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_admin, 'yt-admin@example.invalid'),
    (v_owner, 'yt-owner@example.invalid')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles (user_id, role) VALUES (v_admin, 'admin')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.workspaces (id, name, owner_id, is_personal) VALUES
    (v_ws, 'yt-ws', v_owner, false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
    (v_ws, v_owner, 'owner')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.connector_connections
    (id, workspace_id, connector_type, toolkit, composio_auth_config_id, external_account_id, status)
  VALUES
    (v_conn, v_ws, 'youtube', 'youtube', 'ac-yt', 'yt-channel-external', 'active');

  -- access_token is NULL: the migration relaxed the column because Composio
  -- holds the Google token (spec §10.1). Inserting NULL here proves the relax.
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, workspace_id, is_active,
     auth_provider, connection_id, needs_reauth)
  VALUES
    (v_acct, v_owner, 'youtube', 'yt-channel-1', 'yt channel', NULL, v_ws, true,
     'composio', v_conn, false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.ai_agent_tools
    (id, user_id, name, description, connector_type, auth_strategy, connection_id, social_account_id, platform, scope, is_enabled)
  VALUES
    (v_tool, v_owner, 'yt tool', 'test tool', 'youtube', 'composio_oauth', v_conn, v_acct, 'youtube', 'account', true);
END $seed$;

GRANT SELECT ON yt_ids TO authenticated, service_role;

-- (a) auth_provider='composio' without a connection is refused.
DO $composio_needs_connection$
DECLARE
  v_owner UUID := (SELECT id FROM yt_ids WHERE k = 'owner');
  v_ws UUID := (SELECT id FROM yt_ids WHERE k = 'ws');
BEGIN
  BEGIN
    INSERT INTO public.social_accounts
      (user_id, platform, platform_user_id, platform_username, access_token, workspace_id, auth_provider)
    VALUES (v_owner, 'youtube', 'yt-orphan', 'orphan', NULL, v_ws, 'composio');
    RAISE EXCEPTION 'unexpected success: composio account without a connection was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS a: composio provider requires connection_id';
END $composio_needs_connection$;

-- (b) An unknown provider value is refused.
DO $provider_allow_list$
DECLARE
  v_owner UUID := (SELECT id FROM yt_ids WHERE k = 'owner');
  v_ws UUID := (SELECT id FROM yt_ids WHERE k = 'ws');
BEGIN
  BEGIN
    INSERT INTO public.social_accounts
      (user_id, platform, platform_user_id, platform_username, access_token, workspace_id, auth_provider)
    VALUES (v_owner, 'youtube', 'yt-weird', 'weird', 'token', v_ws, 'weird');
    RAISE EXCEPTION 'unexpected success: unknown auth_provider was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS b: auth_provider allow-list is exact';
END $provider_allow_list$;

-- (c) Revocation marks the linked Composio account for reauth and still
-- disables dependent tools.
DO $revoke_marks_reauth$
DECLARE
  v_owner UUID := (SELECT id FROM yt_ids WHERE k = 'owner');
  v_acct UUID := (SELECT id FROM yt_ids WHERE k = 'acct');
  v_conn UUID := (SELECT id FROM yt_ids WHERE k = 'conn');
  v_tool UUID := (SELECT id FROM yt_ids WHERE k = 'tool');
BEGIN
  PERFORM pg_temp.must((SELECT needs_reauth FROM public.social_accounts WHERE id = v_acct) = false,
    'composio account starts without reauth');
  PERFORM pg_temp.must((SELECT is_enabled FROM public.ai_agent_tools WHERE id = v_tool),
    'dependent tool starts enabled');
  PERFORM pg_temp.act_as(v_owner);
  PERFORM public.revoke_connector_connection(v_conn);
  PERFORM pg_temp.must((SELECT status FROM public.connector_connections WHERE id = v_conn) = 'revoked',
    'owner revokes own connection');
  PERFORM pg_temp.must((SELECT needs_reauth FROM public.social_accounts WHERE id = v_acct) = true,
    'revocation marks the linked composio account for reauth');
  PERFORM pg_temp.must(NOT (SELECT is_enabled FROM public.ai_agent_tools WHERE id = v_tool),
    'revocation still disables the dependent tool');
  RAISE NOTICE 'PASS c: revoke sets needs_reauth and disables tools';
END $revoke_marks_reauth$;

-- (d) The Slice F callback upserts ON CONFLICT ON CONSTRAINT
-- social_accounts_user_platform_unique, so the constraint must exist.
SELECT pg_temp.must(
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname = 'social_accounts_user_platform_unique'
            AND conrelid = 'public.social_accounts'::regclass),
  'upsert target constraint social_accounts_user_platform_unique exists');
\echo 'PASS d: upsert target constraint exists'

-- (e) The migration is a no-op on re-apply: both CHECKs and the index exist
-- exactly once (a second ALTER ... ADD CONSTRAINT would raise duplicate_object
-- without the EXCEPTION guard, and CREATE INDEX without IF NOT EXISTS the same).
SELECT pg_temp.must(
  (SELECT count(*) FROM pg_constraint
   WHERE conrelid = 'public.social_accounts'::regclass
     AND conname = 'social_accounts_auth_provider_check') = 1,
  'auth_provider check exists exactly once');
SELECT pg_temp.must(
  (SELECT count(*) FROM pg_constraint
   WHERE conrelid = 'public.social_accounts'::regclass
     AND conname = 'social_accounts_provider_matches_connection') = 1,
  'provider-matches-connection check exists exactly once');
SELECT pg_temp.must(
  (SELECT count(*) FROM pg_class c
   JOIN pg_index i ON i.indexrelid = c.oid
   WHERE i.indrelid = 'public.social_accounts'::regclass
     AND c.relname = 'social_accounts_connection_idx') = 1,
  'connection index exists exactly once');
\echo 'PASS e: migration constraints and index exist exactly once'

SELECT pg_temp.yt_cleanup();
\echo '=== youtube_composio_provider: ALL CHECKS PASSED ==='
