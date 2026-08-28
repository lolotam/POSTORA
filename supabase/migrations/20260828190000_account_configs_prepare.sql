-- ============================================================================
-- Per-account agent configuration -- PREPARE half (PR B-1)
-- ============================================================================
-- Lands every change needed for per-account agent configs EXCEPT the final
-- drop of ai_agent_configs_user_id_platform_key, which stays enforced here.
-- The orchestrator applies that one-line drop as a separate migration once
-- this code is deployed and verified; everything in this file must hold
-- while the constraint still stands.
--
--   A. the clone that gives every active messaging account a config of its
--      own -- written here so it is reviewed and tested alongside the code
--      that depends on it, but structurally inert while the legacy
--      constraint exists (see the guard);
--   B. asserts no config row is left without an account;
--   C. makes the config's account link prove the PLATFORM matches, not just
--      the owner;
--   D. NOT the SET NOT NULL -- that ships with the constraint drop, once the
--      deployed code has stopped writing a null account.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- A. Clone: every active messaging account inherits the owner's config
-- ---------------------------------------------------------------------------
-- One login can own several accounts per platform (production today: 6
-- Facebook pages, 9 Instagram accounts, 6 Threads profiles). While the
-- legacy UNIQUE (user_id, platform) stands there is exactly one config row
-- per (owner, platform) and the other accounts read it through the platform
-- fallback in _shared/agentConfigLookup.ts. The moment that constraint is
-- dropped the fallback becomes a genuine cross-account read and must be
-- deleted -- so every account needs its OWN row before that happens, or
-- pages B-F resolve to nothing and their agents go silent.
--
-- THE CLONE CANNOT EXECUTE IN THIS MIGRATION. Cloning inserts a second row
-- for a (user_id, platform) pair -- always, by construction -- which the
-- legacy constraint forbids. The guard below therefore keeps the statement
-- inert while the constraint exists; it is a no-op as this file applies,
-- under every possible apply order. The migration that drops
-- ai_agent_configs_user_id_platform_key is where the clone belongs: it must
-- repeat this INSERT unguarded, immediately AFTER the drop and inside the same
-- transaction. Not before -- a unique constraint is checked per statement, so
-- the first cloned row would raise 23505 while the constraint still stands.
-- Same transaction, so no session sees uniqueness gone with an account still
-- falling back to another's config.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_agent_configs_user_id_platform_key'
      AND conrelid = 'public.ai_agent_configs'::regclass
  ) THEN
    RAISE NOTICE 'ai_agent_configs_user_id_platform_key still enforced: clone skipped, it belongs to the migration that drops this constraint';
  ELSE
    INSERT INTO public.ai_agent_configs (
      user_id, platform, social_account_id,
      is_enabled, default_mode, persona_instructions, business_profile_text,
      language_mode, model, fallback_model_1, fallback_model_2, temperature,
      admin_phone_numbers, daily_message_cap, reply_cooldown_seconds,
      max_tool_iterations, handoff_on_request, handoff_on_low_confidence
    )
    SELECT
      config.user_id, config.platform, account.id,
      config.is_enabled, config.default_mode, config.persona_instructions,
      config.business_profile_text, config.language_mode, config.model,
      config.fallback_model_1, config.fallback_model_2, config.temperature,
      config.admin_phone_numbers, config.daily_message_cap,
      config.reply_cooldown_seconds, config.max_tool_iterations,
      config.handoff_on_request, config.handoff_on_low_confidence
    FROM public.social_accounts AS account
    JOIN public.ai_agent_configs AS config
      ON config.user_id = account.user_id
     AND config.platform = account.platform
    WHERE account.platform IN ('whatsapp', 'facebook', 'instagram', 'threads')
      AND account.is_active
      -- Only accounts with no config of their own; re-runs and accounts the
      -- backfill already bound are skipped, and the source config's own
      -- account is excluded because it does have a config.
      AND NOT EXISTS (
        SELECT 1 FROM public.ai_agent_configs AS own
        WHERE own.social_account_id = account.id
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- B. Guard: no config without an account
-- ---------------------------------------------------------------------------
-- Production has zero such rows since the 20260828140000 backfill; this is a
-- guard, not a repair. A NULL here would survive as a row no account-scoped
-- read can find, and once per-account writes are the only writes nothing
-- would ever target it again -- so fail loudly with the offending list
-- instead of carrying the row silently forward.
DO $$
DECLARE
  orphans integer;
  detail text;
BEGIN
  SELECT count(*) INTO orphans
  FROM public.ai_agent_configs WHERE social_account_id IS NULL;
  IF orphans > 0 THEN
    SELECT string_agg(format('%s/%s', user_id, platform), ', ')
      INTO detail
      FROM public.ai_agent_configs WHERE social_account_id IS NULL;
    RAISE EXCEPTION
      '% agent config(s) still have no account: %. '
      'Reconnect the account, assign it in the UI, or delete the row, then re-run.',
      orphans, detail;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- C. The config's account link must prove the platform too
-- ---------------------------------------------------------------------------
-- The composite FK from 20260828140000 proves the account belongs to the
-- same owner, but says nothing about the platform: a config row can name
-- platform = 'instagram' while pointing at a Facebook account, and every
-- reader keyed on the account would load the Facebook persona for an
-- Instagram request. Extending the key on social_accounts and pointing the
-- config's FK at it moves that check into the schema, where the service
-- role cannot bypass it. Production has zero mismatching rows, so the new
-- FK validates cleanly.
ALTER TABLE public.social_accounts
  DROP CONSTRAINT IF EXISTS social_accounts_id_user_id_platform_key;
ALTER TABLE public.social_accounts
  ADD CONSTRAINT social_accounts_id_user_id_platform_key
  UNIQUE (id, user_id, platform);

-- The (id, user_id) key from 20260828140000 stays: ai_knowledge_source_accounts
-- still references it, and the wider key above does not replace it for that
-- foreign key.
ALTER TABLE public.ai_agent_configs
  DROP CONSTRAINT IF EXISTS ai_agent_configs_account_same_owner;
ALTER TABLE public.ai_agent_configs
  ADD CONSTRAINT ai_agent_configs_account_same_owner_platform
  FOREIGN KEY (social_account_id, user_id, platform)
  REFERENCES public.social_accounts (id, user_id, platform)
  ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- D. SET NOT NULL is deliberately NOT here
-- ---------------------------------------------------------------------------
-- It belongs with the constraint drop, not with this preparation, and the
-- reason is the apply order rather than the data: a migration always lands
-- before the code that depends on it. Between the two, the DEPLOYED
-- messaging-api is still the old one, and its unscoped ai_upsert_config
-- branch inserts { user_id, platform, ... } with no social_account_id. For a
-- platform the owner has already configured that is an UPDATE and harmless;
-- for a first-time save it is an INSERT, and against a NOT NULL column it
-- fails outright.
--
-- 2026-08-28: this file was applied by hand while it still carried the
-- constraint, and exactly that happened -- every owner who had not yet
-- configured a platform could no longer configure one, 52 accounts across 20
-- logins. It was reverted with ALTER COLUMN ... DROP NOT NULL and moved here
-- in writing so it cannot be reintroduced by a replay.
--
-- The follow-up migration adds it after the scoped write path is serving,
-- alongside the clone and the drop of ai_agent_configs_user_id_platform_key.

COMMIT;
