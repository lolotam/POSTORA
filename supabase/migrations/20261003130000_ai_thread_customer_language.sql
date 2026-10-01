-- ai_threads.customer_language: the language the customer last wrote in (#256).
--
-- A message with no letters (an emoji, a rating, a phone number) answers in this language
-- instead of recounting earlier turns. Recounting broke three ways: the model's six-row
-- history window drops the customer's last real message after a few letterless replies,
-- assistant replies carry Latin product names and links, and a stored voice note wears an
-- English envelope. ai-agent-reply writes it only from the customer's own words or a
-- transcript's detected language, never from its own fallback.
--
-- Additive and idempotent (the rehearsal applies it twice). Ships before the function that
-- writes it: PostgREST refuses a write naming an unknown column.

BEGIN;

ALTER TABLE public.ai_threads
  ADD COLUMN IF NOT EXISTS customer_language text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_threads_customer_language_check'
      AND conrelid = 'public.ai_threads'::regclass
  ) THEN
    ALTER TABLE public.ai_threads
      ADD CONSTRAINT ai_threads_customer_language_check CHECK (customer_language IN ('ar', 'en'));
  END IF;
END $$;

COMMENT ON COLUMN public.ai_threads.customer_language IS
  'Language of the customer''s newest message that showed one (ar|en), or NULL. Written only by ai-agent-reply.';

COMMIT;
