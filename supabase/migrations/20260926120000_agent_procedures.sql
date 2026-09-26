-- Procedures (Spec A): per-conversation flow state, and the booking intent for saved tests.
--
-- WHY: the AI agent runs five fixed, multi-turn customer flows (order_status,
-- lead_capture, complaint_return, booking, product_finder). The active flow is
-- held as state on the thread row and written only by ai-agent-reply once a
-- turn's reply is final. Separately, saved agent-test expectations admit the new
-- `booking` intent alongside the existing six.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, so applying twice
-- is safe (the rehearsal applies it twice).

BEGIN;

ALTER TABLE public.ai_threads
  ADD COLUMN IF NOT EXISTS procedure_state jsonb;

COMMENT ON COLUMN public.ai_threads.procedure_state IS
  'Active AI agent procedure for this conversation, or NULL. Written only by ai-agent-reply, once the turn''s reply is final.';

-- Same signature as 20260926110000; only the intent list gains 'booking'.
CREATE OR REPLACE FUNCTION public.ai_agent_test_expected_valid(e jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
  SELECT CASE
    WHEN e IS NULL THEN false
    WHEN jsonb_typeof(e) <> 'object' THEN false
    WHEN EXISTS (
      SELECT 1 FROM jsonb_object_keys(e) AS k
      WHERE k NOT IN ('intent', 'connector', 'contains', 'avoids', 'escalates')
    ) THEN false
    WHEN (e ? 'intent') AND NOT (
      jsonb_typeof(e -> 'intent') = 'string'
      AND (e ->> 'intent') IN ('pricing', 'order_status', 'complaint', 'lead', 'booking', 'greeting', 'other')
    ) THEN false
    WHEN (e ? 'connector') AND NOT (
      jsonb_typeof(e -> 'connector') = 'string'
      AND char_length(e ->> 'connector') BETWEEN 1 AND 100
    ) THEN false
    -- The nested CASEs evaluate in order, so jsonb_array_elements is only
    -- ever called after the value has proven to be an array; calling it on
    -- a scalar or object would raise rather than return false.
    WHEN (e ? 'contains') AND CASE
      WHEN jsonb_typeof(e -> 'contains') <> 'array' THEN true
      WHEN (SELECT count(*) FROM jsonb_array_elements(e -> 'contains')) > 10 THEN true
      WHEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(e -> 'contains') AS v
        WHERE jsonb_typeof(v) <> 'string'
          OR char_length(v #>> '{}') NOT BETWEEN 1 AND 200
      ) THEN true
      ELSE false
    END THEN false
    WHEN (e ? 'avoids') AND CASE
      WHEN jsonb_typeof(e -> 'avoids') <> 'array' THEN true
      WHEN (SELECT count(*) FROM jsonb_array_elements(e -> 'avoids')) > 10 THEN true
      WHEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(e -> 'avoids') AS v
        WHERE jsonb_typeof(v) <> 'string'
          OR char_length(v #>> '{}') NOT BETWEEN 1 AND 200
      ) THEN true
      ELSE false
    END THEN false
    WHEN (e ? 'escalates') AND jsonb_typeof(e -> 'escalates') <> 'boolean' THEN false
    ELSE true
  END
$function$;

REVOKE EXECUTE ON FUNCTION public.ai_agent_test_expected_valid(jsonb) FROM PUBLIC, anon;

COMMIT;

NOTIFY pgrst, 'reload schema';
