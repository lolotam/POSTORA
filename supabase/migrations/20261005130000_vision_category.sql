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

UPDATE public.ai_models m
SET capabilities = ARRAY(SELECT DISTINCT unnest(m.capabilities || ARRAY['vision']::text[]) ORDER BY 1),
    updated_at = now()
FROM public.ai_providers p
WHERE p.id = m.provider_id
  AND NOT ('vision' = ANY (m.capabilities))
  AND (
    (p.provider_code = 'gemini' AND m.model_id IN ('gemini-3.1-flash-lite', 'gemini-3.5-flash'))
    OR (p.provider_code = 'openrouter' AND m.model_id IN (
      'google/gemini-3.1-flash-lite',
      'google/gemini-3.5-flash',
      'openai/gpt-5.4-mini',
      'google/gemma-4-31b-it:free'
    ))
  );

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
