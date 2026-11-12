-- ============================================================================
-- ai_provider_oauth.sql
--
-- Proof for 20261112120000_ai_provider_oauth.sql (spec
-- 2026-11-12-ai-provider-auth-methods-design.md §5, §8, §9):
--
--   public.ai_provider_oauth_connections  (deny-all RLS, no grants)
--   public.save_ai_oauth_credentials
--   public.get_ai_oauth_credentials
--   public.begin_ai_oauth_refresh         (single-flight lease)
--   public.fail_ai_oauth_refresh
--   public.delete_ai_oauth_connection     (reclaims the Vault secret)
--   public.get_ai_oauth_statuses
--   Kimi (moonshot) provider + 4 seeded models
--   feature_ai_provider_oauth seeded false
--
-- Run with psql AS A SUPERUSER against a THROWAWAY database with every
-- migration applied. NEVER against production: it writes rows.
--
--   psql "$HARNESS_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/ai_provider_oauth.sql
--
-- HOW IT PROVES THINGS
--   * Header, transaction and assert style follow byok_provider_keys.sql:
--     every expected refusal sits in its own BEGIN/EXCEPTION block, every
--     failure RAISES with a FAIL: prefix, and an accepted write that should
--     have been refused exits psql non-zero via ON_ERROR_STOP.
--   * Vault-backed positive reads (save/get/begin/fail/delete) are asserted
--     only when supabase_vault is installed; the harness creates it, but a
--     baseline without it must still pass the structural assertions. One
--     NOTICE covers the skip.
--   * RLS impersonation is SET ROLE (statement level; role changes are not
--     allowed inside DO blocks).
--   * Self-cleaning except for the moonshot catalog rows the MIGRATION
--     created: the migration runs once, so deleting its rows here would
--     break re-runs of this suite. The fixture rows this suite owns are
--     removed before AND after.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== ai_provider_oauth: start ==='

-- ---------------------------------------------------------------------------
-- Cleanup (before AND after, so a crashed earlier run cannot wedge this one)
-- ---------------------------------------------------------------------------
DO $aio_cleanup_leading$
DECLARE
  v_present boolean;
BEGIN
  DELETE FROM public.ai_provider_oauth_connections
   WHERE oauth_provider IN ('anthropic', 'openai-codex');
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault')
    INTO v_present;
  IF v_present THEN
    DELETE FROM vault.secrets
     WHERE name IN ('ai_oauth_anthropic', 'ai_oauth_openai-codex');
  END IF;
  -- Fixture catalog row this suite owns (see below). Providers go last.
  DELETE FROM public.ai_providers WHERE provider_code = 'claude';
END $aio_cleanup_leading$;

-- ---------------------------------------------------------------------------
-- Fixture: one `claude` provider row for the connection FK. The harness
-- baseline is SCHEMA-ONLY, so ai_providers is empty here (see
-- byok_provider_keys.sql, "Schema-only means no rows"). Production HAS the
-- row; the suite seeds the fixture itself.
-- ---------------------------------------------------------------------------
INSERT INTO public.ai_providers
  (provider_code, name, api_endpoint, api_key_env_var, api_type,
   supports_streaming, is_active)
VALUES
  ('claude', 'Anthropic API', 'https://api.anthropic.com/v1',
   'ANTHROPIC_API_KEY', 'anthropic', true, false)
ON CONFLICT (provider_code) DO NOTHING;

-- ===========================================================================
-- 1. The table and its RPCs are invisible to a normal user.
--    SET ROLE at statement level: role changes are not allowed inside DO
--    blocks. The REVOKE ALL means these raise insufficient_privilege rather
--    than returning zero rows — deny-all is a refusal, not an empty set.
-- ===========================================================================
\echo '--- as authenticated: table SELECT refused ---'
SET ROLE authenticated;
DO $aio_auth_table$
BEGIN
  BEGIN
    PERFORM 1 FROM public.ai_provider_oauth_connections;
    RAISE EXCEPTION 'FAIL: authenticated SELECT on ai_provider_oauth_connections was ACCEPTED';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected: REVOKE ALL FROM authenticated + deny-all RLS
  END;
END $aio_auth_table$;

