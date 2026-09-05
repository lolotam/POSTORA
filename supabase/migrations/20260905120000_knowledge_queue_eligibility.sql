-- A deferred crawl must not block everything behind it.
--
-- The website path releases a still-running crawl back to `pending` so the next
-- cron tick can poll it again. But the claim orders globally by created_at, so
-- the same crawl is re-selected on every tick -- and one slow site therefore
-- blocks every later document and crawl, for every user, until it finishes or
-- hits its 30-minute timeout. Stopping the drain loop (the previous fix) only
-- stopped the hammering WITHIN one invocation; this is the across-tick half.
--
-- next_attempt_at is the standard visibility-timeout shape: a row is invisible
-- to the claim until its time arrives, and everything behind it proceeds.

ALTER TABLE public.ai_knowledge_sources
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

COMMENT ON COLUMN public.ai_knowledge_sources.next_attempt_at IS
  'Earliest time this source may be claimed again. Set when a crawl is released mid-flight so it does not monopolise the queue; NULL means immediately eligible.';

-- Partial index: the claim only ever asks about rows that are waiting, and the
-- overwhelming majority of this table is `ready` with a NULL value here.
CREATE INDEX IF NOT EXISTS idx_ai_knowledge_sources_next_attempt
  ON public.ai_knowledge_sources (next_attempt_at)
  WHERE next_attempt_at IS NOT NULL;

-- Identical to the applied definition except for the eligibility clause.
CREATE OR REPLACE FUNCTION public.claim_ai_knowledge_excel_source()
RETURNS SETOF public.ai_knowledge_sources
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed public.ai_knowledge_sources;
BEGIN
  WITH candidate AS (
    SELECT id
    FROM public.ai_knowledge_sources
    WHERE (
        status = 'pending'
        OR (status = 'processing' AND updated_at < now() - interval '10 minutes')
      )
      -- A source waiting out a deferral is skipped entirely, so the next item
      -- in line is claimed instead of the same crawl every tick.
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      AND (
        -- The worker is the only processor for tabular sources, so pending
        -- alone is safe: nothing else is writing their chunks.
        source_type IN ('excel', 'csv')
        -- These have two possible processors, so they are claimed only once the
        -- inline path has explicitly handed them over. Types are named rather
        -- than left open so a type added without a processor cannot be claimed
        -- into a loop of failures.
        OR (source_type IN ('doc', 'pdf', 'image', 'website') AND queued_at IS NOT NULL)
      )
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.ai_knowledge_sources source
  SET status = 'processing', error = NULL
  FROM candidate
  WHERE source.id = candidate.id
  RETURNING source.* INTO claimed;

  IF FOUND THEN RETURN NEXT claimed; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ai_knowledge_excel_source() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_ai_knowledge_excel_source() TO service_role;
