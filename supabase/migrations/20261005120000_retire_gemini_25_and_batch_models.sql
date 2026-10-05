-- ============================================================================
-- Retire Gemini 2.5 text models and OpenRouter :batch models
-- ============================================================================
-- Type: data only. Idempotent: every statement converges on re-run.
--
-- Evidence (2026-10-05, one live call per model with the production key):
--   * gemini-2.5-flash, gemini-2.5-flash-lite and gemini-2.5-pro answer 404
--     "no longer available to new users". The Gemini key had to move to a new
--     Google project that day, so every rung naming one of them now fails.
--   * OpenRouter `<model>:batch` answers 404 on /chat/completions ("cannot be
--     used with the chat/completions endpoint"); it is an asynchronous batch
--     route. 72 were active and one sat in default_ai_model_agent_fallback_2.
--
-- Rows are DEACTIVATED, not deleted. The catalogue sync inserts any model the
-- provider still lists that has no row, and Google still lists the 2.5 models,
-- so a deleted row would come back active on the next sync. An inactive row
-- without metadata.sync_deactivated is never reactivated by the sync, and
-- inactive models are hidden from every picker.
--
-- Spec: docs/superpowers/specs/2026-10-05-vision-ladder-and-model-cleanup.md
-- ============================================================================

BEGIN;

-- 1. Settings slots that name a retired Gemini model -> gemini-3.1-flash-lite
--    (verified 200 for text and image input on 2026-10-05).
UPDATE public.system_settings
SET value = jsonb_build_object('provider_code', 'gemini', 'model_id', 'gemini-3.1-flash-lite'),
    updated_at = now()
WHERE (key = 'default_ai_model' OR key LIKE 'default_ai_model\_%')
  AND value->>'model_id' ~ '^(google/|gemini/)?gemini-2\.5-(flash|flash-lite|pro)$';

-- 2. Settings slots that name a :batch model -> the same model without the suffix.
UPDATE public.system_settings
SET value = jsonb_set(value, '{model_id}', to_jsonb(regexp_replace(value->>'model_id', ':batch$', ''))),
    updated_at = now()
WHERE (key = 'default_ai_model' OR key LIKE 'default_ai_model\_%')
  AND value->>'model_id' LIKE '%:batch';

-- 3. Per-row references. ai_agent_configs.model is deprecated (unread since
--    2026-08-27) and profiles.ai_model is ignored by the backend (the admin Chat
--    ladder governs), but stale values still surface in the UI.
UPDATE public.ai_agent_configs
SET model = 'google/gemini-3.1-flash-lite'
WHERE model ~ '^(google/|gemini/)?gemini-2\.5-(flash|flash-lite|pro)$';

UPDATE public.profiles
SET ai_model = 'google/gemini-3.1-flash-lite'
WHERE ai_model ~ '^(google/|gemini/)?gemini-2\.5-(flash|flash-lite|pro)$';

ALTER TABLE public.profiles ALTER COLUMN ai_model SET DEFAULT 'google/gemini-3.1-flash-lite';

UPDATE public.user_ai_model_overrides
SET model = regexp_replace(model, 'gemini-2\.5-(flash-lite|flash|pro)$', 'gemini-3.1-flash-lite')
WHERE model ~ 'gemini-2\.5-(flash|flash-lite|pro)$';

UPDATE public.ai_agent_allowed_models
SET is_active = false
WHERE model_id ~ '^(google/|gemini/)?gemini-2\.5-(flash|flash-lite|pro)$';

-- 4. Catalogue rows.
UPDATE public.ai_models m
SET is_active = false,
    metadata = coalesce(m.metadata, '{}'::jsonb) || jsonb_build_object('retired', 'no longer available to new Google projects (2026-10-05)'),
    updated_at = now()
FROM public.ai_providers p
WHERE p.id = m.provider_id
  AND p.provider_code = 'gemini'
  AND m.model_id IN ('gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro');

UPDATE public.ai_models
SET is_active = false,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('retired', 'batch route; unusable on chat/completions'),
    updated_at = now()
WHERE model_id LIKE '%:batch' AND is_active;

COMMIT;