DO $aio_auth_get$
BEGIN
  BEGIN
    PERFORM 1 FROM public.get_ai_oauth_credentials('anthropic') AS g;
    RAISE EXCEPTION 'FAIL: authenticated EXECUTE of get_ai_oauth_credentials was ACCEPTED';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected: no EXECUTE grant for authenticated
  END;
END $aio_auth_get$;
RESET ROLE;

-- The remaining RPCs are service-role-only too (spec §8: only the service
-- role reads the table, through the edge function).
DO $aio_auth_privs$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'save_ai_oauth_credentials(text,text,jsonb,text,timestamptz,uuid)',
    'begin_ai_oauth_refresh(text,int)',
    'fail_ai_oauth_refresh(text,text,boolean)',
    'delete_ai_oauth_connection(text)',
    'get_ai_oauth_statuses()'] LOOP
    IF has_function_privilege('authenticated',
        'public.' || f, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL: % is EXECUTEable as authenticated', f;
    END IF;
    IF NOT has_function_privilege('service_role',
        'public.' || f, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL: % is NOT EXECUTEable as service_role', f;
    END IF;
  END LOOP;
END $aio_auth_privs$;

-- ===========================================================================
-- 2-6. VAULT-CONDITIONAL lifecycle: save → get round trip, single-flight
-- lease, reauth flip, heal on re-save, delete reclaims the secret. Never
-- CALLED when supabase_vault is absent: the RPC bodies reference vault.*
-- and would fail the suite for the wrong reason. One NOTICE covers the skip.
-- ===========================================================================
\echo '--- connection lifecycle (vault-conditional) ---'
DO $aio_lifecycle$
DECLARE
  v_present boolean;
  v_creds jsonb;
  v_status text;
  v_lock timestamptz;
  v_secret uuid;
  v_rows integer;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault')
    INTO v_present;
  IF NOT v_present THEN
    RAISE NOTICE 'vault absent: skipping connection lifecycle assertions';
    RETURN;
  END IF;

  -- 2. Save creates a row whose credentials decrypt back out.
  PERFORM public.save_ai_oauth_credentials(
    'anthropic', 'claude', '{"access":"a","refresh":"r","expires":1}'::jsonb,
    'me', now(), NULL);
  v_creds := public.get_ai_oauth_credentials('anthropic');
  IF v_creds->>'refresh' IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION 'FAIL: saved refresh reads back as %, expected r', v_creds->>'refresh';
  END IF;
  IF v_creds->>'status' IS DISTINCT FROM 'connected' THEN
    RAISE EXCEPTION 'FAIL: saved status reads back as %, expected connected', v_creds->>'status';
  END IF;
  SELECT credentials_secret_id INTO v_secret
    FROM public.ai_provider_oauth_connections
   WHERE oauth_provider = 'anthropic';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'FAIL: save left no linked Vault secret';
  END IF;

  -- 3. The refresh lease is won exactly once; an expired lease is reclaimable.
  IF public.begin_ai_oauth_refresh('anthropic', 30) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: first begin_ai_oauth_refresh did not win the lease';
  END IF;
  IF public.begin_ai_oauth_refresh('anthropic', 30) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL: second begin_ai_oauth_refresh won a held lease';
  END IF;
  UPDATE public.ai_provider_oauth_connections
     SET refresh_lock_until = now() - interval '1 second'
   WHERE oauth_provider = 'anthropic';
  IF public.begin_ai_oauth_refresh('anthropic', 30) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: expired lease was not reclaimable';
  END IF;

  -- 4. fail(..., reauth := true) flips the status and releases the lock.
  PERFORM public.fail_ai_oauth_refresh('anthropic', 'x', true);
  SELECT status, refresh_lock_until INTO v_status, v_lock
    FROM public.ai_provider_oauth_connections
   WHERE oauth_provider = 'anthropic';
  IF v_status IS DISTINCT FROM 'reauth_required' THEN
    RAISE EXCEPTION 'FAIL: fail_ai_oauth_refresh left status %, expected reauth_required', v_status;
  END IF;
  IF v_lock IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: fail_ai_oauth_refresh left the refresh lease held';
  END IF;

  -- 5. A re-save heals reauth_required back to connected (refresh "complete").
  PERFORM public.save_ai_oauth_credentials(
    'anthropic', 'claude', '{"access":"a2","refresh":"r2","expires":1}'::jsonb,
    'me-2', now(), NULL);
  SELECT status INTO v_status
    FROM public.ai_provider_oauth_connections
   WHERE oauth_provider = 'anthropic';
  IF v_status IS DISTINCT FROM 'connected' THEN
    RAISE EXCEPTION 'FAIL: re-save left status %, expected connected', v_status;
  END IF;
  v_creds := public.get_ai_oauth_credentials('anthropic');
  IF v_creds->>'refresh' IS DISTINCT FROM 'r2' THEN
    RAISE EXCEPTION 'FAIL: re-save did not replace the stored refresh token';
  END IF;

  -- 6. delete removes the row AND the Vault secret behind it.
  SELECT credentials_secret_id INTO v_secret
    FROM public.ai_provider_oauth_connections
   WHERE oauth_provider = 'anthropic';
  PERFORM public.delete_ai_oauth_connection('anthropic');
  SELECT count(*) INTO v_rows
    FROM public.ai_provider_oauth_connections
   WHERE oauth_provider = 'anthropic';
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL: delete left % connection rows, expected 0', v_rows;
  END IF;
  SELECT count(*) INTO v_rows FROM vault.secrets WHERE id = v_secret;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL: Vault secret % survives delete_ai_oauth_connection', v_secret;
  END IF;
END $aio_lifecycle$;

-- ===========================================================================
-- 7. Kimi: the migration seeded the moonshot provider and 4 active chat
--    models. These rows come from the migration itself and are NOT cleaned
--    up below: the migration runs once, so removing them would break re-runs.
-- ===========================================================================
DO $aio_kimi$
DECLARE
  v_rows integer;
BEGIN
  SELECT count(*) INTO v_rows
    FROM public.ai_providers
   WHERE provider_code = 'moonshot'
     AND api_type = 'openai'
     AND auth_type = 'api_key';
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL: moonshot provider row missing or wrong (% rows)', v_rows;
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.ai_models m
    JOIN public.ai_providers p ON p.id = m.provider_id
   WHERE p.provider_code = 'moonshot'
     AND m.is_active
     AND m.capabilities @> ARRAY['chat'];
  IF v_rows <> 4 THEN
    RAISE EXCEPTION 'FAIL: % active moonshot chat models, expected 4', v_rows;
  END IF;
END $aio_kimi$;

-- ===========================================================================
-- 8. The feature flag is seeded OFF. Absent or false means off; the seed
--    writes the literal false.
-- ===========================================================================
DO $aio_flag$
DECLARE
  v_value jsonb;
BEGIN
  SELECT value INTO v_value
    FROM public.system_settings
   WHERE key = 'feature_ai_provider_oauth';
  IF v_value IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'FAIL: feature_ai_provider_oauth is %, expected false', v_value;
  END IF;
END $aio_flag$;

-- ===========================================================================
-- 9. The provider CHECK refuses pi-ai OAuth providers without a Postora
--    pathway (github-copilot is out of scope; spec §4).
-- ===========================================================================
DO $aio_check$
BEGIN
  BEGIN
    INSERT INTO public.ai_provider_oauth_connections (oauth_provider, provider_code)
    VALUES ('github-copilot', 'claude');
    RAISE EXCEPTION 'FAIL: oauth_provider github-copilot INSERT was ACCEPTED';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;
END $aio_check$;

-- ---------------------------------------------------------------------------
-- Trailing cleanup: everything this suite created, EXCEPT the moonshot
-- catalog rows the migration owns (they must survive re-runs).
-- ---------------------------------------------------------------------------
DO $aio_cleanup_trailing$
DECLARE
  v_present boolean;
  v_secret uuid;
BEGIN
  SELECT credentials_secret_id INTO v_secret
    FROM public.ai_provider_oauth_connections
   WHERE oauth_provider IN ('anthropic', 'openai-codex');
  DELETE FROM public.ai_provider_oauth_connections
   WHERE oauth_provider IN ('anthropic', 'openai-codex');
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault')
    INTO v_present;
  IF v_present AND v_secret IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_secret;
  END IF;
  DELETE FROM public.ai_providers WHERE provider_code = 'claude';
END $aio_cleanup_trailing$;

\echo '=== ai_provider_oauth: ALL CHECKS PASSED ==='
