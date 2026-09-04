-- Website knowledge sources, and the cron that has been missing since the
-- knowledge queue shipped.
--
-- Verified on production 2026-09-05: cron.job held only
-- prune-ai-knowledge-graph-daily, and the standalone EXCEL_WORKER_POLL
-- container was not running -- so nothing drained the queue at all. There were
-- zero pending rows, so this strands nothing; without it, every queued crawl
-- and every large document handed over by ai-knowledge-ingest would sit
-- forever.

ALTER TABLE public.ai_knowledge_sources
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.ai_knowledge_sources.metadata IS
  'Source-type specific state. Website sources carry {url, mode, crawl_job_id, stage, pages_done, pages_total}; stage drives the progress checklist in the UI.';

ALTER TABLE public.ai_knowledge_sources
  DROP CONSTRAINT IF EXISTS ai_knowledge_sources_source_type_check;
ALTER TABLE public.ai_knowledge_sources
  ADD CONSTRAINT ai_knowledge_sources_source_type_check
    CHECK (source_type IN ('excel', 'csv', 'pdf', 'doc', 'image', 'catalog', 'profile_text', 'website'));

-- Identical to the applied definition except that 'website' joins the
-- handed-over types. queued_at is required for the same reason it is for
-- documents: a crawl is only claimable once its Firecrawl job id has been
-- recorded, and the inline path may still be writing that row.
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

-- The drainer. Same shape and the same secret mechanism as the other
-- function-invoking crons in this database (copied from
-- process-pending-agent-replies): a cron that 401s looks exactly like a cron
-- that never ran.
--
-- Unscheduled first so re-applying the migration replaces the job rather than
-- failing on the duplicate name.
SELECT cron.unschedule('drain-ai-knowledge-queue')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-ai-knowledge-queue');

SELECT cron.schedule(
  'drain-ai-knowledge-queue',
  '*/2 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://api.postora.cloud/functions/v1/ai-knowledge-excel-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_cron_secret()
    ),
    body := '{}'::jsonb
  );
  $cron$
);
