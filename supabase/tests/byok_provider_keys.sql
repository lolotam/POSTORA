-- ============================================================================
-- byok_provider_keys.sql
--
-- Proof for 20260906120000_byok_provider_keys_and_routing.sql (Slice 1 of the
-- AI provider account/auth/routing plan; design §5, acceptance criterion 10):
--
--   public.user_ai_provider_keys + public.user_ai_provider_key_status
--   public.get_user_ai_provider_key(uuid, text, boolean)
--   public.reclaim_user_ai_provider_key_secret()
--   public.user_ai_routing_preferences (both CHECKs)
--   public.ai_provider_waitlist
--   catalog renames / Anthropic model seeds / retirements
--   app_settings feature_byok_providers
--
-- Run with psql AS A SUPERUSER against a THROWAWAY database with every
-- migration applied. NEVER against production: it writes rows.
--
--   psql "$HARNESS_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/byok_provider_keys.sql
--
-- HOW IT PROVES THINGS
--   * Positive controls run FIRST. Without them a negative result could just
--     mean the feature is broken for everyone.
--   * Each expected refusal sits in its own BEGIN/EXCEPTION block, so one
--     expected failure does not abort the rest, and an ACCEPTED write that
--     should have been refused raises an uncaught exception -- with
--     ON_ERROR_STOP that exits psql non-zero.
--   * RLS impersonation is SET ROLE (statement level; role changes are not
--     allowed inside DO blocks) plus request.jwt.claim.sub, exactly as
--     PostgREST presents the caller. UUIDs inside SET ROLE blocks are
--     literals, NOT reads of a temp table: temp objects belong to the
--     superuser session and reading them under SET ROLE tests the wrong
--     thing (see partner_api_dispatch_intents.sql).
--   * Nothing prints PASS unless the assertion actually held. Every check
--     RAISES instead of selecting.
--   * Vault-backed positive reads and the reclaim trigger are asserted only
--     when supabase_vault is installed; the harness baseline lacks it, and a
--     plpgsql body referencing vault.decrypted_secrets fails only at
--     EXECUTION time, so the RPC is never CALLED on the baseline -- one
--     NOTICE covers the skip.
--   * Self-cleaning, fixed UUIDs, re-runnable.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== byok_provider_keys: start ==='

-- ---------------------------------------------------------------------------
-- Cleanup (before AND after, so a crashed earlier run cannot wedge this one)
-- ---------------------------------------------------------------------------
DO $byok_cleanup_leading$
BEGIN
  DELETE FROM public.user_ai_provider_keys
   WHERE user_id IN ('11111111-1111-4111-8111-111111111111',
                     '22222222-2222-4222-8222-222222222222');
  DELETE FROM public.user_ai_routing_preferences
   WHERE user_id IN ('11111111-1111-4111-8111-111111111111',
                     '22222222-2222-4222-8222-222222222222');
  DELETE FROM public.ai_provider_waitlist
   WHERE user_id IN ('11111111-1111-4111-8111-111111111111',
                     '22222222-2222-4222-8222-222222222222');
  -- Fixture catalog rows this suite owns (see below). Providers go last:
  -- deleting a provider cascades to its models.
  DELETE FROM public.ai_models m USING public.ai_providers p
   WHERE m.provider_id = p.id AND p.provider_code = 'claude'
     AND m.model_id IN ('claude-sonnet-5',
                        'claude-haiku-4-5-20251001',
                        'claude-opus-5',
                        'claude-3-5-sonnet-20241022',
                        'claude-3-5-haiku-20241022',
                        'claude-3-opus-20240229',
                        'claude-sonnet-4-20250514');
  DELETE FROM public.ai_providers
   WHERE provider_code IN ('openai', 'claude', 'gemini', 'openrouter');
  DELETE FROM auth.users
   WHERE id IN ('11111111-1111-4111-8111-111111111111',
                '22222222-2222-4222-8222-222222222222');
END $byok_cleanup_leading$;

-- ---------------------------------------------------------------------------
-- Fixture catalog + users.
--
-- WHY THE SUITE SEEDS PROVIDERS: the harness restores a SCHEMA-ONLY baseline,
-- so ai_providers/ai_models are EMPTY here -- every catalog seed sits at or
-- below the baseline marker and contributes no rows (see
-- supabase/tests/README.md, "Schema-only means no rows"). Production HAS the
-- rows (20260323193759 seeds openai/claude inactive). The suite therefore
-- inserts the pre-migration fixture itself -- old display names, inactive
-- providers, ACTIVE retired models -- so the migration's renames, seeds and
-- retirements have something real to act on and every catalog assertion
-- below is load-bearing rather than vacuous.
-- ---------------------------------------------------------------------------
DO $byok_seed_catalog$
DECLARE
  v_claude_id uuid;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    ('11111111-1111-4111-8111-111111111111', 'byok-user-a@example.invalid'),
    ('22222222-2222-4222-8222-222222222222', 'byok-user-b@example.invalid')
  ON CONFLICT (id) DO NOTHING;

  -- Pre-migration names and flags, copied from 20260323193759.
  INSERT INTO public.ai_providers
    (provider_code, name, api_endpoint, api_key_env_var, api_type,
     supports_streaming, is_active)
  VALUES
    ('openai', 'OpenAI', 'https://api.openai.com/v1', 'OPENAI_API_KEY',
     'openai', true, false),
    ('claude', 'Anthropic Claude', 'https://api.anthropic.com/v1',
     'ANTHROPIC_API_KEY', 'anthropic', true, false),
    ('gemini', 'Google Gemini', 'https://generativelanguage.googleapis.com/v1beta',
     'GOOGLE_AI_STUDIO_KEY', 'google', true, true),
    ('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1',
     'OPENROUTER_API_KEY', 'openai', true, true)
  ON CONFLICT (provider_code) DO NOTHING;

  -- Retired Claude ids, ACTIVE, so the migration's retirement UPDATE has
  -- something to deactivate and the assertion proves it did.
  SELECT id INTO v_claude_id FROM public.ai_providers WHERE provider_code = 'claude';
  INSERT INTO public.ai_models
    (provider_id, model_id, name, description, capabilities, context_limit,
     cost_per_1m_input_tokens, cost_per_1m_output_tokens, is_active)
  VALUES
    (v_claude_id, 'claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet',
     'Previous flagship', ARRAY['chat'], 200000, 3.0, 15.0, true),
    (v_claude_id, 'claude-3-5-haiku-20241022', 'Claude 3.5 Haiku',
     'Fast & affordable', ARRAY['chat'], 200000, 0.8, 4.0, true),
    (v_claude_id, 'claude-3-opus-20240229', 'Claude 3 Opus',
     'Most capable legacy', ARRAY['chat'], 200000, 15.0, 75.0, true),
    (v_claude_id, 'claude-sonnet-4-20250514', 'Claude Sonnet 4',
     'Latest balanced', ARRAY['chat'], 200000, 3.0, 15.0, true)
  ON CONFLICT (provider_id, model_id) DO NOTHING;
