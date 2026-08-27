-- Reproduces supabase/manual-sql/20260712120000_ai_agent_allowed_models.sql so a
-- migrations-only replay produces the table. Without it, messaging-api's
-- ai_upsert_config fails at its allow-list query on any fresh environment.
--
-- The manual-sql original ends with a seed of three OpenAI models. That seed is
-- deliberately NOT reproduced: production's allow-list holds five rows and none
-- of them is an OpenAI model, so replaying the seed would re-insert models an
-- admin removed -- and would make "gpt-4o-mini" valid again, the exact string
-- behind the persona-loss bug fixed in 0642c878.

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

-- Created only when absent, never dropped and recreated. The manual-sql original
-- uses DROP POLICY IF EXISTS + CREATE POLICY, which is fine against a fresh
-- database but is NOT a no-op against production: run through plain psql with no
-- enclosing transaction, the drop commits on its own, and until the create lands
-- ordinary users read zero rows and admin writes are denied. A failure between the
-- two leaves the policy permanently missing.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'ai_agent_allowed_models'
          AND policyname = 'ai_agent_allowed_models_read_active'
    ) THEN
        CREATE POLICY "ai_agent_allowed_models_read_active"
            ON public.ai_agent_allowed_models FOR SELECT
            TO authenticated
            USING (is_active = true OR public.has_role(auth.uid(), 'admin'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'ai_agent_allowed_models'
          AND policyname = 'ai_agent_allowed_models_admin_all'
    ) THEN
        CREATE POLICY "ai_agent_allowed_models_admin_all"
            ON public.ai_agent_allowed_models FOR ALL
            TO authenticated
            USING (public.has_role(auth.uid(), 'admin'))
            WITH CHECK (public.has_role(auth.uid(), 'admin'));
    END IF;
END $$;
