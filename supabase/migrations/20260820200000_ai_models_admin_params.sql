-- Admin-set generation parameters for a model, e.g. GPT Image 2's resolution
-- and quality. These belong to the MODEL, not to the tier slot it currently
-- occupies, because models move between Primary/Fallback/Fallback 2 freely and
-- a knob set for one model is meaningless for another.
--
-- Survives a catalog refresh: sync_models upserts only provider_id, model_id,
-- name, description, capabilities, metadata and is_active, so a column it does
-- not name is left untouched.
--
-- Safe to re-run.
ALTER TABLE public.ai_models
  ADD COLUMN IF NOT EXISTS admin_params jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.ai_models.admin_params IS
  'Administrator-set generation parameters for this model (resolution, quality, style_id, ...). Merged over the model spec defaults and under the user-supplied aspect ratio. Public config only — never credentials.';
