-- Per-model parameter metadata for the AI catalog.
--
-- Every Higgsfield model accepts a different set of knobs, and sending one a
-- model does not accept fails the whole request upstream. The catalog therefore
-- has to carry the shape of each model rather than the app guessing at it.
--
-- `metadata` holds what the provider reported for the model on the last sync:
-- parameters, aspect_ratios, durations / duration_range, medias, tags.
--
-- This column was missing in Postora while the ported Higgsfield code already
-- wrote it: higgsfield-oauth's sync_models action upserts `metadata` into
-- ai_models, so the "Sync models" button in Admin -> Settings could not
-- succeed, and VideoGenerator's select of the same column did not typecheck.
-- Same omission as provider_api_keys.meta, fixed in 20260820170000.
--
-- Safe to re-run.
ALTER TABLE public.ai_models
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.ai_models.metadata IS
  'Provider-reported model capabilities: parameters, aspect_ratios, durations, medias, tags. Populated by the Higgsfield "Sync models" action. Public config only — never credentials.';

-- Image generations are recorded alongside video ones so the media library has
-- provenance for every generated asset. Keeps the "recent generations" read
-- cheap now that both modalities land in the same table.
CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_modality_created
  ON public.ai_generation_jobs (modality, created_at DESC);
