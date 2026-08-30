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
-- every type) and ai-knowledge-ingest FIRST, confirm they are serving, and only
-- then apply this. The rule behind both orderings is the same one: never let a
-- deployed component receive something it cannot handle.
--
-- The function keeps its "excel" name. Renaming it would need the new name
-- created, the worker redeployed against it, and the old one dropped -- three
-- ordered steps to fix a label, when the deployed worker calls this name today.
-- The comment carries the correction instead.

BEGIN;

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
    -- Every type the parser understands. Named explicitly rather than left
    -- unfiltered so a type added to the table without a parser cannot be
    -- claimed into a loop of failures.
    WHERE source_type IN ('excel', 'csv', 'doc', 'pdf', 'image')
      AND (
        status = 'pending'
        OR (status = 'processing' AND updated_at < now() - interval '10 minutes')
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
-- Left alone they would sit in `processing` forever, and the 10-minute reclaim
-- above would not reach them while the claim was still tabular-only.
UPDATE public.ai_knowledge_sources
SET status = 'pending', chunk_count = 0, error = NULL
WHERE status = 'processing'
  AND coalesce(chunk_count, 0) = 0
  AND error IS NULL
  AND source_type IN ('doc', 'pdf', 'image');

COMMIT;
