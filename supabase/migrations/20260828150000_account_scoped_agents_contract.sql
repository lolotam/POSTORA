-- ============================================================================
-- Per-account agent tenancy -- CONTRACT half
-- ============================================================================
-- DO NOT APPLY WITH THE EXPANSION MIGRATION.
--
-- Ordering (from docs/plans/agent-tenancy-and-knowledge-scoping.md section 5):
--   1. 20260828140000_..._expand.sql   -- while the OLD functions are live
--   2. deploy the account-aware edge functions, verify hashes, restart
--   3. ship the account selector in the frontend
--   4. THIS FILE, once every config has an account
--
-- Applying this before step 3 breaks the frontend: it drops
-- UNIQUE (user_id, platform), which the old `ai_upsert_config` upsert targets
-- through onConflict, so every agent settings save starts failing.
--
-- The assertion below is the gate. It fails loudly rather than leaving a NULL
-- behind, because a config with no account is one an agent can still adopt
-- through the expansion-window fallback in ai-agent-reply -- exactly the
-- silent inheritance this work removes.
-- ============================================================================

BEGIN;

-- Re-run the backfill: rows written during the expansion window may have
-- arrived through the old code path with no account, and an account
-- disconnected at expansion time may since have reconnected.
UPDATE public.ai_agent_configs AS config
SET social_account_id = account.id
FROM public.social_accounts AS account
WHERE account.user_id = config.user_id
  AND account.platform = config.platform
  AND account.is_active
  AND config.social_account_id IS NULL
  AND (
    SELECT count(*) FROM public.social_accounts AS candidate
    WHERE candidate.user_id = config.user_id
      AND candidate.platform = config.platform
      AND candidate.is_active
  ) = 1;

DO $$
DECLARE
  orphans integer;
  detail text;
BEGIN
  SELECT count(*) INTO orphans FROM public.ai_agent_configs WHERE social_account_id IS NULL;
  IF orphans > 0 THEN
    SELECT string_agg(format('%s/%s', user_id, platform), ', ')
      INTO detail
      FROM public.ai_agent_configs WHERE social_account_id IS NULL;
    RAISE EXCEPTION
      '% agent config(s) still have no account and cannot be resolved automatically: %. '
      'Reconnect the account, assign it in the UI, or delete the row, then re-run.',
      orphans, detail;
  END IF;
END $$;

ALTER TABLE public.ai_agent_configs
  ALTER COLUMN social_account_id SET NOT NULL;

-- The reason the column exists: without dropping this, a login with nine
-- Instagram accounts is still limited to one Instagram persona.
ALTER TABLE public.ai_agent_configs
  DROP CONSTRAINT IF EXISTS ai_agent_configs_user_id_platform_key;

COMMIT;

-- The three legacy user-wide matchers (match_ai_knowledge_chunks,
-- match_ai_knowledge_chunks_bge_m3, match_ai_knowledge_graph_relations) are
-- deliberately NOT dropped here. They are the rollback path for the edge
-- functions, and the deployed test sandbox still reaches them when it has no
-- account context. Drop them in a separate cleanup once nothing calls them.
