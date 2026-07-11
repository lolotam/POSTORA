-- ═══════════════════════════════════════════════════════════════════
-- AI Agent fallback model columns
-- Users select a primary model (from admin allow-list) plus up to two
-- fallback models. The edge function tries them in order if a call fails.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.ai_agent_configs
    ADD COLUMN IF NOT EXISTS fallback_model_1 text,
    ADD COLUMN IF NOT EXISTS fallback_model_2 text;

-- Rollback:
--   ALTER TABLE public.ai_agent_configs
--     DROP COLUMN IF EXISTS fallback_model_1,
--     DROP COLUMN IF EXISTS fallback_model_2;
