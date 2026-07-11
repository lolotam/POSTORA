-- ═══════════════════════════════════════════════════════════════════
-- AI Agent Allowed Models
-- Admin curates a list of models available to users in the AI agent
-- Advanced panel. Users pick 1 primary + up to 2 fallbacks.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ai_agent_allowed_models (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL,
    model_id text NOT NULL,
    label text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 100,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, model_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_allowed_models_active
    ON public.ai_agent_allowed_models (is_active, sort_order);

GRANT SELECT ON public.ai_agent_allowed_models TO authenticated;
GRANT ALL ON public.ai_agent_allowed_models TO service_role;

ALTER TABLE public.ai_agent_allowed_models ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_agent_allowed_models_read_active" ON public.ai_agent_allowed_models;
CREATE POLICY "ai_agent_allowed_models_read_active"
    ON public.ai_agent_allowed_models FOR SELECT
    TO authenticated
    USING (is_active = true OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "ai_agent_allowed_models_admin_all" ON public.ai_agent_allowed_models;
CREATE POLICY "ai_agent_allowed_models_admin_all"
    ON public.ai_agent_allowed_models FOR ALL
    TO authenticated
    USING (public.has_role(auth.uid(), 'admin'))
    WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Seed with common defaults
INSERT INTO public.ai_agent_allowed_models (provider, model_id, label, sort_order) VALUES
    ('openai', 'gpt-4o-mini', 'GPT-4o mini (OpenAI)', 10),
    ('openai', 'gpt-4o', 'GPT-4o (OpenAI)', 20),
    ('openai', 'gpt-4.1-mini', 'GPT-4.1 mini (OpenAI)', 30)
ON CONFLICT (provider, model_id) DO NOTHING;

-- Rollback:
--   DROP TABLE IF EXISTS public.ai_agent_allowed_models;
