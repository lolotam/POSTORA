-- ============================================================================
-- Image & Document Understanding (`vision`) model category
-- ============================================================================
-- Type: additive data seeding. Idempotent: capability merge is a set union and
-- the ladder rows use ON CONFLICT DO NOTHING, so an admin's later choice wins.
--
-- Images and PDFs customers send to the messaging agents used to ride the
-- Speech-to-Text ladder, where only its single Gemini rung could see. One
-- retired (404) or overloaded (503) Gemini model therefore left the agent
-- answering "I'm not able to view images" (2026-10-05, two WhatsApp accounts).
-- They now follow their own three-rung ladder, chosen in /admin/settings.
--
-- Every model below read "TOTAL: 45.500 KWD / REF 88213" correctly from a JPEG
-- with the production keys on 2026-10-05. The seeded ladder spans two vendor
-- accounts (OpenRouter, Google) and two model families, so no single outage
-- empties it. google/gemma-4-31b-it:free also read images but answered 429
-- (shared free-tier limit) on the first try, so it is selectable, not seeded.
--
-- Spec: docs/superpowers/specs/2026-10-05-vision-ladder-and-model-cleanup.md
-- ============================================================================

BEGIN;

-- Upsert, not a bare UPDATE: on a database the catalogue sync has not filled yet
-- these rows do not exist, and the card would list nothing while the seeded
-- Gemini third rung failed the last-resort "active model" check. An existing row
-- keeps every admin edit; it only gains `vision` (a set union, so re-runs are
-- no-ops). In production all six rows already existed, so this applied as the
-- capability merge alone.
INSERT INTO public.ai_models (provider_id, model_id, name, capabilities, is_active)
SELECT p.id, v.model_id, v.name, ARRAY['chat', 'vision']::text[], true
FROM public.ai_providers p
JOIN (VALUES
  ('gemini', 'gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite'),
  ('gemini', 'gemini-3.5-flash', 'Gemini 3.5 Flash'),
  ('openrouter', 'google/gemini-3.1-flash-lite', 'Google: Gemini 3.1 Flash Lite'),
  ('openrouter', 'google/gemini-3.5-flash', 'Google: Gemini 3.5 Flash'),
  ('openrouter', 'openai/gpt-5.4-mini', 'OpenAI: GPT-5.4 Mini'),
  ('openrouter', 'google/gemma-4-31b-it:free', 'Google: Gemma 4 31B (free)')
) AS v(provider_code, model_id, name) ON v.provider_code = p.provider_code
ON CONFLICT (provider_id, model_id) DO UPDATE
SET capabilities = ARRAY(SELECT DISTINCT unnest(public.ai_models.capabilities || ARRAY['vision']::text[]) ORDER BY 1),
    updated_at = now()
WHERE NOT ('vision' = ANY (public.ai_models.capabilities));

INSERT INTO public.system_settings (key, value, description)
VALUES
  ('default_ai_model_vision',
   '{"provider_code": "openrouter", "model_id": "google/gemini-3.1-flash-lite"}'::jsonb,
   'Image & Document Understanding: primary model'),
  ('default_ai_model_vision_fallback',
   '{"provider_code": "openrouter", "model_id": "openai/gpt-5.4-mini"}'::jsonb,
   'Image & Document Understanding: first fallback'),
  ('default_ai_model_vision_fallback_2',
   '{"provider_code": "gemini", "model_id": "gemini-3.5-flash"}'::jsonb,
   'Image & Document Understanding: last resort')
ON CONFLICT (key) DO NOTHING;

COMMIT;
