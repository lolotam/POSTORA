-- ============================================================================
-- Fast chat models selectable as AI-agent triage tiers (`triage_chat`)
-- ============================================================================
-- Type: data. Idempotent: the capability merge is a set union. Safe to apply
-- before the code that uses it (see the note at the end).
--
-- Triage used to accept only decision models (TypeSafe Jev on the OpenRouter /
-- Vercel decision APIs), so all three slots held Jev and one Jev outage left
-- the agent with no triage at all. agentTriage.ts now runs any chat model as a
-- tier by asking the same questions as strict JSON. These models were timed on
-- that exact prompt with the production keys on 2026-10-05 (3 runs each):
--   openrouter mistralai/ministral-8b-2512   0.83-1.11 s  valid JSON
--   openrouter openai/gpt-5.4-nano           1.02-1.43 s  valid JSON
--   openrouter google/gemini-3.1-flash-lite  1.16-1.36 s  valid JSON
--   deepseek   deepseek-flash                0.97-1.51 s  valid JSON
--   gemini     gemini-3.1-flash-lite         0.68-6.50 s  (one 503) - kept, but not seeded
-- Rejected: qwen/qwen3.5-flash-02-23 (non-JSON output), meta-llama/llama-4-scout
-- (404, no endpoint), deepseek/deepseek-v4-flash via OpenRouter (2.7-4.8 s).
--
-- `triage_chat`, not `triage`: the catalogue sync manages `triage` for
-- OpenRouter (decision models only) and would strip it from a chat model.
--
-- Spec: docs/superpowers/specs/2026-10-05-vision-ladder-and-model-cleanup.md (Phase C)
-- ============================================================================

BEGIN;

INSERT INTO public.ai_models (provider_id, model_id, name, capabilities, is_active)
SELECT p.id, v.model_id, v.name, ARRAY['chat', 'triage_chat']::text[], true
FROM public.ai_providers p
JOIN (VALUES
  ('openrouter', 'mistralai/ministral-8b-2512', 'Mistral: Ministral 8B'),
  ('openrouter', 'openai/gpt-5.4-nano', 'OpenAI: GPT-5.4 Nano'),
  ('openrouter', 'google/gemini-3.1-flash-lite', 'Google: Gemini 3.1 Flash Lite'),
  ('deepseek', 'deepseek-flash', 'DeepSeek Flash'),
  ('gemini', 'gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite')
) AS v(provider_code, model_id, name) ON v.provider_code = p.provider_code
ON CONFLICT (provider_id, model_id) DO UPDATE
SET capabilities = ARRAY(SELECT DISTINCT unnest(public.ai_models.capabilities || ARRAY['triage_chat']::text[]) ORDER BY 1),
    updated_at = now()
WHERE NOT ('triage_chat' = ANY (public.ai_models.capabilities));

-- The live slots are deliberately NOT changed here. A migration runs before the
-- functions deploy, and the runtime before this change sends every OpenRouter
-- slot to the decision API, where a chat model cannot answer. This file only
-- makes the models selectable, which the old runtime and picker ignore. Moving
-- default_ai_model_agent_triage_fallback_2 off its second Jev is done in
-- /admin/settings once the new triage runtime is live.

COMMIT;
