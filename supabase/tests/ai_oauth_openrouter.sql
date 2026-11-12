-- ============================================================================
-- ai_oauth_openrouter.sql
--
-- Proof for 20261112210000_ai_oauth_openrouter.sql (spec
-- 2026-11-12-ai-provider-auth-more-providers-design.md §5, §10 PR A):
--
--   public.ai_provider_oauth_connections.oauth_provider accepts 'openrouter'
--   and still refuses an id nobody declared.
--
-- Run with psql AS A SUPERUSER against a THROWAWAY database with every
-- migration applied. NEVER against production: it writes rows.
--
--   psql "$HARNESS_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/ai_oauth_openrouter.sql
--
-- HOW IT PROVES THINGS
--   * Every expected refusal sits in its own BEGIN/EXCEPTION block, every
--     failure RAISES with a FAIL: prefix, and an accepted write that should
--     have been refused exits psql non-zero via ON_ERROR_STOP.
--   * The fixture rows this suite owns are removed before AND after.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== ai_oauth_openrouter: start ==='

-- ---------------------------------------------------------------------------
-- Cleanup (before AND after, so a crashed earlier run cannot wedge this one)
-- ---------------------------------------------------------------------------
DO $aioor_cleanup_leading$
BEGIN
  DELETE FROM public.ai_provider_oauth_connections
   WHERE oauth_provider IN ('openrouter', 'not-a-provider');
  -- Fixture catalog row this suite owns (see below). Providers go last.
  DELETE FROM public.ai_providers WHERE provider_code = 'openrouter';
END $aioor_cleanup_leading$;

-- ---------------------------------------------------------------------------
-- Fixture: one `openrouter` provider row for the connection FK. The harness
-- baseline is SCHEMA-ONLY, so ai_providers is empty here (see
-- byok_provider_keys.sql, "Schema-only means no rows"). Production HAS the
-- row; the suite seeds the fixture itself.
-- ---------------------------------------------------------------------------
INSERT INTO public.ai_providers
  (provider_code, name, api_endpoint, api_key_env_var, api_type,
   supports_streaming, is_active)
VALUES
  ('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1',
   'OPENROUTER_API_KEY', 'openai-compatible', true, false)
ON CONFLICT (provider_code) DO NOTHING;

-- ===========================================================================
-- 1. The CHECK names every provider id the design lists. The ids are ours,
--    not pi-ai's: pi-ai 0.73.1 has no OAuth provider for OpenRouter.
-- ===========================================================================
DO $aioor_constraint$
DECLARE
  v_def text;
  v_id text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.ai_provider_oauth_connections'::regclass
     AND conname = 'ai_provider_oauth_connections_oauth_provider_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'FAIL: the oauth_provider CHECK is missing';
  END IF;
  FOREACH v_id IN ARRAY ARRAY[
    'anthropic', 'openai-codex', 'openrouter',
    'xai', 'kimi-coding', 'minimax-code', 'zai-coding'] LOOP
    IF v_def NOT LIKE '%' || v_id || '%' THEN
      RAISE EXCEPTION 'FAIL: % is missing from the oauth_provider CHECK', v_id;
    END IF;
  END LOOP;
END $aioor_constraint$;

-- ===========================================================================
-- 2. 'openrouter' is accepted: the sign-in stores its credential under this id.
-- ===========================================================================
\echo '--- openrouter is accepted ---'
DO $aioor_accept$
DECLARE
  v_count int;
BEGIN
  INSERT INTO public.ai_provider_oauth_connections
    (oauth_provider, provider_code, status, account_label, expires_at)
  VALUES
    ('openrouter', 'openrouter', 'connected', NULL, '9999-12-31T00:00:00Z');
  SELECT count(*) INTO v_count
    FROM public.ai_provider_oauth_connections
   WHERE oauth_provider = 'openrouter'
     AND provider_code = 'openrouter'
     AND expires_at = '9999-12-31T00:00:00Z'::timestamptz;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: the openrouter connection was not stored';
  END IF;
END $aioor_accept$;

-- ===========================================================================
-- 3. The two ids that were already there still work: the migration widens
--    the CHECK, it does not replace it.
-- ===========================================================================
\echo '--- the existing ids still work ---'
DO $aioor_existing$
DECLARE
  v_id text;
BEGIN
  FOREACH v_id IN ARRAY ARRAY['anthropic', 'openai-codex'] LOOP
    BEGIN
      INSERT INTO public.ai_provider_oauth_connections
        (oauth_provider, provider_code, status)
      VALUES
        (v_id, 'openrouter', 'connected');
      DELETE FROM public.ai_provider_oauth_connections WHERE oauth_provider = v_id;
    EXCEPTION WHEN check_violation THEN
      RAISE EXCEPTION 'FAIL: oauth_provider % is no longer accepted', v_id;
    END;
  END LOOP;
END $aioor_existing$;

-- ===========================================================================
-- 4. An id nobody declared is still refused.
-- ===========================================================================
\echo '--- an unknown id is refused ---'
DO $aioor_unknown$
BEGIN
  BEGIN
    INSERT INTO public.ai_provider_oauth_connections
      (oauth_provider, provider_code, status)
    VALUES
      ('not-a-provider', 'openrouter', 'connected');
    RAISE EXCEPTION 'FAIL: oauth_provider not-a-provider INSERT was ACCEPTED';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;
END $aioor_unknown$;

-- ---------------------------------------------------------------------------
-- Trailing cleanup: everything this suite created.
-- ---------------------------------------------------------------------------
DO $aioor_cleanup_trailing$
BEGIN
  DELETE FROM public.ai_provider_oauth_connections
   WHERE oauth_provider IN ('openrouter', 'not-a-provider');
  DELETE FROM public.ai_providers WHERE provider_code = 'openrouter';
END $aioor_cleanup_trailing$;

\echo '=== ai_oauth_openrouter: ALL CHECKS PASSED ==='
