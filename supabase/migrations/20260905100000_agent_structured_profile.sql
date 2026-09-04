-- Structured business profile and agent behavior.
--
-- business_profile_text stays the column the vector database is built from;
-- this migration adds the STRUCTURE behind it, which ai_upsert_config renders
-- back into that text. Doing the render server-side is deliberate: the client
-- form is the layer that blanked live business profiles twice (2026-08-28,
-- 2026-08-30), and confirm_clear/blankedFields only protect
-- business_profile_text.
--
-- agent_behavior is read by buildSystemPrompt. Every key is optional and every
-- key is additive, so an account that never opens the new cards keeps exactly
-- the prompt it has today.

ALTER TABLE public.ai_agent_configs
  ADD COLUMN IF NOT EXISTS business_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS agent_behavior   jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.ai_agent_configs.business_profile IS
  'Structured business profile (industry, products, policies, faqs, notes). Rendered into business_profile_text by ai_upsert_config; never read directly by retrieval.';
COMMENT ON COLUMN public.ai_agent_configs.agent_behavior IS
  'Tone, response length, goals, greeting and instruction blocks. Read by buildSystemPrompt in ai-agent-reply.';

-- Existing free text becomes `notes`, so the Manual tab opens pre-filled and no
-- wording a user typed is lost.
--
-- Guarded on business_profile = '{}' rather than on "has this migration run":
-- re-running it must not overwrite a profile someone has since filled in
-- through the new form.
UPDATE public.ai_agent_configs
SET business_profile = jsonb_build_object('notes', business_profile_text)
WHERE business_profile = '{}'::jsonb
  AND business_profile_text IS NOT NULL
  AND btrim(business_profile_text) <> '';
