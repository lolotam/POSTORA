-- Inbound media understanding: the text the AI agent reads in place of a
-- "[Audio message]" / "[Image]" placeholder.
--
-- Deliberately additive and separate from `message_text`. Everything that
-- reads `message_text` today -- the inbox, the n8n payload, the auto-reply
-- rules -- keeps seeing the placeholder, so enabling this cannot regress them.
-- Spec: docs/specs/2026-08-25-inbound-media-understanding.md (D5).

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS media_understanding      TEXT,
  ADD COLUMN IF NOT EXISTS media_understanding_meta JSONB;

COMMENT ON COLUMN public.whatsapp_messages.media_understanding IS
  'Transcript (audio) or description+OCR (image) handed to the AI agent in place of the placeholder. NULL when the feature is off or understanding failed.';

COMMENT ON COLUMN public.whatsapp_messages.media_understanding_meta IS
  'provider, model, kind, duration_seconds, confidence, extracted_data, attempted_at. Used for cost attribution and for judging transcription quality after the fact.';

-- No index here on purpose.
--
-- An earlier revision added a partial index to support a daily-cap COUNT over this table.
-- That cap now lives in media_understanding_usage (20260825130000), so the index had no
-- reader -- and CREATE INDEX takes ACCESS EXCLUSIVE on whatsapp_messages, which receives
-- every inbound webhook write. Building an unused index would stall live inserts for
-- nothing. Add one when a query actually needs it, with CONCURRENTLY in its own
-- non-transactional migration.