END $byok_seed_catalog$;

-- Re-apply the migration's catalog section (§F) onto the fixture. The file
-- itself is idempotent by design, but this suite cannot re-include it: the
-- psql shim feeds -f scripts via stdin, so \ir has no base file to resolve
-- against (verified: "No such file or directory"). The statements below are
-- therefore a VERBATIM replay of migration §F -- keep them in sync with
-- 20260906120000_byok_provider_keys_and_routing.sql. Gate 2 replays the file
-- itself and proves it runs twice cleanly; this block proves §F transforms
-- the pre-migration world into the post-migration one.
\echo '--- byok: replaying migration catalog section onto the fixture ---'
UPDATE public.ai_providers SET name = 'OpenAI API' WHERE provider_code = 'openai';
UPDATE public.ai_providers SET name = 'Anthropic API' WHERE provider_code = 'claude';

INSERT INTO public.ai_models
  (provider_id, model_id, name, description, capabilities, context_limit,
   cost_per_1m_input_tokens, cost_per_1m_output_tokens, is_active)
SELECT p.id, v.model_id, v.name, v.description, v.capabilities, v.context_limit,
       v.cost_in, v.cost_out, true
FROM public.ai_providers AS p CROSS JOIN (VALUES
  ('claude-sonnet-5', 'Claude Sonnet 5', 'Best balance of speed and intelligence',
   ARRAY['chat','agent'], 1000000, 2.0, 10.0),
  ('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'Fastest, near-frontier',
   ARRAY['chat','agent'], 200000, 1.0, 5.0),
  ('claude-opus-5', 'Claude Opus 5', 'Most capable for complex agentic work',
   ARRAY['chat','agent'], 1000000, 5.0, 25.0)
) AS v(model_id, name, description, capabilities, context_limit, cost_in, cost_out)
WHERE p.provider_code = 'claude'
ON CONFLICT (provider_id, model_id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  capabilities = EXCLUDED.capabilities,
  context_limit = EXCLUDED.context_limit,
  cost_per_1m_input_tokens = EXCLUDED.cost_per_1m_input_tokens,
  cost_per_1m_output_tokens = EXCLUDED.cost_per_1m_output_tokens,
  is_active = true;

UPDATE public.ai_models AS m
SET is_active = false
FROM public.ai_providers AS p
WHERE m.provider_id = p.id
  AND p.provider_code = 'claude'
  AND m.model_id IN ('claude-3-5-sonnet-20241022',
                     'claude-3-5-haiku-20241022',
                     'claude-3-opus-20240229',
                     'claude-sonnet-4-20250514');

-- ---------------------------------------------------------------------------
-- Seed: one key row for A (Vault-backed when possible)
-- ---------------------------------------------------------------------------
DO $byok_seed$
DECLARE
  v_vault_present boolean;
  v_secret_id uuid;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault')
    INTO v_vault_present;

  IF v_vault_present THEN
    -- A real Vault secret, the shape the Edge Function writes:
    -- a JSON blob carrying the api_key field the RPC extracts.
    v_secret_id := vault.create_secret(
      '{"api_key":"byok-test-key-A"}',
      'byok-test:' || gen_random_uuid()::text,
      'harness byok test secret for user A');
    INSERT INTO public.user_ai_provider_keys
      (user_id, provider_code, credentials_secret_id, key_hint, status)
    VALUES ('11111111-1111-4111-8111-111111111111', 'openai',
            v_secret_id, 'key-A', 'active');
  ELSE
    -- No vault extension on this database: the row still proves every
    -- baseline-safe assertion (RLS, grants, view columns), with a NULL
    -- secret id. The decrypt/reclaim assertions below skip with a NOTICE.
    INSERT INTO public.user_ai_provider_keys
      (user_id, provider_code, credentials_secret_id, key_hint, status)
    VALUES ('11111111-1111-4111-8111-111111111111', 'openai',
            NULL, 'key-A', 'active');
  END IF;
END $byok_seed$;

-- ===========================================================================
-- Keys table: anon holds nothing (positive control: the row IS there)
-- SET ROLE at statement level: role changes are not allowed inside DO blocks.
-- ===========================================================================
\echo '--- keys as anon: SELECT refused ---'
SET ROLE anon;
DO $byok_anon$
BEGIN
  BEGIN
    PERFORM 1 FROM public.user_ai_provider_keys;
    RAISE EXCEPTION 'FAIL: anon SELECT on user_ai_provider_keys was ACCEPTED';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected: REVOKE ALL FROM anon
  END;
END $byok_anon$;
RESET ROLE;

-- ===========================================================================
-- Keys table as the owner: granted columns visible, secret column denied,
-- status view scoped, all writes refused.
-- ===========================================================================
\echo '--- keys as authenticated owner A ---'
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
DO $byok_owner_a$
DECLARE
  v_count integer;
BEGIN
  -- Positive control: the owner sees exactly their own row, safe columns.
  SELECT count(*) INTO v_count
    FROM public.user_ai_provider_keys
   WHERE id IS NOT NULL AND key_hint = 'key-A';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: owner A sees % key rows, expected 1', v_count;
  END IF;

  -- The secret id is never client-readable, even to the owner.
  BEGIN
    PERFORM credentials_secret_id FROM public.user_ai_provider_keys LIMIT 1;
    RAISE EXCEPTION 'FAIL: owner SELECT of credentials_secret_id was ACCEPTED';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected: column-level GRANT excludes it
  END;

  -- The status view returns the owner's row through RLS + security_invoker.
  SELECT count(*) INTO v_count FROM public.user_ai_provider_key_status;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: status view returns % rows to A, expected 1', v_count;
  END IF;

  -- No client writes: no INSERT/UPDATE/DELETE grants to authenticated.
  BEGIN
    INSERT INTO public.user_ai_provider_keys (user_id, provider_code)
    VALUES ('11111111-1111-4111-8111-111111111111', 'openai');
    RAISE EXCEPTION 'FAIL: owner INSERT on user_ai_provider_keys was ACCEPTED';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected
  END;
  BEGIN
    UPDATE public.user_ai_provider_keys SET key_hint = 'forged' WHERE key_hint = 'key-A';
    RAISE EXCEPTION 'FAIL: owner UPDATE on user_ai_provider_keys was ACCEPTED';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected
  END;
  BEGIN
    DELETE FROM public.user_ai_provider_keys WHERE key_hint = 'key-A';
    RAISE EXCEPTION 'FAIL: owner DELETE on user_ai_provider_keys was ACCEPTED';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected
  END;
END $byok_owner_a$;

-- ===========================================================================
-- Keys table as another user: the status view leaks nothing.
-- ===========================================================================
SELECT set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
DO $byok_owner_b$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.user_ai_provider_key_status;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL: status view leaks % rows to user B, expected 0', v_count;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.user_ai_provider_keys WHERE key_hint = 'key-A';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL: user B reads % of user A''s key rows, expected 0', v_count;
  END IF;
END $byok_owner_b$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);

