-- Reproduces supabase/manual-sql/20260712120500_ai_agent_fallback_models.sql.
-- Nullable text, no default, no CHECK, no foreign key -- matching production
-- exactly. Phase 3 stops reading these columns but never drops them.

ALTER TABLE public.ai_agent_configs
    ADD COLUMN IF NOT EXISTS fallback_model_1 text,
    ADD COLUMN IF NOT EXISTS fallback_model_2 text;
