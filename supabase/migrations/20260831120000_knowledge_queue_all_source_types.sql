-- Widen the knowledge ingestion queue to every source type.
--
-- WHY
-- A 65KB markdown file could not be indexed. The inline path in
-- ai-knowledge-ingest embeds every chunk in one request, and the edge worker is
-- killed at ~60s ("request has been cancelled by supervisor"), leaving the row
-- stranded in `processing` with chunk_count 0, no error, and a UI that polls it
-- every 5 seconds forever. A 14KB file (10 chunks) finished; 65KB did not.
--
-- The escape hatch already existed and was reachable only by CSV and Excel,
-- which are queued to ai-knowledge-excel-worker precisely because they "cannot
-- finish inside the edge worker's ~60s ceiling". That worker already carries the
-- parts that matter: a WORK_BUDGET_MS deadline that reserves headroom, a
-- durable chunk_count checkpoint, and a 10-minute stale-`processing` reclaim.
-- It simply could not parse anything but a workbook.
--
-- ORDERING -- THE REVERSE OF THE USUAL RULE, DELIBERATELY
-- Migrations here normally land BEFORE the code that depends on them. This one
-- must land AFTER, because it does not enable new code -- it changes what the
-- ALREADY-DEPLOYED worker is handed. Widening the claim while the deployed
-- worker still parses only workbooks would feed it markdown and PDFs through
-- XLSX.read, and every one of those sources would be marked failed with a
-- meaningless error.
--
-- So: deploy ai-knowledge-excel-worker (which now calls parseSourceFile for
-- every type, and needs the new parsing.ts copied alongside it) and
-- ai-knowledge-ingest FIRST, confirm they are serving, and only then apply
-- this. The rule behind both orderings is the same one: never let a deployed
-- component receive something it cannot handle.
--
-- The function keeps its "excel" name. Renaming it would need the new name
-- created, the worker redeployed against it, and the old one dropped -- three
-- ordered steps to fix a label, when the deployed worker calls this name today.

BEGIN;

-- WHY A MARKER, AND NOT JUST `status = 'pending'`
-- create_ai_knowledge_source inserts EVERY source as 'pending', and the browser
-- calls ingest_source immediately afterwards. The worker polls every 15s, so a
-- predicate of "pending and a document type" would let it claim an ordinary
-- small upload in that gap while the inline path is already processing the same
-- row. Both delete and insert chunks and advance the checkpoint: duplicated or
-- discarded chunks, and embedding paid for twice.
--
-- `pending` therefore means "not started", which is not the same fact as
-- "handed to the worker". queued_at records the handoff explicitly, and only
-- the inline path sets it -- after parsing, once it knows the source is too
-- large to finish inline.
--
-- Tabular sources keep their existing behaviour: the worker is their ONLY
-- processor, so for them pending has always meant queued and there is no second
-- writer to race.
ALTER TABLE public.ai_knowledge_sources
  ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ;

COMMENT ON COLUMN public.ai_knowledge_sources.queued_at IS
  'Set by ai-knowledge-ingest when a non-tabular source is handed to the queue '
  'worker because it is too large to embed inline. Distinguishes "handed over" '
  'from "not started yet", which status alone cannot express.';

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
      AND (
        -- The worker is the only processor for tabular sources, so pending
        -- alone is safe: nothing else is writing their chunks.
        source_type IN ('excel', 'csv')
        -- Documents have two possible processors, so they are claimed only once
        -- the inline path has explicitly handed them over. Types are named
        -- rather than left open so a type added without a parser cannot be
        -- claimed into a loop of failures.
        OR (source_type IN ('doc', 'pdf', 'image') AND queued_at IS NOT NULL)
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

-- Sources already stranded by the old inline path become claimable. They are
-- identifiable without guessing: `processing` with no chunks written and no
-- error recorded is exactly the shape a killed worker leaves, because every
-- path that fails on purpose writes an error first.
--
-- queued_at is set here too, because the claim above now requires it -- these
-- rows ARE being handed to the worker, which is precisely what the column
-- records.
UPDATE public.ai_knowledge_sources
SET status = 'pending', chunk_count = 0, error = NULL, queued_at = now()
WHERE status = 'processing'
  AND coalesce(chunk_count, 0) = 0
  AND error IS NULL
  AND source_type IN ('doc', 'pdf', 'image');

COMMIT;