-- ===========================================================================
-- View column set: secret-adjacent columns are absent (superuser check)
-- ===========================================================================
DO $byok_view_cols$
DECLARE
  v_bad integer;
  v_good integer;
BEGIN
  SELECT count(*) INTO v_bad
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'user_ai_provider_key_status'
     AND column_name IN ('credentials_secret_id', 'last_error_code');
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'FAIL: status view exposes % secret columns', v_bad;
  END IF;

  SELECT count(*) INTO v_good
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'user_ai_provider_key_status'
     AND column_name IN ('id', 'user_id', 'provider_code', 'key_hint',
                         'status', 'last_verified_at', 'updated_at');
  IF v_good <> 7 THEN
    RAISE EXCEPTION 'FAIL: status view has % of the 7 expected columns', v_good;
  END IF;
END $byok_view_cols$;

-- ===========================================================================
-- Function privilege surface: neither RPC executable as anon/authenticated,
-- both executable as service_role; exactly one get_user_ai_provider_key.
-- ===========================================================================
DO $byok_privs$
DECLARE
  v_proc_count integer;
BEGIN
  IF has_function_privilege('anon',
      'public.get_user_ai_provider_key(uuid,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: get_user_ai_provider_key is EXECUTEable as anon';
  END IF;
  IF has_function_privilege('authenticated',
      'public.get_user_ai_provider_key(uuid,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: get_user_ai_provider_key is EXECUTEable as authenticated';
  END IF;
  IF NOT has_function_privilege('service_role',
      'public.get_user_ai_provider_key(uuid,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: get_user_ai_provider_key is NOT EXECUTEable as service_role';
  END IF;

  IF has_function_privilege('anon',
      'public.reclaim_user_ai_provider_key_secret()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: reclaim_user_ai_provider_key_secret is EXECUTEable as anon';
  END IF;
  IF has_function_privilege('authenticated',
      'public.reclaim_user_ai_provider_key_secret()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: reclaim_user_ai_provider_key_secret is EXECUTEable as authenticated';
  END IF;
  IF NOT has_function_privilege('service_role',
      'public.reclaim_user_ai_provider_key_secret()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: reclaim_user_ai_provider_key_secret is NOT EXECUTEable as service_role';
  END IF;

  -- One function, one signature: a second overload would double as a second
  -- read path with its own (default-open) privileges.
  SELECT count(*) INTO v_proc_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_user_ai_provider_key';
  IF v_proc_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: % pg_proc rows named get_user_ai_provider_key, expected exactly 1', v_proc_count;
  END IF;
END $byok_privs$;

-- ===========================================================================
-- VAULT-CONDITIONAL: positive decrypt reads + p_include_invalid behaviour.
-- Never CALLED when supabase_vault is absent: the plpgsql body fails only at
-- execution time without the extension, so calling it there would fail the
-- suite for the wrong reason. One NOTICE covers the skip.
-- ===========================================================================
DO $byok_vault_read$
DECLARE
  v_present boolean;
  v_a uuid := '11111111-1111-4111-8111-111111111111';
  v_b uuid := '22222222-2222-4222-8222-222222222222';
  v_key text;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault')
    INTO v_present;
  IF NOT v_present THEN
    RAISE NOTICE 'vault absent: skipping decrypt/reclaim assertions';
    RETURN;
  END IF;

  -- Positive control: A's key decrypts to the stored api_key.
  v_key := public.get_user_ai_provider_key(v_a, 'openai');
  IF v_key IS DISTINCT FROM 'byok-test-key-A' THEN
    RAISE EXCEPTION 'FAIL: decrypt for A returned %, expected the api_key', v_key;
  END IF;

  -- Structural tenancy: B has no row, so the RPC returns NULL rather than
  -- A's key. The ownership check lives in the SQL, not the caller.
  v_key := public.get_user_ai_provider_key(v_b, 'openai');
  IF v_key IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: decrypt for B returned a key for A''s row';
  END IF;

  -- An invalid key is invisible to the default (execution-path) call but
  -- readable with p_include_invalid (the test_key re-verify path).
  UPDATE public.user_ai_provider_keys
     SET status = 'invalid' WHERE user_id = v_a AND provider_code = 'openai';
  v_key := public.get_user_ai_provider_key(v_a, 'openai');
  IF v_key IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: invalid key still returned by the default call';
  END IF;
  v_key := public.get_user_ai_provider_key(v_a, 'openai', true);
  IF v_key IS DISTINCT FROM 'byok-test-key-A' THEN
    RAISE EXCEPTION 'FAIL: p_include_invalid=true returned %, expected the api_key', v_key;
  END IF;
  -- Heal the row: later blocks (reclaim) must see an active key.
  UPDATE public.user_ai_provider_keys
     SET status = 'active' WHERE user_id = v_a AND provider_code = 'openai';
END $byok_vault_read$;

-- ===========================================================================
-- Routing preferences: valid rows succeed; both CHECKs refuse; RLS isolates.
-- ===========================================================================
\echo '--- routing preferences as authenticated owner A ---'
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
DO $byok_routing_valid$
BEGIN
  -- Global default row and a user_first capability row with consent.
  INSERT INTO public.user_ai_routing_preferences
    (user_id, capability, mode, allow_platform_fallback)
  VALUES ('11111111-1111-4111-8111-111111111111', '*', 'postora_only', false);

  INSERT INTO public.user_ai_routing_preferences
    (user_id, capability, mode, preferred_provider_code, preferred_model_id,
     allow_platform_fallback)
  VALUES ('11111111-1111-4111-8111-111111111111', 'chat', 'user_first',
          'openai', 'gpt-4o-mini', true);

  -- Mode/consent CHECK, both directions: user_first REQUIRES consent...
  BEGIN
    INSERT INTO public.user_ai_routing_preferences
      (user_id, capability, mode, preferred_provider_code, preferred_model_id,
       allow_platform_fallback)
    VALUES ('11111111-1111-4111-8111-111111111111', 'agent', 'user_first',
            'openai', 'gpt-4o-mini', false);
    RAISE EXCEPTION 'FAIL: user_first without consent was ACCEPTED';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected: user_ai_routing_preferences_mode_consent_check
  END;
  -- ...and consent FORBIDS any other mode.
  BEGIN
    INSERT INTO public.user_ai_routing_preferences
      (user_id, capability, mode, allow_platform_fallback)
    VALUES ('11111111-1111-4111-8111-111111111111', 'agent', 'user_only', true);
    RAISE EXCEPTION 'FAIL: user_only with consent was ACCEPTED';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected: user_ai_routing_preferences_mode_consent_check
  END;

  -- Provider/model CHECK: user_only without a provider/model is refused.
  BEGIN
    INSERT INTO public.user_ai_routing_preferences
      (user_id, capability, mode, allow_platform_fallback)
    VALUES ('11111111-1111-4111-8111-111111111111', 'agent', 'user_only', false);
    RAISE EXCEPTION 'FAIL: user_only without provider/model was ACCEPTED';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected: user_ai_routing_preferences_provider_model_check
  END;

  -- RLS WITH CHECK: A cannot file a preference row under B's user_id.
  BEGIN
    INSERT INTO public.user_ai_routing_preferences
      (user_id, capability, mode, allow_platform_fallback)
    VALUES ('22222222-2222-4222-8222-222222222222', '*', 'postora_only', false);
    RAISE EXCEPTION 'FAIL: A inserted a routing row for B';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected: RLS WITH CHECK violation (SQLSTATE 42501)
  END;
END $byok_routing_valid$;

SELECT set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
DO $byok_routing_isolation$
DECLARE
  v_count integer;
BEGIN
  -- B reads none of A's preference rows.
  SELECT count(*) INTO v_count FROM public.user_ai_routing_preferences;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL: user B reads % routing rows, expected 0', v_count;
  END IF;
END $byok_routing_isolation$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);

-- ===========================================================================
-- Waitlist: one row per user per provider; unknown providers refused.
-- ===========================================================================
\echo '--- waitlist as authenticated owner A ---'
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
DO $byok_waitlist_a$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.ai_provider_waitlist (user_id, provider_code)
  VALUES ('11111111-1111-4111-8111-111111111111', 'codex');

  -- The PRIMARY KEY is the idempotency rule: a second join fails closed.
  BEGIN
    INSERT INTO public.ai_provider_waitlist (user_id, provider_code)
    VALUES ('11111111-1111-4111-8111-111111111111', 'codex');
    RAISE EXCEPTION 'FAIL: duplicate waitlist row was ACCEPTED';
  EXCEPTION WHEN unique_violation THEN
    NULL; -- expected
  END;

  -- Only 'codex' is a waitlistable provider.
  BEGIN
    INSERT INTO public.ai_provider_waitlist (user_id, provider_code)
    VALUES ('11111111-1111-4111-8111-111111111111', 'openai');
    RAISE EXCEPTION 'FAIL: waitlist row for openai was ACCEPTED';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;

  SELECT count(*) INTO v_count FROM public.ai_provider_waitlist;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: A reads % waitlist rows, expected 1', v_count;
  END IF;
END $byok_waitlist_a$;

SELECT set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
DO $byok_waitlist_b$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.ai_provider_waitlist;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL: user B reads % waitlist rows, expected 0', v_count;
  END IF;
END $byok_waitlist_b$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);

-- ===========================================================================
-- VAULT-CONDITIONAL reclaim: deleting the key row removes the Vault secret.
-- Runs after every block that needs A's key row to still exist.
-- ===========================================================================
DO $byok_reclaim$
DECLARE
  v_present boolean;
  v_a uuid := '11111111-1111-4111-8111-111111111111';
  v_secret_id uuid;
  v_left integer;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault')
    INTO v_present;
  IF NOT v_present THEN
    RAISE NOTICE 'vault absent: skipping decrypt/reclaim assertions';
    RETURN;
  END IF;

  SELECT credentials_secret_id INTO v_secret_id
    FROM public.user_ai_provider_keys
   WHERE user_id = v_a AND provider_code = 'openai';
  IF v_secret_id IS NULL THEN
    RAISE EXCEPTION 'FAIL: A''s key row has no linked Vault secret to reclaim';
  END IF;

  DELETE FROM public.user_ai_provider_keys
   WHERE user_id = v_a AND provider_code = 'openai';

  SELECT count(*) INTO v_left FROM vault.secrets WHERE id = v_secret_id;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'FAIL: Vault secret % survives its key row deletion', v_secret_id;
  END IF;
END $byok_reclaim$;

-- ===========================================================================
-- Catalog: providers renamed and still inactive; new models active; retired
-- models dark. is_active=false is asserted as UNCHANGED: the harness baseline
-- seeds both providers inactive, and this migration must not activate them
-- (the deployed backend would route them to Google).
-- ===========================================================================
DO $byok_catalog$
DECLARE
  v_name text;
  v_active boolean;
  v_new_active integer;
  v_retired_active integer;
BEGIN
  SELECT name, is_active INTO v_name, v_active
    FROM public.ai_providers WHERE provider_code = 'openai';
  IF v_name IS DISTINCT FROM 'OpenAI API' THEN
    RAISE EXCEPTION 'FAIL: openai provider name is %, expected OpenAI API', v_name;
  END IF;
  IF v_active THEN
    RAISE EXCEPTION 'FAIL: openai provider was ACTIVATED by the migration';
  END IF;

  SELECT name, is_active INTO v_name, v_active
    FROM public.ai_providers WHERE provider_code = 'claude';
  IF v_name IS DISTINCT FROM 'Anthropic API' THEN
    RAISE EXCEPTION 'FAIL: claude provider name is %, expected Anthropic API', v_name;
  END IF;
  IF v_active THEN
    RAISE EXCEPTION 'FAIL: claude provider was ACTIVATED by the migration';
  END IF;

  SELECT count(*) INTO v_new_active
    FROM public.ai_models m JOIN public.ai_providers p ON p.id = m.provider_id
   WHERE p.provider_code = 'claude' AND m.is_active
     AND m.model_id IN ('claude-sonnet-5',
                        'claude-haiku-4-5-20251001',
                        'claude-opus-5');
  IF v_new_active <> 3 THEN
    RAISE EXCEPTION 'FAIL: % of the 3 seeded Anthropic models are active', v_new_active;
  END IF;

  SELECT count(*) INTO v_retired_active
    FROM public.ai_models m JOIN public.ai_providers p ON p.id = m.provider_id
   WHERE p.provider_code = 'claude' AND m.is_active
     AND m.model_id IN ('claude-3-5-sonnet-20241022',
                        'claude-3-5-haiku-20241022',
                        'claude-3-opus-20240229',
                        'claude-sonnet-4-20250514');
  IF v_retired_active <> 0 THEN
    RAISE EXCEPTION 'FAIL: % retired Claude models are still active', v_retired_active;
  END IF;
END $byok_catalog$;

-- ===========================================================================
-- Flag row: present, false, and readable as an ordinary authenticated user
-- (the feature\_% arm of the app_settings SELECT policy).
-- ===========================================================================
DO $byok_flag_row$
DECLARE
  v_value jsonb;
BEGIN
  SELECT value INTO v_value FROM public.app_settings WHERE key = 'feature_byok_providers';
  IF v_value IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'FAIL: feature_byok_providers value is %, expected false', v_value;
  END IF;
END $byok_flag_row$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
DO $byok_flag_read$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.app_settings WHERE key = 'feature_byok_providers';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: authenticated reads % feature_byok_providers rows, expected 1', v_count;
  END IF;
END $byok_flag_read$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);

-- ===========================================================================
-- save_user_ai_provider_key privilege surface: service_role only, one
-- signature. The Edge Function calls it under the service role; a second
-- overload would double as a second write path with its own privileges.
-- ===========================================================================
\echo '--- save function privileges ---'
DO $byok_save_privs$
DECLARE
  v_proc_count integer;
BEGIN
  IF has_function_privilege('anon',
      'public.save_user_ai_provider_key(uuid,text,text,text,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: save_user_ai_provider_key is EXECUTEable as anon';
  END IF;
  IF has_function_privilege('authenticated',
      'public.save_user_ai_provider_key(uuid,text,text,text,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: save_user_ai_provider_key is EXECUTEable as authenticated';
  END IF;
  IF NOT has_function_privilege('service_role',
      'public.save_user_ai_provider_key(uuid,text,text,text,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: save_user_ai_provider_key is NOT EXECUTEable as service_role';
  END IF;

  SELECT count(*) INTO v_proc_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'save_user_ai_provider_key';
  IF v_proc_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: % pg_proc rows named save_user_ai_provider_key, expected exactly 1', v_proc_count;
  END IF;
END $byok_save_privs$;

-- ===========================================================================
-- save_user_ai_provider_key input guard: baseline-safe, no Vault needed.
-- Both refusals fire before any vault.* reference, so this block proves the
-- guard on a database without supabase_vault too.
-- ===========================================================================
\echo '--- save function input guard ---'
DO $byok_save_input_guard$
BEGIN
  BEGIN
    PERFORM 1 FROM public.save_user_ai_provider_key(
      '11111111-1111-4111-8111-111111111111', 'openai', '', 'hint-x', now()) AS s;
    RAISE EXCEPTION 'FAIL: empty api key was ACCEPTED';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL:%' THEN
      RAISE;
    ELSIF SQLERRM NOT LIKE '%api key must not be empty%' THEN
      RAISE;
    END IF;
    -- else the expected validation refusal: swallow
  END;

  BEGIN
    PERFORM 1 FROM public.save_user_ai_provider_key(
      '11111111-1111-4111-8111-111111111111', 'xai', 'byok-probe-key', 'hint-x', now()) AS s;
    RAISE EXCEPTION 'FAIL: unknown provider was ACCEPTED';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL:%' THEN
      RAISE;
    ELSIF SQLERRM NOT LIKE '%unknown provider%' THEN
      RAISE;
    END IF;
    -- else the expected validation refusal: swallow
  END;
END $byok_save_input_guard$;

-- ===========================================================================
-- VAULT-CONDITIONAL save/replace/heal: first save creates row + secret,
-- replacement reuses the row id AND the secret id, a save heals an
-- 'invalid' row back to 'active', and deleting the row still reclaims the
-- Vault secret. Never CALLED when supabase_vault is absent: the body
-- touches vault.* at execution time, so calling it there would fail the
-- suite for the wrong reason. One NOTICE covers the skip.
-- ===========================================================================
\echo '--- save/replace/heal (vault-conditional) ---'
DO $byok_save_replace$
DECLARE
  v_present boolean;
  v_a uuid := '11111111-1111-4111-8111-111111111111';
  v_n integer;
  v_first_id uuid;
  v_second_id uuid;
  v_status text;
  v_hint text;
  v_first_secret uuid;
  v_second_secret uuid;
  v_key text;
  v_left integer;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault')
    INTO v_present;
  IF NOT v_present THEN
    RAISE NOTICE 'vault absent: skipping save_user_ai_provider_key assertions';
    RETURN;
  END IF;

  -- First save: one row, active, hint stored, key readable back.
  SELECT s.id, s.status, s.key_hint INTO v_first_id, v_status, v_hint
    FROM public.save_user_ai_provider_key(
      v_a, 'openai', 'byok-save-key-1', 'hint-1', now()) AS s;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL: first save returned % rows, expected 1', v_n;
  END IF;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'FAIL: first save status is %, expected active', v_status;
  END IF;
  IF v_hint IS DISTINCT FROM 'hint-1' THEN
    RAISE EXCEPTION 'FAIL: first save key_hint is %, expected hint-1', v_hint;
  END IF;
  v_key := public.get_user_ai_provider_key(v_a, 'openai');
  IF v_key IS DISTINCT FROM 'byok-save-key-1' THEN
    RAISE EXCEPTION 'FAIL: first save key reads back as %, expected byok-save-key-1', v_key;
  END IF;
  SELECT k.credentials_secret_id INTO v_first_secret
    FROM public.user_ai_provider_keys AS k
   WHERE k.user_id = v_a AND k.provider_code = 'openai';
  IF v_first_secret IS NULL THEN
    RAISE EXCEPTION 'FAIL: first save left no linked Vault secret';
  END IF;

  -- Replacement save: same row id, SAME secret id (in-place update), new key.
  SELECT s.id, s.status, s.key_hint INTO v_second_id, v_status, v_hint
    FROM public.save_user_ai_provider_key(
      v_a, 'openai', 'byok-save-key-2', 'hint-2', now()) AS s;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL: replacement save returned % rows, expected 1', v_n;
  END IF;
  IF v_second_id IS DISTINCT FROM v_first_id THEN
    RAISE EXCEPTION 'FAIL: replacement save changed row id % to %', v_first_id, v_second_id;
  END IF;
  SELECT k.credentials_secret_id INTO v_second_secret
    FROM public.user_ai_provider_keys AS k
   WHERE k.user_id = v_a AND k.provider_code = 'openai';
  IF v_second_secret IS DISTINCT FROM v_first_secret THEN
    RAISE EXCEPTION 'FAIL: replacement save re-pointed secret % to %', v_first_secret, v_second_secret;
  END IF;
  v_key := public.get_user_ai_provider_key(v_a, 'openai');
  IF v_key IS DISTINCT FROM 'byok-save-key-2' THEN
    RAISE EXCEPTION 'FAIL: replacement save key reads back as %, expected byok-save-key-2', v_key;
  END IF;

  -- Heal: an invalid row comes back active on the next save.
  UPDATE public.user_ai_provider_keys
     SET status = 'invalid'
   WHERE user_id = v_a AND provider_code = 'openai';
  SELECT s.id, s.status INTO v_second_id, v_status
    FROM public.save_user_ai_provider_key(
      v_a, 'openai', 'byok-save-key-3', 'hint-3', now()) AS s;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'FAIL: save did not heal invalid status, got %', v_status;
  END IF;
  IF v_second_id IS DISTINCT FROM v_first_id THEN
    RAISE EXCEPTION 'FAIL: heal save changed row id % to %', v_first_id, v_second_id;
  END IF;
  v_key := public.get_user_ai_provider_key(v_a, 'openai');
  IF v_key IS DISTINCT FROM 'byok-save-key-3' THEN
    RAISE EXCEPTION 'FAIL: heal save key reads back as %, expected byok-save-key-3', v_key;
  END IF;

  -- The save path reclaims like the direct-write path: deleting the row
  -- removes the Vault secret.
  SELECT k.credentials_secret_id INTO v_second_secret
    FROM public.user_ai_provider_keys AS k
   WHERE k.user_id = v_a AND k.provider_code = 'openai';
  DELETE FROM public.user_ai_provider_keys
   WHERE user_id = v_a AND provider_code = 'openai';
  SELECT count(*) INTO v_left FROM vault.secrets WHERE id = v_second_secret;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'FAIL: Vault secret % survives its save-path key row deletion', v_second_secret;
  END IF;
END $byok_save_replace$;

-- ===========================================================================
-- VAULT-CONDITIONAL rollback proof: a save rolled back leaves neither a row
-- nor a Vault secret behind. The whole point of the transactional wrapper
-- is that the Vault write shares the row's fate.
-- ===========================================================================
\echo '--- save rollback proof (vault-conditional) ---'
DO $byok_save_rollback$
DECLARE
  v_present boolean;
  v_b uuid := '22222222-2222-4222-8222-222222222222';
  v_before integer;
  v_after integer;
  v_rows integer;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault')
    INTO v_present;
  IF NOT v_present THEN
    RAISE NOTICE 'vault absent: skipping save rollback assertion';
    RETURN;
  END IF;

  SELECT count(*) INTO v_before
    FROM vault.secrets
   WHERE name LIKE 'user_ai_provider_key:credentials:%';

  -- No explicit SAVEPOINT here on purpose: ROLLBACK TO SAVEPOINT is a
  -- transaction-control statement, which plpgsql (and therefore a DO block)
  -- rejects. The inner BEGIN/EXCEPTION block below establishes its own
  -- implicit subtransaction instead: everything it does -- the Vault write
  -- plus the row upsert -- is undone when the deliberate exception is
  -- caught, which is exactly the atomicity this proves.
  BEGIN
    PERFORM 1 FROM public.save_user_ai_provider_key(
      v_b, 'openai', 'byok-rollback-probe', 'hint-rb', now()) AS s;
    RAISE EXCEPTION 'byok deliberate rollback probe';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%deliberate rollback probe%' THEN
      RAISE;
    END IF;
    -- Swallowing here rolls the inner block back to its implicit
    -- savepoint: the save's Vault write and row insert are both undone.
  END;

  SELECT count(*) INTO v_rows
    FROM public.user_ai_provider_keys
   WHERE user_id = v_b;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL: rollback left % key rows for B, expected 0', v_rows;
  END IF;

  SELECT count(*) INTO v_after
    FROM vault.secrets
   WHERE name LIKE 'user_ai_provider_key:credentials:%';
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'FAIL: rollback left vault secrets behind (% before, % after)', v_before, v_after;
  END IF;
END $byok_save_rollback$;

-- ===========================================================================
-- delete_user_ai_provider_key privilege surface: service_role only, one
-- signature. The Edge Function calls it under the service role; a second
-- overload would double as a second delete path with its own privileges.
-- ===========================================================================
\echo '--- delete function privileges ---'
DO $byok_delete_privs$
DECLARE
  v_proc_count integer;
BEGIN
  IF has_function_privilege('anon',
      'public.delete_user_ai_provider_key(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: delete_user_ai_provider_key is EXECUTEable as anon';
  END IF;
  IF has_function_privilege('authenticated',
      'public.delete_user_ai_provider_key(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: delete_user_ai_provider_key is EXECUTEable as authenticated';
  END IF;
  IF NOT has_function_privilege('service_role',
      'public.delete_user_ai_provider_key(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: delete_user_ai_provider_key is NOT EXECUTEable as service_role';
  END IF;

  SELECT count(*) INTO v_proc_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'delete_user_ai_provider_key';
  IF v_proc_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: % pg_proc rows named delete_user_ai_provider_key, expected exactly 1', v_proc_count;
  END IF;
END $byok_delete_privs$;

-- ===========================================================================
-- delete_user_ai_provider_key baseline-safe: a (user, provider) with no row
-- returns false and raises nothing. No Vault needed: the body touches no
-- vault.* object, so this proves the no-op path on a database without
-- supabase_vault too. User B / openai has no row on either shape: the
-- rollback block above leaves B empty when vault is present, and B never
-- gains a row when it is absent.
-- ===========================================================================
\echo '--- delete function baseline-safe no-row ---'
DO $byok_delete_baseline$
DECLARE
  v_result boolean;
BEGIN
  SELECT public.delete_user_ai_provider_key(
    '22222222-2222-4222-8222-222222222222', 'openai') INTO v_result;
  IF v_result IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL: delete with no row returned %, expected false', v_result;
  END IF;
END $byok_delete_baseline$;

-- ===========================================================================
-- VAULT-CONDITIONAL delete via RPC: save, then delete through the RPC, and
-- the row is gone AND the Vault secret the row referenced is gone (the
-- AFTER DELETE trigger fired inside the RPC transaction); a second call
-- returns false. Never CALLED when supabase_vault is absent: the save path
-- touches vault.* at execution time, so calling it there would fail the
-- suite for the wrong reason. One NOTICE covers the skip.
-- ===========================================================================
\echo '--- delete via RPC (vault-conditional) ---'
DO $byok_delete_vault$
DECLARE
  v_present boolean;
  v_a uuid := '11111111-1111-4111-8111-111111111111';
  v_result boolean;
  v_secret uuid;
  v_rows integer;
  v_left integer;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault')
    INTO v_present;
  IF NOT v_present THEN
    RAISE NOTICE 'vault absent: skipping delete_user_ai_provider_key assertions';
    RETURN;
  END IF;

  PERFORM 1 FROM public.save_user_ai_provider_key(
    v_a, 'openai', 'byok-delete-key-1', 'hint-del', now()) AS s;

  SELECT k.credentials_secret_id INTO v_secret
    FROM public.user_ai_provider_keys AS k
   WHERE k.user_id = v_a AND k.provider_code = 'openai';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'FAIL: save left no linked Vault secret for the delete test';
  END IF;

  SELECT public.delete_user_ai_provider_key(v_a, 'openai') INTO v_result;
  IF v_result IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: delete via RPC returned %, expected true', v_result;
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.user_ai_provider_keys
   WHERE user_id = v_a AND provider_code = 'openai';
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL: delete via RPC left % key rows, expected 0', v_rows;
  END IF;

  SELECT count(*) INTO v_left FROM vault.secrets WHERE id = v_secret;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'FAIL: Vault secret % survives delete_user_ai_provider_key', v_secret;
  END IF;

  SELECT public.delete_user_ai_provider_key(v_a, 'openai') INTO v_result;
  IF v_result IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL: second delete via RPC returned %, expected false', v_result;
  END IF;
END $byok_delete_vault$;

-- ===========================================================================
-- Save/delete lock-key proof: baseline-safe, no Vault needed. Advisory locks
-- only exclude each other when both sides hash the same key, so both
-- function bodies must contain the identical lock expression -- a drift
-- between them would silently stop the save and the delete from
-- serialising each other.
-- ===========================================================================
\echo '--- save/delete lock key parity ---'
DO $byok_delete_lockkey$
DECLARE
  v_save_src text;
  v_delete_src text;
  c_lock text := 'pg_advisory_xact_lock(hashtext(p_user_id::text || '':'' || p_provider_code))';
BEGIN
  SELECT p.prosrc INTO v_save_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'save_user_ai_provider_key';
  SELECT p.prosrc INTO v_delete_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'delete_user_ai_provider_key';
  IF v_save_src IS NULL THEN
    RAISE EXCEPTION 'FAIL: save_user_ai_provider_key body not found';
  END IF;
  IF v_delete_src IS NULL THEN
    RAISE EXCEPTION 'FAIL: delete_user_ai_provider_key body not found';
  END IF;
  IF position(c_lock IN v_save_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: save function body lacks the shared lock expression';
  END IF;
  IF position(c_lock IN v_delete_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: delete function body lacks the shared lock expression';
  END IF;
END $byok_delete_lockkey$;

-- ===========================================================================
-- get_user_ai_provider_key_snapshot privilege surface: service_role only,
-- one signature. The Edge Function calls it under the service role; a
-- second overload would double as a second read path with its own
-- privileges.
-- ===========================================================================
\echo '--- snapshot function privileges ---'
DO $byok_snapshot_privs$
DECLARE
  v_proc_count integer;
BEGIN
  IF has_function_privilege('anon',
      'public.get_user_ai_provider_key_snapshot(uuid,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: get_user_ai_provider_key_snapshot is EXECUTEable as anon';
  END IF;
  IF has_function_privilege('authenticated',
      'public.get_user_ai_provider_key_snapshot(uuid,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: get_user_ai_provider_key_snapshot is EXECUTEable as authenticated';
  END IF;
  IF NOT has_function_privilege('service_role',
      'public.get_user_ai_provider_key_snapshot(uuid,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: get_user_ai_provider_key_snapshot is NOT EXECUTEable as service_role';
  END IF;

  SELECT count(*) INTO v_proc_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_user_ai_provider_key_snapshot';
  IF v_proc_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: % pg_proc rows named get_user_ai_provider_key_snapshot, expected exactly 1', v_proc_count;
  END IF;
END $byok_snapshot_privs$;

-- ===========================================================================
-- VAULT-CONDITIONAL snapshot: key + row version from one statement. Never
-- CALLED when supabase_vault is absent: the plpgsql body fails only at
-- execution time without the extension, so calling it there would fail the
-- suite for the wrong reason. One NOTICE covers the skip.
-- ===========================================================================
\echo '--- snapshot read (vault-conditional) ---'
DO $byok_snapshot_read$
DECLARE
  v_present boolean;
  v_a uuid := '11111111-1111-4111-8111-111111111111';
  v_b uuid := '22222222-2222-4222-8222-222222222222';
  v_n integer;
  v_api_key text;
  v_status text;
  v_snap_ts timestamptz;
  v_row_ts timestamptz;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault')
    INTO v_present;
  IF NOT v_present THEN
    RAISE NOTICE 'vault absent: skipping get_user_ai_provider_key_snapshot assertions';
    RETURN;
  END IF;

  -- Own fixture: the earlier blocks deleted A's key row, so save one here.
  PERFORM 1 FROM public.save_user_ai_provider_key(
    v_a, 'openai', 'byok-snapshot-key-1', 'hint-snap', now()) AS s;

  -- Exactly one row: the saved key, active, version equal to the row.
  SELECT count(*) INTO v_n
    FROM public.get_user_ai_provider_key_snapshot(v_a, 'openai') AS s;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL: snapshot returned % rows for A, expected 1', v_n;
  END IF;
  SELECT s.api_key, s.status, s.updated_at
    INTO v_api_key, v_status, v_snap_ts
    FROM public.get_user_ai_provider_key_snapshot(v_a, 'openai') AS s;
  IF v_api_key IS DISTINCT FROM 'byok-snapshot-key-1' THEN
    RAISE EXCEPTION 'FAIL: snapshot api_key is %, expected byok-snapshot-key-1', v_api_key;
  END IF;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'FAIL: snapshot status is %, expected active', v_status;
  END IF;
  SELECT k.updated_at INTO v_row_ts
    FROM public.user_ai_provider_keys AS k
   WHERE k.user_id = v_a AND k.provider_code = 'openai';
  IF v_snap_ts IS DISTINCT FROM v_row_ts THEN
    RAISE EXCEPTION 'FAIL: snapshot updated_at % disagrees with row updated_at %', v_snap_ts, v_row_ts;
  END IF;

  -- An invalid key is invisible to the default call but readable with
  -- p_include_invalid (the re-verify path).
  UPDATE public.user_ai_provider_keys
     SET status = 'invalid' WHERE user_id = v_a AND provider_code = 'openai';
  SELECT count(*) INTO v_n
    FROM public.get_user_ai_provider_key_snapshot(v_a, 'openai') AS s;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL: snapshot returned % rows for invalid key, expected 0', v_n;
  END IF;
  SELECT count(*) INTO v_n
    FROM public.get_user_ai_provider_key_snapshot(v_a, 'openai', true) AS s;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL: snapshot with p_include_invalid returned % rows, expected 1', v_n;
  END IF;
  SELECT s.api_key, s.status INTO v_api_key, v_status
    FROM public.get_user_ai_provider_key_snapshot(v_a, 'openai', true) AS s;
  IF v_api_key IS DISTINCT FROM 'byok-snapshot-key-1' THEN
    RAISE EXCEPTION 'FAIL: snapshot p_include_invalid api_key is %, expected byok-snapshot-key-1', v_api_key;
  END IF;
  IF v_status IS DISTINCT FROM 'invalid' THEN
    RAISE EXCEPTION 'FAIL: snapshot p_include_invalid status is %, expected invalid', v_status;
  END IF;

  -- Structural tenancy: B has no row, so the snapshot returns zero rows
  -- rather than A's key. The ownership check lives in the SQL, not the caller.
  SELECT count(*) INTO v_n
    FROM public.get_user_ai_provider_key_snapshot(v_b, 'openai') AS s;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL: snapshot returned % rows for B, expected 0', v_n;
  END IF;

  -- This block owns its fixture row: remove it so the trailing cleanup
  -- assertion (empty key table) still holds on the vault path.
  DELETE FROM public.user_ai_provider_keys
   WHERE user_id = v_a AND provider_code = 'openai';
END $byok_snapshot_read$;

-- ---------------------------------------------------------------------------
-- Trailing cleanup: the suite leaves no rows behind.
-- ---------------------------------------------------------------------------
DO $byok_cleanup_trailing$
BEGIN
  DELETE FROM public.user_ai_provider_keys
   WHERE user_id IN ('11111111-1111-4111-8111-111111111111',
                     '22222222-2222-4222-8222-222222222222');
  DELETE FROM public.user_ai_routing_preferences
   WHERE user_id IN ('11111111-1111-4111-8111-111111111111',
                     '22222222-2222-4222-8222-222222222222');
  DELETE FROM public.ai_provider_waitlist
   WHERE user_id IN ('11111111-1111-4111-8111-111111111111',
                     '22222222-2222-4222-8222-222222222222');
  -- Remove the catalog fixture (models first: they FK to the providers).
  -- The harness database is left exactly as found: empty provider catalog.
  DELETE FROM public.ai_models m USING public.ai_providers p
   WHERE m.provider_id = p.id AND p.provider_code = 'claude'
     AND m.model_id IN ('claude-sonnet-5',
                        'claude-haiku-4-5-20251001',
                        'claude-opus-5',
                        'claude-3-5-sonnet-20241022',
                        'claude-3-5-haiku-20241022',
                        'claude-3-opus-20240229',
                        'claude-sonnet-4-20250514');
  DELETE FROM public.ai_providers
   WHERE provider_code IN ('openai', 'claude', 'gemini', 'openrouter');
  DELETE FROM auth.users
   WHERE id IN ('11111111-1111-4111-8111-111111111111',
                '22222222-2222-4222-8222-222222222222');
END $byok_cleanup_trailing$;

\echo '=== byok_provider_keys: ALL CHECKS PASSED ==='
