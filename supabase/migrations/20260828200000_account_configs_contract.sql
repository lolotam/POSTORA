-- Apply only after 20260828190000's code is deployed and serving (done: main 61285b74).
--
-- Retires one-config-per-platform. Two statements that must not be separated: the constraint
-- that allows only one config per (owner, platform) goes away, and every active account
-- immediately gets a config of its own.
--
-- THE DROP COMES FIRST, and that order is forced rather than chosen. A unique constraint is
-- checked per statement, not at commit, so cloning account B's config while the constraint
-- still stands raises 23505 on the very first insert -- the clone is only legal once the
-- constraint is gone. Both statements share one transaction, so there is no instant at which
-- uniqueness has been dropped and an account is still without a config.
--
-- Ordering is the whole point. While UNIQUE (user_id, platform) stands, one config per
-- (owner, platform) serves every account on that platform through the platform fallback in
-- _shared/agentConfigLookup.ts. Drop the constraint and delete that fallback with no clone,
-- and every account that was inheriting resolves to nothing -- its agent goes silent with
-- one agent_not_configured line per inbound message as the only evidence.
--
-- Do NOT apply this before PR B-1 is live. The frontend shipped in B-1 is what stops
-- ai_upsert_config taking its unscoped branch; that branch upserts
-- ON CONFLICT (user_id, platform), and against a dropped constraint PostgREST answers 42P10
-- on every agent settings save.
--
-- FORWARD-ONLY. Once several configs share a platform the constraint cannot be restored, and
-- code that upserts on it fails against a target that no longer exists. Roll forward.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. Drop the constraint that makes the clone illegal
-- ---------------------------------------------------------------------------

ALTER TABLE public.ai_agent_configs
  DROP CONSTRAINT IF EXISTS ai_agent_configs_user_id_platform_key;

-- ---------------------------------------------------------------------------
-- B. Clone, now that a second row per platform is legal
-- ---------------------------------------------------------------------------
-- Runs immediately after the drop, in the same transaction, so no other session ever observes
-- a state where uniqueness is gone and an account still has no config. Against production this
-- currently inserts zero rows -- every account without its own config belongs to an owner who has no
-- config for that platform either -- but it is written for the case that appears the moment
-- any of those owners configures a platform.

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
  ON config.user_id = account.user_id AND config.platform = account.platform
WHERE account.platform IN ('whatsapp', 'facebook', 'instagram', 'threads')
  AND account.is_active
  AND NOT EXISTS (
    SELECT 1 FROM public.ai_agent_configs AS own
    WHERE own.social_account_id = account.id
  );

-- ---------------------------------------------------------------------------
-- C. Assert nothing was left behind
-- ---------------------------------------------------------------------------
-- The check 20260828150000 never made: it asserted every CONFIG has an account, never that
-- every active ACCOUNT has a config. Both directions, after the clone, inside the same
-- transaction, so a failure rolls the drop back with it.

DO $$
DECLARE
  silent integer;
  detail text;
BEGIN
  SELECT count(*) INTO silent
  FROM public.social_accounts AS account
  WHERE account.is_active
    AND account.platform IN ('whatsapp', 'facebook', 'instagram', 'threads')
    AND EXISTS (
      SELECT 1 FROM public.ai_agent_configs AS peer
      WHERE peer.user_id = account.user_id AND peer.platform = account.platform
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.ai_agent_configs AS own
      WHERE own.social_account_id = account.id
    );
  IF silent > 0 THEN
    SELECT string_agg(format('%s/%s', account.id, account.platform), ', ') INTO detail
    FROM public.social_accounts AS account
    WHERE account.is_active
      AND account.platform IN ('whatsapp', 'facebook', 'instagram', 'threads')
      AND NOT EXISTS (
        SELECT 1 FROM public.ai_agent_configs AS own
        WHERE own.social_account_id = account.id
      );
    RAISE EXCEPTION
      '% active account(s) whose owner has a config for that platform still have none of '
      'their own after the clone: %. Aborting rather than silencing them.', silent, detail;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- D. The account becomes mandatory
-- ---------------------------------------------------------------------------
-- Held back from 20260828190000 because a migration always lands before the code that
-- depends on it: in that gap the deployed messaging-api still inserted a config with no
-- account, and on 2026-08-28 exactly that blocked every first-time save for 52 accounts.
-- Safe here only because the scoped write path is already serving and (C) just proved the
-- column holds no nulls -- rechecked immediately before the constraint, not earlier in the
-- transaction, since a concurrent write from an old worker could still have landed.

DO $$
DECLARE
  nulls integer;
BEGIN
  SELECT count(*) INTO nulls FROM public.ai_agent_configs WHERE social_account_id IS NULL;
  IF nulls > 0 THEN
    RAISE EXCEPTION '% config(s) still have no account; deploy the scoped write path first.', nulls;
  END IF;
END $$;

ALTER TABLE public.ai_agent_configs
  ALTER COLUMN social_account_id SET NOT NULL;

COMMIT;

-- After this lands, delete the platform fallback in _shared/agentConfigLookup.ts and the
-- matching unscoped read in messaging-api's ai_get_config. Until they are gone the fallback
-- is a genuine cross-account read: page B would answer in page A's voice.
